<?php
// Tests: Ping, Erst-Admin, Login, Bremse, Sitzung, CSRF, Passwort, Sperre.

function test_ping()
{
    $r = (new Client())->get('ping');
    assert_status(200, $r);
    assert_eq(1, $r['json']['schema']);
}

function test_unknown_route_and_method()
{
    $c = new Client();
    assert_status(404, $c->get('gibtsnicht'), 'not_found');
    assert_status(405, $c->get('login'), 'method_not_allowed');
}

function test_bootstrap_admin_and_login()
{
    $c = new Client();
    $r = $c->login(T_ADMIN_USER, T_ADMIN_PASS);
    assert_eq('admin', $r['json']['user']['role']);
    assert_true(strlen($c->csrf) >= 40, 'csrf');
    assert_true(isset($c->cookies[NZ_COOKIE]), 'cookie gesetzt');
    $me = $c->get('me');
    assert_status(200, $me);
    assert_eq(T_ADMIN_USER, $me['json']['user']['username']);
    assert_eq($c->csrf, $me['json']['csrf']);
}

function test_admin_secret_change_resets_password_and_sessions()
{
    $c = new Client();
    $c->login(T_ADMIN_USER, T_ADMIN_PASS);
    // Admin changes own password in the app; same secret → no reset on next requests.
    assert_status(200, $c->post('password', ['old' => T_ADMIN_PASS, 'new' => 'mein-eigenes-pw-1']));
    set_config(test_config());           // same secret, new bcrypt salt
    ensure_schema();
    (new Client())->login(T_ADMIN_USER, 'mein-eigenes-pw-1');
    // Secret changed → password reset, all sessions ended.
    set_config(test_config('neues-secret-pw-99'));
    ensure_schema();
    assert_status(401, $c->get('me'), 'unauthenticated');
    $r = (new Client('10.9.9.9'))->post('login', ['username' => T_ADMIN_USER, 'password' => 'mein-eigenes-pw-1']);
    assert_status(401, $r, 'bad_credentials');
    (new Client())->login(T_ADMIN_USER, 'neues-secret-pw-99');
}

function test_login_wrong_and_unknown_same_answer()
{
    make_user('anna');
    $a = (new Client())->post('login', ['username' => 'anna', 'password' => 'falsch-falsch']);
    $b = (new Client())->post('login', ['username' => 'niemand', 'password' => 'falsch-falsch']);
    assert_status(401, $a, 'bad_credentials');
    assert_status(401, $b, 'bad_credentials');
    assert_eq($a['json'], $b['json']);
}

function test_login_case_insensitive_username()
{
    make_user('anna');
    (new Client())->login('Anna', 'passwort-1234');
}

function test_login_throttle_per_user()
{
    make_user('anna');
    for ($i = 0; $i < 5; $i++) {
        assert_status(401, (new Client('10.2.0.' . $i))->post('login', ['username' => 'anna', 'password' => 'falsch' . $i]));
    }
    // Even the right password is refused now, from any IP.
    assert_status(429, (new Client('10.3.0.1'))->post('login', ['username' => 'anna', 'password' => 'passwort-1234']), 'too_many_attempts');
    $GLOBALS['NZ_NOW'] = now_ms() + 16 * 60 * 1000;
    (new Client('10.3.0.1'))->login('anna', 'passwort-1234');
}

function test_login_throttle_per_ip()
{
    make_user('anna');
    $c = new Client('10.4.0.1');
    for ($i = 0; $i < 20; $i++) $c->post('login', ['username' => 'u' . $i, 'password' => 'x']);
    assert_status(429, $c->post('login', ['username' => 'anna', 'password' => 'passwort-1234']), 'too_many_attempts');
}

function test_locked_user_cannot_login_and_session_ends()
{
    $id = make_user('anna');
    $c = new Client();
    $c->login('anna', 'passwort-1234');
    q("UPDATE {users} SET status = 'locked' WHERE id = ?", [$id]);
    assert_status(401, $c->get('me'), 'unauthenticated');
    assert_status(403, (new Client())->post('login', ['username' => 'anna', 'password' => 'passwort-1234']), 'locked');
}

