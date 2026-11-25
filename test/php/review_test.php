<?php
// Tests: Ordnerfarbe und Seiten-Metadaten im Sync, Abgabe und Korrektur (Freigabe mit review, correction_get/save/clear).

function test_sync_folder_color_and_page_meta()
{
    $a = user_client('anna');
    $r = push($a, [
        ch('folder', uid_(1), f_data('Mathe', null, 1000, ['color' => '#2F5FD0'])),
        ch('note', uid_(2), n_data('N', uid_(1))),
        ch('page', uid_(3), p_data(uid_(2), '[]', 1000, ['meta' => '{"label":"Kapitel 1","learn":{"v":1,"rows":{}}}', 'paper' => 'coord'])),
    ]);
    assert_eq(['ok', 'ok', 'ok'], array_column($r, 'status'));
    assert_eq('#2f5fd0', $r[0]['row']['color']);
    assert_eq('coord', val('SELECT paper FROM {pages} WHERE id = ?', [uid_(3)]));
    // Älterer Client ohne color/meta: Werte bleiben
    $r = push($a, [ch('folder', uid_(1), f_data('Mathematik', null, 2000), 1), ch('page', uid_(3), p_data(uid_(2), '[{"i":"x"}]', 2000, ['paper' => 'coord']), 1)]);
    assert_eq(['ok', 'ok'], array_column($r, 'status'));
    assert_eq('#2f5fd0', val('SELECT color FROM {folders} WHERE id = ?', [uid_(1)]));
    assert_eq('{"label":"Kapitel 1","learn":{"v":1,"rows":{}}}', val('SELECT meta FROM {pages} WHERE id = ?', [uid_(3)]));
    // Farbe entfernen
    $r = push($a, [ch('folder', uid_(1), f_data('Mathematik', null, 3000, ['color' => null]), 2)]);
    assert_eq(null, val('SELECT color FROM {folders} WHERE id = ?', [uid_(1)]));
    // Ungültig
    foreach ([['folder', uid_(5), f_data('X', null, 1000, ['color' => 'red'])],
              ['page', uid_(6), p_data(uid_(2), '[]', 1000, ['meta' => '[1,2]'])],
              ['page', uid_(7), p_data(uid_(2), '[]', 1000, ['meta' => str_repeat('x', 40000)])],
              ['page', uid_(8), p_data(uid_(2), '[]', 1000, ['paper' => 'papyrus'])]] as $t) {
        $r = push($a, [ch($t[0], $t[1], $t[2])]);
        assert_eq('rejected', $r[0]['status'], json_encode($t[2]));
    }
    // Pull liefert die Felder
    $p = $a->get('sync_pull', ['since' => 0]);
    assert_status(200, $p);
    $rows = [];
    foreach ($p['json']['items'] as $c) $rows[$c['kind'] . $c['row']['id']] = $c['row'];
    assert_eq(null, $rows['folder' . uid_(1)]['color']);
    assert_eq('{"label":"Kapitel 1","learn":{"v":1,"rows":{}}}', $rows['page' . uid_(3)]['meta']);
}

/** anna: Note N10 with page P20 in folder F2 (in F1); bert gets folder F1 with review, carl note N10 read only. */
function review_seed()
{
    $a = user_client('anna');
    $b = user_client('bert');
    $c = user_client('carl');
    share_test_seed($a);
    $r = $a->post('share', ['kind' => 'folder', 'id' => uid_(1), 'target_ids' => [share_test_id('bert')], 'review' => true]);
    assert_status(200, $r);
    assert_eq(1, $r['json']['shares'][0]['review']);
    share_test_share($a, 'note', uid_(10), [share_test_id('carl')]);
    return [$a, $b, $c];
}

