import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { I18N } from '../public/i18n.js';
import { PRESET_IDS, DEFAULT_RULES } from '../public/rules.js';

test('no and en have the same keys', () => {
  assert.deepEqual(Object.keys(I18N.en).sort(), Object.keys(I18N.no).sort());
});

test('every literal key used by app.js exists', () => {
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const keys = [...src.matchAll(/\btt?\('([\w.]+)'/g), ...src.matchAll(/data-i18n(?:-title|-placeholder)?="([\w.]+)"/g)].map((m) => m[1]);
  for (const k of keys) assert.ok(k in I18N.no, `missing ${k}`);
});

test('every preset and rule has strings', () => {
  for (const id of PRESET_IDS) assert.ok(`preset.${id}` in I18N.no, id);
  for (const [k, v] of Object.entries(DEFAULT_RULES)) {
    assert.ok(`rule.${k}` in I18N.no, `rule.${k}`);
    if (typeof v === 'string') assert.ok(`rule.${k}.${v}` in I18N.no, `rule.${k}.${v}`);
  }
});
