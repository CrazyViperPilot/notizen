<?php
if (!defined('NZ_ENTRY')) { http_response_code(403); exit; }
// Sync protocol (docs/ARCHITEKTUR.md, section 5): sync_push, sync_pull, sync_pages, trash purge, daily cleanup, quota.
//
// Invariants:
// - Every write to a folder/note/page row gets a fresh, unique seq = ++users.seq (users row locked FOR UPDATE).
// - rev counts accepted versions of a row; clients send base_rev = the rev their change is based on.
// - users.used_bytes = SUM(pages.bytes) over the user's pages with purged = 0 (trash counts) + SUM(assets.bytes).
// - pages.bg (background asset) must reference an asset of the same user that is already uploaded (missing_asset).

const NZ_SYNC_MAX_CHANGES = 50;
const NZ_SYNC_MAX_STROKES = 8388608;    // 8 MB per page
const NZ_PULL_MAX_BYTES = 4194304;      // soft cap per pull/pages response
const NZ_TRASH_MS = 2592000000;         // 30 days
const NZ_CLEANUP_EVERY_MS = 86400000;   // once per day and user
const NZ_ASSET_GRACE_MS = 86400000;     // unused assets are removed after one day

function sync_kinds()
{
    return [
        'folder' => ['table' => 'folders', 'parent' => 'parent_id'],
        'note' => ['table' => 'notes', 'parent' => 'folder_id'],
        'page' => ['table' => 'pages', 'parent' => 'note_id'],
    ];
}

function uuid_v4()
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    $h = bin2hex($b);
    return substr($h, 0, 8) . '-' . substr($h, 8, 4) . '-' . substr($h, 12, 4) . '-' . substr($h, 16, 4) . '-' . substr($h, 20);
}

function sync_int($v, $label, $nullable = false)
{
    if ($v === null && $nullable) return null;
    if (is_float($v) && floor($v) == $v) $v = (int)$v;
    if (!is_int($v) || $v < 0) fail(400, 'invalid', $label . ' ungültig.');
    return $v;
}

/** Validates the client's data for $kind and returns the writable columns. */
function sync_clean($kind, $d)
{
    if (!is_array($d)) fail(400, 'invalid', 'Daten fehlen.');
    $now = now_ms();
    $c = [];
    $c['created_at'] = min(sync_int(isset($d['created_at']) ? $d['created_at'] : null, 'created_at'), $now);
    // A client clock in the future must not win every conflict.
    $c['updated_at'] = min(sync_int(isset($d['updated_at']) ? $d['updated_at'] : null, 'updated_at'), $now);
    $c['deleted_at'] = sync_int(isset($d['deleted_at']) ? $d['deleted_at'] : null, 'deleted_at', true);
    if ($c['deleted_at'] !== null) $c['deleted_at'] = min($c['deleted_at'], $now);
    $c['purged'] = !empty($d['purged']) ? 1 : 0;

    $parentKey = sync_kinds()[$kind]['parent'];
    $parent = isset($d[$parentKey]) ? $d[$parentKey] : null;
    if ($parent !== null && !uuid_valid($parent)) fail(400, 'invalid', $parentKey . ' ungültig.');
    if ($kind === 'page' && $parent === null) fail(400, 'invalid', 'note_id fehlt.');
    $c[$parentKey] = $parent;

    if ($kind === 'folder') $c['name'] = clean_text(isset($d['name']) ? $d['name'] : '', 200, 'Ordnername', true);
    if ($kind === 'note') {
        $c['title'] = clean_text(isset($d['title']) ? $d['title'] : '', 200, 'Titel', true);
        $c['pinned'] = !empty($d['pinned']) ? 1 : 0;
    }
    if ($kind === 'page') {
        $pos = isset($d['pos']) ? $d['pos'] : null;
        if (!is_int($pos) && !is_float($pos) || !is_finite((float)$pos)) fail(400, 'invalid', 'pos ungültig.');
        $c['pos'] = (float)$pos;
        $papers = ['blank', 'lined', 'grid', 'dotted', 'vocab', 'lin1', 'lin2', 'lin3', 'lin4', 'math'];
        $c['paper'] = isset($d['paper']) && in_array($d['paper'], $papers, true) ? $d['paper'] : fail(400, 'invalid', 'Papier ungültig.');
        $c['orient'] = isset($d['orient']) && in_array($d['orient'], ['p', 'l'], true) ? $d['orient'] : fail(400, 'invalid', 'Ausrichtung ungültig.');
        $bg = isset($d['bg']) ? $d['bg'] : null;
        if ($bg !== null && !asset_id_valid($bg)) fail(400, 'invalid', 'Bild ungültig.');
        $c['bg'] = $bg;
        $s = isset($d['strokes']) ? $d['strokes'] : '[]';
        if (!is_string($s)) fail(400, 'invalid', 'Striche ungültig.');
        if (strlen($s) > NZ_SYNC_MAX_STROKES) fail(413, 'page_too_large', 'Die Seite ist zu groß.');
        if (!is_array(json_decode($s, true, 8))) fail(400, 'invalid', 'Striche ungültig.');
        $c['strokes'] = $s;
        $c['bytes'] = strlen($s);
        $c['conflict'] = !empty($d['conflict']) ? 1 : 0;
    }
    if ($c['purged']) $c = sync_blank($kind, $c);
    return $c;
}

