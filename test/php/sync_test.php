<?php
// Tests: Sync-Protokoll (Push/Pull/Pages, Konflikte, Papierkorb, Bereinigung, Quota, Isolation).

function uid_($n)
{
    return sprintf('00000000-0000-4000-8000-%012d', $n);
}

function f_data($name, $parent = null, $t = 1000, array $extra = [])
{
    return $extra + ['name' => $name, 'parent_id' => $parent, 'created_at' => $t, 'updated_at' => $t, 'deleted_at' => null, 'purged' => 0];
}

function n_data($title, $folder = null, $t = 1000, array $extra = [])
{
    return $extra + ['title' => $title, 'folder_id' => $folder, 'created_at' => $t, 'updated_at' => $t, 'deleted_at' => null, 'purged' => 0];
}

function p_data($note, $strokes = '[]', $t = 1000, array $extra = [])
{
    return $extra + ['note_id' => $note, 'pos' => 1, 'paper' => 'lined', 'orient' => 'p', 'strokes' => $strokes, 'conflict' => 0,
        'created_at' => $t, 'updated_at' => $t, 'deleted_at' => null, 'purged' => 0];
}

function ch($kind, $id, $data, $base = 0)
{
    return ['kind' => $kind, 'id' => $id, 'base_rev' => $base, 'data' => $data];
}

/** Push and return results; asserts HTTP 200. */
function push(Client $c, array $changes)
{
    $r = $c->post('sync_push', ['changes' => $changes]);
    assert_status(200, $r);
    return $r['json']['results'];
}

/** Pulls everything from $since; returns [items by id, cursor, reset]. */
function pull_all(Client $c, $since = 0, $limit = 200)
{
    $items = [];
    $reset = false;
    for ($i = 0; $i < 100; $i++) {
        $r = $c->get('sync_pull', ['since' => (string)$since, 'limit' => (string)$limit]);
        assert_status(200, $r);
        $reset = $reset || $r['json']['reset'];
        foreach ($r['json']['items'] as $it) $items[$it['row']['id']] = $it;
        $since = $r['json']['cursor'];
        if (!$r['json']['more']) break;
    }
    return [$items, $since, $reset];
}

function strokes_of(Client $c, $id)
{
    $r = $c->post('sync_pages', ['ids' => [$id]]);
    assert_status(200, $r);
    return $r['json']['pages'] ? $r['json']['pages'][0]['strokes'] : null;
}

function test_sync_create_and_pull()
{
    $c = user_client('anna');
    $res = push($c, [
        ch('page', uid_(3), p_data(uid_(2), '[{"i":"a"}]')),  // out of order on purpose
        ch('folder', uid_(1), f_data('Schule')),
        ch('note', uid_(2), n_data('Mathe', uid_(1))),
    ]);
    assert_eq(['ok', 'ok', 'ok'], array_column($res, 'status'));
    assert_eq(1, $res[0]['row']['rev']);
    assert_true(!isset($res[0]['row']['strokes']), 'ok-Antwort ohne strokes');
    list($items, $cursor) = pull_all($c);
    assert_eq(3, count($items));
    assert_eq(3, $cursor);
    assert_eq('Mathe', $items[uid_(2)]['row']['title']);
    assert_true(!isset($items[uid_(3)]['row']['strokes']), 'pull ohne strokes');
    assert_eq(11, $items[uid_(3)]['row']['bytes']);
    assert_eq('[{"i":"a"}]', strokes_of($c, uid_(3)));
    list($items2, $cursor2) = pull_all($c, $cursor);
    assert_eq(0, count($items2));
    assert_eq($cursor, $cursor2);
    assert_eq(11, (int)$c->get('account')['json']['used_bytes']);
}

function test_sync_update_with_base_rev()
{
    $c = user_client('anna');
    push($c, [ch('folder', uid_(1), f_data('A'))]);
    $r = push($c, [ch('folder', uid_(1), f_data('B', null, 2000), 1)]);
    assert_eq('ok', $r[0]['status']);
    assert_eq(2, $r[0]['row']['rev']);
    assert_eq('B', $r[0]['row']['name']);
}

function test_sync_pull_paging_never_skips()
{
    $c = user_client('anna');
    $changes = [];
    for ($i = 1; $i <= 30; $i++) $changes[] = ch($i % 2 ? 'folder' : 'note', uid_($i), $i % 2 ? f_data('F' . $i) : n_data('N' . $i));
    push($c, $changes);
    list($items, $cursor) = pull_all($c, 0, 7);
    assert_eq(30, count($items));
    assert_eq(30, $cursor);
}

