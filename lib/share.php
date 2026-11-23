<?php
// Sharing (read only): recipient directory, manage shares, read access to shared trees and pages.
// Routes: directory, shares_of, share, unshare, shared_tree, shared_pages. Read helpers live in tree.php.

const NZ_SHARE_MAX_TARGETS = 100;

/** 'folder' or 'note', otherwise fail(400). */
function share_kind($v)
{
    if ($v !== 'folder' && $v !== 'note') fail(400, 'invalid', 'Art ungültig (Ordner oder Notiz).');
    return $v;
}

/** Valid UUID, otherwise fail(400). */
function share_uuid($v)
{
    if (!uuid_valid($v)) fail(400, 'invalid', 'ID ungültig.');
    return $v;
}

/** Positive integer ID (int or digit string), otherwise fail(400). */
function share_int_id($v, $label)
{
    if (is_string($v) && preg_match('/^[0-9]{1,15}$/', $v) === 1) $v = (int)$v;
    if (!is_int($v) || $v < 1) fail(400, 'invalid', $label . ' ungültig.');
    return $v;
}

/**
 * The caller's own folder or note (404 if missing or purged). With $live the item must also be visible,
 * i.e. not deleted and not below a deleted folder (404 otherwise).
 */
function share_own_item($uid, $kind, $id, $live)
{
    $table = $kind === 'folder' ? 'folders' : 'notes';
    $row = one('SELECT * FROM {' . $table . '} WHERE id = ? AND user_id = ?', [$id, (int)$uid]);
    if ($row === null || (int)$row['purged'] === 1) fail(404, 'not_found', 'Ordner oder Notiz nicht gefunden.');
    if (!$live) return $row;
    $liveMap = folder_live_map(owner_folders($uid));
    if ($kind === 'folder') {
        $visible = isset($liveMap[$id]);
    } else {
        $visible = $row['deleted_at'] === null && note_in_live_folder($row, $liveMap);
    }
    if (!$visible) fail(404, 'not_found', 'Ordner oder Notiz nicht gefunden.');
    return $row;
}

/** Shares of one item of the owner: {shares:[{id, target_id, display_name}]}. */
function share_list($ownerId, $kind, $itemId)
{
    $rows = all('SELECT s.id, s.target_id, u.display_name FROM {shares} s JOIN {users} u ON u.id = s.target_id
                 WHERE s.owner_id = ? AND s.kind = ? AND s.item_id = ? ORDER BY u.display_name, s.id',
        [(int)$ownerId, $kind, $itemId]);
    $out = [];
    foreach ($rows as $r) {
        $out[] = ['id' => (int)$r['id'], 'target_id' => (int)$r['target_id'], 'display_name' => $r['display_name']];
    }
    return ['shares' => $out];
}

/**
 * Visible part of one owner's tree for the viewer: shared folders with all visible subfolders and their notes,
 * plus individually shared notes. Folders whose parent is not in the result get parent_id null, notes whose
 * folder is not in the result get folder_id null. Without strokes.
 */
function shared_tree_of($ownerId, $viewerId)
{
    $folders = owner_folders($ownerId);
    $live = folder_live_map($folders);
    $rootIds = [];
    $noteIds = [];
    $shares = all('SELECT kind, item_id FROM {shares} WHERE owner_id = ? AND target_id = ?', [$ownerId, $viewerId]);
    foreach ($shares as $s) {
        if ($s['kind'] === 'folder') $rootIds[] = $s['item_id'];
        else $noteIds[] = $s['item_id'];
    }

    $inTree = [];
    foreach ($rootIds as $root) {
        if (!isset($live[$root])) continue;
        foreach (folder_descendants($folders, $root) as $d) {
            if (isset($live[$d])) $inTree[$d] = true;
        }
    }
    $folderRows = [];
    foreach ($folders as $f) {
        if (isset($inTree[$f['id']])) $folderRows[] = $f;
    }

    $notes = [];
    if ($inTree) {
        $ids = array_keys($inTree);
        $ph = implode(',', array_fill(0, count($ids), '?'));
        $rows = all("SELECT * FROM {notes} WHERE user_id = ? AND purged = 0 AND deleted_at IS NULL AND folder_id IN ($ph)",
            array_merge([(int)$ownerId], $ids));
        foreach ($rows as $n) $notes[$n['id']] = $n;
    }
    if ($noteIds) {
        $ph = implode(',', array_fill(0, count($noteIds), '?'));
        $rows = all("SELECT * FROM {notes} WHERE user_id = ? AND purged = 0 AND deleted_at IS NULL AND id IN ($ph)",
            array_merge([(int)$ownerId], $noteIds));
        foreach ($rows as $n) {
            if (note_in_live_folder($n, $live)) $notes[$n['id']] = $n;
        }
    }
    $noteList = array_values($notes);
    usort($noteList, function ($a, $b) { return $a['seq'] <=> $b['seq']; });

    $outFolders = [];
    foreach ($folderRows as $f) {
        $row = sync_row_out('folder', $f, false);
        if ($row['parent_id'] !== null && !isset($inTree[$row['parent_id']])) $row['parent_id'] = null;
        $outFolders[] = $row;
    }
    $outNotes = [];
    foreach ($noteList as $n) {
        $row = sync_row_out('note', $n, false);
        if ($row['folder_id'] !== null && !isset($inTree[$row['folder_id']])) $row['folder_id'] = null;
        $outNotes[] = $row;
    }
    return ['folders' => $outFolders, 'notes' => $outNotes];
}

