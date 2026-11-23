<?php
if (!defined('NZ_ENTRY')) { http_response_code(403); exit; }
// HTTP layer: request abstraction (so tests can call dispatch() in-process), errors, cookies, JSON.

class HttpError extends Exception
{
    public $status;
    public $errCode;

    public function __construct($status, $errCode, $message)
    {
        parent::__construct($message);
        $this->status = $status;
        $this->errCode = $errCode;
    }
}

const NZ_MAX_BODY = 16777216; // 16 MB

/** Throws; api.php turns it into {"error":{code,message}} with the given status. */
function fail($status, $code, $message)
{
    throw new HttpError($status, $code, $message);
}

/** Current request: method, route, query, raw body, headers (lowercase keys), cookies, ip. */
function req()
{
    return $GLOBALS['NZ_REQ'];
}

function set_request(array $r)
{
    $r += ['method' => 'GET', 'query' => [], 'body' => '', 'headers' => [], 'cookies' => [], 'ip' => '0.0.0.0'];
    $h = [];
    foreach ($r['headers'] as $k => $v) $h[strtolower($k)] = $v;
    $r['headers'] = $h;
    $r['_json'] = null;
    $GLOBALS['NZ_REQ'] = $r;
    $GLOBALS['NZ_RES'] = ['cookies' => []];
    $GLOBALS['NZ_USER'] = false; // current_user() cache: false = not yet resolved
}

function request_from_globals()
{
    $headers = [];
    foreach ($_SERVER as $k => $v) {
        if (strpos($k, 'HTTP_') === 0) $headers[str_replace('_', '-', substr($k, 5))] = $v;
    }
    if (isset($_SERVER['CONTENT_TYPE'])) $headers['CONTENT-TYPE'] = $_SERVER['CONTENT_TYPE'];
    $body = '';
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $len = isset($_SERVER['CONTENT_LENGTH']) ? (int)$_SERVER['CONTENT_LENGTH'] : 0;
        if ($len > NZ_MAX_BODY) {
            set_request(['method' => 'POST']);
            fail(413, 'too_large', 'Die Anfrage ist zu groß.');
        }
        $body = (string)file_get_contents('php://input', false, null, 0, NZ_MAX_BODY + 1);
    }
    return [
        'method' => $_SERVER['REQUEST_METHOD'],
        'query' => $_GET,
        'body' => $body,
        'headers' => $headers,
        'cookies' => $_COOKIE,
        'ip' => isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '0.0.0.0',
    ];
}

/** Parsed JSON body (object/array). Empty body = []. */
function body()
{
    $r = &$GLOBALS['NZ_REQ'];
    if ($r['_json'] !== null) return $r['_json'];
    if (strlen($r['body']) > NZ_MAX_BODY) fail(413, 'too_large', 'Die Anfrage ist zu groß.');
    if (trim($r['body']) === '') return $r['_json'] = [];
    $j = json_decode($r['body'], true);
    if (!is_array($j)) fail(400, 'bad_json', 'Ungültige Anfrage (JSON).');
    return $r['_json'] = $j;
}

/** Query parameter (GET). */
function param($name, $default = null)
{
    $q = $GLOBALS['NZ_REQ']['query'];
    return isset($q[$name]) && !is_array($q[$name]) ? (string)$q[$name] : $default;
}

/** Field from the JSON body. */
function field($name, $default = null)
{
    $b = body();
    return array_key_exists($name, $b) ? $b[$name] : $default;
}

function header_in($name)
{
    $h = $GLOBALS['NZ_REQ']['headers'];
    $k = strtolower($name);
    return isset($h[$k]) ? (string)$h[$k] : '';
}

function cookie_in($name)
{
    $c = $GLOBALS['NZ_REQ']['cookies'];
    return isset($c[$name]) && is_string($c[$name]) ? $c[$name] : '';
}

/** Queue a cookie; $maxAge <= 0 deletes it. Emitted by api.php (or read by tests). */
function set_cookie($name, $value, $maxAge)
{
    $GLOBALS['NZ_RES']['cookies'][] = ['name' => $name, 'value' => $value, 'max_age' => $maxAge];
}

function client_ip()
{
    return $GLOBALS['NZ_REQ']['ip'];
}

/** Writes a JSON response (used by api.php only). */
function json_out($status, $data)
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}