function test_review_save_get_clear()
{
    list($a, $b, $c) = review_seed();
    // bert darf korrigieren
    $sp = $b->get('shared_pages', ['note' => uid_(10)]);
    assert_status(200, $sp);
    assert_eq(true, $sp['json']['can_review']);
    $r = $b->post('correction_save', ['note' => uid_(10), 'page' => uid_(20), 'strokes' => '[{"i":"r1"}]']);
    assert_status(200, $r);
    // carl nur lesen
    $sp = $c->get('shared_pages', ['note' => uid_(10)]);
    assert_eq(false, $sp['json']['can_review']);
    assert_status(404, $c->post('correction_save', ['note' => uid_(10), 'page' => uid_(20), 'strokes' => '[]']), 'not_found');
    $g = $c->get('correction_get', ['note' => uid_(10)]);
    assert_status(200, $g);
    assert_eq([], $g['json']['corrections'], 'Leser sieht keine Korrekturen');
    // anna sieht die Korrektur mit Namen
    $g = $a->get('correction_get', ['note' => uid_(10)]);
    assert_status(200, $g);
    assert_eq(1, count($g['json']['corrections']));
    assert_eq('[{"i":"r1"}]', $g['json']['corrections'][0]['strokes']);
    assert_eq(uid_(20), $g['json']['corrections'][0]['page_id']);
    assert_eq('Bert', $g['json']['corrections'][0]['reviewer']);
    // bert sieht nur seine eigene
    $g = $b->get('correction_get', ['note' => uid_(10)]);
    assert_eq(true, $g['json']['can_review']);
    assert_eq(1, count($g['json']['corrections']));
    // Überschreiben, dann anna löscht
    assert_status(200, $b->post('correction_save', ['note' => uid_(10), 'page' => uid_(20), 'strokes' => '[{"i":"r2"}]']));
    assert_eq(1, (int)val('SELECT COUNT(*) FROM {corrections}'));
    assert_status(404, $b->post('correction_clear', ['note' => uid_(10)]), 'not_found');
    assert_status(200, $a->post('correction_clear', ['note' => uid_(10), 'page' => uid_(20)]));
    assert_eq(0, (int)val('SELECT COUNT(*) FROM {corrections}'));
    // Leere Striche löschen die eigene Korrektur
    assert_status(200, $b->post('correction_save', ['note' => uid_(10), 'page' => uid_(20), 'strokes' => '[{"i":"r3"}]']));
    assert_status(200, $b->post('correction_save', ['note' => uid_(10), 'page' => uid_(20), 'strokes' => '[]']));
    assert_eq(0, (int)val('SELECT COUNT(*) FROM {corrections}'));
}

function test_review_denied_cases()
{
    list($a, $b, $c) = review_seed();
    // Notiz außerhalb der Freigabe (Privat/Geheim), fremde Seite, kaputte Striche, eigene Notiz
    assert_status(404, $b->post('correction_save', ['note' => uid_(11), 'page' => uid_(20), 'strokes' => '[]']), 'not_found');
    assert_status(404, $b->post('correction_save', ['note' => uid_(10), 'page' => uid_(99), 'strokes' => '[]']), 'not_found');
    assert_status(400, $b->post('correction_save', ['note' => uid_(10), 'page' => uid_(20), 'strokes' => '{"x":']), 'invalid');
    assert_status(404, $a->post('correction_save', ['note' => uid_(10), 'page' => uid_(20), 'strokes' => '[]']), 'not_found');
    assert_status(404, $c->get('correction_get', ['note' => uid_(11)]), 'not_found');
    // Freigabe ohne review → keine Korrektur mehr
    $r = $a->post('share', ['kind' => 'folder', 'id' => uid_(1), 'target_ids' => [share_test_id('bert')], 'review' => false]);
    assert_eq(0, $r['json']['shares'][0]['review']);
    assert_status(404, $b->post('correction_save', ['note' => uid_(10), 'page' => uid_(20), 'strokes' => '[{"i":"z"}]']), 'not_found');
    // Gelöschte Seite: Korrektur nicht mehr sichtbar
    $a->post('share', ['kind' => 'folder', 'id' => uid_(1), 'target_ids' => [share_test_id('bert')], 'review' => true]);
    assert_status(200, $b->post('correction_save', ['note' => uid_(10), 'page' => uid_(20), 'strokes' => '[{"i":"z"}]']));
    q('UPDATE {pages} SET deleted_at = 5 WHERE id = ?', [uid_(20)]);
    assert_eq([], $a->get('correction_get', ['note' => uid_(10)])['json']['corrections']);
    // Konto gelöscht → Korrekturen weg (Fremdschlüssel)
    q('DELETE FROM {users} WHERE username = ?', ['bert']);
    assert_eq(0, (int)val('SELECT COUNT(*) FROM {corrections}'));
}
