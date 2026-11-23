<?php
// Tests: Admin-API (Liste mit Zählern, Anlegen, Bearbeiten, Reset, Sperren, Sitzungen, Löschen, Protokoll, Schutzregeln).

/** Admin client logged in as the configured admin. */
function admin_test_client()
{
    $c = new Client('10.7.0.1');
    $c->login(T_ADMIN_USER, T_ADMIN_PASS);
    return $c;
}

function admin_test_id($username)
{
    return (int)val('SELECT id FROM {users} WHERE username = ?', [$username]);
}

function admin_test_sessions($userId)
{
    return (int)val('SELECT COUNT(*) FROM {sessions} WHERE user_id = ?', [(int)$userId]);
}

/** Inserts a note row directly. $state: 'ok', 'deleted' or 'purged'. */
function admin_test_note($userId, $state = 'ok')
{
    static $n = 0;
    $n++;
    $id = sprintf('00000000-0000-4000-8000-%012d', $n);
    $now = now_ms();
    q("INSERT INTO {notes} (id, user_id, folder_id, title, created_at, updated_at, deleted_at, purged, rev, seq)
       VALUES (?, ?, NULL, 'Notiz', ?, ?, ?, ?, 1, 1)",
        [$id, (int)$userId, $now, $now, $state === 'ok' ? null : $now, $state === 'purged' ? 1 : 0]);
    return $id;
}

/** Calls an admin handler directly (for protection rules that the API cannot reach, e.g. last admin). Returns the error code or null. */
function admin_test_direct($handler, array $fakeAdmin, array $body)
{
    set_request(['method' => 'POST', 'query' => ['r' => 'direkt'], 'body' => json_encode($body), 'headers' => ['Host' => 'localhost']]);
    try {
        $handler($fakeAdmin);
    } catch (HttpError $e) {
        return $e->errCode;
    }
    return null;
}

function test_admin_list_with_counts()
{
    $admin = admin_test_client();
    $anna = make_user('anna');
    make_user('zoe');
    admin_test_note($anna);
    admin_test_note($anna);
    admin_test_note($anna, 'deleted');
    admin_test_note($anna, 'purged');
    q('UPDATE {users} SET used_bytes = 4096 WHERE id = ?', [$anna]);

    (new Client('10.7.0.2'))->login('anna', 'passwort-1234');
    (new Client('10.7.0.3'))->login('anna', 'passwort-1234');
    $expired = new Client('10.7.0.4');
    $expired->login('anna', 'passwort-1234');
    q('UPDATE {sessions} SET expires_at = 1 WHERE id_hash = ?', [hash('sha256', $expired->cookies[NZ_COOKIE])]);

    $r = $admin->get('admin_users');
    assert_status(200, $r);
    $users = $r['json']['users'];
    assert_eq(['anna', 'chef', 'zoe'], array_column($users, 'username'), 'sortiert nach Benutzername');

    $a = $users[0];
    assert_eq(2, $a['notes_count'], 'Notizen ohne gelöschte und endgültig gelöschte');
    assert_eq(2, $a['sessions_count'], 'abgelaufene Sitzungen nicht mitzählen');
    assert_eq(4096, $a['used_bytes']);
    assert_eq(524288000, $a['quota_bytes']);
    assert_eq('user', $a['role']);
    assert_eq('active', $a['status']);
    assert_eq(false, $a['must_change_pw']);
    assert_true(!isset($a['password_hash']), 'kein Hash in der Ausgabe');

    assert_eq(1, $users[1]['sessions_count'], 'Admin selbst hat eine Sitzung');
    assert_eq(0, $users[2]['notes_count']);
    assert_eq(0, $users[2]['sessions_count']);
}

