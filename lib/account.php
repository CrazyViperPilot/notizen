<?php
// Own account: password, logout everywhere, account info.

function route_password($u)
{
    $new = field('new');
    $problem = password_problem($new);
    if ($problem) fail(400, 'weak_password', $problem);
    if (!$u['must_change_pw']) {
        $old = field('old', '');
        if (!is_string($old) || !password_verify($old, $u['password_hash'])) fail(403, 'bad_password', 'Das bisherige Passwort stimmt nicht.');
    }
    if (password_verify($new, $u['password_hash'])) fail(400, 'same_password', 'Bitte ein neues Passwort wählen.');
    tx(function () use ($u, $new) {
        q('UPDATE {users} SET password_hash = ?, must_change_pw = 0 WHERE id = ?', [hash_password($new), $u['id']]);
        end_sessions_for($u['id'], $u['_sid']);
    });
    $u['must_change_pw'] = 0;
    return ['user' => user_public($u)];
}

function route_logout_all($u)
{
    end_sessions_for($u['id']);
    set_cookie(NZ_COOKIE, '', 0);
    return [];
}

function route_account($u)
{
    return [
        'user' => user_public($u),
        'used_bytes' => (int)$u['used_bytes'],
        'quota_bytes' => (int)$u['quota_bytes'],
        'admins_can_read' => true,
    ];
}

route('password', 'POST', 'route_password', 'user_any');
route('logout_all', 'POST', 'route_logout_all', 'user');
route('account', 'GET', 'route_account', 'user');
