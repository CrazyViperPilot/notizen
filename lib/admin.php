<?php
// Admin API: user list, create/update/reset/lock/logout/delete users, admin protocol.
// Protection rules: the last active admin cannot be locked, deleted or demoted; an admin cannot lock or delete himself.
// Mutations run in tx(). Admin rows are locked first (ORDER BY id, FOR UPDATE), then the target row, so that
// parallel requests cannot both pass the last-admin check.

const NZ_ADMIN_MAX_QUOTA_MB = 100000;
const NZ_ADMIN_MB = 1048576;

/** Whole number (int or digit string) within [$min, $max], otherwise fail(400, 'invalid', $message). */
function admin_int($v, $min, $max, $message)
{
    if (is_string($v) && preg_match('/^[0-9]{1,15}$/', $v) === 1) $v = (int)$v;
    if (!is_int($v) || $v < $min || $v > $max) fail(400, 'invalid', $message);
    return $v;
}

/** Target user id from the JSON body (id > 0). */
function admin_id_param()
{
    return admin_int(field('id'), 1, 4294967295, 'Ungültige Benutzer-ID.');
}

function admin_role($v)
{
    if ($v !== 'user' && $v !== 'admin') fail(400, 'invalid', 'Ungültige Rolle.');
    return $v;
}

/** Locks all admin rows (in id order) and returns them. Call first in every mutation that can change admin status. */
function admin_lock_admins()
{
    return all("SELECT id, role, status FROM {users} WHERE role = 'admin' ORDER BY id FOR UPDATE");
}

/** Number of active admins from $admins (locked rows) except $exceptId. */
function admin_other_active_admins(array $admins, $exceptId)
{
    $n = 0;
    foreach ($admins as $a) {
        if ($a['status'] === 'active' && (int)$a['id'] !== (int)$exceptId) $n++;
    }
    return $n;
}

/** Locks the target user row; 404 if it does not exist. */
function admin_target($id)
{
    $t = one('SELECT * FROM {users} WHERE id = ? FOR UPDATE', [$id]);
    if ($t === null) fail(404, 'not_found', 'Benutzer nicht gefunden.');
    return $t;
}

/** user_public plus the storage numbers. */
function admin_user_out(array $u)
{
    return user_public($u) + [
        'quota_bytes' => (int)$u['quota_bytes'],
        'used_bytes' => (int)$u['used_bytes'],
    ];
}

