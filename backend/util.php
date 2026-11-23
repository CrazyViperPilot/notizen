<?php
if (!defined('NZ_ENTRY')) { http_response_code(403); exit; }
// Small helpers shared by all modules.

/** Milliseconds since epoch (UTC). Tests can override via $GLOBALS['NZ_NOW']. */
function now_ms()
{
    if (isset($GLOBALS['NZ_NOW'])) return (int)$GLOBALS['NZ_NOW'];
    return (int)floor(microtime(true) * 1000);
}

/** Lowercase UUID (any version, 8-4-4-4-12 hex). */
function uuid_valid($s)
{
    return is_string($s) && preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $s) === 1;
}

function random_token($bytes = 32)
{
    return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '=');
}

/** Trimmed string with max length in characters, or fail(400). */
function clean_text($v, $max, $label, $allowEmpty = false)
{
    if (!is_string($v)) fail(400, 'invalid', $label . ' fehlt.');
    $v = trim(preg_replace('/[\x00-\x1F\x7F]/u', '', $v));
    if (!$allowEmpty && $v === '') fail(400, 'invalid', $label . ' darf nicht leer sein.');
    if (mb_strlen($v, 'UTF-8') > $max) fail(400, 'invalid', $label . ' ist zu lang (höchstens ' . $max . ' Zeichen).');
    return $v;
}

/** Writes an entry to the admin log. */
function admin_log($adminId, $action, $targetUserId = null, $details = '')
{
    q('INSERT INTO {admin_log} (admin_id, action, target_user_id, details, at) VALUES (?, ?, ?, ?, ?)',
        [(int)$adminId, $action, $targetUserId === null ? null : (int)$targetUserId, mb_substr((string)$details, 0, 500, 'UTF-8'), now_ms()]);
}