function test_admin_create_with_temp_password()
{
    $admin = admin_test_client();
    $r = $admin->post('admin_user_create', ['username' => '  Neu.User ', 'display_name' => '', 'role' => 'user', 'quota_mb' => 500]);
    assert_status(200, $r);
    $u = $r['json']['user'];
    assert_eq('neu.user', $u['username'], 'Benutzername klein und getrimmt');
    assert_eq('neu.user', $u['display_name'], 'leerer Anzeigename wird durch Benutzername ersetzt');
    assert_eq(true, $u['must_change_pw']);
    assert_eq('active', $u['status']);
    assert_eq(null, $u['last_login_at']);
    assert_true(!isset($u['password_hash']), 'kein Hash in der Ausgabe');

    $temp = $r['json']['temp_password'];
    assert_true(strlen($temp) >= 10, 'Einmal-Passwort vorhanden');
    assert_eq(524288000, (int)val('SELECT quota_bytes FROM {users} WHERE username = ?', ['neu.user']), '500 MB');
    assert_eq(1, (int)val('SELECT must_change_pw FROM {users} WHERE username = ?', ['neu.user']));

    $c = new Client('10.7.1.1');
    $login = $c->login('neu.user', $temp);
    assert_eq(true, $login['json']['user']['must_change_pw']);
    assert_status(403, $c->get('account'), 'must_change_password');
    assert_status(200, $c->post('password', ['new' => 'mein-neues-passwort']));
    assert_status(200, $c->get('account'));
}

function test_admin_create_with_own_password_still_must_change()
{
    $admin = admin_test_client();
    $r = $admin->post('admin_user_create', ['username' => 'bob', 'display_name' => 'Bob', 'role' => 'admin', 'quota_mb' => 100, 'password' => 'eigenes-passwort-1']);
    assert_status(200, $r);
    assert_eq('eigenes-passwort-1', $r['json']['temp_password']);
    assert_eq(true, $r['json']['user']['must_change_pw']);
    assert_eq('admin', $r['json']['user']['role']);
    assert_eq(104857600, (int)val('SELECT quota_bytes FROM {users} WHERE username = ?', ['bob']));
    $c = new Client('10.7.1.2');
    $c->login('bob', 'eigenes-passwort-1');
    assert_status(403, $c->get('admin_users'), 'must_change_password');
}

function test_admin_create_validation()
{
    $admin = admin_test_client();
    make_user('anna');
    $base = ['display_name' => 'Test', 'role' => 'user', 'quota_mb' => 500];

    assert_status(409, $admin->post('admin_user_create', ['username' => ' ANNA '] + $base), 'username_taken');
    assert_status(409, $admin->post('admin_user_create', ['username' => 'anna'] + $base), 'username_taken');
    foreach (['ab', 'a b', 'äöü', str_repeat('a', 33), 'x@y.de', ''] as $bad) {
        assert_status(400, $admin->post('admin_user_create', ['username' => $bad] + $base), 'invalid_username');
    }
    assert_status(400, $admin->post('admin_user_create', ['username' => 'neu1', 'display_name' => 'Test', 'role' => 'superuser', 'quota_mb' => 500]), 'invalid');
    assert_status(400, $admin->post('admin_user_create', ['username' => 'neu2', 'display_name' => 'Test', 'role' => 'user', 'quota_mb' => 0]), 'invalid');
    assert_status(400, $admin->post('admin_user_create', ['username' => 'neu3', 'display_name' => 'Test', 'role' => 'user', 'quota_mb' => 100001]), 'invalid');
    assert_status(400, $admin->post('admin_user_create', ['username' => 'neu4', 'display_name' => 'Test', 'role' => 'user', 'quota_mb' => 'viel']), 'invalid');
    assert_status(400, $admin->post('admin_user_create', ['username' => 'neu5', 'display_name' => str_repeat('ä', 65), 'role' => 'user', 'quota_mb' => 500]), 'invalid');
    assert_status(400, $admin->post('admin_user_create', ['username' => 'neu6', 'display_name' => 'Test', 'role' => 'user', 'quota_mb' => 500, 'password' => 'kurz']), 'weak_password');
    assert_eq(0, admin_test_id('neu6'), 'nichts angelegt');

    assert_status(403, user_client('bob')->post('admin_user_create', ['username' => 'carl'] + $base), 'forbidden');
    assert_eq(0, admin_test_id('carl'));
}

