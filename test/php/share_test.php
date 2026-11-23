<?php
// Tests: Freigaben (Ordner rekursiv, Notiz einzeln), Lesezugriff (shared_tree, shared_pages), Verzeichnis,
// Schutz gegen fremde Zugriffe und Admin-Ansicht (admin_tree, admin_pages). Daten werden über die Sync-API angelegt.

/** Id of a user by name. */
function share_test_id($username)
{
    return (int)val('SELECT id FROM {users} WHERE username = ?', [$username]);
}

/** Pushes changes and asserts that every single change was accepted. */
function share_test_push(Client $c, array $changes)
{
    foreach (push($c, $changes) as $r) assert_eq('ok', $r['status'], 'Sync-Änderung abgelehnt: ' . json_encode($r));
}

/**
 * Tree of anna (as seeded by share_test_seed):
 *   Schule (F1, uid 1) > Mathe (F2, uid 2) > Algebra (F3, uid 3); Hausaufgaben (N10, uid 10) in F2, page P20 with strokes
 *   Privat (F9, uid 9); Geheim (N11, uid 11) in F9
 */
function share_test_seed(Client $c)
{
    share_test_push($c, [
        ch('folder', uid_(1), f_data('Schule')),
        ch('folder', uid_(2), f_data('Mathe', uid_(1))),
        ch('folder', uid_(3), f_data('Algebra', uid_(2))),
        ch('folder', uid_(9), f_data('Privat')),
        ch('note', uid_(10), n_data('Hausaufgaben', uid_(2))),
        ch('note', uid_(11), n_data('Geheim', uid_(9))),
    ]);
    share_test_push($c, [ch('page', uid_(20), p_data(uid_(10), '[{"i":"a1"}]'))]);
}

/** Shares an item and returns the shares list from the response. */
function share_test_share(Client $c, $kind, $id, array $targets)
{
    $r = $c->post('share', ['kind' => $kind, 'id' => $id, 'target_ids' => $targets]);
    assert_status(200, $r);
    return $r['json']['shares'];
}

/** Owners of shared_tree as seen by the client. */
function share_test_owners(Client $c)
{
    $r = $c->get('shared_tree');
    assert_status(200, $r);
    return $r['json']['owners'];
}

/** Rows of one kind ('folders' or 'notes') across all owners. */
function share_test_all(array $owners, $key)
{
    $out = [];
    foreach ($owners as $o) {
        foreach ($o[$key] as $row) $out[] = $row;
    }
    return $out;
}

/** Sorted copy of an ID list (for order-independent comparisons). */
function share_test_sorted(array $ids)
{
    sort($ids);
    return $ids;
}

function share_test_ids(array $rows)
{
    return share_test_sorted(array_column($rows, 'id'));
}

function test_share_folder_recursive_includes_later_notes()
{
    $anna = user_client('anna');
    $bob = user_client('bob');
    $bobId = share_test_id('bob');
    share_test_seed($anna);

    $shares = share_test_share($anna, 'folder', uid_(1), [$bobId]);
    assert_eq(1, count($shares));
    assert_eq($bobId, $shares[0]['target_id']);
    assert_eq('Bob', $shares[0]['display_name']);

    $owners = share_test_owners($bob);
    assert_eq(1, count($owners));
    assert_eq(share_test_id('anna'), $owners[0]['owner']['id']);
    assert_eq('Anna', $owners[0]['owner']['display_name']);
    assert_eq(share_test_sorted([uid_(1), uid_(2), uid_(3)]), share_test_ids($owners[0]['folders']), 'Ordner rekursiv');
    assert_eq([uid_(10)], share_test_ids($owners[0]['notes']), 'nur Notizen in den Freigaben');

    $folders = array_column($owners[0]['folders'], null, 'id');
    assert_eq(null, $folders[uid_(1)]['parent_id'], 'Wurzel ist Wurzel');
    assert_eq(uid_(1), $folders[uid_(2)]['parent_id']);
    assert_eq(uid_(2), $folders[uid_(3)]['parent_id']);
    $notes = array_column($owners[0]['notes'], null, 'id');
    assert_eq(uid_(2), $notes[uid_(10)]['folder_id']);

    // Später hinzukommende Notizen im freigegebenen Baum sind sofort sichtbar, ohne neue Freigabe.
    share_test_push($anna, [ch('note', uid_(12), n_data('Neu', uid_(3)))]);
    $notes = share_test_all(share_test_owners($bob), 'notes');
    assert_eq(share_test_sorted([uid_(10), uid_(12)]), share_test_ids($notes));
    assert_eq(uid_(3), array_column($notes, null, 'id')[uid_(12)]['folder_id']);
    assert_true(!array_key_exists('strokes', $notes[0]), 'shared_tree ohne strokes');

    // Privat (F9) und Geheim (N11) sind nicht freigegeben.
    assert_status(404, $bob->get('shared_pages', ['note' => uid_(11)]), 'not_found');
}