function test_sync_folder_conflict_last_write_wins()
{
    $a = user_client('anna');
    push($a, [ch('folder', uid_(1), f_data('Alt'))]);
    push($a, [ch('folder', uid_(1), f_data('Gerät A', null, 3000), 1)]);       // rev 2
    $r = push($a, [ch('folder', uid_(1), f_data('Gerät B älter', null, 2000), 1)]); // stale base, older
    assert_eq('conflict', $r[0]['status']);
    assert_eq('Gerät A', $r[0]['row']['name']);
    assert_eq(2, $r[0]['row']['rev']);
    $r = push($a, [ch('folder', uid_(1), f_data('Gerät B neuer', null, 4000), 1)]); // stale base, newer
    assert_eq('conflict', $r[0]['status']);
    assert_eq('Gerät B neuer', $r[0]['row']['name']);
    assert_eq(3, $r[0]['row']['rev']);
}

function test_sync_page_conflict_keeps_both()
{
    $a = user_client('anna');
    push($a, [ch('note', uid_(2), n_data('N')), ch('page', uid_(3), p_data(uid_(2), '[]'))]);
    push($a, [ch('page', uid_(3), p_data(uid_(2), '[{"i":"A"}]', 3000), 1)]);   // device A, rev 2
    // Device B, based on rev 1, newer → wins in place, A's ink becomes a copy.
    $r = push($a, [ch('page', uid_(3), p_data(uid_(2), '[{"i":"B"}]', 4000), 1)]);
    assert_eq('conflict', $r[0]['status']);
    assert_eq('[{"i":"B"}]', strokes_of($a, uid_(3)));
    list($items) = pull_all($a);
    $copies = array_values(array_filter($items, function ($it) { return $it['kind'] === 'page' && $it['row']['conflict'] === 1; }));
    assert_eq(1, count($copies));
    assert_eq('[{"i":"A"}]', strokes_of($a, $copies[0]['row']['id']));
    assert_true($copies[0]['row']['pos'] > 1, 'Kopie hinter der Seite');
    // Device C, based on rev 1, older → server wins, C's ink becomes a copy; server row returned with strokes.
    $r = push($a, [ch('page', uid_(3), p_data(uid_(2), '[{"i":"C"}]', 3500), 1)]);
    assert_eq('conflict', $r[0]['status']);
    assert_eq('[{"i":"B"}]', $r[0]['row']['strokes']);
    $n = (int)val('SELECT COUNT(*) FROM {pages} WHERE conflict = 1');
    assert_eq(2, $n);
}

function test_sync_page_conflict_same_ink_no_copy()
{
    $a = user_client('anna');
    push($a, [ch('note', uid_(2), n_data('N')), ch('page', uid_(3), p_data(uid_(2), '[]'))]);
    push($a, [ch('page', uid_(3), p_data(uid_(2), '[{"i":"A"}]', 3000, ['paper' => 'grid']), 1)]);
    $r = push($a, [ch('page', uid_(3), p_data(uid_(2), '[{"i":"A"}]', 4000, ['paper' => 'dotted']), 1)]);
    assert_eq('conflict', $r[0]['status']);
    assert_eq('dotted', $r[0]['row']['paper']);
    assert_eq(0, (int)val('SELECT COUNT(*) FROM {pages} WHERE conflict = 1'));
}

function test_sync_delete_vs_edit()
{
    $a = user_client('anna');
    push($a, [ch('note', uid_(2), n_data('N')), ch('page', uid_(3), p_data(uid_(2), '[{"i":"0"}]'))]);
    push($a, [ch('page', uid_(3), p_data(uid_(2), '[{"i":"edit"}]', 3000), 1)]);      // edited, rev 2
    // Other device deleted it later (based on rev 1): deletion wins, the edit survives as a copy.
    $r = push($a, [ch('page', uid_(3), p_data(uid_(2), '[{"i":"0"}]', 4000, ['deleted_at' => 4000]), 1)]);
    assert_eq('conflict', $r[0]['status']);
    assert_eq(4000, $r[0]['row']['deleted_at']);
    $copy = one('SELECT * FROM {pages} WHERE conflict = 1');
    assert_eq('[{"i":"edit"}]', $copy['strokes']);
    assert_eq(null, $copy['deleted_at']);
}

function test_sync_future_clock_is_clamped()
{
    $a = user_client('anna');
    $future = now_ms() + 365 * 86400000;
    $r = push($a, [ch('folder', uid_(1), f_data('X', null, $future))]);
    assert_true($r[0]['row']['updated_at'] <= now_ms() + 5000, 'updated_at begrenzt');
}