/** Content removed for a purged tombstone. */
function sync_blank($kind, array $c)
{
    if ($kind === 'folder') $c['name'] = '';
    if ($kind === 'note') { $c['title'] = ''; $c['pinned'] = 0; }
    if ($kind === 'page') { $c['strokes'] = '[]'; $c['bytes'] = 0; $c['bg'] = null; }
    return $c;
}

/** Row as sent to the client. Pages carry strokes only if $withStrokes. */
function sync_row_out($kind, array $r, $withStrokes)
{
    $o = [
        'id' => $r['id'],
        'created_at' => (int)$r['created_at'],
        'updated_at' => (int)$r['updated_at'],
        'deleted_at' => $r['deleted_at'] === null ? null : (int)$r['deleted_at'],
        'purged' => (int)$r['purged'],
        'rev' => (int)$r['rev'],
        'seq' => (int)$r['seq'],
    ];
    if ($kind === 'folder') { $o['parent_id'] = $r['parent_id']; $o['name'] = $r['name']; }
    if ($kind === 'note') { $o['folder_id'] = $r['folder_id']; $o['title'] = $r['title']; $o['pinned'] = (int)$r['pinned']; }
    if ($kind === 'page') {
        $o['note_id'] = $r['note_id'];
        $o['pos'] = (float)$r['pos'];
        $o['paper'] = $r['paper'];
        $o['orient'] = $r['orient'];
        $o['bg'] = $r['bg'];
        $o['conflict'] = (int)$r['conflict'];
        $o['bytes'] = (int)$r['bytes'];
        if ($withStrokes) $o['strokes'] = $r['strokes'];
    }
    return $o;
}

function sync_get($kind, $id, $lock = false)
{
    return one('SELECT * FROM {' . sync_kinds()[$kind]['table'] . '} WHERE id = ?' . ($lock ? ' FOR UPDATE' : ''), [$id]);
}

/** Locks the user's sync state. */
function sync_state($uid)
{
    $u = one('SELECT seq, used_bytes, quota_bytes, purge_floor, last_purge_at FROM {users} WHERE id = ? FOR UPDATE', [$uid]);
    return ['uid' => (int)$uid, 'seq' => (int)$u['seq'], 'used' => (int)$u['used_bytes'], 'quota' => (int)$u['quota_bytes'],
        'purge_floor' => (int)$u['purge_floor'], 'last_purge_at' => (int)$u['last_purge_at'], 'floor_changed' => false];
}

function sync_state_save(array $st)
{
    q('UPDATE {users} SET seq = ?, used_bytes = ?, purge_floor = ?, last_purge_at = ? WHERE id = ?',
        [$st['seq'], max(0, $st['used']), $st['purge_floor'], $st['last_purge_at'], $st['uid']]);
}

