<?php
// Tests: Bild-Assets als Seitenhintergrund (asset_put, asset_get), bg im Sync, Bereinigung, Kontingent.

/** Smallest real JPEG (1 x 1 px). */
function asset_test_jpeg()
{
    return base64_decode('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=');
}

/** JPEG bytes with a tag appended: distinct ids, the server only checks the JPEG signature. */
function asset_test_bytes($tag = '')
{
    return asset_test_jpeg() . $tag;
}

/** asset_put body for $bytes. */
function asset_test_body($bytes)
{
    return ['id' => hash('sha256', $bytes), 'mime' => 'image/jpeg', 'w' => 1, 'h' => 1, 'data' => base64_encode($bytes)];
}

/** Uploads $bytes (asserts 200) and returns the asset id. */
function asset_test_put(Client $c, $bytes)
{
    $body = asset_test_body($bytes);
    assert_status(200, $c->post('asset_put', $body));
    return $body['id'];
}

/** users.used_bytes as reported by the account route. */
function asset_test_used(Client $c)
{
    return (int)$c->get('account')['json']['used_bytes'];
}

function asset_test_user_id($username)
{
    return (int)val('SELECT id FROM {users} WHERE username = ?', [$username]);
}

/** Note uid_(1) with one page uid_(2) (strokes '[]') whose background is $assetId. Pushes must be accepted. */
function asset_test_note(Client $c, $assetId, $t = 1000)
{
    $r = push($c, [ch('note', uid_(1), n_data('Bilder', null, $t)), ch('page', uid_(2), p_data(uid_(1), '[]', $t, ['bg' => $assetId]))]);
    assert_eq(['ok', 'ok'], array_column($r, 'status'));
}

function test_asset_put_ok_and_idempotent()
{
    $a = user_client('anna');
    $bytes = asset_test_bytes();
    $body = asset_test_body($bytes);
    $r = $a->post('asset_put', $body);
    assert_status(200, $r);
    assert_eq($body['id'], $r['json']['asset']['id']);
    assert_eq(strlen($bytes), $r['json']['asset']['bytes']);
    assert_eq(strlen($bytes), asset_test_used($a));
    // Same file again: ok, and not counted twice.
    assert_status(200, $a->post('asset_put', $body));
    assert_eq(strlen($bytes), asset_test_used($a));
    assert_eq(1, (int)val('SELECT COUNT(*) FROM {assets} WHERE user_id = ?', [asset_test_user_id('anna')]));
}

function test_asset_put_rejects_bad_input()
{
    $a = user_client('anna');
    $good = asset_test_body(asset_test_bytes());
    // Hash does not match the content.
    assert_status(400, $a->post('asset_put', ['id' => str_repeat('0', 64)] + $good), 'invalid');
    // Malformed id (upper case is not allowed).
    assert_status(400, $a->post('asset_put', ['id' => strtoupper($good['id'])] + $good), 'invalid');
    // Correct hash, but no JPEG signature.
    assert_status(400, $a->post('asset_put', asset_test_body("\x89PNG\r\n\x1a\n" . 'x')), 'invalid');
    // Not base64.
    assert_status(400, $a->post('asset_put', ['data' => '!!!'] + $good), 'invalid');
    // Other mime type.
    assert_status(400, $a->post('asset_put', ['mime' => 'image/png'] + $good), 'invalid');
    // Dimensions out of range.
    assert_status(400, $a->post('asset_put', ['w' => 0] + $good), 'invalid');
    assert_eq(0, (int)val('SELECT COUNT(*) FROM {assets}'));
    assert_eq(0, asset_test_used($a));
}

function test_asset_put_too_large()
{
    $a = user_client('anna');
    $big = "\xFF\xD8\xFF" . str_repeat('a', NZ_ASSET_MAX_BYTES - 2); // 8 MB + 1 byte
    assert_status(413, $a->post('asset_put', asset_test_body($big)), 'too_large');
    assert_eq(0, asset_test_used($a));
}