function test_sync_isolation()
{
    $a = user_client('anna');
    $b = user_client('bert');
    push($a, [ch('folder', uid_(1), f_data('Geheim')), ch('note', uid_(2), n_data('N', uid_(1))), ch('page', uid_(3), p_data(uid_(2), '[{"i":"x"}]'))]);
    // B can't overwrite, purge, or attach to A's rows.
    $r = push($b, [
        ch('folder', uid_(1), f_data('Übernommen', null, 9000), 1),
        ch('folder', uid_(1), f_data('', null, 9000, ['purged' => 1]), 1),
        ch('note', uid_(10), n_data('B-Notiz', uid_(1))),
        ch('page', uid_(11), p_data(uid_(2), '[]')),
    ]);
    assert_eq(['rejected', 'rejected', 'rejected', 'rejected'], array_column($r, 'status'));
    assert_eq(['forbidden', 'forbidden', 'forbidden', 'forbidden'], array_column($r, 'code'));
    list($items) = pull_all($b);
    assert_eq(0, count($items));
    $p = $b->post('sync_pages', ['ids' => [uid_(3)]]);
    assert_eq([], $p['json']['pages']);
    assert_eq('Geheim', val('SELECT name FROM {folders} WHERE id = ?', [uid_(1)]));
}

function test_sync_rejects_invalid_and_keeps_rest()
{
    $a = user_client('anna');
    $r = push($a, [
        ch('folder', 'kein-uuid', f_data('X')),
        ch('page', uid_(3), p_data(uid_(99), '[]')),                      // note unknown
        ch('page', uid_(4), p_data(null, '[]')),
        ch('note', uid_(5), n_data('ok')),
        ch('page', uid_(6), p_data(uid_(5), 'kein json')),
        ch('page', uid_(7), p_data(uid_(5), '[]', 1000, ['paper' => 'kariert'])),
        ['kind' => 'blob', 'id' => uid_(8), 'base_rev' => 0, 'data' => []],
    ]);
    assert_eq(['rejected', 'rejected', 'rejected', 'ok', 'rejected', 'rejected', 'rejected'], array_column($r, 'status'));
    assert_eq('orphan', $r[1]['code']);
    list($items, $cursor) = pull_all($a);
    assert_eq(1, count($items));
    assert_eq(1, $cursor);
}

function test_sync_missing_parent_folder_goes_to_top_level()
{
    $a = user_client('anna');
    $r = push($a, [ch('note', uid_(2), n_data('Waise', uid_(77)))]);
    assert_eq('ok', $r[0]['status']);
    assert_eq(null, $r[0]['row']['folder_id']);
}

function test_sync_folder_cycle_rejected()
{
    $a = user_client('anna');
    push($a, [ch('folder', uid_(1), f_data('A')), ch('folder', uid_(2), f_data('B', uid_(1)))]);
    $r = push($a, [ch('folder', uid_(1), f_data('A', uid_(2), 2000), 1)]);
    assert_eq('rejected', $r[0]['status']);
    assert_eq('cycle', $r[0]['code']);
    $r = push($a, [ch('folder', uid_(1), f_data('A', uid_(1), 2000), 1)]);
    assert_eq('cycle', $r[0]['code']);
}

function test_sync_purge_cascades()
{
    $a = user_client('anna');
    push($a, [
        ch('folder', uid_(1), f_data('Oben')), ch('folder', uid_(2), f_data('Unten', uid_(1))),
        ch('note', uid_(3), n_data('N', uid_(2))), ch('page', uid_(4), p_data(uid_(3), '[{"i":"x"}]')),
        ch('note', uid_(5), n_data('Bleibt')),
    ]);
    list(, $cursor) = pull_all($a);
    assert_true((int)$a->get('account')['json']['used_bytes'] > 0, 'Bytes gezählt');
    $r = push($a, [ch('folder', uid_(1), f_data('', null, 5000, ['deleted_at' => 5000, 'purged' => 1]), 1)]);
    assert_eq('ok', $r[0]['status']);
    assert_eq(1, $r[0]['row']['purged']);
    list($items) = pull_all($a, $cursor);
    assert_eq(4, count($items));
    foreach ($items as $it) assert_eq(1, $it['row']['purged'], 'Grabstein ' . $it['kind']);
    assert_eq('[]', val('SELECT strokes FROM {pages} WHERE id = ?', [uid_(4)]));
    assert_eq('', val('SELECT title FROM {notes} WHERE id = ?', [uid_(3)]));
    assert_eq(0, (int)$a->get('account')['json']['used_bytes']);
    // Writing to a purged row: server wins.
    $r = push($a, [ch('page', uid_(4), p_data(uid_(3), '[{"i":"spät"}]', 9000), 1)]);
    assert_eq('conflict', $r[0]['status']);
    assert_eq(1, $r[0]['row']['purged']);
    // New page in a purged note: orphan.
    $r = push($a, [ch('page', uid_(6), p_data(uid_(3), '[]'))]);
    assert_eq('orphan', $r[0]['code']);
}

