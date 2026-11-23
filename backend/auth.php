<?php
if (!defined('NZ_ENTRY')) { http_response_code(403); exit; }
// Passwords, sessions, CSRF, login throttling + routes login, logout, me.

const NZ_COOKIE = 'notizen_sid';
const NZ_SESSION_MS = 5184000000;      // 60 days
const NZ_TOUCH_MS = 3600000;           // refresh last_seen/expires at most hourly
const NZ_THROTTLE_MS = 900000;         // 15 min window
const NZ_MAX_FAIL_USER = 5;
const NZ_MAX_FAIL_IP = 20;
const NZ_DUMMY_HASH = '$2y$10$zpupe91n4Xthnxyq2GmKjuWHtzz7BJgBgnSasU1U/Ogjg1SQEOksS';

function hash_password($p)
{
    return password_hash($p, PASSWORD_DEFAULT);
}

function validate_username($u)
{
    return is_string($u) && preg_match('/^[a-z0-9._-]{3,32}$/', $u) === 1;
}

/** Returns an error message or null. */
function password_problem($p)
{
    if (!is_string($p)) return 'Passwort fehlt.';
    $n = mb_strlen($p, 'UTF-8');
    if ($n < 10) return 'Das Passwort muss mindestens 10 Zeichen haben.';
    if ($n > 200) return 'Das Passwort ist zu lang.';
    return null;
}

/** One-time password like "k7mp-x3ra-q9tz" (no ambiguous characters). */
function gen_temp_password()
{
    $alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    $parts = [];
    for ($p = 0; $p < 3; $p++) {
        $s = '';
        for ($i = 0; $i < 4; $i++) $s .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        $parts[] = $s;
    }
    return implode('-', $parts);
}

function user_public(array $u)
{
    return [
        'id' => (int)$u['id'],
        'username' => $u['username'],
        'display_name' => $u['display_name'],
        'role' => $u['role'],
        'status' => $u['status'],
        'must_change_pw' => (bool)$u['must_change_pw'],
        'created_at' => (int)$u['created_at'],
        'last_login_at' => $u['last_login_at'] === null ? null : (int)$u['last_login_at'],
    ];
}

