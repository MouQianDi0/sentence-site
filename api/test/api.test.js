// 端到端测试：真实 PostgreSQL（经 psql）+ 假的大模型接口 + 真实的 HTTP 请求
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setQueryImpl } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createLlm } from '../src/llm.js';
import { createAi } from '../src/ai.js';
import * as repo from '../src/repo.js';
import { importExport } from '../src/importer.js';
import { createTestDb, startFakeLlm, startApp } from './helpers.js';

const quiet = { log() {}, error() {}, warn() {} };
let db, llmServer, app, cfg, ai;

const sentenceFor = (i, extra = {}) => ({
  level: 'CET-4',
  focus: `测试考点${i}`,
  segs: [
    { r: 'adv', t: 'Although remote work ^offers^ flexibility,', n: '让步状语从句。', k: 'adv_concession' },
    { r: 'main', t: 'many employees *miss*', n: '主句主语和谓语。', k: 'main' },
    { r: 'main', t: 'the informal conversations', n: '宾语。', k: 'main' },
    { r: 'attr', t: `that ^used^ to happen in the office every single day for team ${i}.`, n: '定语从句。', k: 'attr_r' },
  ],
  trunk: 'Many employees miss the informal conversations.',
  trunkZh: '许多员工怀念非正式的交谈。',
  trap: '',
  tip: '让步从句译成“尽管……，但……”。',
  ref: '尽管远程办公很灵活，但许多员工怀念过去每天在办公室里的闲聊。',
  opts: [
    { t: '尽管远程办公很灵活，但许多员工怀念过去每天在办公室里的闲聊。', ok: true, why: '好' },
    { t: '虽然远程工作提供灵活性，许多雇员错过非正式的对话。', ok: false, why: '硬译' },
    { t: '远程办公很灵活，所以员工不想去办公室。', ok: false, why: '逻辑错' },
  ],
  words: [{ w: 'flexibility', lemma: 'flexibility', pos: 'n.', zh: '灵活性' }],
  phrases: [{ m: 'used to', p: 'used to do', zh: '过去常常' }],
  ...extra,
});

let gradeReply = null;
let gradeReplyGetter = () => gradeReply;
let generateReplyGetter = () => null;