function route_admin_users($admin)
{
    $rows = all('SELECT u.*,
            (SELECT COUNT(*) FROM {notes} n WHERE n.user_id = u.id AND n.deleted_at IS NULL AND n.purged = 0) AS notes_count,
            (SELECT COUNT(*) FROM {sessions} s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions_count
         FROM {users} u
         ORDER BY u.username', [now_ms()]);
    $users = [];
    foreach ($rows as $r) {
        $users[] = admin_user_out($r) + [
            'notes_count' => (int)$r['notes_count'],
            'sessions_count' => (int)$r['sessions_count'],
        ];
    }
    return ['users' => $users];
}

function route_admin_user_create($admin)
{
    $username = field('username', '');
    $username = is_string($username) ? strtolower(trim($username)) : '';
    if (!validate_username($username)) {
        fail(400, 'invalid_username', 'Der Benutzername muss 3 bis 32 Zeichen lang sein und darf nur a–z, 0–9, Punkt, Bindestrich und Unterstrich enthalten.');
    }
    $displayName = clean_text(field('display_name', ''), 64, 'Anzeigename', true);
    if ($displayName === '') $displayName = $username;
    $role = admin_role(field('role'));
    $quotaValue = field('quota_mb');
    $quotaMb = $quotaValue === null
        ? 500
        : admin_int($quotaValue, 1, NZ_ADMIN_MAX_QUOTA_MB, 'Das Speicherlimit muss eine ganze Zahl von 1 bis 100000 MB sein.');

    $password = field('password', null);
    if ($password !== null && $password !== '') {
        $problem = password_problem($password);
        if ($problem !== null) fail(400, 'weak_password', $problem);
    } else {
        $password = gen_temp_password();
    }
    $hash = hash_password($password);
    $quotaBytes = $quotaMb * NZ_ADMIN_MB;
    $now = now_ms();

    try {
        $newId = tx(function () use ($admin, $username, $displayName, $role, $hash, $quotaBytes, $now) {
            if (one('SELECT id FROM {users} WHERE username = ?', [$username]) !== null) {
                fail(409, 'username_taken', 'Dieser Benutzername ist schon vergeben.');
            }
            q("INSERT INTO {users} (username, display_name, password_hash, role, status, must_change_pw, quota_bytes, created_at)
               VALUES (?, ?, ?, ?, 'active', 1, ?, ?)", [$username, $displayName, $hash, $role, $quotaBytes, $now]);
            $id = (int)db()->lastInsertId();
            admin_log($admin['id'], 'create_user', $id, 'username=' . $username . ', role=' . $role);
            return $id;
        });
    } catch (PDOException $e) {
        // Concurrent insert of the same name (UNIQUE key, SQLSTATE 23000).
        if ($e->getCode() === '23000') fail(409, 'username_taken', 'Dieser Benutzername ist schon vergeben.');
        throw $e;
    }

    return [
        'user' => user_public([
            'id' => $newId, 'username' => $username, 'display_name' => $displayName, 'role' => $role,
            'status' => 'active', 'must_change_pw' => 1, 'created_at' => $now, 'last_login_at' => null,
        ]),
        'temp_password' => $password,
    ];
}

function route_admin_user_update($admin)
{
    $id = admin_id_param();
    $body = body();
    return tx(function () use ($admin, $id, $body) {
        $admins = admin_lock_admins();
        $t = admin_target($id);
        $new = $t;
        $sets = [];
        $params = [];
        $changes = [];

        if (array_key_exists('display_name', $body)) {
            $name = clean_text($body['display_name'], 64, 'Anzeigename');
            if ($name !== $t['display_name']) {
                $sets[] = 'display_name = ?';
                $params[] = $name;
                $changes[] = 'display_name=' . $name;
                $new['display_name'] = $name;
            }
        }

        if (array_key_exists('role', $body)) {
            $role = admin_role($body['role']);
            if ($role !== $t['role']) {
                // Demotion admin -> user needs another active admin afterwards.
                if ($t['role'] === 'admin' && admin_other_active_admins($admins, $id) === 0) {
                    fail(409, 'last_admin', 'Es muss mindestens ein anderer aktiver Admin bleiben.');
                }
                $sets[] = 'role = ?';
                $params[] = $role;
                $changes[] = 'role=' . $role;
                $new['role'] = $role;
            }
        }

        if (array_key_exists('quota_mb', $body)) {
            $mb = admin_int($body['quota_mb'], 1, NZ_ADMIN_MAX_QUOTA_MB, 'Das Speicherlimit muss eine ganze Zahl von 1 bis 100000 MB sein.');
            $bytes = $mb * NZ_ADMIN_MB;
            if ($bytes !== (int)$t['quota_bytes']) {
                $sets[] = 'quota_bytes = ?';
                $params[] = $bytes;
                $changes[] = 'quota_mb=' . $mb;
                $new['quota_bytes'] = $bytes;
            }
        }

        if ($sets) {
            $params[] = $id;
            q('UPDATE {users} SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
            admin_log($admin['id'], 'update_user', $id, implode(', ', $changes));
        }
        return ['user' => admin_user_out($new)];
    });
}

function route_admin_user_reset($admin)
{
    $id = admin_id_param();
    $temp = tx(function () use ($admin, $id) {
        $t = admin_target($id);
        $password = gen_temp_password();
        q('UPDATE {users} SET password_hash = ?, must_change_pw = 1 WHERE id = ?', [hash_password($password), $id]);
        end_sessions_for($id);
        admin_log($admin['id'], 'reset_password', $id, 'username=' . $t['username']);
        return $password;
    });
    if ($id === (int)$admin['id']) set_cookie(NZ_COOKIE, '', 0);
    return ['temp_password' => $temp];
}

function route_admin_user_lock($admin)
{
    $id = admin_id_param();
    $locked = field('locked');
    if (!is_bool($locked)) fail(400, 'invalid', 'Die Angabe „locked“ fehlt oder ist kein Wahrheitswert.');
    if ($locked && $id === (int)$admin['id']) fail(409, 'self', 'Du kannst dich nicht selbst sperren.');

    return tx(function () use ($admin, $id, $locked) {
        $admins = admin_lock_admins();
        $t = admin_target($id);
        $newStatus = $locked ? 'locked' : 'active';
        if ($t['status'] !== $newStatus) {
            if ($locked && $t['role'] === 'admin' && admin_other_active_admins($admins, $id) === 0) {
                fail(409, 'last_admin', 'Es muss mindestens ein anderer aktiver Admin bleiben.');
            }
            q('UPDATE {users} SET status = ? WHERE id = ?', [$newStatus, $id]);
            if ($locked) end_sessions_for($id);
            admin_log($admin['id'], $locked ? 'lock_user' : 'unlock_user', $id, 'username=' . $t['username']);
            $t['status'] = $newStatus;
        }
        return ['user' => admin_user_out($t)];
    });
}

function route_admin_user_logout($admin)
{
    $id = admin_id_param();
    tx(function () use ($admin, $id) {
        $t = admin_target($id);
        end_sessions_for($id);
        admin_log($admin['id'], 'logout_user', $id, 'username=' . $t['username']);
    });
    if ($id === (int)$admin['id']) set_cookie(NZ_COOKIE, '', 0);
    return [];
}

function route_admin_user_delete($admin)
{
    $id = admin_id_param();
    $confirm = field('confirm_username', '');
    tx(function () use ($admin, $id, $confirm) {
        $admins = admin_lock_admins();
        $t = admin_target($id);
        if (!is_string($confirm) || $confirm !== $t['username']) {
            fail(400, 'confirm_mismatch', 'Zur Bestätigung bitte den Benutzernamen genau eingeben.');
        }
        if ($id === (int)$admin['id']) fail(409, 'self', 'Du kannst dein eigenes Konto nicht löschen.');
        if ($t['role'] === 'admin' && $t['status'] === 'active' && admin_other_active_admins($admins, $id) === 0) {
            fail(409, 'last_admin', 'Es muss mindestens ein anderer aktiver Admin bleiben.');
        }
        // Foreign keys cascade to sessions, notes, pages and shares.
        q('DELETE FROM {users} WHERE id = ?', [$id]);
        admin_log($admin['id'], 'delete_user', $id, 'username=' . $t['username']);
    });
    return [];
}

function route_admin_log($admin)
{
    $before = param('before', '');
    $beforeId = $before === '' ? null : admin_int($before, 1, 4294967295, 'Ungültige Angabe für „before“.');
    $limitParam = param('limit', '');
    $limit = $limitParam === '' ? 50 : admin_int($limitParam, 1, 1000000, 'Ungültige Angabe für „limit“.');
    if ($limit > 200) $limit = 200;

    $where = '';
    $params = [];
    if ($beforeId !== null) {
        $where = 'WHERE l.id < ?';
        $params[] = $beforeId;
    }
    // LIMIT is inlined: $limit is an validated int (native prepares cannot bind LIMIT as a number).
    $rows = all("SELECT l.id, l.at, l.action, l.details, l.admin_id, a.username AS admin_username,
            l.target_user_id, t.username AS target_username
         FROM {admin_log} l
         LEFT JOIN {users} a ON a.id = l.admin_id
         LEFT JOIN {users} t ON t.id = l.target_user_id
         $where
         ORDER BY l.id DESC
         LIMIT " . (int)$limit, $params);

    $entries = [];
    foreach ($rows as $r) {
        $entries[] = [
            'id' => (int)$r['id'],
            'at' => (int)$r['at'],
            'action' => $r['action'],
            'details' => $r['details'],
            'admin_id' => (int)$r['admin_id'],
            'admin_username' => $r['admin_username'],
            'target_user_id' => $r['target_user_id'] === null ? null : (int)$r['target_user_id'],
            'target_username' => $r['target_username'],
        ];
    }
    return ['entries' => $entries];
}

route('admin_users', 'GET', 'route_admin_users', 'admin');
route('admin_user_create', 'POST', 'route_admin_user_create', 'admin');
route('admin_user_update', 'POST', 'route_admin_user_update', 'admin');
route('admin_user_reset', 'POST', 'route_admin_user_reset', 'admin');
route('admin_user_lock', 'POST', 'route_admin_user_lock', 'admin');
route('admin_user_logout', 'POST', 'route_admin_user_logout', 'admin');
route('admin_user_delete', 'POST', 'route_admin_user_delete', 'admin');
route('admin_log', 'GET', 'route_admin_log', 'admin');

/** Read-only view of a user's tree (folders and notes, no strokes). Protocol entry 'view_tree'. */
function route_admin_tree($admin)
{
    $userId = param('user', '');
    if (!ctype_digit($userId) || (int)$userId < 1) fail(400, 'invalid', 'Ungültige Benutzer-ID.');
    $userId = (int)$userId;
    $target = one('SELECT id, username FROM {users} WHERE id = ?', [$userId]);
    if ($target === null) fail(404, 'not_found', 'Benutzer nicht gefunden.');
    $tree = owner_tree($userId);
    admin_log($admin['id'], 'view_tree', $userId, 'username=' . $target['username']);
    return $tree;
}

/** Pages of one note of a user, with strokes (read only). Protocol entry 'view_note'. */
function route_admin_pages($admin)
{
    $userId = param('user', '');
    if (!ctype_digit($userId) || (int)$userId < 1) fail(400, 'invalid', 'Ungültige Benutzer-ID.');
    $userId = (int)$userId;
    $noteId = param('note', '');
    if (!uuid_valid($noteId)) fail(400, 'invalid', 'Ungültige Notiz-ID.');
    $note = one('SELECT * FROM {notes} WHERE id = ? AND user_id = ? AND purged = 0', [$noteId, $userId]);
    if ($note === null) fail(404, 'not_found', 'Notiz nicht gefunden.');
    $out = note_with_pages($note);
    admin_log($admin['id'], 'view_note', $userId, 'note=' . $noteId);
    return $out;
}

route('admin_tree', 'GET', 'route_admin_tree', 'admin');
route('admin_pages', 'GET', 'route_admin_pages', 'admin');