function test_asset_put_quota()
{
    $a = user_client('anna');
    $bytes = asset_test_bytes();
    q('UPDATE {users} SET quota_bytes = ? WHERE username = ?', [strlen($bytes) - 1, 'anna']);
    assert_status(507, $a->post('asset_put', asset_test_body($bytes)), 'quota');
    assert_eq(0, asset_test_used($a));
    // Exactly the quota fits.
    q('UPDATE {users} SET quota_bytes = ? WHERE username = ?', [strlen($bytes), 'anna']);
    asset_test_put($a, $bytes);
    assert_eq(strlen($bytes), asset_test_used($a));
}

function test_asset_same_file_stored_per_user()
{
    $a = user_client('anna');
    $b = user_client('bert');
    $bytes = asset_test_bytes('-gleich');
    asset_test_put($a, $bytes);
    asset_test_put($b, $bytes);
    assert_eq(2, (int)val('SELECT COUNT(*) FROM {assets}'));
    assert_eq(strlen($bytes), asset_test_used($a));
    assert_eq(strlen($bytes), asset_test_used($b));
}

function test_asset_get_own_binary()
{
    $a = user_client('anna');
    $bytes = asset_test_bytes();
    $id = asset_test_put($a, $bytes);
    $r = $a->get('asset_get', ['id' => $id]);
    assert_status(200, $r);
    assert_eq('image/jpeg', $r['json']['__type']);
    assert_eq($bytes, $r['json']['__raw']);
    assert_eq('private, max-age=31536000, immutable', $r['json']['__cache']);
}

function test_asset_get_errors()
{
    $a = user_client('anna');
    $id = asset_test_put($a, asset_test_bytes());
    assert_status(401, (new Client())->get('asset_get', ['id' => $id]), 'unauthenticated');
    assert_status(400, $a->get('asset_get', ['id' => 'nope']), 'invalid');
    assert_status(404, $a->get('asset_get', ['id' => str_repeat('a', 64)]), 'not_found');
}

function test_asset_get_foreign_without_note_is_404()
{
    $anna = user_client('anna');
    $bert = user_client('bert');
    $id = asset_test_put($anna, asset_test_bytes());
    assert_status(404, $bert->get('asset_get', ['id' => $id]), 'not_found');
}

function test_asset_get_via_shared_note()
{
    $anna = user_client('anna');
    $bert = user_client('bert');
    $bytes = asset_test_bytes();
    $id = asset_test_put($anna, $bytes);
    asset_test_note($anna, $id);
    // Not shared yet: 404.
    assert_status(404, $bert->get('asset_get', ['id' => $id, 'note' => uid_(1)]), 'not_found');
    assert_status(200, $anna->post('share', ['kind' => 'note', 'id' => uid_(1), 'target_ids' => [asset_test_user_id('bert')]]));
    $r = $bert->get('asset_get', ['id' => $id, 'note' => uid_(1)]);
    assert_status(200, $r);
    assert_eq($bytes, $r['json']['__raw']);
    // An asset that no page of that note uses is not reachable through it.
    $other = asset_test_put($anna, asset_test_bytes('-anderes'));
    assert_status(404, $bert->get('asset_get', ['id' => $other, 'note' => uid_(1)]), 'not_found');
}

function test_asset_get_admin_via_note()
{
    $anna = user_client('anna');
    $bytes = asset_test_bytes();
    $id = asset_test_put($anna, $bytes);
    asset_test_note($anna, $id);
    $admin = new Client('10.2.0.1');
    $admin->login(T_ADMIN_USER, T_ADMIN_PASS);
    assert_status(404, $admin->get('asset_get', ['id' => $id]), 'not_found'); // no own asset
    $r = $admin->get('asset_get', ['id' => $id, 'note' => uid_(1)]);
    assert_status(200, $r);
    assert_eq($bytes, $r['json']['__raw']);
}