function test_sync_cleanup_trash_and_reset()
{
    $a = user_client('anna');
    $t0 = now_ms();
    push($a, [
        ch('note', uid_(1), n_data('Gelöscht', null, $t0, ['deleted_at' => $t0])),
        ch('page', uid_(2), p_data(uid_(1), '[{"i":"x"}]', $t0)),
        ch('note', uid_(3), n_data('Lebt', null, $t0)),
    ]);
    list(, $oldCursor) = pull_all($a);  // first pull runs cleanup (nothing old yet)
    // 31 days later: the deleted note gets purged.
    $GLOBALS['NZ_NOW'] = $t0 + 31 * 86400000;
    list($items, $cursor) = pull_all($a, $oldCursor);
    assert_eq(2, count($items));
    assert_eq(1, $items[uid_(1)]['row']['purged']);
    assert_eq(0, (int)$a->get('account')['json']['used_bytes']);
    // Another 31 days: tombstones removed physically → old cursors get reset.
    $GLOBALS['NZ_NOW'] = $t0 + 62 * 86400000;
    $r = $a->get('sync_pull', ['since' => (string)$cursor]);
    assert_eq(false, $r['json']['reset']);  // this client is up to date
    assert_eq(0, (int)val('SELECT COUNT(*) FROM {notes} WHERE id = ?', [uid_(1)]));
    list($items, , $reset) = pull_all($a, $oldCursor);
    assert_eq(true, $reset);
    assert_eq([uid_(3)], array_keys($items));
}

function test_sync_cleanup_once_per_day()
{
    $a = user_client('anna');
    pull_all($a);
    $first = (int)val('SELECT last_purge_at FROM {users} WHERE username = ?', ['anna']);
    $GLOBALS['NZ_NOW'] = now_ms() + 3600000;
    pull_all($a);
    assert_eq($first, (int)val('SELECT last_purge_at FROM {users} WHERE username = ?', ['anna']));
}

function test_sync_quota()
{
    $a = user_client('anna');
    q('UPDATE {users} SET quota_bytes = 100 WHERE username = ?', ['anna']);
    $big = '[' . str_repeat('1,', 40) . '1]'; // 83 bytes
    $r = push($a, [ch('note', uid_(1), n_data('N')), ch('page', uid_(2), p_data(uid_(1), $big))]);
    assert_eq(['ok', 'ok'], array_column($r, 'status'));
    $r = push($a, [ch('page', uid_(3), p_data(uid_(1), $big))]);
    assert_eq('rejected', $r[0]['status']);
    assert_eq('quota', $r[0]['code']);
    // Shrinking is always allowed, empty new pages too.
    $r = push($a, [ch('page', uid_(2), p_data(uid_(1), '[]', 2000), 1), ch('page', uid_(4), p_data(uid_(1), '[]'))]);
    assert_eq(['ok', 'ok'], array_column($r, 'status'));
    assert_eq(4, (int)$a->get('account')['json']['used_bytes']); // zwei Seiten mit '[]'
}

function test_sync_limits()
{
    $a = user_client('anna');
    $many = [];
    for ($i = 0; $i < 51; $i++) $many[] = ch('folder', uid_($i + 1), f_data('F'));
    assert_status(413, $a->post('sync_push', ['changes' => $many]), 'too_many');
    assert_status(400, $a->post('sync_push', ['changes' => 'x']), 'invalid');
    assert_status(400, $a->get('sync_pull', ['since' => '-1']), 'invalid');
    $r = push($a, [ch('folder', uid_(1), f_data(str_repeat('x', 201)))]);
    assert_eq('rejected', $r[0]['status']);
}

function test_sync_requires_login_and_csrf()
{
    assert_status(401, (new Client())->get('sync_pull'), 'unauthenticated');
    $a = user_client('anna');
    $a->csrf = '';
    assert_status(403, $a->post('sync_push', ['changes' => []]), 'bad_csrf');
}

function test_sync_vocab_paper()
{
    $a = user_client('anna');
    $r = push($a, [ch('note', uid_(1), n_data('Englisch')), ch('page', uid_(2), p_data(uid_(1), '[]', 1000, ['paper' => 'vocab', 'orient' => 'l']))]);
    assert_eq(['ok', 'ok'], array_column($r, 'status'));
    assert_eq('vocab', val('SELECT paper FROM {pages} WHERE id = ?', [uid_(2)]));
}
