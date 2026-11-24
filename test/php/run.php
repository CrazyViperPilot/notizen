<?php
// PHP-Tests ohne Framework. Laufen in-process gegen eine echte MySQL/MariaDB (Tabellenpräfix test_).
//   php test/php/run.php [filter]
// Zugang per Umgebung: NZ_TEST_DB_HOST (127.0.0.1), NZ_TEST_DB_PORT (3306), NZ_TEST_DB_NAME (notizen_test),
//                      NZ_TEST_DB_USER (root), NZ_TEST_DB_PASS ('')
// Jede Datei test/php/*_test.php definiert Funktionen test_*; vor jedem Test werden alle Tabellen geleert.

error_reporting(E_ALL);
ini_set('display_errors', '1');
ini_set('log_errors', '0');
$GLOBALS['NZ_DEBUG'] = true;

define('NZ_ENTRY', 1);
require __DIR__ . '/../../backend/bootstrap.php';

function env($k, $d)
{
    $v = getenv($k);
    return $v === false ? $d : $v;
}

const T_ADMIN_USER = 'chef';
const T_ADMIN_PASS = 'admin-passwort-123';

function test_config($adminPass = T_ADMIN_PASS)
{
    return [
        'db' => [
            'host' => env('NZ_TEST_DB_HOST', '127.0.0.1'),
            'port' => (int)env('NZ_TEST_DB_PORT', '3306'),
            'name' => env('NZ_TEST_DB_NAME', 'notizen_test'),
            'user' => env('NZ_TEST_DB_USER', 'root'),
            'pass' => env('NZ_TEST_DB_PASS', ''),
            'prefix' => 'test_',
        ],
        'base_path' => '/',
        'cookie_secure' => false,
        'admin' => [
            'username' => T_ADMIN_USER,
            'password_hash' => password_hash($adminPass, PASSWORD_DEFAULT),
            'fp' => hash('sha256', T_ADMIN_USER . "\n" . $adminPass),
        ],
    ];
}

/** Simulated browser: keeps the cookie jar and the CSRF token. */
class Client
{
    public $cookies = [];
    public $csrf = '';
    public $ip;
    public $origin = null;
    public $last;

    public function __construct($ip = '10.0.0.1')
    {
        $this->ip = $ip;
    }

    public function call($method, $route, $body = null, array $query = [], array $headers = [])
    {
        $headers += ['Host' => 'localhost', 'User-Agent' => 'test'];
        if ($this->csrf !== '' && !isset($headers['X-CSRF-Token'])) $headers['X-CSRF-Token'] = $this->csrf;
        if ($this->origin !== null) $headers['Origin'] = $this->origin;
        set_request([
            'method' => $method,
            'query' => ['r' => $route] + $query,
            'body' => $body === null ? '' : json_encode($body),
            'headers' => $headers,
            'cookies' => $this->cookies,
            'ip' => $this->ip,
        ]);
        list($status, $json) = dispatch();
        foreach ($GLOBALS['NZ_RES']['cookies'] as $c) {
            if ($c['max_age'] > 0) $this->cookies[$c['name']] = $c['value'];
            else unset($this->cookies[$c['name']]);
        }
        // Binary responses (asset_get) carry raw bytes that json_encode cannot take; they are passed as they are.
        if (!(is_array($json) && array_key_exists('__raw', $json))) $json = json_decode(json_encode($json), true); // like the wire format
        if (isset($json['csrf'])) $this->csrf = $json['csrf'];
        return $this->last = ['status' => $status, 'json' => $json];
    }

    public function get($route, array $query = [])
    {
        return $this->call('GET', $route, null, $query);
    }

    public function post($route, $body = [], array $headers = [])
    {
        return $this->call('POST', $route, $body, [], $headers);
    }

    public function login($user, $pass)
    {
        $r = $this->post('login', ['username' => $user, 'password' => $pass]);
        if ($r['status'] !== 200) throw new Exception('Login fehlgeschlagen: ' . json_encode($r));
        return $r;
    }
}

// ---- Assertions ----
$GLOBALS['T_ASSERTS'] = 0;

function assert_true($cond, $msg = 'Bedingung falsch')
{
    $GLOBALS['T_ASSERTS']++;
    if (!$cond) throw new Exception($msg);
}