function test_share_single_note_only()
{
    $anna = user_client('anna');
    $bob = user_client('bob');
    $bobId = share_test_id('bob');
    share_test_seed($anna);
    share_test_share($anna, 'note', uid_(10), [$bobId]);

    $owners = share_test_owners($bob);
    assert_eq([], share_test_all($owners, 'folders'), 'kein Ordner freigegeben');
    $notes = share_test_all($owners, 'notes');
    assert_eq([uid_(10)], share_test_ids($notes));
    assert_eq(null, $notes[0]['folder_id'], 'Ordner nicht im Ergebnis → folder_id null');
    assert_eq('Hausaufgaben', $notes[0]['title']);

    $r = $bob->get('shared_pages', ['note' => uid_(10)]);
    assert_status(200, $r);
    assert_eq(uid_(10), $r['json']['note']['id']);
    assert_eq([uid_(20)], share_test_ids($r['json']['pages']));
    assert_eq('[{"i":"a1"}]', $r['json']['pages'][0]['strokes']);
}

function test_share_foreign_note_without_share_is_404()
{
    $anna = user_client('anna');
    $bob = user_client('bob');
    $carl = user_client('carl');
    share_test_seed($anna);
    share_test_share($anna, 'note', uid_(10), [share_test_id('carl')]);

    assert_status(404, $bob->get('shared_pages', ['note' => uid_(10)]), 'not_found');
    assert_status(404, $bob->get('shared_pages', ['note' => uid_(11)]), 'not_found');
    assert_status(404, $bob->get('shared_pages', ['note' => uid_(99)]), 'not_found');
    assert_status(200, $carl->get('shared_pages', ['note' => uid_(10)]));
    assert_eq([], share_test_owners($bob));
}

function test_share_deleted_folder_and_note_hidden()
{
    $anna = user_client('anna');
    $bob = user_client('bob');
    $bobId = share_test_id('bob');
    share_test_seed($anna);
    share_test_push($anna, [ch('note', uid_(13), n_data('Direkt', uid_(1)))]);
    share_test_share($anna, 'folder', uid_(1), [$bobId]);
    share_test_share($anna, 'note', uid_(11), [$bobId]);

    // Mathe (F2) in den Papierkorb: Algebra (F3) und Hausaufgaben (N10) verschwinden mit.
    share_test_push($anna, [ch('folder', uid_(2), f_data('Mathe', uid_(1), 1000, ['deleted_at' => 2000]), 1)]);
    $owners = share_test_owners($bob);
    assert_eq([uid_(1)], share_test_ids(share_test_all($owners, 'folders')));
    assert_eq(share_test_sorted([uid_(11), uid_(13)]), share_test_ids(share_test_all($owners, 'notes')));
    assert_status(404, $bob->get('shared_pages', ['note' => uid_(10)]), 'not_found');

    // Die einzeln freigegebene Notiz im Papierkorb verschwindet auch direkt.
    share_test_push($anna, [ch('note', uid_(11), n_data('Geheim', uid_(9), 1000, ['deleted_at' => 2000]), 1)]);
    assert_eq([uid_(13)], share_test_ids(share_test_all(share_test_owners($bob), 'notes')));
    assert_status(404, $bob->get('shared_pages', ['note' => uid_(11)]), 'not_found');
    assert_status(200, $bob->get('shared_pages', ['note' => uid_(13)]));
}