function test_admin_update_fields_and_validation()
{
    $admin = admin_test_client();
    $anna = make_user('anna');

    $r = $admin->post('admin_user_update', ['id' => $anna, 'display_name' => 'Anna Neu', 'quota_mb' => 1000]);
    assert_status(200, $r);
    assert_eq('Anna Neu', $r['json']['user']['display_name']);
    assert_eq('user', $r['json']['user']['role']);
    assert_eq(1000 * 1048576, $r['json']['user']['quota_bytes']);
    assert_eq(0, $r['json']['user']['used_bytes']);
    assert_true(!isset($r['json']['user']['password_hash']), 'kein Hash in der Ausgabe');
    assert_eq(1000 * 1048576, (int)val('SELECT quota_bytes FROM {users} WHERE id = ?', [$anna]));

    // Nur übergebene Felder ändern.
    $r = $admin->post('admin_user_update', ['id' => $anna, 'role' => 'admin']);
    assert_status(200, $r);
    assert_eq('admin', $r['json']['user']['role']);
    assert_eq('Anna Neu', $r['json']['user']['display_name']);
    assert_eq(1000 * 1048576, $r['json']['user']['quota_bytes']);

    assert_status(404, $admin->post('admin_user_update', ['id' => 99999, 'display_name' => 'X']), 'not_found');
    assert_status(400, $admin->post('admin_user_update', ['display_name' => 'X']), 'invalid');
    assert_status(400, $admin->post('admin_user_update', ['id' => 0, 'display_name' => 'X']), 'invalid');
    assert_status(400, $admin->post('admin_user_update', ['id' => 'abc', 'display_name' => 'X']), 'invalid');
    assert_status(400, $admin->post('admin_user_update', ['id' => $anna, 'display_name' => '   ']), 'invalid');
    assert_status(400, $admin->post('admin_user_update', ['id' => $anna, 'role' => 'boss']), 'invalid');
    assert_status(400, $admin->post('admin_user_update', ['id' => $anna, 'quota_mb' => 0]), 'invalid');
}

function test_admin_update_last_admin_protection()
{
    $admin = admin_test_client();
    $chef = admin_test_id(T_ADMIN_USER);
    assert_status(409, $admin->post('admin_user_update', ['id' => $chef, 'role' => 'user']), 'last_admin');
    assert_eq('admin', val('SELECT role FROM {users} WHERE id = ?', [$chef]), 'unverändert');

    $anna = make_user('anna', 'passwort-1234', 'admin');
    assert_status(200, $admin->post('admin_user_update', ['id' => $chef, 'role' => 'user']));
    assert_status(403, $admin->get('admin_users'), 'forbidden');

    // Anna ist jetzt der letzte aktive Admin.
    $a = new Client('10.7.2.1');
    $a->login('anna', 'passwort-1234');
    assert_status(409, $a->post('admin_user_update', ['id' => $anna, 'role' => 'user']), 'last_admin');
    assert_status(409, $a->post('admin_user_lock', ['id' => $anna, 'locked' => true]), 'self');
    assert_status(200, $a->post('admin_user_update', ['id' => $chef, 'role' => 'admin']));
}