function assert_eq($expected, $actual, $msg = '')
{
    $GLOBALS['T_ASSERTS']++;
    if ($expected !== $actual) {
        throw new Exception(($msg ? $msg . ': ' : '') . 'erwartet ' . var_export($expected, true) . ', bekommen ' . var_export($actual, true));
    }
}

/** Asserts HTTP status (and optionally error code) of a Client response. */
function assert_status($status, $res, $code = null)
{
    $GLOBALS['T_ASSERTS']++;
    $got = $res['status'];
    $gotCode = isset($res['json']['error']['code']) ? $res['json']['error']['code'] : null;
    if ($got !== $status || ($code !== null && $gotCode !== $code)) {
        throw new Exception('erwartet ' . $status . ($code ? ' ' . $code : '') . ', bekommen ' . $got . ' ' . json_encode($res['json'], JSON_UNESCAPED_UNICODE));
    }
}

// ---- Helpers for tests ----

/** Creates a user directly in the DB and returns its id. */
function make_user($username, $password = 'passwort-1234', $role = 'user', array $extra = [])
{
    $row = $extra + [
        'username' => $username, 'display_name' => ucfirst($username), 'password_hash' => password_hash($password, PASSWORD_DEFAULT),
        'role' => $role, 'status' => 'active', 'must_change_pw' => 0, 'created_at' => now_ms(),
    ];
    $cols = implode(', ', array_keys($row));
    $ph = implode(', ', array_fill(0, count($row), '?'));
    q("INSERT INTO {users} ($cols) VALUES ($ph)", array_values($row));
    return (int)db()->lastInsertId();
}

/** Client logged in as a fresh user. */
function user_client($username, $password = 'passwort-1234', $role = 'user')
{
    make_user($username, $password, $role);
    $c = new Client('10.1.' . mt_rand(0, 255) . '.' . mt_rand(1, 254));
    $c->login($username, $password);
    return $c;
}

function reset_db()
{
    unset($GLOBALS['NZ_NOW']);
    set_config(test_config());
    $tables = all("SELECT table_name AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'test\\_%'");
    db()->exec('SET FOREIGN_KEY_CHECKS = 0');
    foreach ($tables as $t) {
        if ($t['n'] === 'test_settings') db()->exec("DELETE FROM `test_settings` WHERE k <> 'schema_version'");
        else db()->exec('TRUNCATE TABLE `' . $t['n'] . '`');
    }
    db()->exec('SET FOREIGN_KEY_CHECKS = 1');
    ensure_schema(); // creates the admin again
}

// ---- Runner ----
$filter = isset($argv[1]) ? $argv[1] : '';
set_config(test_config());
try {
    db();
} catch (PDOException $e) {
    fwrite(STDERR, "Keine Test-Datenbank erreichbar: " . $e->getMessage() . "\n");
    exit(2);
}
// Fresh schema once per run.
$old = all("SELECT table_name AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'test\\_%'");
db()->exec('SET FOREIGN_KEY_CHECKS = 0');
foreach ($old as $t) db()->exec('DROP TABLE `' . $t['n'] . '`');
db()->exec('SET FOREIGN_KEY_CHECKS = 1');

$files = glob(__DIR__ . '/*_test.php');
sort($files);
foreach ($files as $f) require $f;

$tests = array_filter(get_defined_functions()['user'], function ($fn) use ($filter) {
    return strpos($fn, 'test_') === 0 && $fn !== 'test_config' && ($filter === '' || strpos($fn, $filter) !== false);
});
$failed = 0;
$t0 = microtime(true);
foreach ($tests as $fn) {
    try {
        reset_db();
        $fn();
        echo "  ok    $fn\n";
    } catch (Throwable $e) {
        $failed++;
        echo "  FAIL  $fn\n        " . $e->getMessage() . "\n        " . basename($e->getFile()) . ':' . $e->getLine() . "\n";
    }
}
printf("%d Tests, %d Prüfungen, %d fehlgeschlagen (%.1f s)\n", count($tests), $GLOBALS['T_ASSERTS'], $failed, microtime(true) - $t0);
exit($failed ? 1 : 0);