before(async () => {
  db = createTestDb();
  setQueryImpl(db.query);
  await repo.ensureSchema(await fs.readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  llmServer = await startFakeLlm({
    grade: () => gradeReplyGetter(),
    lookup: () => ({ lemma: 'publish', ipa: '/ˈpʌblɪʃ/', pos: 'v.', zh: '发表', more: '出版；公布' }),
    generate: () => generateReplyGetter(),
  });
  cfg = loadConfig({
    ACCESS_PASSWORD: 'open-sesame-42',
    COOKIE_SECRET: 'x'.repeat(64),
    LLM_BASE_URL: llmServer.url,
    LLM_API_KEY: 'test-key',
    LLM_MODEL_MAIN: 'fake-main',
    LLM_MODEL_LIGHT: 'fake-light',
    DAILY_GRADE_LIMIT: '3',
  });
  const llm = createLlm(cfg);
  ai = createAi({ cfg, llm, log: quiet });
  app = await startApp(createApp(cfg, { llm, log: quiet }));
});

after(() => {
  app?.close();
  llmServer?.close();
  db?.drop();
});

test('导入旧页面导出的数据，重复导入不会重复写入', async () => {
  const data = JSON.parse(await fs.readFile(new URL('../seed/export.json', import.meta.url), 'utf8'));
  const first = await importExport(data);
  assert.equal(first.sentences, 6);
  assert.equal(first.records, 3);
  assert.equal(first.attempts, 2);
  const again = await importExport(data);
  assert.equal(again.sentences, 0);
  assert.equal(again.attempts, 0);
  assert.equal(await repo.countSentences(), 6);
});

test('没输密码时只能访问公开接口', async () => {
  assert.equal((await app.api('GET', '/api/health')).status, 200);
  assert.deepEqual((await app.api('GET', '/api/session')).body, { unlocked: false });
  const r = await app.api('GET', '/api/sentences');
  assert.equal(r.status, 401);
  assert.match(r.body.error, /访问密码/);
  assert.equal((await app.api('GET', '/api/nope')).status, 404);
});

test('密码错误会提示剩余次数，输对后拿到 Cookie', async () => {
  const wrong = await app.api('POST', '/api/unlock', { password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body.error, /还可以再试 4 次/);
  const ok = await app.api('POST', '/api/unlock', { password: 'open-sesame-42' });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /^ss_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
  assert.deepEqual((await app.api('GET', '/api/session')).body, { unlocked: true });
});

test('伪造或篡改的 Cookie 无效', async () => {
  const forged = await fetch(`${app.base}/api/sentences`, { headers: { Cookie: 'ss_session=abc.def' } });
  assert.equal(forged.status, 401);
});

test('句库列表：字段齐全，按时间排序，since 只返回更新的', async () => {
  const r = await app.api('GET', '/api/sentences');
  assert.equal(r.status, 200);
  const list = r.body.sentences;
  assert.equal(list.length, 6);
  assert.deepEqual(list.map((s) => s.id), ['s-20261013-01', 's-20261013-02', 's-20261013-03', 's-20261013-04', 's-20261013-05', 's-20261013-06']);
  const s = list[0];
  for (const k of ['id', 'created', 'batch', 'source', 'level', 'focus', 'segs', 'trunk', 'trunkZh', 'trap', 'tip', 'ref', 'opts', 'words', 'phrases']) {
    assert.ok(k in s, `缺少字段 ${k}`);
  }
  assert.equal(s.batch, '2026-10-13');
  assert.ok(Array.isArray(s.segs) && s.segs[0].r === 'main');
  const since = await app.api('GET', `/api/sentences?since=${encodeURIComponent(list[3].created)}`);
  assert.deepEqual(since.body.sentences.map((x) => x.id), ['s-20261013-05', 's-20261013-06']);
  assert.equal((await app.api('GET', '/api/sentences?since=garbage')).status, 400);
});

test('练习记录：导入的记录可读，部分更新只改传入的字段', async () => {
  const list = (await app.api('GET', '/api/records')).body.records;
  assert.equal(list.length, 3);
  const r2 = list.find((r) => r.sentenceId === 's-20261013-02');
  assert.equal(r2.done, true);
  assert.ok(r2.draft.length > 0);

  const put = await app.api('PUT', '/api/records/s-20261013-04', { draft: '草稿一' });
  assert.equal(put.status, 200);
  assert.equal(put.body.record.draft, '草稿一');
  assert.equal(put.body.record.done, false);

  const put2 = await app.api('PUT', '/api/records/s-20261013-04', { verbs: { ok: 3, total: 4, wrong: 1 }, choice: { pick: 2, ok: true }, done: true });
  assert.equal(put2.body.record.draft, '草稿一', '没传的字段保持不变');
  assert.deepEqual(put2.body.record.verbs, { ok: 3, total: 4, wrong: 1 });
  assert.equal(put2.body.record.done, true);

  assert.equal((await app.api('PUT', '/api/records/s-20261013-04', { done: 'yes' })).status, 400);
  assert.equal((await app.api('PUT', '/api/records/s-20261013-04', {})).status, 400);
  assert.equal((await app.api('PUT', '/api/records/s-nope', { done: true })).status, 404);
});

test('批改历史：导入的旧批改按时间倒序返回', async () => {
  const r = await app.api('GET', '/api/attempts');
  assert.equal(r.body.attempts.length, 2);
  const one = (await app.api('GET', '/api/attempts?sentenceId=s-20261013-03')).body.attempts;
  assert.equal(one.length, 1);
  assert.equal(one[0].total, 76);
  assert.ok(one[0].feedback && one[0].feedback.level, '最近一次点评一起导入');
});

test('AI 批改：分数夹到范围内，总分后端计算，找不到的问题片段被丢掉', async () => {
  const text = '尽管远程工作很灵活，许多员工错过了办公室的谈话。';
  gradeReply = {
    acc: 55, flu: 20, comp: 30, total: 999,
    level: '基本准确',
    good: ['结构理解正确'],
    issues: [
      { src: '错过了', type: '误译', why: 'miss 这里是怀念', fix: '怀念' },
      { src: '根本不存在的片段', type: '用词', why: 'x', fix: 'y' },
    ],
    better: '尽管远程工作很灵活，许多员工怀念办公室里的闲聊。',
  };
  const r = await app.api('POST', '/api/grade', { sentenceId: 's-20261013-02', text });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.body.attempt;
  assert.equal(a.acc, 40);
  assert.equal(a.total, 90);
  assert.equal(a.feedback.issues.length, 1);
  assert.equal(a.model, 'fake-main');
  assert.equal(a.inputTokens, 700);
  const call = llmServer.calls.at(-1);
  assert.equal(call.auth, 'Bearer test-key');
  assert.equal(call.path, '/v1/chat/completions');
  assert.deepEqual(call.data.response_format, { type: 'json_object' });
  assert.ok(call.prompt.includes(text));
  const usage = (await app.api('GET', '/api/usage')).body;
  assert.equal(usage.grades, 1);
  assert.equal(usage.aiReady, true);
});

test('AI 批改：输入检查和每日上限', async () => {
  assert.equal((await app.api('POST', '/api/grade', { sentenceId: 's-20261013-02', text: '  ' })).status, 400);
  assert.equal((await app.api('POST', '/api/grade', { sentenceId: 's-nope', text: '译文' })).status, 404);
  gradeReply = { acc: 30, flu: 20, comp: 20, issues: [], good: [], level: 'ok', better: '' };
  assert.equal((await app.api('POST', '/api/grade', { sentenceId: 's-20261013-02', text: '第二次' })).status, 200);
  assert.equal((await app.api('POST', '/api/grade', { sentenceId: 's-20261013-02', text: '第三次' })).status, 200);
  const over = await app.api('POST', '/api/grade', { sentenceId: 's-20261013-02', text: '第四次' });
  assert.equal(over.status, 429);
  assert.match(over.body.error, /3 次/);
});

test('AI 批改：模型返回非 JSON 时自动重试一次', async () => {
  await db.raw('DELETE FROM ai_usage');
  const replies = ['抱歉我不太明白', { acc: 35, flu: 25, comp: 28, issues: [], good: [], level: '很好', better: '' }];
  let n = 0;
  gradeReplyGetter = () => replies[n++];
  const before = llmServer.calls.length;
  const r = await app.api('POST', '/api/grade', { sentenceId: 's-20261013-03', text: '一段译文' });
  gradeReplyGetter = () => gradeReply;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.attempt.total, 88);
  assert.equal(llmServer.calls.length - before, 2);
});

test('查词：第一次调用模型并缓存，第二次直接读缓存', async () => {
  const before = llmServer.calls.length;
  const a = await app.api('POST', '/api/lookup', { sentenceId: 's-20261013-01', word: 'Published' });
  assert.equal(a.status, 200);
  assert.equal(a.body.cached, false);
  assert.equal(a.body.data.zh, '发表');
  assert.equal(llmServer.calls.at(-1).data.model, 'fake-light');
  const b = await app.api('POST', '/api/lookup', { sentenceId: 's-20261013-01', word: 'published' });
  assert.equal(b.body.cached, true);
  assert.equal(llmServer.calls.length - before, 1);
  assert.equal((await app.api('POST', '/api/lookup', { sentenceId: 's-20261013-01', word: '发表' })).status, 400);
});

test('出题：不合格的句子被丢掉，不足时补一轮，新句子出现在句库里', async () => {
  let round = 0;
  generateReplyGetter = () => {
    round += 1;
    if (round === 1) {
      return {
        sentences: [
          sentenceFor(1),
          sentenceFor(2, { segs: [{ r: 'main', t: '*Too* short.', n: '', k: 'main' }, { r: 'main', t: 'x', n: '', k: 'main' }] }),
          sentenceFor(3, { opts: [{ t: 'a', ok: true }, { t: 'b', ok: true }, { t: 'c' }] }),
        ],
      };
    }
    return { sentences: [sentenceFor(4), sentenceFor(5), sentenceFor(6), sentenceFor(7)] };
  };
  const r = await app.api('POST', '/api/sentences/generate');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.added.length, 5);
  assert.equal(round, 2);
  assert.match(r.body.added[0], /^s-\d{8}-\d{6}-1$/);
  const all = (await app.api('GET', '/api/sentences')).body.sentences;
  assert.equal(all.length, 11);
  assert.equal(all.at(-1).source, 'manual');
});