/** Inserts ($existing === null) or updates a row with a fresh seq; returns the stored row. */
function sync_store($kind, $id, array $cols, array &$st, $existing)
{
    $table = sync_kinds()[$kind]['table'];
    $seq = ++$st['seq'];
    if ($kind === 'page') $st['used'] += ($cols['purged'] ? 0 : $cols['bytes']) - ($existing && !$existing['purged'] ? (int)$existing['bytes'] : 0);
    if ($existing === null) {
        $cols = ['id' => $id, 'user_id' => $st['uid'], 'rev' => 1, 'seq' => $seq] + $cols;
        $names = implode(', ', array_keys($cols));
        q('INSERT INTO {' . $table . "} ($names) VALUES (" . implode(', ', array_fill(0, count($cols), '?')) . ')', array_values($cols));
    } else {
        unset($cols['created_at']);
        $set = implode(', ', array_map(function ($k) { return "$k = ?"; }, array_keys($cols)));
        q('UPDATE {' . $table . "} SET $set, rev = rev + 1, seq = ? WHERE id = ?", array_merge(array_values($cols), [$seq, $id]));
    }
    return sync_get($kind, $id);
}

/** Parent checks for insert/update. Returns possibly adjusted $cols. */
function sync_check_parent($kind, $id, array $cols, array $st)
{
    $key = sync_kinds()[$kind]['parent'];
    $pid = $cols[$key];
    if ($pid === null) return $cols;
    $pkind = $kind === 'page' ? 'note' : 'folder';
    $p = one('SELECT user_id, purged FROM {' . sync_kinds()[$pkind]['table'] . '} WHERE id = ?', [$pid]);
    if ($p && (int)$p['user_id'] !== $st['uid']) fail(403, 'forbidden', 'Kein Zugriff.');
    if ($kind === 'page') {
        if (!$p || ($p['purged'] && !$cols['purged'])) fail(409, 'orphan', 'Die Notiz zu dieser Seite gibt es nicht mehr.');
        return $cols;
    }
    // Folder/note whose parent folder no longer exists: keep it, at the top level.
    if (!$p) { $cols[$key] = null; return $cols; }
    if ($kind === 'folder') {
        $cur = $pid;
        for ($depth = 0; $cur !== null && $depth < 200; $depth++) {
            if ($cur === $id) fail(409, 'cycle', 'Ein Ordner kann nicht in sich selbst liegen.');
            $cur = val('SELECT parent_id FROM {folders} WHERE id = ? AND user_id = ?', [$cur, $st['uid']]);
        }
    }
    return $cols;
}

/** Marks a row and everything below it as purged (tombstones). Returns number of rows changed. */
function sync_purge_tree($kind, $id, array &$st)
{
    $uid = $st['uid'];
    $now = now_ms();
    $targets = []; // [kind, id]
    if ($kind === 'folder') {
        $children = [];
        foreach (all('SELECT id, parent_id FROM {folders} WHERE user_id = ?', [$uid]) as $f) $children[(string)$f['parent_id']][] = $f['id'];
        $folders = [$id];
        for ($i = 0; $i < count($folders); $i++) {
            if (isset($children[$folders[$i]])) foreach ($children[$folders[$i]] as $c) $folders[] = $c;
        }
        foreach ($folders as $f) $targets[] = ['folder', $f];
        $ph = implode(',', array_fill(0, count($folders), '?'));
        $notes = array_column(all("SELECT id FROM {notes} WHERE user_id = ? AND folder_id IN ($ph)", array_merge([$uid], $folders)), 'id');
    } elseif ($kind === 'note') {
        $notes = [$id];
    } else {
        $notes = [];
        $targets[] = ['page', $id];
    }
    foreach ($notes as $n) $targets[] = ['note', $n];
    if ($notes) {
        $ph = implode(',', array_fill(0, count($notes), '?'));
        foreach (all("SELECT id FROM {pages} WHERE user_id = ? AND note_id IN ($ph)", array_merge([$uid], $notes)) as $p) $targets[] = ['page', $p['id']];
    }
    $n = 0;
    foreach ($targets as $t) {
        $row = sync_get($t[0], $t[1], true);
        if (!$row || $row['purged'] || (int)$row['user_id'] !== $uid) continue;
        $cols = sync_blank($t[0], ['purged' => 1, 'updated_at' => $now, 'deleted_at' => $row['deleted_at'] === null ? $now : (int)$row['deleted_at']]);
        sync_store($t[0], $t[1], $cols, $st, $row);
        $n++;
    }
    return $n;
}