function test_admin_last_admin_guard_direct()
{
    // Protection in the handlers, even if the calling admin is not in the database.
    $chef = admin_test_id(T_ADMIN_USER);
    $ghost = ['id' => 9999, 'role' => 'admin', 'username' => 'geist'];
    assert_eq('last_admin', admin_test_direct('route_admin_user_lock', $ghost, ['id' => $chef, 'locked' => true]));
    assert_eq('last_admin', admin_test_direct('route_admin_user_delete', $ghost, ['id' => $chef, 'confirm_username' => T_ADMIN_USER]));
    assert_eq('last_admin', admin_test_direct('route_admin_user_update', $ghost, ['id' => $chef, 'role' => 'user']));
    $row = one('SELECT role, status FROM {users} WHERE id = ?', [$chef]);
    assert_eq('admin', $row['role'], 'unverändert');
    assert_eq('active', $row['status'], 'unverändert');
}

function test_admin_reset_password()
{
    $admin = admin_test_client();
    $anna = user_client('anna');
    $annaId = admin_test_id('anna');
    assert_status(404, $admin->post('admin_user_reset', ['id' => 99999]), 'not_found');

    $r = $admin->post('admin_user_reset', ['id' => $annaId]);
    assert_status(200, $r);
    $temp = $r['json']['temp_password'];
    assert_true(strlen($temp) >= 10, 'Einmal-Passwort');
    assert_eq(1, (int)val('SELECT must_change_pw FROM {users} WHERE id = ?', [$annaId]));

    assert_status(401, $anna->get('me'));
    assert_status(401, (new Client('10.7.3.1'))->post('login', ['username' => 'anna', 'password' => 'passwort-1234']), 'bad_credentials');
    $n = new Client('10.7.3.2');
    $n->login('anna', $temp);
    assert_status(403, $n->get('account'), 'must_change_password');

    // Der Admin setzt sein eigenes Passwort zurück: erlaubt, seine Sitzung endet ebenfalls.
    $r2 = $admin->post('admin_user_reset', ['id' => admin_test_id(T_ADMIN_USER)]);
    assert_status(200, $r2);
    assert_status(401, $admin->get('me'));
    $admin2 = new Client('10.7.3.3');
    $admin2->login(T_ADMIN_USER, $r2['json']['temp_password']);
    assert_status(403, $admin2->get('admin_users'), 'must_change_password');
}

function test_admin_lock_and_unlock()
{
    $admin = admin_test_client();
    $anna = user_client('anna');
    $anna2 = new Client('10.7.4.1');
    $anna2->login('anna', 'passwort-1234');
    $id = admin_test_id('anna');

    assert_status(400, $admin->post('admin_user_lock', ['id' => $id, 'locked' => 'ja']), 'invalid');
    assert_status(400, $admin->post('admin_user_lock', ['id' => $id]), 'invalid');
    assert_status(409, $admin->post('admin_user_lock', ['id' => admin_test_id(T_ADMIN_USER), 'locked' => true]), 'self');
    assert_status(404, $admin->post('admin_user_lock', ['id' => 99999, 'locked' => true]), 'not_found');

    $r = $admin->post('admin_user_lock', ['id' => $id, 'locked' => true]);
    assert_status(200, $r);
    assert_eq('locked', $r['json']['user']['status']);
    assert_status(401, $anna->get('me'));
    assert_status(401, $anna2->get('me'));
    assert_status(403, (new Client('10.7.4.2'))->post('login', ['username' => 'anna', 'password' => 'passwort-1234']), 'locked');
    assert_eq(0, admin_test_sessions($id));

    $list = $admin->get('admin_users');
    assert_eq('locked', $list['json']['users'][0]['status']);

    $r = $admin->post('admin_user_lock', ['id' => $id, 'locked' => false]);
    assert_status(200, $r);
    assert_eq('active', $r['json']['user']['status']);
    (new Client('10.7.4.3'))->login('anna', 'passwort-1234');
}

