<?php
if (!defined('NZ_ENTRY')) { http_response_code(403); exit; }
// Loads all modules, keeps the route table and dispatches a request.
//
// Modules register routes with route($name, $method, $handler, $access):
//   $access: 'none' (no login), 'user' (logged in, own password set), 'user_any' (logged in, also with
//   must_change_pw), 'admin'. Handlers get the user row (except 'none') and return an array that is sent
//   as {"ok":true, ...}. Errors: fail($status, $code, $message).

require_once __DIR__ . '/http.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/util.php';
require_once __DIR__ . '/migrate.php';

$GLOBALS['NZ_ROUTES'] = [];

function route($name, $method, $handler, $access)
{
    $GLOBALS['NZ_ROUTES'][$name] = ['method' => $method, 'handler' => $handler, 'access' => $access];
}

function cfg($key)
{
    return isset($GLOBALS['NZ_CFG'][$key]) ? $GLOBALS['NZ_CFG'][$key] : null;
}

function set_config(array $c)
{
    $GLOBALS['NZ_CFG'] = $c + ['base_path' => '/notizen/', 'cookie_secure' => true, 'admin' => null];
    unset($GLOBALS['NZ_PDO']);
}

// Modules in a fixed order; later work packages add files, missing ones are skipped.
foreach (['auth', 'account', 'sync', 'tree', 'share', 'admin'] as $m) {
    if (is_file(__DIR__ . '/' . $m . '.php')) require_once __DIR__ . '/' . $m . '.php';
}

function route_ping()
{
    return [
        'php' => PHP_VERSION,
        'mysql' => (string)val('SELECT VERSION()'),
        'schema' => (int)read_settings()['schema_version'],
    ];
}
route('ping', 'GET', 'route_ping', 'none');

/** Handles the current request (see set_request). Returns [status, payload]. */
function dispatch()
{
    try {
        $r = req();
        $name = isset($r['query']['r']) && is_string($r['query']['r']) ? $r['query']['r'] : '';
        if (!isset($GLOBALS['NZ_ROUTES'][$name])) fail(404, 'not_found', 'Unbekannte Aktion.');
        $route = $GLOBALS['NZ_ROUTES'][$name];
        if ($r['method'] !== $route['method']) fail(405, 'method_not_allowed', 'Falsche Methode.');

        try {
            db();
        } catch (PDOException $e) {
            error_log('notizen db: ' . $e->getMessage());
            fail(503, 'db_unavailable', 'Datenbank nicht erreichbar.');
        }
        ensure_schema();

        if ($route['method'] === 'POST' && $name !== 'login') require_csrf();
        $access = $route['access'];
        if ($access === 'none') $result = call_user_func($route['handler']);
        else {
            if ($access === 'admin') $u = require_admin();
            else $u = require_user($access === 'user_any');
            $result = call_user_func($route['handler'], $u);
        }
        return [200, ['ok' => true] + ($result ?: [])];
    } catch (HttpError $e) {
        return [$e->status, ['error' => ['code' => $e->errCode, 'message' => $e->getMessage()]]];
    } catch (Throwable $e) {
        error_log('notizen: ' . get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
        if (!empty($GLOBALS['NZ_DEBUG'])) throw $e;
        return [500, ['error' => ['code' => 'server_error', 'message' => 'Interner Fehler auf dem Server.']]];
    }
}