function test_share_folder_below_deleted_ancestor_hidden()
{
    $anna = user_client('anna');
    $bob = user_client('bob');
    $bobId = share_test_id('bob');
    share_test_seed($anna);
    share_test_share($anna, 'folder', uid_(2), [$bobId]);

    $owners = share_test_owners($bob);
    assert_eq(share_test_sorted([uid_(2), uid_(3)]), share_test_ids(share_test_all($owners, 'folders')));
    assert_status(200, $bob->get('shared_pages', ['note' => uid_(10)]));

    // Die Schule (F1) über der freigegebenen Mathe (F2) geht in den Papierkorb.
    share_test_push($anna, [ch('folder', uid_(1), f_data('Schule', null, 1000, ['deleted_at' => 2000]), 1)]);
    $owners = share_test_owners($bob);
    assert_eq([], share_test_all($owners, 'folders'), 'Vorfahr gelöscht → nichts sichtbar');
    assert_eq([], share_test_all($owners, 'notes'));
    assert_status(404, $bob->get('shared_pages', ['note' => uid_(10)]), 'not_found');
}

function test_share_locked_owner_sees_nothing_until_unlocked()
{
    $anna = user_client('anna');
    $bob = user_client('bob');
    $bobId = share_test_id('bob');
    share_test_seed($anna);
    share_test_share($anna, 'folder', uid_(1), [$bobId]);
    share_test_share($anna, 'note', uid_(11), [$bobId]);
    assert_eq(1, count(share_test_owners($bob)));

    q("UPDATE {users} SET status = 'locked' WHERE username = ?", ['anna']);
    assert_eq([], share_test_owners($bob), 'gesperrter Besitzer → nichts');
    assert_status(404, $bob->get('shared_pages', ['note' => uid_(10)]), 'not_found');
    assert_status(404, $bob->get('shared_pages', ['note' => uid_(11)]), 'not_found');

    // Freigaben bleiben bestehen und werden beim Entsperren wieder sichtbar.
    assert_eq(2, (int)val('SELECT COUNT(*) FROM {shares}'));
    q("UPDATE {users} SET status = 'active' WHERE username = ?", ['anna']);
    $owners = share_test_owners($bob);
    assert_eq(share_test_sorted([uid_(1), uid_(2), uid_(3)]), share_test_ids(share_test_all($owners, 'folders')));
    assert_eq(share_test_sorted([uid_(10), uid_(11)]), share_test_ids(share_test_all($owners, 'notes')));
}

function test_share_unshare_only_by_owner()
{
    $anna = user_client('anna');
    $bob = user_client('bob');
    share_test_seed($anna);
    $shares = share_test_share($anna, 'folder', uid_(1), [share_test_id('bob')]);
    $shareId = $shares[0]['id'];

    assert_status(404, $bob->post('unshare', ['share_id' => $shareId]), 'not_found');
    assert_eq(1, count(share_test_owners($bob)), 'Freigabe bleibt bestehen');
    assert_status(400, $anna->post('unshare', []), 'invalid');

    $r = $anna->post('unshare', ['share_id' => $shareId]);
    assert_status(200, $r);
    assert_eq([], share_test_owners($bob));
    assert_eq([], $anna->get('shares_of', ['kind' => 'folder', 'id' => uid_(1)])['json']['shares']);
    assert_status(404, $anna->post('unshare', ['share_id' => $shareId]), 'not_found');
}

