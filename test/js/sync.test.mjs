import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePulled, applyPushResult, toChange } from '../../js/sync.js';

const page = (o = {}) => ({ id: 'p1', note_id: 'n1', pos: 1, paper: 'lined', orient: 'p', rev: 1, seq: 5, purged: 0, deleted_at: null, ...o });

test('pull: new folder is stored clean', () => {
  const a = mergePulled('folder', undefined, { id: 'f', name: 'A', rev: 1, purged: 0 });
  assert.equal(a.action, 'put');
  assert.equal(a.row.dirty, 0);
});

test('pull: new page has no strokes yet and needs them', () => {
  const a = mergePulled('page', undefined, page());
  assert.equal(a.row.strokes, null);
  assert.equal(a.row.need, 1);
});

test('pull: own page echoed back (same rev) keeps strokes, no fetch', () => {
  const a = mergePulled('page', page({ strokes: '[1]', dirty: 0, need: 0, lrev: 3 }), page({ seq: 9 }));
  assert.equal(a.row.strokes, '[1]');
  assert.equal(a.row.need, 0);
  assert.equal(a.row.seq, 9);
  assert.equal(a.row.lrev, 3);
});

test('pull: newer page rev keeps old strokes visible but needs fetch', () => {
  const a = mergePulled('page', page({ strokes: '[1]', dirty: 0 }), page({ rev: 2 }));
  assert.equal(a.row.strokes, '[1]');
  assert.equal(a.row.need, 1);
});

test('pull: dirty local row is kept', () => {
  assert.equal(mergePulled('note', { id: 'n', dirty: 1 }, { id: 'n', rev: 4, purged: 0 }).action, 'keep');
  assert.equal(mergePulled('note', { id: 'n', dirty: 2 }, { id: 'n', rev: 4, purged: 0 }).action, 'keep');
});

test('pull: purged → delete (unless local unsent edit)', () => {
  assert.equal(mergePulled('page', page({ dirty: 0 }), page({ purged: 1 })).action, 'delete');
  assert.equal(mergePulled('page', undefined, page({ purged: 1 })).action, 'delete');
  assert.equal(mergePulled('page', page({ dirty: 1 }), page({ purged: 1 })).action, 'keep');
});

test('push ok: clean, new rev, strokes kept', () => {
  const local = page({ strokes: '[1]', dirty: 1, lrev: 2, rev: 0 });
  const a = applyPushResult('page', local, 2, { status: 'ok', row: page({ rev: 1, seq: 7 }) });
  assert.equal(a.row.dirty, 0);
  assert.equal(a.row.rev, 1);
  assert.equal(a.row.strokes, '[1]');
});

test('push ok but edited meanwhile: stays dirty, adopts rev', () => {
  const local = page({ strokes: '[1,2]', dirty: 1, lrev: 3, rev: 0 });
  const a = applyPushResult('page', local, 2, { status: 'ok', row: page({ rev: 1 }) });
  assert.equal(a.row.dirty, 1);
  assert.equal(a.row.rev, 1);
  assert.equal(a.row.strokes, '[1,2]');
});

test('push conflict, server won: take server strokes', () => {
  const local = page({ strokes: '[mine]', dirty: 1, lrev: 2, rev: 1 });
  const a = applyPushResult('page', local, 2, { status: 'conflict', row: page({ rev: 3, strokes: '[theirs]' }) });
  assert.equal(a.row.strokes, '[theirs]');
  assert.equal(a.row.rev, 3);
  assert.equal(a.row.dirty, 0);
});

test('push conflict, client won: keep own strokes', () => {
  const local = page({ strokes: '[mine]', dirty: 1, lrev: 2, rev: 1 });
  const a = applyPushResult('page', local, 2, { status: 'conflict', row: page({ rev: 3 }) });
  assert.equal(a.row.strokes, '[mine]');
});

test('push conflict while edited meanwhile: no change (next push conflicts again, server keeps both)', () => {
  const local = page({ strokes: '[mine2]', dirty: 1, lrev: 3, rev: 1 });
  assert.equal(applyPushResult('page', local, 2, { status: 'conflict', row: page({ rev: 3 }) }).action, 'none');
});

test('push rejected: dirty 2 with code', () => {
  const a = applyPushResult('folder', { id: 'f', dirty: 1, lrev: 1 }, 1, { status: 'rejected', code: 'cycle' });
  assert.equal(a.row.dirty, 2);
  assert.equal(a.row.error, 'cycle');
});

test('push purge confirmed → delete', () => {
  assert.equal(applyPushResult('note', { id: 'n', dirty: 1, lrev: 1, purged: 1 }, 1, { status: 'ok', row: { id: 'n', purged: 1 } }).action, 'delete');
  assert.equal(applyPushResult('note', { id: 'n', dirty: 1, lrev: 1, purged: 1 }, 1, { status: 'ok', row: null }).action, 'delete');
});

test('toChange strips local fields, base_rev from rev', () => {
  const c = toChange('page', page({ strokes: '[]', dirty: 1, lrev: 4, need: 0, rev: 2, seq: 3, error: 'x' }));
  assert.equal(c.base_rev, 2);
  assert.equal(c.id, 'p1');
  for (const k of ['dirty', 'lrev', 'need', 'rev', 'seq', 'error', 'id']) assert.ok(!(k in c.data), k);
  assert.equal(c.data.strokes, '[]');
});