/** pos for a conflict copy: right behind $page within its note. */
function sync_pos_after(array $page)
{
    $next = val('SELECT MIN(pos) FROM {pages} WHERE note_id = ? AND pos > ? AND purged = 0', [$page['note_id'], $page['pos']]);
    $p = (float)$page['pos'];
    return ($next === null || $next === false) ? $p + 1 : ($p + (float)$next) / 2;
}

/** Stores the losing side of a page conflict as a new page (conflict = 1). */
function sync_conflict_copy(array $winner, array $loserCols, array &$st)
{
    $cols = $loserCols;
    $cols['note_id'] = $winner['note_id'];
    $cols['pos'] = sync_pos_after($winner);
    $cols['conflict'] = 1;
    $cols['deleted_at'] = null;
    $cols['purged'] = 0;
    $cols['created_at'] = now_ms();
    return sync_store('page', uuid_v4(), $cols, $st, null);
}

function row_cols($kind, array $row)
{
    $keep = ['created_at', 'updated_at', 'deleted_at', 'purged', sync_kinds()[$kind]['parent']];
    if ($kind === 'folder') $keep[] = 'name';
    if ($kind === 'note') { $keep[] = 'title'; $keep[] = 'pinned'; }
    if ($kind === 'page') $keep = array_merge($keep, ['pos', 'paper', 'orient', 'bg', 'strokes', 'bytes', 'conflict']);
    $c = [];
    foreach ($keep as $k) $c[$k] = $row[$k];
    return $c;
}

/** A page may only point to a background asset that is uploaded, or to the one it already has. */
function sync_check_asset($kind, array $cols, $row, array $st)
{
    if ($kind !== 'page' || $cols['bg'] === null) return;
    if ($row !== null && $row['bg'] === $cols['bg']) return;
    if (one('SELECT 1 FROM {assets} WHERE user_id = ? AND id = ?', [$st['uid'], $cols['bg']]) === null) {
        fail(409, 'missing_asset', 'Bild noch nicht hochgeladen.');
    }
}

/** Applies one change. Returns a result entry. */
function sync_apply(array $ch, array &$st)
{
    $kinds = sync_kinds();
    $kind = isset($ch['kind']) ? $ch['kind'] : null;
    $id = isset($ch['id']) ? $ch['id'] : null;
    if (!isset($kinds[$kind]) || !uuid_valid($id)) fail(400, 'invalid', 'Ungültige Änderung.');
    $base = sync_int(isset($ch['base_rev']) ? $ch['base_rev'] : 0, 'base_rev');
    $cols = sync_clean($kind, isset($ch['data']) ? $ch['data'] : null);

    $row = sync_get($kind, $id, true);
    if ($row && (int)$row['user_id'] !== $st['uid']) fail(403, 'forbidden', 'Kein Zugriff.');

    // Explicit "delete permanently": always accepted.
    if ($cols['purged']) {
        if ($row && !$row['purged']) sync_purge_tree($kind, $id, $st);
        $row = sync_get($kind, $id);
        return ['id' => $id, 'status' => 'ok', 'row' => $row ? sync_row_out($kind, $row, false) : null];
    }

    if (!$row) {
        sync_check_asset($kind, $cols, null, $st);
        if ($kind === 'page' && $cols['bytes'] > 0 && $st['used'] + $cols['bytes'] > $st['quota']) fail(507, 'quota', 'Speicherplatz voll.');
        $cols = sync_check_parent($kind, $id, $cols, $st);
        $new = sync_store($kind, $id, $cols, $st, null);
        return ['id' => $id, 'status' => 'ok', 'row' => sync_row_out($kind, $new, false)];
    }

    // Permanently deleted elsewhere: server wins, the client drops it.
    if ($row['purged']) return ['id' => $id, 'status' => 'conflict', 'row' => sync_row_out($kind, $row, true)];
    sync_check_asset($kind, $cols, $row, $st);

    $grow = $kind === 'page' ? $cols['bytes'] - (int)$row['bytes'] : 0;
    $quotaOk = $grow <= 0 || $st['used'] + $grow <= $st['quota'];

    if ($base === (int)$row['rev']) {
        if (!$quotaOk) fail(507, 'quota', 'Speicherplatz voll.');
        $cols = sync_check_parent($kind, $id, $cols, $st);
        $new = sync_store($kind, $id, $cols, $st, $row);
        return ['id' => $id, 'status' => 'ok', 'row' => sync_row_out($kind, $new, false)];
    }

    // Conflict: newer updated_at wins (ties: server).
    $clientWins = $cols['updated_at'] > (int)$row['updated_at'];
    if ($kind !== 'page') {
        if (!$clientWins) return ['id' => $id, 'status' => 'conflict', 'row' => sync_row_out($kind, $row, true)];
        $cols = sync_check_parent($kind, $id, $cols, $st);
        $new = sync_store($kind, $id, $cols, $st, $row);
        return ['id' => $id, 'status' => 'conflict', 'row' => sync_row_out($kind, $new, true)];
    }

    $sameInk = $cols['strokes'] === $row['strokes'];
    if ($clientWins) {
        $willCopy = !$sameInk && $row['deleted_at'] === null;
        if ($willCopy) {
            if ($st['used'] + $cols['bytes'] > $st['quota']) fail(507, 'quota', 'Speicherplatz voll.');
        } elseif (!$quotaOk) {
            fail(507, 'quota', 'Speicherplatz voll.');
        }
        $cols = sync_check_parent($kind, $id, $cols, $st);
        $old = $row;
        $new = sync_store('page', $id, $cols, $st, $row);
        if ($willCopy) sync_conflict_copy($new, row_cols('page', $old), $st);
        return ['id' => $id, 'status' => 'conflict', 'row' => sync_row_out('page', $new, false)];
    }
    // Server wins: keep the client's handwriting as a copy.
    if (!$sameInk && $cols['deleted_at'] === null) {
        if ($st['used'] + $cols['bytes'] > $st['quota']) fail(507, 'quota', 'Speicherplatz voll.');
        sync_conflict_copy($row, $cols, $st);
    }
    return ['id' => $id, 'status' => 'conflict', 'row' => sync_row_out('page', sync_get('page', $id), true)];
}