function test_share_invalid_targets_rejected()
{
    $anna = user_client('anna');
    make_user('bob');
    make_user('carl', 'passwort-1234', 'user', ['status' => 'locked']);
    share_test_seed($anna);
    $annaId = share_test_id('anna');
    $bobId = share_test_id('bob');
    $carlId = share_test_id('carl');
    $share = function (array $targets) use ($anna) {
        return $anna->post('share', ['kind' => 'folder', 'id' => uid_(1), 'target_ids' => $targets]);
    };

    assert_status(400, $share([$annaId]), 'invalid_target');   // sich selbst
    assert_status(400, $share([$carlId]), 'invalid_target');   // gesperrt
    assert_status(400, $share([99999]), 'invalid_target');     // unbekannt
    assert_status(400, $share([$bobId, $carlId]), 'invalid_target'); // einer ungültig: nichts angelegt
    assert_status(400, $share([$bobId, 'abc']), 'invalid');
    assert_status(400, $share(range(1, 101)), 'invalid');      // mehr als 100
    assert_eq(0, (int)val('SELECT COUNT(*) FROM {shares}'), 'keine Freigabe angelegt');

    // Doppelte Empfänger ergeben eine Freigabe, erneutes Teilen ändert nichts.
    $r = $share([$bobId, $bobId]);
    assert_status(200, $r);
    assert_eq(1, count($r['json']['shares']));
    assert_status(200, $share([$bobId]));
    assert_eq(1, (int)val('SELECT COUNT(*) FROM {shares}'));
}

function test_share_foreign_or_deleted_item_is_404()
{
    $anna = user_client('anna');
    $bob = user_client('bob');
    make_user('carl');
    $bobId = share_test_id('bob');
    $carlId = share_test_id('carl');
    share_test_seed($anna);

    // Bob darf weder Annas Ordner oder Notiz teilen noch deren Freigaben sehen.
    assert_status(404, $bob->post('share', ['kind' => 'folder', 'id' => uid_(1), 'target_ids' => [$carlId]]), 'not_found');
    assert_status(404, $bob->post('share', ['kind' => 'note', 'id' => uid_(10), 'target_ids' => [$carlId]]), 'not_found');
    assert_status(404, $bob->get('shares_of', ['kind' => 'folder', 'id' => uid_(1)]), 'not_found');

    // Gelöschte Notiz, Unterordner eines gelöschten Ordners und endgültig gelöschte Ordner sind nicht teilbar.
    share_test_push($anna, [ch('note', uid_(11), n_data('Geheim', uid_(9), 1000, ['deleted_at' => 2000]), 1)]);
    assert_status(404, $anna->post('share', ['kind' => 'note', 'id' => uid_(11), 'target_ids' => [$bobId]]), 'not_found');
    share_test_push($anna, [ch('folder', uid_(2), f_data('Mathe', uid_(1), 1000, ['deleted_at' => 2000]), 1)]);
    assert_status(404, $anna->post('share', ['kind' => 'folder', 'id' => uid_(3), 'target_ids' => [$bobId]]), 'not_found');
    share_test_push($anna, [ch('folder', uid_(9), f_data('Privat', null, 1000, ['purged' => 1]), 1)]);
    assert_status(404, $anna->post('share', ['kind' => 'folder', 'id' => uid_(9), 'target_ids' => [$bobId]]), 'not_found');
    assert_status(404, $anna->get('shares_of', ['kind' => 'folder', 'id' => uid_(9)]), 'not_found');
}