function test_admin_logout_all_sessions()
{
    $admin = admin_test_client();
    $anna = user_client('anna');
    $b = new Client('10.7.5.1');
    $b->login('anna', 'passwort-1234');
    $id = admin_test_id('anna');
    assert_eq(2, admin_test_sessions($id));

    $r = $admin->post('admin_user_logout', ['id' => $id]);
    assert_status(200, $r);
    assert_eq(true, $r['json']['ok']);
    assert_status(401, $anna->get('me'));
    assert_status(401, $b->get('me'));
    assert_eq(0, admin_test_sessions($id));
    assert_status(404, $admin->post('admin_user_logout', ['id' => 99999]), 'not_found');
}

function test_admin_delete()
{
    $admin = admin_test_client();
    $anna = make_user('anna');
    admin_test_note($anna);
    admin_test_note($anna);
    $c = new Client('10.7.6.1');
    $c->login('anna', 'passwort-1234');
    $chef = admin_test_id(T_ADMIN_USER);

    assert_status(400, $admin->post('admin_user_delete', ['id' => $anna, 'confirm_username' => 'Anna']), 'confirm_mismatch');
    assert_status(400, $admin->post('admin_user_delete', ['id' => $anna]), 'confirm_mismatch');
    assert_status(409, $admin->post('admin_user_delete', ['id' => $chef, 'confirm_username' => T_ADMIN_USER]), 'self');
    assert_status(404, $admin->post('admin_user_delete', ['id' => 99999, 'confirm_username' => 'anna']), 'not_found');
    assert_status(400, $admin->post('admin_user_delete', ['id' => 'abc', 'confirm_username' => 'anna']), 'invalid');
    assert_eq(1, admin_test_sessions($anna), 'nichts gelöscht');

    $r = $admin->post('admin_user_delete', ['id' => $anna, 'confirm_username' => 'anna']);
    assert_status(200, $r);
    assert_eq(true, $r['json']['ok']);
    assert_status(401, $c->get('me'));
    assert_status(401, (new Client('10.7.6.2'))->post('login', ['username' => 'anna', 'password' => 'passwort-1234']), 'bad_credentials');
    assert_eq(0, (int)val('SELECT COUNT(*) FROM {users} WHERE id = ?', [$anna]), 'Konto weg');
    assert_eq(0, (int)val('SELECT COUNT(*) FROM {notes} WHERE user_id = ?', [$anna]), 'Notizen weg');
    assert_eq(0, admin_test_sessions($anna), 'Sitzungen weg');
}

