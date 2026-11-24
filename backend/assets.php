<?php
if (!defined('NZ_ENTRY')) { http_response_code(403); exit; }
// Image assets as page background (docs/ARCHITEKTUR.md, 10.1): routes asset_put and asset_get.
//
// An asset is a JPEG; its id is the SHA-256 (hex) of its bytes, so the same file is stored once per user.
// Rows are per user (PK user_id, id); their bytes count in users.used_bytes and the quota.
// Reading: the own asset, or an asset used as bg by a live page of a note the caller may read
// (can_read_note); an admin may also read through any note that is not purged. Everything else is 404.

const NZ_ASSET_MAX_BYTES = 8388608;      // 8 MB decoded
const NZ_ASSET_MAX_B64 = 11184812;       // base64 length of 8 MB: ceil(8388608 / 3) * 4
const NZ_ASSET_MAX_SIDE = 10000;         // px
const NZ_ASSET_CACHE = 'private, max-age=31536000, immutable';

/** True for a SHA-256 hex id (64 lowercase hex characters). */
function asset_id_valid($id)
{
    return is_string($id) && preg_match('/^[0-9a-f]{64}$/', $id) === 1;
}

/** Asset row of one user (with data) or null. */
function asset_row($userId, $assetId)
{
    return one('SELECT * FROM {assets} WHERE user_id = ? AND id = ?', [(int)$userId, $assetId]);
}

/**
 * Owner id if the note $noteId is readable for $u (or $u is admin) and has a live page (not deleted, not purged)
 * with bg = $assetId. Otherwise null.
 */
function asset_note_owner($u, $noteId, $assetId)
{
    if (!uuid_valid($noteId)) return null;
    $note = can_read_note($u['id'], $noteId);
    if ($note === null && $u['role'] === 'admin') {
        $note = one('SELECT * FROM {notes} WHERE id = ? AND purged = 0', [$noteId]);
    }
    if ($note === null) return null;
    $owner = (int)$note['user_id'];
    $page = one('SELECT id FROM {pages} WHERE user_id = ? AND note_id = ? AND bg = ? AND deleted_at IS NULL AND purged = 0 LIMIT 1',
        [$owner, $note['id'], $assetId]);
    return $page === null ? null : $owner;
}

/** Uploads an asset (idempotent: an existing id is answered with ok and not counted twice). */
function route_asset_put($u)
{
    $id = field('id');
    if (!asset_id_valid($id)) fail(400, 'invalid', 'Ungültige Bild-ID.');
    if (field('mime') !== 'image/jpeg') fail(400, 'invalid', 'Nur JPEG-Bilder sind erlaubt.');
    $w = sync_int(field('w'), 'Breite');
    $h = sync_int(field('h'), 'Höhe');
    if ($w < 1 || $h < 1 || $w > NZ_ASSET_MAX_SIDE || $h > NZ_ASSET_MAX_SIDE) fail(400, 'invalid', 'Bildmaße ungültig.');
    $data = field('data');
    if (!is_string($data)) fail(400, 'invalid', 'Bilddaten fehlen.');
    if (strlen($data) > NZ_ASSET_MAX_B64) fail(413, 'too_large', 'Das Bild ist zu groß (höchstens 8 MB).');
    $bytes = base64_decode($data, true);
    if ($bytes === false || $bytes === '') fail(400, 'invalid', 'Bilddaten ungültig.');
    if (strlen($bytes) > NZ_ASSET_MAX_BYTES) fail(413, 'too_large', 'Das Bild ist zu groß (höchstens 8 MB).');
    $info = @getimagesizefromstring($bytes);
    if ($info === false || $info[2] !== IMAGETYPE_JPEG) fail(400, 'invalid', 'Kein JPEG-Bild.');
    $w = (int)$info[0];
    $h = (int)$info[1];
    if ($w < 1 || $h < 1 || $w > NZ_ASSET_MAX_SIDE || $h > NZ_ASSET_MAX_SIDE) fail(400, 'invalid', 'Bildmaße ungültig.');
    if (hash('sha256', $bytes) !== $id) fail(400, 'invalid', 'Die Bild-ID passt nicht zum Inhalt.');

    $uid = (int)$u['id'];
    $len = strlen($bytes);
    $stored = tx(function () use ($uid, $id, $bytes, $len, $w, $h) {
        $owner = one('SELECT used_bytes, quota_bytes FROM {users} WHERE id = ? FOR UPDATE', [$uid]);
        $have = one('SELECT bytes FROM {assets} WHERE user_id = ? AND id = ?', [$uid, $id]);
        if ($have !== null) return (int)$have['bytes'];
        if ((int)$owner['used_bytes'] + $len > (int)$owner['quota_bytes']) fail(507, 'quota', 'Speicherplatz voll.');
        $st = db()->prepare(sql_tables('INSERT INTO {assets} (user_id, id, mime, w, h, bytes, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'));
        $st->bindValue(1, $uid, PDO::PARAM_INT);
        $st->bindValue(2, $id, PDO::PARAM_STR);
        $st->bindValue(3, 'image/jpeg', PDO::PARAM_STR);
        $st->bindValue(4, $w, PDO::PARAM_INT);
        $st->bindValue(5, $h, PDO::PARAM_INT);
        $st->bindValue(6, $len, PDO::PARAM_INT);
        $st->bindValue(7, $bytes, PDO::PARAM_LOB);
        $st->bindValue(8, now_ms(), PDO::PARAM_INT);
        $st->execute();
        q('UPDATE {users} SET used_bytes = used_bytes + ? WHERE id = ?', [$len, $uid]);
        return $len;
    });
    return ['asset' => ['id' => $id, 'bytes' => $stored]];
}

/** Binary response of an asset: own asset, or via a note the caller may read (see asset_note_owner). */
function route_asset_get($u)
{
    $id = param('id', '');
    if (!asset_id_valid($id)) fail(400, 'invalid', 'Ungültige Bild-ID.');
    $asset = asset_row($u['id'], $id);
    if ($asset === null) {
        $note = param('note', '');
        $owner = $note === '' ? null : asset_note_owner($u, $note, $id);
        if ($owner !== null) $asset = asset_row($owner, $id);
    }
    if ($asset === null) fail(404, 'not_found', 'Bild nicht gefunden.');
    return ['__raw' => $asset['data'], '__type' => $asset['mime'], '__cache' => NZ_ASSET_CACHE];
}

route('asset_put', 'POST', 'route_asset_put', 'user');
route('asset_get', 'GET', 'route_asset_get', 'user');