function test_csrf_required_for_post()
{
    $c = user_client('anna');
    $csrf = $c->csrf;
    $c->csrf = '';
    assert_status(403, $c->post('logout_all'), 'bad_csrf');
    assert_status(403, $c->post('logout_all', [], ['X-CSRF-Token' => 'falsch']), 'bad_csrf');
    $c->csrf = $csrf;
    assert_status(200, $c->get('me'));
}

function test_foreign_origin_rejected()
{
    $c = user_client('anna');
    $c->origin = 'https://boese.example';
    assert_status(403, $c->post('logout_all'), 'bad_origin');
    $c->origin = 'http://localhost';
    assert_status(200, $c->post('logout_all'));
}

function test_session_expires_and_slides()
{
    $c = user_client('anna');
    $start = now_ms();
    $GLOBALS['NZ_NOW'] = $start + 50 * 86400000;  // day 50: still valid, gets extended
    assert_status(200, $c->get('me'));
    $GLOBALS['NZ_NOW'] = $start + 100 * 86400000; // day 100: 50 days after last use
    assert_status(200, $c->get('me'));
    $GLOBALS['NZ_NOW'] = $start + 161 * 86400000; // 61 days idle
    assert_status(401, $c->get('me'), 'unauthenticated');
}

function test_logout()
{
    $c = user_client('anna');
    assert_status(200, $c->post('logout'));
    assert_true(!isset($c->cookies[NZ_COOKIE]), 'Cookie gelöscht');
    assert_status(401, $c->get('me'));
}

function test_must_change_password_flow()
{
    make_user('neu', 'abcd-efgh-jkmn', 'user', ['must_change_pw' => 1]);
    $c = new Client();
    $r = $c->login('neu', 'abcd-efgh-jkmn');
    assert_eq(true, $r['json']['user']['must_change_pw']);
    assert_status(200, $c->get('me'));
    assert_status(403, $c->get('account'), 'must_change_password');
    assert_status(400, $c->post('password', ['new' => 'kurz']), 'weak_password');
    assert_status(200, $c->post('password', ['new' => 'mein-neues-passwort']));
    assert_status(200, $c->get('account'));
}

function test_password_change_requires_old_and_ends_other_sessions()
{
    $a = user_client('anna');
    $b = new Client('10.5.0.1');
    $b->login('anna', 'passwort-1234');
    assert_status(403, $a->post('password', ['old' => 'falsch', 'new' => 'neues-passwort-1']), 'bad_password');
    assert_status(400, $a->post('password', ['old' => 'passwort-1234', 'new' => 'passwort-1234']), 'same_password');
    assert_status(200, $a->post('password', ['old' => 'passwort-1234', 'new' => 'neues-passwort-1']));
    assert_status(200, $a->get('me'));
    assert_status(401, $b->get('me'));
}

function test_logout_all()
{
    $a = user_client('anna');
    $b = new Client('10.5.0.2');
    $b->login('anna', 'passwort-1234');
    assert_status(200, $a->post('logout_all'));
    assert_status(401, $a->get('me'));
    assert_status(401, $b->get('me'));
}

function test_account_info()
{
    $c = user_client('anna');
    $r = $c->get('account');
    assert_status(200, $r);
    assert_eq(true, $r['json']['admins_can_read']);
    assert_eq(524288000, $r['json']['quota_bytes']);
    assert_eq(0, $r['json']['used_bytes']);
    assert_true(!isset($r['json']['user']['password_hash']), 'kein Hash in der Ausgabe');
}

function test_admin_route_guard()
{
    route('t_admin_only', 'GET', function ($u) { return ['who' => $u['username']]; }, 'admin');
    assert_status(403, user_client('anna')->get('t_admin_only'), 'forbidden');
    $c = new Client();
    $c->login(T_ADMIN_USER, T_ADMIN_PASS);
    assert_status(200, $c->get('t_admin_only'));
    assert_status(401, (new Client())->get('t_admin_only'), 'unauthenticated');
}

function test_bad_json_body()
{
    $c = user_client('anna');
    set_request(['method' => 'POST', 'query' => ['r' => 'password'], 'body' => '{kaputt', 'headers' => ['Host' => 'localhost', 'X-CSRF-Token' => $c->csrf], 'cookies' => $c->cookies]);
    list($status, $json) = dispatch();
    assert_eq(400, $status);
    assert_eq('bad_json', $json['error']['code']);
}
