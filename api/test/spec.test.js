// 出题规范 SKILL.md 和代码保持一致：知识点键、完整示例、提示词里确实用上了规范
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spec, specKbKeys, specExample, parseSpec } from '../src/spec.js';
import { KB_KEYS, checkSentence } from '../src/validate.js';
import { generatePrompt, reviewPrompt } from '../src/prompts.js';
import { KB } from '../../web/js/kb.js';
import { flat, trunkWords } from '../../web/js/text.js';

test('规范里的知识点键和后端、页面完全一致', () => {
  assert.deepEqual(specKbKeys(), KB_KEYS);
  assert.deepEqual(Object.keys(KB), KB_KEYS);
});

test('规范里的完整示例能通过严格校验，主干能在原句里按顺序找到', () => {
  const ex = specExample();
  const r = checkSentence(ex, { strict: true });
  assert.ok(r.ok, r.reason);
  const fw = flat(ex);
  const tw = trunkWords(ex, fw);
  assert.ok(tw, '主干对不上原句');
  assert.equal([...tw].sort((a, b) => a - b).map((i) => fw[i].norm).join(' '), 'the professor explained that the experiment had failed');
});

test('主干对齐：选连成段数最少的对法，对不上返回 null', () => {
  const s = { segs: [{ r: 'main', t: 'The man in the room *saw* the dog.' }], trunk: 'The man saw the dog.' };
  const fw = flat(s);
  assert.deepEqual([...trunkWords(s, fw)].sort((a, b) => a - b), [0, 1, 5, 6, 7]);
  assert.equal(trunkWords({ ...s, trunk: 'The man saw a cat.' }, fw), null);
  assert.equal(trunkWords({ ...s, trunk: '' }, fw), null);
});

test('出题和复核的提示词都用上了规范', () => {
  const g = generatePrompt(['CET-4'], []);
  for (const name of ['predicates', 'segments', 'kb', 'trunk', 'fields', 'example']) assert.ok(g.includes(spec(name)), `出题提示词缺少 ${name}`);
  const r = reviewPrompt([specExample()]);
  assert.ok(r.includes(spec('predicates')));
  assert.ok(!r.includes(spec('segments')), '复核只核对谓语');
});

test('规范少了某一段时直接报错', () => {
  assert.throws(() => parseSpec('<!-- prompt:predicates -->\nx\n<!-- /prompt -->'), /缺少/);
});