function test_asset_get_deleted_page_hides_asset()
{
    $anna = user_client('anna');
    $bert = user_client('bert');
    $id = asset_test_put($anna, asset_test_bytes());
    asset_test_note($anna, $id);
    assert_status(200, $anna->post('share', ['kind' => 'note', 'id' => uid_(1), 'target_ids' => [asset_test_user_id('bert')]]));
    assert_status(200, $bert->get('asset_get', ['id' => $id, 'note' => uid_(1)]));
    // The page goes to the trash: the background is no longer served to readers of the note.
    push($anna, [ch('page', uid_(2), p_data(uid_(1), '[]', 2000, ['bg' => $id, 'deleted_at' => 2000]), 1)]);
    assert_status(404, $bert->get('asset_get', ['id' => $id, 'note' => uid_(1)]), 'not_found');
}

function test_asset_page_needs_uploaded_asset()
{
    $a = user_client('anna');
    $bytes = asset_test_bytes();
    $id = hash('sha256', $bytes);
    $r = push($a, [ch('note', uid_(1), n_data('N')), ch('page', uid_(2), p_data(uid_(1), '[]', 1000, ['bg' => $id]))]);
    assert_eq(['ok', 'rejected'], array_column($r, 'status'));
    assert_eq('missing_asset', $r[1]['code']);
    // An asset of another user does not count.
    $bert = user_client('bert');
    asset_test_put($bert, $bytes);
    $r = push($a, [ch('page', uid_(2), p_data(uid_(1), '[]', 1000, ['bg' => $id]))]);
    assert_eq('missing_asset', $r[0]['code']);
    // After the upload the page is accepted.
    asset_test_put($a, $bytes);
    $r = push($a, [ch('page', uid_(2), p_data(uid_(1), '[]', 1000, ['bg' => $id]))]);
    assert_eq('ok', $r[0]['status']);
    assert_eq($id, val('SELECT bg FROM {pages} WHERE id = ?', [uid_(2)]));
}

function test_asset_bg_sync_roundtrip()
{
    $a = user_client('anna');
    $id = asset_test_put($a, asset_test_bytes());
    asset_test_note($a, $id);
    list($items) = pull_all($a);
    assert_eq($id, $items[uid_(2)]['row']['bg']);
    assert_true(!isset($items[uid_(1)]['row']['bg']), 'Notizen haben kein bg');
    $p = $a->post('sync_pages', ['ids' => [uid_(2)]]);
    assert_status(200, $p);
    assert_eq($id, $p['json']['pages'][0]['bg']);
    // Invalid background value.
    $r = push($a, [ch('page', uid_(3), p_data(uid_(1), '[]', 1000, ['bg' => 'xyz']))]);
    assert_eq('invalid', $r[0]['code']);
    // Removing the background (null) is a normal change.
    $r = push($a, [ch('page', uid_(2), p_data(uid_(1), '[]', 2000, ['bg' => null]), 1)]);
    assert_eq('ok', $r[0]['status']);
    assert_eq(null, $r[0]['row']['bg']);
    assert_eq(null, val('SELECT bg FROM {pages} WHERE id = ?', [uid_(2)]));
}

function test_asset_conflict_copy_keeps_bg()
{
    $a = user_client('anna');
    $x = asset_test_put($a, asset_test_bytes('-x'));
    $y = asset_test_put($a, asset_test_bytes('-y'));
    push($a, [ch('note', uid_(1), n_data('N')), ch('page', uid_(2), p_data(uid_(1), '[{"i":"A"}]', 1000, ['bg' => $x]))]);
    $r = push($a, [ch('page', uid_(2), p_data(uid_(1), '[{"i":"B"}]', 3000, ['bg' => $y]), 1)]); // rev 2
    assert_eq('ok', $r[0]['status']);
    // Stale device, newer: wins in place; the losing version (strokes B, bg y) becomes a copy.
    $r = push($a, [ch('page', uid_(2), p_data(uid_(1), '[{"i":"C"}]', 4000, ['bg' => $x]), 1)]);
    assert_eq('conflict', $r[0]['status']);
    assert_eq($x, val('SELECT bg FROM {pages} WHERE id = ?', [uid_(2)]));
    $copy = one('SELECT * FROM {pages} WHERE conflict = 1');
    assert_eq('[{"i":"B"}]', $copy['strokes']);
    assert_eq($y, $copy['bg']);
}

