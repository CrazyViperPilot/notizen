<?php
if (!defined('NZ_ENTRY')) { http_response_code(403); exit; }
// Read access to the trees of other users (sharing and admin view). Helpers only, no routes.
//
// Visibility rules:
// - A folder is hidden if it or any ancestor has deleted_at set. A parent that is not in the list (purged or
//   missing) hides its children too, and so does a loop or a chain deeper than NZ_TREE_MAX_DEPTH.
// - A note is visible if it is not deleted or purged and its folder (if any) is visible.
// Rows are passed around as stored in the DB; output goes through sync_row_out() (no strokes for notes/folders).

const NZ_TREE_MAX_DEPTH = 200;

/** All folders of the owner that are not purged, in creation order (seq). */
function owner_folders($ownerId)
{
    return all('SELECT * FROM {folders} WHERE user_id = ? AND purged = 0 ORDER BY seq', [(int)$ownerId]);
}

/** [folderId => true] for every folder that is deleted itself or lies below a deleted (or missing) folder. */
function folder_deleted_map(array $folders)
{
    $by = [];
    foreach ($folders as $f) $by[$f['id']] = $f;
    $map = [];
    foreach ($by as $id => $f) {
        $cur = $f;
        $hidden = false;
        $reachedRoot = false;
        for ($d = 0; $d < NZ_TREE_MAX_DEPTH; $d++) {
            if ($cur['deleted_at'] !== null) {
                $hidden = true;
                break;
            }
            $pid = $cur['parent_id'];
            if ($pid === null) {
                $reachedRoot = true;
                break;
            }
            if (!isset($by[$pid])) {
                $hidden = true; // parent purged or missing
                break;
            }
            $cur = $by[$pid];
        }
        if ($hidden || !$reachedRoot) $map[$id] = true;
    }
    return $map;
}

/** [folderId => true] for every visible folder (the complement of folder_deleted_map). */
function folder_live_map(array $folders)
{
    $deleted = folder_deleted_map($folders);
    $live = [];
    foreach ($folders as $f) {
        if (!isset($deleted[$f['id']])) $live[$f['id']] = true;
    }
    return $live;
}

/** True if a note may be shown given the live folders: no folder, or its folder is visible. */
function note_in_live_folder(array $note, array $live)
{
    return $note['folder_id'] === null || isset($live[$note['folder_id']]);
}

/** IDs of $rootId and all its descendants in $folders (cycle-safe). $rootId is always first. */
function folder_descendants(array $folders, $rootId)
{
    $children = [];
    foreach ($folders as $f) {
        if ($f['parent_id'] !== null) $children[$f['parent_id']][] = $f['id'];
    }
    $out = [$rootId];
    $seen = [$rootId => true];
    for ($i = 0; $i < count($out); $i++) {
        if (!isset($children[$out[$i]])) continue;
        foreach ($children[$out[$i]] as $c) {
            if (isset($seen[$c])) continue;
            $seen[$c] = true;
            $out[] = $c;
        }
    }
    return $out;
}

/**
 * Note row if $userId may read it, otherwise null. The owner always may (if the note is visible).
 * Others may if the owner is active and the note is shared directly (kind 'note') or lies in a folder
 * shared with them (or in one of its subfolders). Deleted or purged notes and folders are never readable.
 */
function can_read_note($userId, $noteId)
{
    $userId = (int)$userId;
    if (!uuid_valid($noteId)) return null;
    $n = one('SELECT * FROM {notes} WHERE id = ?', [$noteId]);
    if ($n === null || (int)$n['purged'] === 1 || $n['deleted_at'] !== null) return null;
    $ownerId = (int)$n['user_id'];
    if ($ownerId !== $userId) {
        $owner = one('SELECT status FROM {users} WHERE id = ?', [$ownerId]);
        if ($owner === null || $owner['status'] !== 'active') return null;
    }
    $folders = owner_folders($ownerId);
    $live = folder_live_map($folders);
    if (!note_in_live_folder($n, $live)) return null;
    if ($ownerId === $userId) return $n;

    $direct = one("SELECT id FROM {shares} WHERE owner_id = ? AND target_id = ? AND kind = 'note' AND item_id = ?",
        [$ownerId, $userId, $noteId]);
    if ($direct !== null) return $n;
    if ($n['folder_id'] === null) return null;

    $shared = [];
    foreach (all("SELECT item_id FROM {shares} WHERE owner_id = ? AND target_id = ? AND kind = 'folder'", [$ownerId, $userId]) as $s) {
        $shared[$s['item_id']] = true;
    }
    if (!$shared) return null;
    $byId = [];
    foreach ($folders as $f) $byId[$f['id']] = $f;
    // Walk up from the note's folder; the first shared folder on the way (itself visible) grants access.
    $cur = $n['folder_id'];
    for ($d = 0; $cur !== null && isset($byId[$cur]) && $d < NZ_TREE_MAX_DEPTH; $d++) {
        if (isset($shared[$cur]) && isset($live[$cur])) return $n;
        $cur = $byId[$cur]['parent_id'];
    }
    return null;
}

/** ['note' => note row, 'pages' => [page rows with strokes, sorted by pos]] for a note row. Deleted and purged pages are left out. */
function note_with_pages(array $note)
{
    $rows = all('SELECT * FROM {pages} WHERE note_id = ? AND user_id = ? AND deleted_at IS NULL AND purged = 0 ORDER BY pos, id',
        [$note['id'], (int)$note['user_id']]);
    $pages = [];
    foreach ($rows as $p) $pages[] = sync_row_out('page', $p, true);
    return ['note' => sync_row_out('note', $note, false), 'pages' => $pages];
}

/** Everything visible in the owner's tree: ['folders' => [...], 'notes' => [...]] (no strokes). */
function owner_tree($ownerId)
{
    $ownerId = (int)$ownerId;
    $folders = owner_folders($ownerId);
    $live = folder_live_map($folders);
    $outFolders = [];
    foreach ($folders as $f) {
        if (isset($live[$f['id']])) $outFolders[] = sync_row_out('folder', $f, false);
    }
    $outNotes = [];
    $notes = all('SELECT * FROM {notes} WHERE user_id = ? AND purged = 0 AND deleted_at IS NULL ORDER BY seq', [$ownerId]);
    foreach ($notes as $n) {
        if (note_in_live_folder($n, $live)) $outNotes[] = sync_row_out('note', $n, false);
    }
    return ['folders' => $outFolders, 'notes' => $outNotes];
}
