// Farbumrechnung des eigenen Farbwählers (js/ui/colorpicker.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hsvToHex, hexToHsv } from '../../js/ui/colorpicker.js';

test('hsvToHex: Grundfarben, Weiß, Schwarz', () => {
  assert.equal(hsvToHex(0, 1, 1), '#ff0000');
  assert.equal(hsvToHex(120, 1, 1), '#00ff00');
  assert.equal(hsvToHex(240, 1, 1), '#0000ff');
  assert.equal(hsvToHex(0, 0, 1), '#ffffff');
  assert.equal(hsvToHex(200, 0.5, 0), '#000000');
});

test('hexToHsv → hsvToHex ergibt wieder dieselbe Farbe', () => {
  for (const c of ['#0a8f8f', '#ffb000', '#123456', '#abcdef', '#808080', '#ff00ff', '#000000', '#ffffff']) {
    const { h, s, v } = hexToHsv(c);
    assert.equal(hsvToHex(h, s, v), c);
  }
});