function test_asset_cleanup_removes_unused_only()
{
    $a = user_client('anna');
    $t0 = now_ms();
    $GLOBALS['NZ_NOW'] = $t0;
    $oldId = asset_test_put($a, asset_test_bytes('-alt'));
    $usedBytes = asset_test_bytes('-benutzt');
    $usedId = asset_test_put($a, $usedBytes);
    asset_test_note($a, $usedId, $t0);
    // Two days later: a fresh upload that no page uses yet.
    $GLOBALS['NZ_NOW'] = $t0 + 2 * 86400000;
    $freshBytes = asset_test_bytes('-frisch');
    $freshId = asset_test_put($a, $freshBytes);
    pull_all($a); // runs the daily cleanup
    assert_status(404, $a->get('asset_get', ['id' => $oldId]), 'not_found');
    assert_status(200, $a->get('asset_get', ['id' => $usedId]));
    assert_status(200, $a->get('asset_get', ['id' => $freshId]));
    // used_bytes = page strokes ('[]' = 2 bytes) + both remaining assets.
    assert_eq(2 + strlen($usedBytes) + strlen($freshBytes), asset_test_used($a));
}

function test_asset_kept_while_page_in_trash()
{
    $a = user_client('anna');
    $t0 = now_ms();
    $GLOBALS['NZ_NOW'] = $t0;
    $id = asset_test_put($a, asset_test_bytes());
    asset_test_note($a, $id, $t0);
    push($a, [ch('page', uid_(2), p_data(uid_(1), '[]', $t0, ['bg' => $id, 'deleted_at' => $t0]), 1)]);
    $GLOBALS['NZ_NOW'] = $t0 + 2 * 86400000;
    pull_all($a);
    assert_status(200, $a->get('asset_get', ['id' => $id]));
}

function test_asset_released_by_purged_page()
{
    $a = user_client('anna');
    $t0 = now_ms();
    $GLOBALS['NZ_NOW'] = $t0;
    $id = asset_test_put($a, asset_test_bytes());
    asset_test_note($a, $id, $t0);
    // Permanently deleted page: its background reference is removed with its content.
    $r = push($a, [ch('page', uid_(2), p_data(uid_(1), '[]', $t0 + 1, ['deleted_at' => $t0 + 1, 'purged' => 1]), 1)]);
    assert_eq('ok', $r[0]['status']);
    assert_eq(null, val('SELECT bg FROM {pages} WHERE id = ?', [uid_(2)]));
    $GLOBALS['NZ_NOW'] = $t0 + 2 * 86400000;
    pull_all($a);
    assert_status(404, $a->get('asset_get', ['id' => $id]), 'not_found');
    assert_eq(0, asset_test_used($a));
}

function test_asset_put_rejects_fake_jpeg_and_stores_real_dimensions()
{
    $a = user_client('anna');
    // Fake JPEG with valid 3-byte magic prefix but invalid JPEG body must be rejected.
    $fake = "\xFF\xD8\xFF" . '<html><script>alert(1)</script></html>';
    assert_status(400, $a->post('asset_put', asset_test_body($fake)), 'invalid');
    assert_eq(0, (int)val('SELECT COUNT(*) FROM {assets}'));

    // Spoofed w/h on a real 1x1 JPEG must be overwritten with server-verified dimensions.
    $real = asset_test_bytes('-spoofed');
    $body = ['w' => 9999, 'h' => 8888] + asset_test_body($real);
    assert_status(200, $a->post('asset_put', $body));
    $row = one('SELECT w, h FROM {assets} WHERE user_id = ? AND id = ?', [asset_test_user_id('anna'), $body['id']]);
    assert_eq(1, (int)$row['w'], 'echte Breite gespeichert');
    assert_eq(1, (int)$row['h'], 'echte Höhe gespeichert');
}
