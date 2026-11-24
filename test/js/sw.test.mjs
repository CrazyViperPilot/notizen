// Every app file must be in the service worker's precache list, otherwise views fail offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const shell = [...sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [relative(root, p)];
  });
}

const NOT_CACHED = [/^js\/admin\//, /^css\/admin\.css$/, /^js\/labor\.js$/, /^css\/labor\.css$/, /^js\/vendor\//];

test('all app js/css/icons are precached', () => {
  const files = ['js', 'css', 'icons'].flatMap((d) => walk(join(root, d))).filter((f) => !NOT_CACHED.some((re) => re.test(f)));
  const missing = files.filter((f) => !shell.includes(f));
  assert.deepEqual(missing, [], 'In sw.js SHELL ergänzen: ' + missing.join(', '));
});

test('precached files exist', () => {
  const gone = shell.filter((f) => f !== './' && !existsSync(join(root, f)));
  assert.deepEqual(gone, []);
});

test('cache name has the notizen- prefix', () => {
  assert.match(sw, /const CACHE_NAME = 'notizen-v\d+';/);
});