function test_admin_log_entries_and_paging()
{
    $admin = admin_test_client();
    $adminId = admin_test_id(T_ADMIN_USER);
    make_user('bob');
    assert_status(200, $admin->post('admin_user_create', ['username' => 'carl', 'display_name' => 'Carl', 'role' => 'user', 'quota_mb' => 100]));
    $carl = admin_test_id('carl');
    assert_status(200, $admin->post('admin_user_update', ['id' => $carl, 'display_name' => 'Robert']));
    assert_status(200, $admin->post('admin_user_reset', ['id' => $carl]));
    assert_status(200, $admin->post('admin_user_lock', ['id' => $carl, 'locked' => true]));
    assert_status(200, $admin->post('admin_user_lock', ['id' => $carl, 'locked' => false]));
    assert_status(200, $admin->post('admin_user_logout', ['id' => $carl]));
    assert_status(200, $admin->post('admin_user_delete', ['id' => $carl, 'confirm_username' => 'carl']));

    $r = $admin->get('admin_log');
    assert_status(200, $r);
    $entries = $r['json']['entries'];
    assert_eq(
        ['delete_user', 'logout_user', 'unlock_user', 'lock_user', 'reset_password', 'update_user', 'create_user'],
        array_column($entries, 'action'),
        'neueste zuerst'
    );

    $create = $entries[6];
    assert_eq($adminId, $create['admin_id']);
    assert_eq(T_ADMIN_USER, $create['admin_username']);
    assert_eq($carl, $create['target_user_id']);
    assert_eq(null, $create['target_username'], 'carl wurde später gelöscht → null');
    assert_eq('username=carl, role=user', $create['details']);
    assert_true($create['at'] > 0, 'Zeitstempel');

    assert_eq('display_name=Robert', $entries[5]['details']);
    assert_eq('username=carl', $entries[4]['details']);

    $del = $entries[0];
    assert_eq($carl, $del['target_user_id'], 'Ziel-ID bleibt');
    assert_eq(null, $del['target_username'], 'gelöschter Benutzer → null');
    assert_eq('username=carl', $del['details']);
    assert_eq(T_ADMIN_USER, $del['admin_username']);

    // Paginierung über before.
    $p1 = $admin->get('admin_log', ['limit' => 2]);
    assert_status(200, $p1);
    assert_eq(2, count($p1['json']['entries']));
    assert_eq(['delete_user', 'logout_user'], array_column($p1['json']['entries'], 'action'));
    $lastId = $p1['json']['entries'][1]['id'];
    $p2 = $admin->get('admin_log', ['limit' => 2, 'before' => $lastId]);
    assert_status(200, $p2);
    assert_eq(['unlock_user', 'lock_user'], array_column($p2['json']['entries'], 'action'));
    foreach ($p2['json']['entries'] as $e) assert_true($e['id'] < $lastId, 'nur ältere Einträge');
    $p4 = $admin->get('admin_log', ['limit' => 2, 'before' => $p2['json']['entries'][1]['id']]);
    $p5 = $admin->get('admin_log', ['limit' => 2, 'before' => $p4['json']['entries'][1]['id']]);
    assert_eq(['create_user'], array_column($p5['json']['entries'], 'action'), 'letzte Seite');

    // Limit: Standard 50, Obergrenze 200.
    assert_eq(7, count($admin->get('admin_log')['json']['entries']));
    assert_status(200, $admin->get('admin_log', ['limit' => 500]));
    assert_status(400, $admin->get('admin_log', ['limit' => 0]), 'invalid');
    assert_status(400, $admin->get('admin_log', ['limit' => 'viele']), 'invalid');
    assert_status(400, $admin->get('admin_log', ['before' => 'abc']), 'invalid');
}

function test_admin_routes_forbidden_for_users()
{
    make_user('chef2', 'passwort-1234', 'admin', ['must_change_pw' => 1]);
    $u = user_client('anna');
    $id = admin_test_id('anna');
    $body = ['id' => $id, 'username' => 'x', 'display_name' => 'x', 'role' => 'user', 'quota_mb' => 10, 'locked' => true, 'confirm_username' => 'anna'];
    $routes = [
        ['GET', 'admin_users', []],
        ['POST', 'admin_user_create', $body],
        ['POST', 'admin_user_update', $body],
        ['POST', 'admin_user_reset', $body],
        ['POST', 'admin_user_lock', $body],
        ['POST', 'admin_user_logout', $body],
        ['POST', 'admin_user_delete', $body],
        ['GET', 'admin_log', []],
    ];
    foreach ($routes as [$method, $route, $b]) {
        $res = $method === 'GET' ? $u->get($route) : $u->post($route, $b);
        assert_status(403, $res, 'forbidden');
    }
    assert_eq(1, (int)val('SELECT COUNT(*) FROM {users} WHERE id = ?', [$id]), 'nichts verändert');
    assert_eq('user', val('SELECT role FROM {users} WHERE id = ?', [$id]));

    // Ohne Anmeldung 401, mit Einmal-Passwort 403 must_change_password.
    assert_status(401, (new Client('10.7.7.1'))->get('admin_users'), 'unauthenticated');
    assert_status(401, (new Client('10.7.7.2'))->post('admin_user_reset', ['id' => $id]), 'unauthenticated');
    $pending = new Client('10.7.7.3');
    $pending->login('chef2', 'passwort-1234');
    assert_status(403, $pending->get('admin_users'), 'must_change_password');
    assert_status(403, $pending->post('admin_user_reset', ['id' => $id]), 'must_change_password');
}
