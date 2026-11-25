<?php
if (!defined('NZ_ENTRY')) { http_response_code(403); exit; }
// Abgabe und Korrektur (docs/ARCHITEKTUR.md 14.5): Wer eine Notiz mit review = 1 geteilt bekommt (direkt oder über einen
// Ordner), darf je Seite eine eigene Korrektur-Ebene (Striche wie pages.strokes) speichern. Der Besitzer sieht alle
// Korrekturen seiner Notiz und kann sie entfernen; ein Korrektor sieht nur seine eigenen. Nur online, kein Sync.
// Routes: correction_get, correction_save, correction_clear.

const NZ_CORR_MAX = 2097152;   // 2 MB je Seite und Korrektor

/** Live page row (not deleted/purged) of the note, or fail(404). */
function review_page($noteId, $pageId)
{
    if (!uuid_valid($pageId)) fail(400, 'invalid', 'Seite ungültig.');
    $p = one('SELECT id, note_id, user_id FROM {pages} WHERE id = ? AND note_id = ? AND deleted_at IS NULL AND purged = 0', [$pageId, $noteId]);
    if ($p === null) fail(404, 'not_found', 'Seite nicht gefunden.');
    return $p;
}

/** Corrections of a note: all (owner) or only those of $reviewerId. Live pages only. */
function review_list($noteId, $ownerId, $reviewerId = null)
{
    $sql = 'SELECT c.page_id, c.reviewer_id, c.strokes, c.updated_at, u.display_name FROM {corrections} c
            JOIN {pages} p ON p.id = c.page_id AND p.deleted_at IS NULL AND p.purged = 0
            JOIN {users} u ON u.id = c.reviewer_id
            WHERE c.note_id = ? AND c.owner_id = ?';
    $args = [$noteId, (int)$ownerId];
    if ($reviewerId !== null) { $sql .= ' AND c.reviewer_id = ?'; $args[] = (int)$reviewerId; }
    $out = [];
    foreach (all($sql . ' ORDER BY c.updated_at', $args) as $r) {
        $out[] = ['page_id' => $r['page_id'], 'reviewer_id' => (int)$r['reviewer_id'], 'reviewer' => $r['display_name'],
            'strokes' => $r['strokes'], 'updated_at' => (int)$r['updated_at']];
    }
    return $out;
}

function route_correction_get($u)
{
    $uid = (int)$u['id'];
    $noteId = param('note', '');
    $note = can_read_note($uid, $noteId);
    if ($note === null) fail(404, 'not_found', 'Notiz nicht gefunden.');
    $owner = (int)$note['user_id'];
    if ($owner === $uid) return ['corrections' => review_list($noteId, $owner), 'can_review' => false];
    $can = can_read_note($uid, $noteId, true) !== null;
    // Ein reiner Leser sieht keine Korrekturen anderer.
    return ['corrections' => $can ? review_list($noteId, $owner, $uid) : [], 'can_review' => $can];
}

function route_correction_save($u)
{
    $uid = (int)$u['id'];
    $noteId = field('note', '');
    $note = can_read_note($uid, $noteId, true);
    if ($note === null) fail(404, 'not_found', 'Notiz nicht gefunden.');
    $page = review_page($noteId, field('page', ''));
    $s = field('strokes', '[]');
    if (!is_string($s)) fail(400, 'invalid', 'Striche ungültig.');
    if (strlen($s) > NZ_CORR_MAX) fail(413, 'page_too_large', 'Die Korrektur ist zu groß.');
    if (!is_array(json_decode($s, true, 8))) fail(400, 'invalid', 'Striche ungültig.');
    $now = now_ms();
    if ($s === '[]') {
        q('DELETE FROM {corrections} WHERE page_id = ? AND reviewer_id = ?', [$page['id'], $uid]);
    } else {
        q('INSERT INTO {corrections} (page_id, reviewer_id, owner_id, note_id, strokes, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE strokes = VALUES(strokes), updated_at = VALUES(updated_at)',
            [$page['id'], $uid, (int)$note['user_id'], $noteId, $s, $now]);
    }
    return ['updated_at' => $now];
}

/** Besitzer entfernt Korrekturen: einer Seite (page) oder der ganzen Notiz, optional nur eines Korrektors. */
function route_correction_clear($u)
{
    $uid = (int)$u['id'];
    $noteId = field('note', '');
    $note = can_read_note($uid, $noteId);
    if ($note === null || (int)$note['user_id'] !== $uid) fail(404, 'not_found', 'Notiz nicht gefunden.');
    $sql = 'DELETE FROM {corrections} WHERE note_id = ? AND owner_id = ?';
    $args = [$noteId, $uid];
    $pageId = field('page', null);
    if ($pageId !== null) { review_page($noteId, $pageId); $sql .= ' AND page_id = ?'; $args[] = $pageId; }
    $rev = field('reviewer_id', null);
    if ($rev !== null) {
        if (!is_int($rev) || $rev < 1) fail(400, 'invalid', 'Korrektor ungültig.');
        $sql .= ' AND reviewer_id = ?'; $args[] = $rev;
    }
    q($sql, $args);
    return [];
}

route('correction_get', 'GET', 'route_correction_get', 'user');
route('correction_save', 'POST', 'route_correction_save', 'user');
route('correction_clear', 'POST', 'route_correction_clear', 'user');