function route_sync_push($u)
{
    $changes = field('changes');
    if (!is_array($changes)) fail(400, 'invalid', 'changes fehlt.');
    if (count($changes) > NZ_SYNC_MAX_CHANGES) fail(413, 'too_many', 'Zu viele Änderungen auf einmal.');
    // Parents before children, regardless of the client's order.
    $order = ['folder' => 0, 'note' => 1, 'page' => 2];
    $idx = array_keys($changes);
    usort($idx, function ($a, $b) use ($changes, $order) {
        $ka = isset($changes[$a]['kind'], $order[$changes[$a]['kind']]) ? $order[$changes[$a]['kind']] : 3;
        $kb = isset($changes[$b]['kind'], $order[$changes[$b]['kind']]) ? $order[$changes[$b]['kind']] : 3;
        return $ka === $kb ? $a - $b : $ka - $kb;
    });
    return tx(function () use ($u, $changes, $idx) {
        $st = sync_state($u['id']);
        $results = [];
        foreach ($idx as $i) {
            $ch = $changes[$i];
            $id = is_array($ch) && isset($ch['id']) && is_string($ch['id']) ? $ch['id'] : null;
            $before = $st;
            try {
                $results[$i] = sync_apply(is_array($ch) ? $ch : [], $st);
            } catch (HttpError $e) {
                $st = $before; // nothing was written for a rejected change
                $results[$i] = ['id' => $id, 'status' => 'rejected', 'code' => $e->errCode, 'message' => $e->getMessage()];
            }
        }
        sync_state_save($st);
        ksort($results);
        return ['results' => array_values($results), 'cursor' => $st['seq']];
    });
}

