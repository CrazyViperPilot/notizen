<?php
// Schema migrations (migrations/NNN_*.sql) and the first admin from config.php.
// ensure_schema() costs one query per request when nothing is to do.

function migration_files()
{
    $files = glob(__DIR__ . '/../migrations/[0-9][0-9][0-9]_*.sql');
    sort($files);
    $out = [];
    foreach ($files as $f) $out[(int)substr(basename($f), 0, 3)] = $f;
    return $out;
}

function read_settings()
{
    try {
        $rows = all("SELECT k, v FROM {settings} WHERE k IN ('schema_version', 'admin_fp')");
    } catch (PDOException $e) {
        // 42S02 = table does not exist → fresh database
        if ($e->getCode() === '42S02') return ['schema_version' => '0', 'admin_fp' => ''];
        throw $e;
    }
    $s = ['schema_version' => '0', 'admin_fp' => ''];
    foreach ($rows as $r) $s[$r['k']] = $r['v'];
    return $s;
}

function set_setting($k, $v)
{
    q('INSERT INTO {settings} (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [$k, (string)$v]);
}

function ensure_schema()
{
    $files = migration_files();
    $target = $files ? max(array_keys($files)) : 0;
    $s = read_settings();
    $adminFp = admin_cfg_fp();
    if ((int)$s['schema_version'] >= $target && ($adminFp === '' || hash_equals($s['admin_fp'], $adminFp))) return;

    // Serialize against concurrent first requests after a deploy.
    $lock = cfg('db')['prefix'] . 'migrate';
    if ((int)val('SELECT GET_LOCK(?, 30)', [$lock]) !== 1) fail(503, 'busy', 'Server wird gerade aktualisiert, bitte gleich nochmal.');
    try {
        $s = read_settings();
        for ($v = (int)$s['schema_version'] + 1; $v <= $target; $v++) {
            if (!isset($files[$v])) throw new RuntimeException('Migration ' . $v . ' fehlt');
            run_sql_file($files[$v]);
            set_setting('schema_version', $v);
        }
        if ($adminFp !== '' && !hash_equals($s['admin_fp'], $adminFp)) bootstrap_admin();
    } finally {
        val('SELECT RELEASE_LOCK(?)', [$lock]);
    }
}

function run_sql_file($file)
{
    $sql = sql_tables(file_get_contents($file));
    $sql = preg_replace('/^\s*--.*$/m', '', $sql);
    foreach (preg_split('/;\s*$/m', $sql) as $stmt) {
        if (trim($stmt) !== '') db()->exec($stmt);
    }
}

function admin_cfg()
{
    $a = cfg('admin');
    if (!is_array($a) || empty($a['username']) || empty($a['password_hash']) || empty($a['fp'])) return null;
    return $a;
}

function admin_cfg_fp()
{
    $a = admin_cfg();
    return $a ? (string)$a['fp'] : '';
}

/** Creates the configured admin or resets its password (only when the secret changed, see admin_fp). */
function bootstrap_admin()
{
    $a = admin_cfg();
    $username = strtolower($a['username']);
    if (!validate_username($username)) throw new RuntimeException('NOTIZEN_ADMIN_USER ist kein gültiger Benutzername');
    tx(function () use ($a, $username) {
        $u = one('SELECT id FROM {users} WHERE username = ? FOR UPDATE', [$username]);
        if ($u) {
            q("UPDATE {users} SET password_hash = ?, role = 'admin', status = 'active', must_change_pw = 0 WHERE id = ?",
                [$a['password_hash'], $u['id']]);
            end_sessions_for($u['id']);
        } else {
            q("INSERT INTO {users} (username, display_name, password_hash, role, status, must_change_pw, created_at)
               VALUES (?, ?, ?, 'admin', 'active', 0, ?)", [$username, $username, $a['password_hash'], now_ms()]);
        }
        set_setting('admin_fp', $a['fp']);
    });
}