function test_share_directory_without_self_and_locked()
{
    $anna = user_client('anna');
    make_user('bob');
    make_user('dora');
    make_user('ben', 'passwort-1234', 'user', ['display_name' => 'Aaron']);
    make_user('carl', 'passwort-1234', 'user', ['status' => 'locked']);

    $r = $anna->get('directory');
    assert_status(200, $r);
    // 'chef' is the configured admin (an active user, so listed); carl is locked, anna is the caller.
    assert_eq(['Aaron', 'Bob', 'chef', 'Dora'], array_column($r['json']['users'], 'display_name'), 'sortiert nach Anzeigename');
    assert_eq([share_test_id('ben'), share_test_id('bob'), share_test_id('chef'), share_test_id('dora')], array_column($r['json']['users'], 'id'));
    assert_true(!isset($r['json']['users'][0]['username']), 'keine Benutzernamen im Verzeichnis');
}

function test_share_shared_tree_root_parent_is_null()
{
    $anna = user_client('anna');
    $bob = user_client('bob');
    $bobId = share_test_id('bob');
    share_test_seed($anna);

    share_test_share($anna, 'folder', uid_(2), [$bobId]);
    $owners = share_test_owners($bob);
    assert_eq([uid_(10)], share_test_ids(share_test_all($owners, 'notes')), 'Hausaufgaben liegt in der Freigabe');
    $folders = array_column(share_test_all($owners, 'folders'), null, 'id');
    assert_eq(share_test_sorted([uid_(2), uid_(3)]), share_test_sorted(array_keys($folders)));
    assert_eq(null, $folders[uid_(2)]['parent_id'], 'freigegebene Wurzel ohne Vater in der Ausgabe');
    assert_eq(uid_(2), $folders[uid_(3)]['parent_id']);
    assert_eq(uid_(2), array_column(share_test_all($owners, 'notes'), null, 'id')[uid_(10)]['folder_id']);

    // Wird auch der Vater freigegeben, behält Mathe seinen Vater.
    share_test_share($anna, 'folder', uid_(1), [$bobId]);
    $folders = array_column(share_test_all(share_test_owners($bob), 'folders'), null, 'id');
    assert_eq(null, $folders[uid_(1)]['parent_id']);
    assert_eq(uid_(1), $folders[uid_(2)]['parent_id']);
    $notes = array_column(share_test_all(share_test_owners($bob), 'notes'), null, 'id');
    assert_eq(uid_(2), $notes[uid_(10)]['folder_id']);
}

function test_share_pages_have_strokes_sorted_without_deleted()
{
    $anna = user_client('anna');
    $bob = user_client('bob');
    share_test_seed($anna);
    share_test_push($anna, [ch('note', uid_(12), n_data('Mehrseitig'))]);
    share_test_push($anna, [
        ch('page', uid_(21), p_data(uid_(12), '[{"i":"a"}]', 1000, ['pos' => 3])),
        ch('page', uid_(22), p_data(uid_(12), '[{"i":"m"}]', 1000, ['pos' => 2, 'deleted_at' => 2000])),
        ch('page', uid_(23), p_data(uid_(12), '[{"i":"c"}]', 1000, ['pos' => 1])),
        ch('page', uid_(24), p_data(uid_(12), '[{"i":"x"}]', 1000, ['pos' => 4])),
        ch('page', uid_(25), p_data(uid_(12), '[{"i":"b"}]', 1000, ['pos' => 2.5])),
    ]);
    share_test_push($anna, [ch('page', uid_(24), p_data(uid_(12), '[]', 1000, ['purged' => 1]), 1)]);
    share_test_share($anna, 'note', uid_(12), [share_test_id('bob')]);

    $r = $bob->get('shared_pages', ['note' => uid_(12)]);
    assert_status(200, $r);
    assert_eq([uid_(23), uid_(25), uid_(21)], array_column($r['json']['pages'], 'id'), 'nach pos, ohne gelöschte/endgültige');
    assert_eq(['[{"i":"c"}]', '[{"i":"b"}]', '[{"i":"a"}]'], array_column($r['json']['pages'], 'strokes'));
    assert_eq(1, (int)val('SELECT COUNT(*) FROM {pages} WHERE purged = 1 AND id = ?', [uid_(24)]), 'Grabstein bleibt in der DB');
    $notes = share_test_all(share_test_owners($bob), 'notes');
    assert_true(!array_key_exists('strokes', $notes[0]), 'shared_tree ohne strokes');
}