/** Daily: trash older than 30 days → purged; tombstones older than 30 days → removed; used_bytes recomputed. */
function sync_cleanup(array &$st)
{
    $uid = $st['uid'];
    $limit = now_ms() - NZ_TRASH_MS;
    foreach (['folder', 'note', 'page'] as $kind) {
        $rows = all('SELECT id FROM {' . sync_kinds()[$kind]['table'] . '} WHERE user_id = ? AND purged = 0 AND deleted_at IS NOT NULL AND deleted_at < ?', [$uid, $limit]);
        foreach ($rows as $r) sync_purge_tree($kind, $r['id'], $st);
    }
    $removed = 0;
    foreach (['pages', 'notes', 'folders'] as $table) {
        $removed += q('DELETE FROM {' . $table . '} WHERE user_id = ? AND purged = 1 AND updated_at < ?', [$uid, $limit])->rowCount();
    }
    if ($removed > 0) {
        $st['purge_floor'] = $st['seq'];
        $st['floor_changed'] = true;
    }
    // Assets that no non-purged page uses and that are older than the grace period.
    q('DELETE a FROM {assets} a WHERE a.user_id = ? AND a.created_at < ? AND NOT EXISTS (SELECT 1 FROM {pages} p WHERE p.user_id = a.user_id AND p.bg = a.id AND p.purged = 0)',
        [$uid, now_ms() - NZ_ASSET_GRACE_MS]);
    $st['used'] = (int)val('SELECT COALESCE(SUM(bytes), 0) FROM {pages} WHERE user_id = ? AND purged = 0', [$uid])
        + (int)val('SELECT COALESCE(SUM(bytes), 0) FROM {assets} WHERE user_id = ?', [$uid]);
    $st['last_purge_at'] = now_ms();
}

function route_sync_pull($u)
{
    $since = param('since', '0');
    if (!ctype_digit($since)) fail(400, 'invalid', 'since ungültig.');
    $since = (int)$since;
    $limit = (int)param('limit', '200');
    $limit = max(1, min(500, $limit));
    $uid = (int)$u['id'];

    if (now_ms() - (int)$u['last_purge_at'] > NZ_CLEANUP_EVERY_MS) {
        tx(function () use ($uid) {
            $st = sync_state($uid);
            if (now_ms() - $st['last_purge_at'] <= NZ_CLEANUP_EVERY_MS) return; // another request was faster
            sync_cleanup($st);
            sync_state_save($st);
        });
    }
    $floor = (int)val('SELECT purge_floor FROM {users} WHERE id = ?', [$uid]);
    $reset = $since > 0 && $since < $floor;
    if ($reset) $since = 0;

    // One consistent snapshot for all three tables, so no seq is skipped by a concurrent push.
    $cands = tx(function () use ($uid, $since, $limit) {
        $cands = [];
        foreach (sync_kinds() as $kind => $k) {
            $cols = $kind === 'page' ? 'id, note_id, pos, paper, orient, bg, bytes, conflict, created_at, updated_at, deleted_at, purged, rev, seq' : '*';
            foreach (all("SELECT $cols FROM {" . $k['table'] . '} WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ' . ($limit + 1), [$uid, $since]) as $r) {
                $cands[] = ['kind' => $kind, 'row' => $r];
            }
        }
        return $cands;
    });
    usort($cands, function ($a, $b) { return $a['row']['seq'] - $b['row']['seq']; });
    $items = [];
    $cursor = $since;
    foreach (array_slice($cands, 0, $limit) as $c) {
        $items[] = ['kind' => $c['kind'], 'row' => sync_row_out($c['kind'], $c['row'], false)];
        $cursor = (int)$c['row']['seq'];
    }
    return ['items' => $items, 'cursor' => $cursor, 'more' => count($items) < count($cands), 'reset' => $reset];
}

/** Page contents (strokes) by id, own pages only. Unknown/foreign ids are omitted. */
function route_sync_pages($u)
{
    $ids = field('ids');
    if (!is_array($ids) || count($ids) > 100) fail(400, 'invalid', 'ids ungültig.');
    $ids = array_values(array_unique(array_filter($ids, 'uuid_valid')));
    if (!$ids) return ['pages' => []];
    $ph = implode(',', array_fill(0, count($ids), '?'));
    $rows = all("SELECT * FROM {pages} WHERE user_id = ? AND id IN ($ph)", array_merge([(int)$u['id']], $ids));
    $out = [];
    $bytes = 0;
    foreach ($rows as $r) {
        if ($out && $bytes + (int)$r['bytes'] > NZ_PULL_MAX_BYTES) break; // client asks again for the rest
        $out[] = sync_row_out('page', $r, true);
        $bytes += (int)$r['bytes'];
    }
    return ['pages' => $out];
}

route('sync_push', 'POST', 'route_sync_push', 'user');
route('sync_pull', 'GET', 'route_sync_pull', 'user');
route('sync_pages', 'POST', 'route_sync_pages', 'user');
