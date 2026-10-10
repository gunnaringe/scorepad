import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { I18N } from '../public/i18n.js';
import { PRESETS } from '../public/rules.js';

test('no and en have the same keys', () => {
  assert.deepEqual(Object.keys(I18N.en).sort(), Object.keys(I18N.no).sort());
});

test('every literal key used by app.js exists', () => {
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const keys = [...src.matchAll(/\btt?\('([\w.]+)'/g), ...src.matchAll(/data-i18n(?:-title|-placeholder)?="([\w.]+)"/g)].map((m) => m[1]);
  for (const k of keys) assert.ok(k in I18N.no, `missing ${k}`);
});

test('every preset and setting has strings', () => {
  for (const [id, p] of Object.entries(PRESETS)) {
    for (const k of [`preset.${id}`, `preset.${id}.short`, `preset.${id}.rules`]) assert.ok(k in I18N.no, k);
    for (const k of Object.keys(p.defaults)) assert.ok(`set.${id}.${k}` in I18N.no, `set.${id}.${k}`);
  }
});