function test_share_own_note_not_in_shared_pages()
{
    $anna = user_client('anna');
    share_test_seed($anna);
    assert_status(404, $anna->get('shared_pages', ['note' => uid_(10)]), 'not_found');
}

function test_share_admin_tree_and_pages_with_log()
{
    $anna = user_client('anna');
    $bob = user_client('bob');
    $annaId = share_test_id('anna');
    $bobId = share_test_id('bob');
    share_test_seed($anna);
    share_test_push($anna, [ch('note', uid_(15), n_data('Papierkorb', uid_(9), 1000, ['deleted_at' => 2000]))]);
    $admin = admin_test_client();

    $r = $admin->get('admin_tree', ['user' => (string)$annaId]);
    assert_status(200, $r);
    assert_eq(share_test_sorted([uid_(1), uid_(2), uid_(3), uid_(9)]), share_test_ids($r['json']['folders']));
    assert_eq(share_test_sorted([uid_(10), uid_(11)]), share_test_ids($r['json']['notes']), 'ohne gelöschte Notiz');
    assert_true(!array_key_exists('strokes', $r['json']['notes'][0]), 'ohne strokes');
    $log = all("SELECT action, target_user_id, details FROM {admin_log} WHERE action = 'view_tree'");
    assert_eq(1, count($log));
    assert_eq($annaId, (int)$log[0]['target_user_id']);
    assert_eq('username=anna', $log[0]['details']);

    $p = $admin->get('admin_pages', ['user' => (string)$annaId, 'note' => uid_(10)]);
    assert_status(200, $p);
    assert_eq(uid_(10), $p['json']['note']['id']);
    assert_eq([uid_(20)], share_test_ids($p['json']['pages']));
    assert_eq('[{"i":"a1"}]', $p['json']['pages'][0]['strokes']);
    $log = all("SELECT action, target_user_id, details FROM {admin_log} WHERE action = 'view_note'");
    assert_eq(1, count($log));
    assert_eq($annaId, (int)$log[0]['target_user_id']);
    assert_eq('note=' . uid_(10), $log[0]['details']);

    // Notiz gehört einem anderen Benutzer, unbekannter Benutzer, fehlende Angaben.
    assert_status(404, $admin->get('admin_pages', ['user' => (string)$bobId, 'note' => uid_(10)]), 'not_found');
    assert_status(404, $admin->get('admin_tree', ['user' => '99999']), 'not_found');
    assert_status(400, $admin->get('admin_tree'), 'invalid');
    assert_status(400, $admin->get('admin_pages', ['user' => (string)$annaId]), 'invalid');

    // Endgültig gelöschte Notiz ist nicht mehr einsehbar.
    share_test_push($anna, [ch('note', uid_(11), n_data('', uid_(9), 1000, ['purged' => 1]), 1)]);
    assert_status(404, $admin->get('admin_pages', ['user' => (string)$annaId, 'note' => uid_(11)]), 'not_found');
    $tree = $admin->get('admin_tree', ['user' => (string)$annaId]);
    assert_status(200, $tree);
    assert_eq(share_test_sorted([uid_(1), uid_(2), uid_(3), uid_(9)]), share_test_ids($tree['json']['folders']));

    // Benutzer ohne Adminrecht: 403 und kein Protokolleintrag.
    $before = (int)val('SELECT COUNT(*) FROM {admin_log}');
    assert_status(403, $bob->get('admin_tree', ['user' => (string)$annaId]), 'forbidden');
    assert_status(403, $bob->get('admin_pages', ['user' => (string)$annaId, 'note' => uid_(10)]), 'forbidden');
    assert_eq($before, (int)val('SELECT COUNT(*) FROM {admin_log}'));
}