/** Logged-in, active user row (+ '_sid' hash, '_csrf') or null. Cached per request. */
function current_user()
{
    if ($GLOBALS['NZ_USER'] !== false) return $GLOBALS['NZ_USER'];
    $GLOBALS['NZ_USER'] = null;
    $sid = cookie_in(NZ_COOKIE);
    if ($sid === '' || strlen($sid) > 100) return null;
    $hash = hash('sha256', $sid);
    $now = now_ms();
    $row = one("SELECT u.*, s.id_hash AS _sid, s.csrf AS _csrf, s.last_seen_at AS _seen
                FROM {sessions} s JOIN {users} u ON u.id = s.user_id
                WHERE s.id_hash = ? AND s.expires_at > ? AND u.status = 'active'", [$hash, $now]);
    if (!$row) return null;
    if ($now - (int)$row['_seen'] > NZ_TOUCH_MS) {
        q('UPDATE {sessions} SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?', [$now, $now + NZ_SESSION_MS, $hash]);
        set_cookie(NZ_COOKIE, $sid, (int)(NZ_SESSION_MS / 1000));
    }
    unset($row['_seen']);
    return $GLOBALS['NZ_USER'] = $row;
}

/** 401 without session; 403 must_change_password unless $allowMustChange. */
function require_user($allowMustChange = false)
{
    $u = current_user();
    if (!$u) fail(401, 'unauthenticated', 'Bitte anmelden.');
    if (!$allowMustChange && $u['must_change_pw']) fail(403, 'must_change_password', 'Bitte zuerst ein eigenes Passwort setzen.');
    return $u;
}

function require_admin()
{
    $u = require_user();
    if ($u['role'] !== 'admin') fail(403, 'forbidden', 'Nur für Admins.');
    return $u;
}

/** Same-origin check + X-CSRF-Token matching the session. Called by dispatch() for every POST except login. */
function require_csrf()
{
    $origin = header_in('Origin');
    if ($origin !== '' && $origin !== 'null') {
        $host = parse_url($origin, PHP_URL_HOST);
        $port = parse_url($origin, PHP_URL_PORT);
        $o = strtolower($host . ($port ? ':' . $port : ''));
        if ($o !== strtolower(header_in('Host'))) fail(403, 'bad_origin', 'Ungültige Herkunft der Anfrage.');
    }
    $u = current_user();
    if (!$u) return; // require_user() reports 401 afterwards
    $t = header_in('X-CSRF-Token');
    if ($t === '' || !hash_equals($u['_csrf'], $t)) fail(403, 'bad_csrf', 'Sitzung abgelaufen, bitte neu laden.');
}

/** New session for $userId; sets the cookie and returns the CSRF token. */
function create_session($userId)
{
    $sid = random_token(32);
    $csrf = random_token(32);
    $now = now_ms();
    q('INSERT INTO {sessions} (id_hash, user_id, csrf, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [hash('sha256', $sid), (int)$userId, $csrf, $now, $now, $now + NZ_SESSION_MS, mb_substr(header_in('User-Agent'), 0, 200, 'UTF-8')]);
    set_cookie(NZ_COOKIE, $sid, (int)(NZ_SESSION_MS / 1000));
    return $csrf;
}

/** Ends all sessions of a user, optionally except one (by id_hash). */
function end_sessions_for($userId, $exceptHash = null)
{
    if ($exceptHash === null) q('DELETE FROM {sessions} WHERE user_id = ?', [(int)$userId]);
    else q('DELETE FROM {sessions} WHERE user_id = ? AND id_hash <> ?', [(int)$userId, $exceptHash]);
}

function throttled($username, $ip)
{
    $since = now_ms() - NZ_THROTTLE_MS;
    $byUser = (int)val('SELECT COUNT(*) FROM {login_attempts} WHERE username = ? AND at > ?', [$username, $since]);
    if ($byUser >= NZ_MAX_FAIL_USER) return true;
    $byIp = (int)val('SELECT COUNT(*) FROM {login_attempts} WHERE ip = ? AND at > ?', [$ip, $since]);
    return $byIp >= NZ_MAX_FAIL_IP;
}

function route_login()
{
    $username = strtolower(trim((string)field('username', '')));
    $password = field('password', '');
    if (!is_string($password)) $password = '';
    $username = mb_substr($username, 0, 64, 'UTF-8');
    $ip = client_ip();

    if (mt_rand(1, 50) === 1) q('DELETE FROM {login_attempts} WHERE at < ?', [now_ms() - 86400000]);
    if (throttled($username, $ip)) fail(429, 'too_many_attempts', 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.');

    $u = validate_username($username) ? one('SELECT * FROM {users} WHERE username = ?', [$username]) : null;
    $ok = password_verify($password, $u ? $u['password_hash'] : NZ_DUMMY_HASH);
    if (!$u || !$ok) {
        q('INSERT INTO {login_attempts} (username, ip, at) VALUES (?, ?, ?)', [$username, $ip, now_ms()]);
        fail(401, 'bad_credentials', 'Benutzername oder Passwort falsch.');
    }
    if ($u['status'] !== 'active') fail(403, 'locked', 'Dieses Konto ist gesperrt.');

    if (password_needs_rehash($u['password_hash'], PASSWORD_DEFAULT)) {
        q('UPDATE {users} SET password_hash = ? WHERE id = ?', [hash_password($password), $u['id']]);
    }
    q('DELETE FROM {login_attempts} WHERE username = ?', [$username]);
    q('UPDATE {users} SET last_login_at = ? WHERE id = ?', [now_ms(), $u['id']]);
    $csrf = create_session($u['id']);
    $u['last_login_at'] = now_ms();
    return ['user' => user_public($u), 'csrf' => $csrf];
}

function route_logout($u)
{
    q('DELETE FROM {sessions} WHERE id_hash = ?', [$u['_sid']]);
    set_cookie(NZ_COOKIE, '', 0);
    return [];
}

function route_me($u)
{
    return ['user' => user_public($u), 'csrf' => $u['_csrf']];
}

route('login', 'POST', 'route_login', 'none');
route('logout', 'POST', 'route_logout', 'user_any');
route('me', 'GET', 'route_me', 'user_any');