test('每日出题：今天已经出过就不再出', async () => {
  generateReplyGetter = () => ({ sentences: [sentenceFor(11), sentenceFor(12), sentenceFor(13), sentenceFor(14), sentenceFor(15)] });
  const ids = await ai.generate({ source: 'daily', n: 5 });
  assert.equal(ids.length, 5);
  assert.match(ids[0], /^s-\d{8}-d1$/);
  const today = (await app.api('GET', '/api/sentences')).body.sentences.at(-1).batch;
  assert.equal(await repo.hasDailyFor(today), true);
});

test('删除句子会连带删除它的练习记录', async () => {
  assert.equal((await app.api('DELETE', '/api/sentences/s-20261013-04')).status, 200);
  assert.equal((await app.api('DELETE', '/api/sentences/s-20261013-04')).status, 404);
  const recs = (await app.api('GET', '/api/records')).body.records;
  assert.ok(!recs.some((r) => r.sentenceId === 's-20261013-04'));
});

test('没配置模型时 AI 接口返回明确的提示', async () => {
  const bare = loadConfig({ ACCESS_PASSWORD: 'p', COOKIE_SECRET: 'y'.repeat(40) });
  const other = await startApp(createApp(bare, { log: quiet }));
  await other.api('POST', '/api/unlock', { password: 'p' });
  const r = await other.api('POST', '/api/grade', { sentenceId: 's-20261013-02', text: '译文' });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /设置/);
  assert.equal((await other.api('GET', '/api/usage')).body.aiReady, false);
  other.close();
});

test('密码连续输错 5 次后锁定', async () => {
  const other = await startApp(createApp(cfg, { log: quiet }));
  for (let i = 0; i < 4; i++) await other.api('POST', '/api/unlock', { password: 'bad' });
  const fifth = await other.api('POST', '/api/unlock', { password: 'bad' });
  assert.equal(fifth.status, 429);
  const right = await other.api('POST', '/api/unlock', { password: 'open-sesame-42' });
  assert.equal(right.status, 429, '锁定期间输对也不行');
  other.close();
});
