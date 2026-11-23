<?php
// Notizen API – single entry point: api.php?r=<route>. See docs/ARCHITEKTUR.md, section 4.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");

define('NZ_ENTRY', 1);
require __DIR__ . '/backend/bootstrap.php';

$configFile = __DIR__ . '/config.php';
if (!is_file($configFile)) {
    json_out(500, ['error' => ['code' => 'no_config', 'message' => 'config.php fehlt.']]);
    exit;
}
set_config(require $configFile);

try {
    set_request(request_from_globals());
    list($status, $payload) = dispatch();
} catch (HttpError $e) {
    $status = $e->status;
    $payload = ['error' => ['code' => $e->errCode, 'message' => $e->getMessage()]];
}

foreach ($GLOBALS['NZ_RES']['cookies'] as $c) {
    setcookie($c['name'], $c['value'], [
        'expires' => $c['max_age'] > 0 ? time() + $c['max_age'] : 1,
        'path' => cfg('base_path'),
        'secure' => (bool)cfg('cookie_secure'),
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
}
json_out($status, $payload);