/** Active users except the caller, sorted by display name. */
function route_directory($u)
{
    $rows = all("SELECT id, display_name FROM {users} WHERE status = 'active' AND id <> ? ORDER BY display_name, id", [(int)$u['id']]);
    $users = [];
    foreach ($rows as $r) $users[] = ['id' => (int)$r['id'], 'display_name' => $r['display_name']];
    return ['users' => $users];
}

function route_shares_of($u)
{
    $kind = share_kind(param('kind', ''));
    $id = share_uuid(param('id', ''));
    share_own_item((int)$u['id'], $kind, $id, false);
    return share_list((int)$u['id'], $kind, $id);
}

function route_share($u)
{
    $uid = (int)$u['id'];
    $kind = share_kind(field('kind'));
    $id = share_uuid(field('id'));
    $targets = field('target_ids', []);
    if (!is_array($targets)) fail(400, 'invalid', 'Empfänger fehlen.');
    if (count($targets) > NZ_SHARE_MAX_TARGETS) fail(400, 'invalid', 'Höchstens 100 Empfänger auf einmal.');
    $ids = [];
    foreach ($targets as $t) $ids[share_int_id($t, 'Empfänger')] = true;
    $ids = array_keys($ids);

    return tx(function () use ($uid, $kind, $id, $ids) {
        share_own_item($uid, $kind, $id, true);
        if ($ids) {
            if (in_array($uid, $ids, true)) fail(400, 'invalid_target', 'Du kannst nicht an dich selbst freigeben.');
            $ph = implode(',', array_fill(0, count($ids), '?'));
            $found = all("SELECT id FROM {users} WHERE status = 'active' AND id IN ($ph)", $ids);
            if (count($found) !== count($ids)) {
                fail(400, 'invalid_target', 'Mindestens ein Empfänger ist nicht verfügbar.');
            }
            $now = now_ms();
            foreach ($ids as $t) {
                q('INSERT IGNORE INTO {shares} (owner_id, target_id, kind, item_id, created_at) VALUES (?, ?, ?, ?, ?)',
                    [$uid, $t, $kind, $id, $now]);
            }
        }
        return share_list($uid, $kind, $id);
    });
}

function route_unshare($u)
{
    $uid = (int)$u['id'];
    $shareId = share_int_id(field('share_id'), 'Freigabe-ID');
    $row = one('SELECT id FROM {shares} WHERE id = ? AND owner_id = ?', [$shareId, $uid]);
    if ($row === null) fail(404, 'not_found', 'Freigabe nicht gefunden.');
    q('DELETE FROM {shares} WHERE id = ? AND owner_id = ?', [$shareId, $uid]);
    return [];
}

/** Everything shared with the caller, grouped by active owner. */
function route_shared_tree($u)
{
    $viewer = (int)$u['id'];
    $owners = all("SELECT DISTINCT u.id, u.display_name FROM {shares} s JOIN {users} u ON u.id = s.owner_id
                   WHERE s.target_id = ? AND u.status = 'active' AND u.id <> ?
                   ORDER BY u.display_name, u.id", [$viewer, $viewer]);
    $out = [];
    foreach ($owners as $o) {
        $tree = shared_tree_of((int)$o['id'], $viewer);
        $out[] = [
            'owner' => ['id' => (int)$o['id'], 'display_name' => $o['display_name']],
            'folders' => $tree['folders'],
            'notes' => $tree['notes'],
        ];
    }
    return ['owners' => $out];
}

/** Pages of a note shared with the caller. Own notes and notes without access give 404. */
function route_shared_pages($u)
{
    $uid = (int)$u['id'];
    $noteId = share_uuid(param('note', ''));
    $owner = one('SELECT user_id FROM {notes} WHERE id = ?', [$noteId]);
    if ($owner === null || (int)$owner['user_id'] === $uid) fail(404, 'not_found', 'Notiz nicht gefunden.');
    $note = can_read_note($uid, $noteId);
    if ($note === null) fail(404, 'not_found', 'Notiz nicht gefunden.');
    $out = note_with_pages($note);
    $out['note']['folder_id'] = null; // the owner's folder structure is none of the recipient's business
    return $out;
}

route('directory', 'GET', 'route_directory', 'user');
route('shares_of', 'GET', 'route_shares_of', 'user');
route('share', 'POST', 'route_share', 'user');
route('unshare', 'POST', 'route_unshare', 'user');
route('shared_tree', 'GET', 'route_shared_tree', 'user');
route('shared_pages', 'GET', 'route_shared_pages', 'user');
