// 端到端测试：真实 PostgreSQL（经 psql）+ 假的大模型接口 + 真实的 HTTP 请求
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setQueryImpl } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { createLlm } from '../src/llm.ts';
import { createAi } from '../src/ai.ts';
import * as repo from '../src/repo.ts';
import { migrate } from '../src/migrate.ts';
import { importExport } from '../src/importer.ts';
import { createTestDb, startFakeLlm, startApp, type FakeLlm, type TestApp, type TestDb } from './helpers.ts';
import type { AppConfig } from '../src/config.ts';
import type { Ai } from '../src/ai.ts';
import type { AccountRow, NewSentence } from '../src/repo.ts';
import type { PracticeRecord, Sentence, SentenceSource } from '@sentence-site/shared';

/** 测试库里一定有 owner 账户 */
const ownerAccount = async (): Promise<AccountRow> => {
  const a = await repo.getAccount('owner');
  if (!a) throw new Error('没有 owner 账户');
  return a;
};

const quiet = { log() {}, error: (...a: unknown[]) => process.env.DEBUG_TEST && console.error(...a), warn() {} };
let db: TestDb, llmServer: FakeLlm, app: TestApp, cfg: AppConfig, ai: Ai;

const sentenceFor = (i: number, extra: Record<string, unknown> = {}) => ({
  level: 'CET-4',
  focus: `测试考点${i}`,
  segs: [
    { r: 'adv', t: 'Although remote work ^offers^ flexibility,', n: '让步状语从句。', k: 'adv_concession' },
    { r: 'main', t: 'many employees *miss*', n: '主句主语和谓语。', k: 'main' },
    { r: 'main', t: 'the informal conversations', n: '宾语。', k: 'main' },
    {
      r: 'attr',
      t: `that ^used^ to happen in the office every single day for team ${i}.`,
      n: '定语从句。',
      k: 'attr_r',
    },
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

let gradeReply: unknown = null;
let gradeReplyGetter: (prompt?: string) => unknown = () => gradeReply;
const defaultSummary = () => ({ level: '汇总点评', good: [], issues: [], better: '' });
let summaryReplyGetter: (prompt?: string) => unknown = defaultSummary;
let generateReplyGetter: (prompt?: string) => unknown = () => null;

before(async () => {
  db = createTestDb();
  setQueryImpl(db.query);
  await migrate();
  llmServer = await startFakeLlm({
    grade: () => gradeReplyGetter(),
    summary: (prompt) => summaryReplyGetter(prompt),
    lookup: () => ({ lemma: 'publish', ipa: '/ˈpʌblɪʃ/', pos: 'v.', zh: '发表', more: '出版；公布' }),
    generate: (prompt) => generateReplyGetter(prompt),
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
  assert.match(r.body.error, /访问密码或邀请码/);
  assert.equal((await app.api('GET', '/api/nope')).status, 404);
});

test('密码错误会提示剩余次数，输对后拿到 Cookie', async () => {
  const wrong = await app.api('POST', '/api/unlock', { password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body.error, /密码或邀请码不对，还可以再试 4 次/);
  const ok = await app.api('POST', '/api/unlock', { password: 'open-sesame-42' });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie ?? '', /^ss_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
  assert.deepEqual(ok.body, { ok: true, unlocked: true, role: 'owner', name: '' });
  assert.deepEqual((await app.api('GET', '/api/session')).body, { unlocked: true, role: 'owner', name: '' });
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
  assert.deepEqual(
    list.map((s: Sentence) => s.id),
    ['s-20261013-01', 's-20261013-02', 's-20261013-03', 's-20261013-04', 's-20261013-05', 's-20261013-06'],
  );
  const s = list[0];
  for (const k of [
    'id',
    'created',
    'batch',
    'source',
    'level',
    'focus',
    'segs',
    'trunk',
    'trunkZh',
    'trap',
    'tip',
    'ref',
    'opts',
    'words',
    'phrases',
  ]) {
    assert.ok(k in s, `缺少字段 ${k}`);
  }
  assert.equal(s.batch, '2026-10-13');
  assert.ok(Array.isArray(s.segs) && s.segs[0].r === 'main');
  const since = await app.api('GET', `/api/sentences?since=${encodeURIComponent(list[3].created)}`);
  assert.deepEqual(
    since.body.sentences.map((x: Sentence) => x.id),
    ['s-20261013-05', 's-20261013-06'],
  );
  assert.equal((await app.api('GET', '/api/sentences?since=garbage')).status, 400);
});

test('练习记录：导入的记录可读，部分更新只改传入的字段', async () => {
  const list = (await app.api('GET', '/api/records')).body.records;
  assert.equal(list.length, 3);
  const r2 = list.find((r: PracticeRecord) => r.sentenceId === 's-20261013-02');
  assert.equal(r2.done, true);
  assert.ok(r2.draft.length > 0);

  const put = await app.api('PUT', '/api/records/s-20261013-04', { draft: '草稿一' });
  assert.equal(put.status, 200);
  assert.equal(put.body.record.draft, '草稿一');
  assert.equal(put.body.record.done, false);

  const put2 = await app.api('PUT', '/api/records/s-20261013-04', {
    verbs: { ok: 3, total: 4, wrong: 1 },
    choice: { pick: 2, ok: true },
    done: true,
  });
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

test('AI 批改：默认只调用 1 次模型；分数夹到范围内，总分后端计算，找不到的问题片段被丢掉', async () => {
  const text = '尽管远程工作很灵活，许多员工错过了办公室的谈话。';
  gradeReply = {
    acc: 55,
    flu: 20,
    comp: 30,
    total: 999,
    level: '基本准确',
    good: ['结构理解正确'],
    issues: [
      { src: '错过了', type: '误译', why: 'miss 这里是怀念', fix: '怀念' },
      { src: '根本不存在的片段', type: '用词', why: 'x', fix: 'y' },
    ],
    better: '尽管远程工作很灵活，许多员工怀念办公室里的闲聊。',
  };
  const before = llmServer.calls.length;
  const r = await app.api('POST', '/api/grade', { sentenceId: 's-20261013-02', text });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.body.attempt;
  assert.equal(a.acc, 40);
  assert.equal(a.total, 90);
  assert.equal(a.feedback.level, '基本准确');
  assert.equal(a.feedback.issues.length, 1);
  assert.equal(a.feedback.runs, undefined, '没开准确度提升时不记每次的分数');
  assert.equal(a.model, 'fake-main');
  assert.equal(a.inputTokens, 700);
  assert.equal(llmServer.calls.length - before, 1, '没开准确度提升：只调用 1 次，不汇总');
  const call = llmServer.calls.at(-1);
  assert.ok(call);
  assert.equal(call.auth, 'Bearer test-key');
  assert.equal(call.path, '/v1/chat/completions');
  assert.deepEqual(call.data.response_format, { type: 'json_object' });
  assert.deepEqual(
    call.data.messages.map((m: { role: string }) => m.role),
    ['system', 'user'],
    '单独的新对话，不带别的对话记录',
  );
  assert.ok(call.prompt?.includes(text));
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

test('AI 批改：模型返回非 JSON 或缺分数时自动重试一次', async () => {
  await db.raw('DELETE FROM ai_usage');
  const replies = ['抱歉我不太明白', { acc: 35, flu: 25, comp: 28, issues: [], good: [], level: '很好', better: '' }];
  let n = 0;
  gradeReplyGetter = () => replies[n++];
  let before = llmServer.calls.length;
  let r = await app.api('POST', '/api/grade', { sentenceId: 's-20261013-03', text: '一段译文' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.attempt.total, 88);
  assert.equal(llmServer.calls.length - before, 2);

  // 两次都没给分数：报错，不算批改次数
  gradeReplyGetter = () => ({ level: '没给分数' });
  before = llmServer.calls.length;
  r = await app.api('POST', '/api/grade', { sentenceId: 's-20261013-03', text: '一段译文' });
  gradeReplyGetter = () => gradeReply;
  assert.equal(r.status, 502);
  assert.equal(llmServer.calls.length - before, 2);
  assert.equal((await app.api('GET', '/api/usage')).body.grades, 1);
});

test('准确度提升：打开后后台 5 次独立评分 + 1 次汇总，每次都是单独的新对话', async () => {
  await db.raw('DELETE FROM ai_usage');
  const on = await app.api('PUT', '/api/settings/practice', { accuracyBoost: true });
  assert.equal(on.body.accuracyBoost, true);
  const text = '尽管远程工作很灵活，许多员工错过了办公室的谈话。';
  const issues = [
    { src: '错过了', type: '误译', why: 'miss 这里是怀念', fix: '怀念' },
    { src: '根本不存在的片段', type: '用词', why: 'x', fix: 'y' },
  ];
  const better = '尽管远程工作很灵活，许多员工怀念办公室里的闲聊。';
  gradeReply = { acc: 36, flu: 20, comp: 30, level: '基本准确', good: ['结构理解正确'], issues, better };
  summaryReplyGetter = () => ({ level: '基本准确，个别词误译', good: ['结构理解正确'], issues, better });
  const before = llmServer.calls.length;
  const r = await app.api('POST', '/api/grade', { sentenceId: 's-20261013-02', text });
  summaryReplyGetter = defaultSummary;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.body.attempt;
  assert.equal(a.total, 86);
  assert.equal(a.feedback.level, '基本准确，个别词误译', '显示的是汇总后的批注');
  assert.equal(a.feedback.issues.length, 1, '汇总批注里找不到的问题片段也会被丢掉');
  assert.equal(a.feedback.runs.length, 5);
  assert.equal(a.inputTokens, 700 * 6, '6 次请求的用量加起来');

  const calls = llmServer.calls.slice(before);
  assert.equal(calls.length, 6, '5 次评分 + 1 次汇总');
  for (const call of calls) {
    assert.equal(call.auth, 'Bearer test-key');
    // 每次都是单独的新对话：只有系统提示和这一次的提示词，不带别的对话记录
    assert.deepEqual(
      call.data.messages.map((m: { role: string }) => m.role),
      ['system', 'user'],
    );
  }
  const grades = calls.filter((c) => !c.prompt?.includes('汇总多份独立批改'));
  assert.equal(grades.length, 5);
  assert.ok(grades.every((c) => c.prompt === grades[0]?.prompt && c.prompt?.includes(text)));
  const summary = calls.at(-1)?.prompt ?? '';
  assert.ok(summary.includes('汇总多份独立批改'), '最后一次是汇总');
  assert.ok(summary.includes('准确 36，通顺 20，完整 30，总分 86'));
  assert.equal((await app.api('GET', '/api/usage')).body.grades, 1, '后台评分几次都只算一次批改');
});

test('准确度提升：某次评分不是 JSON 或缺分数时，这一次自动重试', async () => {
  await db.raw('DELETE FROM ai_usage');
  const bad: unknown[] = ['抱歉我不太明白', { level: '没给分数' }];
  let n = 0;
  gradeReplyGetter = () => bad[n++] ?? { acc: 35, flu: 25, comp: 28, issues: [], good: [], level: '很好', better: '' };
  const before = llmServer.calls.length;
  const r = await app.api('POST', '/api/grade', { sentenceId: 's-20261013-03', text: '一段译文' });
  gradeReplyGetter = () => gradeReply;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.attempt.total, 88);
  assert.equal(r.body.attempt.feedback.runs.length, 5);
  assert.equal(llmServer.calls.length - before, 8, '5 次评分 + 2 次重试 + 1 次汇总');
});

test('准确度提升：5 次独立评分取平均，汇总批注能看到每一次的结果', async () => {
  await db.raw('DELETE FROM ai_usage');
  const scores = [
    [30, 20, 25],
    [32, 21, 25],
    [34, 22, 26],
    [36, 23, 26],
    [38, 24, 28],
  ];
  let n = 0;
  gradeReplyGetter = () => {
    const [acc, flu, comp] = scores[n++ % scores.length] ?? [];
    return { acc, flu, comp, level: `第 ${n} 次的总评`, good: [], issues: [], better: '' };
  };
  let seen = '';
  summaryReplyGetter = (p) => {
    seen = p ?? '';
    return { level: '理解到位，表达还可以更自然', good: ['主干正确'], issues: [], better: '' };
  };
  const r = await app.api('POST', '/api/grade', { sentenceId: 's-20261013-03', text: '另一段译文' });
  gradeReplyGetter = () => gradeReply;
  summaryReplyGetter = defaultSummary;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.body.attempt;
  assert.deepEqual([a.acc, a.flu, a.comp, a.total], [34, 22, 26, 82]);
  assert.equal(a.feedback.level, '理解到位，表达还可以更自然');
  assert.deepEqual(
    a.feedback.runs.map((x: { acc: number }) => x.acc).sort((x: number, y: number) => x - y),
    [30, 32, 34, 36, 38],
  );
  for (let i = 1; i <= 5; i++) assert.ok(seen.includes(`第 ${i} 份：`));
  assert.ok(seen.includes('准确 34，通顺 22，完整 26，总分 82'));
  const saved = (await app.api('GET', '/api/attempts?sentenceId=s-20261013-03')).body.attempts[0];
  assert.equal(saved.total, 82);
  assert.equal(saved.feedback.runs.length, 5);
});

test('准确度提升：汇总没做成时，用总分最接近平均分的那一次批注', async () => {
  await db.raw('DELETE FROM ai_usage');
  const scores = [
    [20, 10, 10],
    [30, 20, 20],
    [35, 25, 25],
    [36, 26, 26],
    [40, 30, 30],
  ];
  let n = 0;
  gradeReplyGetter = () => {
    const [acc = 0, flu = 0, comp = 0] = scores[n++ % scores.length] ?? [];
    return { acc, flu, comp, level: `总分 ${acc + flu + comp}`, good: [], issues: [], better: '' };
  };
  summaryReplyGetter = () => ({ status: 500, body: { error: { message: 'boom' } } });
  const before = llmServer.calls.length;
  const r = await app.api('POST', '/api/grade', { sentenceId: 's-20261013-03', text: '第三段译文' });
  gradeReplyGetter = () => gradeReply;
  summaryReplyGetter = defaultSummary;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.attempt.total, 76);
  assert.equal(r.body.attempt.feedback.level, '总分 70');
  assert.equal(llmServer.calls.length - before, 7, '汇总出错时重试一次');
});

test('准确度提升：有几次评分失败时，按成功的几次取平均', async () => {
  await db.raw('DELETE FROM ai_usage');
  let n = 0;
  gradeReplyGetter = () =>
    n++ < 2
      ? { status: 401, body: { error: { message: 'nope' } } }
      : { acc: 30, flu: 21, comp: 24, issues: [], good: [], level: '还行', better: '' };
  const r = await app.api('POST', '/api/grade', { sentenceId: 's-20261013-03', text: '第四段译文' });
  gradeReplyGetter = () => gradeReply;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.attempt.total, 75);
  assert.equal(r.body.attempt.feedback.runs.length, 3);
});

test('准确度提升：几次评分全部失败时报错，不算批改次数', async () => {
  await db.raw('DELETE FROM ai_usage');
  gradeReplyGetter = () => ({ status: 401, body: { error: { message: 'nope' } } });
  const r = await app.api('POST', '/api/grade', { sentenceId: 's-20261013-03', text: '第五段译文' });
  gradeReplyGetter = () => gradeReply;
  assert.equal(r.status, 502);
  assert.match(r.body.error, /API 密钥/);
  assert.equal((await app.api('GET', '/api/usage')).body.grades, 0);
});

test('准确度提升：关掉后又只调用 1 次模型', async () => {
  await db.raw('DELETE FROM ai_usage');
  const off = await app.api('PUT', '/api/settings/practice', { accuracyBoost: false });
  assert.equal(off.body.accuracyBoost, false);
  gradeReply = { acc: 30, flu: 20, comp: 20, issues: [], good: [], level: 'ok', better: '' };
  const before = llmServer.calls.length;
  const r = await app.api('POST', '/api/grade', { sentenceId: 's-20261013-03', text: '第六段译文' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.attempt.total, 70);
  assert.equal(llmServer.calls.length - before, 1);
});

test('查词：第一次调用模型并缓存，第二次直接读缓存', async () => {
  const before = llmServer.calls.length;
  const a = await app.api('POST', '/api/lookup', { sentenceId: 's-20261013-01', word: 'Published' });
  assert.equal(a.status, 200);
  assert.equal(a.body.cached, false);
  assert.equal(a.body.data.zh, '发表');
  assert.equal(llmServer.calls.at(-1)?.data.model, 'fake-light');
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
          sentenceFor(2, {
            segs: [
              { r: 'main', t: '*Too* short.', n: '', k: 'main' },
              { r: 'main', t: 'x', n: '', k: 'main' },
            ],
          }),
          sentenceFor(3, { opts: [{ t: 'a', ok: true }, { t: 'b', ok: true }, { t: 'c' }] }),
        ],
      };
    }
    return { sentences: [sentenceFor(4), sentenceFor(5), sentenceFor(6), sentenceFor(7)] };
  };
  // 测试用的句子都是四级
  assert.equal((await app.api('PUT', '/api/settings/practice', { levels: ['CET-4'] })).status, 200);
  const r = await app.api('POST', '/api/sentences/generate');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.added.length, 5);
  assert.equal(round, 2);
  assert.match(r.body.added[0], /^s-\d{8}-\d{6}-1$/);
  const all = (await app.api('GET', '/api/sentences')).body.sentences;
  assert.equal(all.length, 11);
  assert.equal(all.at(-1).source, 'extra');
});

test('每日出题：今天已经出过就不再出', async () => {
  generateReplyGetter = () => ({
    sentences: [sentenceFor(11), sentenceFor(12), sentenceFor(13), sentenceFor(14), sentenceFor(15)],
  });
  const ids = await ai.generate(await ownerAccount(), { source: 'daily', n: 5, levels: ['CET-4'] });
  assert.equal(ids.length, 5);
  assert.match(ids[0], /^s-\d{8}-d1$/);
  const today = (await app.api('GET', '/api/sentences')).body.sentences.at(-1).batch;
  assert.equal(await repo.hasDailyFor('owner', today), true);
});

test('删除句子会连带删除它的练习记录', async () => {
  assert.equal((await app.api('DELETE', '/api/sentences/s-20261013-04')).status, 200);
  assert.equal((await app.api('DELETE', '/api/sentences/s-20261013-04')).status, 404);
  const recs = (await app.api('GET', '/api/records')).body.records;
  assert.ok(!recs.some((r: PracticeRecord) => r.sentenceId === 's-20261013-04'));
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

// ---- 每日任务：难度、句数、加练 ---------------------------------------------------
import { planLevels, createPractice } from '../src/practice.ts';

/** 假模型：按提示词里“按顺序出：第 1 句 CET-6，…”的难度出题 */
let seq = 100;
const followPlan = (prompt = '') => {
  const order = /按顺序出：(.*?)。/.exec(prompt)?.[1]?.match(/CET-[46]/g) ?? [];
  return { sentences: order.map((level) => sentenceFor(seq++, { level })) };
};

test('难度分配：只选一种全是它，两种都选各占一半', () => {
  assert.deepEqual(planLevels(3, ['CET-6']), ['CET-6', 'CET-6', 'CET-6']);
  for (const n of [1, 4, 5, 10]) {
    const plan = planLevels(n, ['CET-4', 'CET-6']);
    const four = plan.filter((l) => l === 'CET-4').length;
    assert.equal(plan.length, n);
    assert.ok(Math.abs(four - (n - four)) <= 1, `n=${n} 四级 ${four} 句`);
  }
});

test('每日任务设置：默认值、校验、保存后重启还在', async () => {
  const base = { maxDaily: 10, serverDaily: true, accuracyBoost: false };
  let r = await app.api('GET', '/api/settings/practice');
  assert.deepEqual(r.body, { levels: ['CET-4'], dailyCount: 5, autoDaily: true, dailyAt: '07:50', ...base });
  const bads = [
    { dailyCount: 11 },
    { dailyCount: 0 },
    { dailyCount: 2.5 },
    { levels: [] },
    { levels: ['CET-8'] },
    { dailyAt: '24:00' },
    { dailyAt: '7:5' },
    { dailyAt: 750 },
    { autoDaily: 'no' },
    { accuracyBoost: 'yes' },
  ];
  for (const bad of bads) {
    assert.equal((await app.api('PUT', '/api/settings/practice', bad)).status, 400, JSON.stringify(bad));
  }
  r = await app.api('PUT', '/api/settings/practice', { levels: ['CET-6', 'CET-4'], dailyCount: 7 });
  assert.deepEqual(r.body, { levels: ['CET-4', 'CET-6'], dailyCount: 7, autoDaily: true, dailyAt: '07:50', ...base });
  // 自己设时间（7:05 存成 07:05）、关掉自动生成；只改一项时其它不变
  r = await app.api('PUT', '/api/settings/practice', { dailyAt: '7:05' });
  assert.equal(r.body.dailyAt, '07:05');
  r = await app.api('PUT', '/api/settings/practice', { autoDaily: false });
  assert.deepEqual(r.body, { levels: ['CET-4', 'CET-6'], dailyCount: 7, autoDaily: false, dailyAt: '07:05', ...base });
  // 准确度提升：只改这一项，其它不变
  r = await app.api('PUT', '/api/settings/practice', { accuracyBoost: true });
  assert.deepEqual(r.body, {
    levels: ['CET-4', 'CET-6'],
    dailyCount: 7,
    autoDaily: false,
    dailyAt: '07:05',
    ...base,
    accuracyBoost: true,
  });
  const p2 = createPractice(cfg);
  assert.equal(p2.get(await repo.getAccount('owner')).dailyCount, 7);
  assert.equal(p2.get(await repo.getAccount('owner')).dailyAt, '07:05');
  assert.equal(p2.get(await repo.getAccount('owner')).accuracyBoost, true);
  await app.api('PUT', '/api/settings/practice', { accuracyBoost: false });
  // .env 关掉每日出题时告诉页面
  assert.equal(createPractice(loadConfig({ DAILY_GENERATE: '0' })).get({}).serverDaily, false);
  await app.api('PUT', '/api/settings/practice', { autoDaily: true, dailyAt: '07:50' });
});

test('每日自动出题：到了账户自己设的时间才出，关掉就不出，错过了会补上', async () => {
  const { createDailyRunner } = await import('../src/daily.ts');
  const practice = createPractice(cfg);
  const calls: { id: string; n?: number }[] = [];
  const fakeAi = {
    generate: async (acc: { id: string }, o: { n?: number } = {}) => (calls.push({ id: acc.id, ...o }), ['x']),
  };
  let clock = new Date('2030-01-02T01:29:00Z'); // 北京时间 09:29
  const runner = createDailyRunner({
    ai: fakeAi,
    llmFor: async () => ({ ready: () => true }),
    practice,
    log: quiet,
    now: () => clock,
  });
  await app.api('PUT', '/api/settings/practice', { autoDaily: true, dailyAt: '09:30', dailyCount: 3 });
  await runner.tick();
  assert.equal(calls.length, 0, '还没到 9:30');
  clock = new Date('2030-01-02T01:30:00Z');
  await runner.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.n, 3);
  await runner.tick();
  assert.equal(calls.length, 1, '一天只出一次');
  // 第二天：关掉自动生成就不出；打开后时间已经过了，马上补上
  clock = new Date('2030-01-03T02:00:00Z'); // 北京时间 10:00
  await app.api('PUT', '/api/settings/practice', { autoDaily: false });
  await runner.tick();
  assert.equal(calls.length, 1);
  await app.api('PUT', '/api/settings/practice', { autoDaily: true, dailyAt: '08:00' });
  await runner.tick();
  assert.equal(calls.length, 2);
  await app.api('PUT', '/api/settings/practice', { dailyAt: '07:50', dailyCount: 7 });
});

test('加练：四六级混合，超过 5 句分两次请求，句子打乱顺序', async () => {
  generateReplyGetter = followPlan;
  const before = llmServer.calls.length;
  const gensBefore = (await app.api('GET', '/api/usage')).body.gens;
  const r = await app.api('POST', '/api/sentences/generate', { kind: 'extra', count: 7 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.added.length, 7);
  const calls = llmServer.calls.slice(before).map((c) => c.prompt ?? '');
  const prompts = calls.filter((p) => !p.includes('逐句核对句子里'));
  assert.equal(prompts.length, 2);
  assert.equal(calls.length - prompts.length, 2, '每批出题后各复核一次');
  // 两批同时请求，到达假模型的先后不固定，只看两批的句数
  const batchSizes = prompts.map(
    (p) => /按顺序出：(第 \d 句 CET-[46][，。])+/.exec(p)?.[0].match(/第 \d 句/g)?.length ?? 0,
  );
  assert.deepEqual(
    batchSizes.sort((a, b) => a - b),
    [2, 5],
  );
  const all = (await app.api('GET', '/api/sentences')).body.sentences;
  const added = all.filter((s: Sentence) => r.body.added.includes(s.id));
  const four = added.filter((s: Sentence) => s.level === 'CET-4').length;
  assert.ok(four === 3 || four === 4, `四级 ${four} 句`);
  assert.ok(added.every((s: Sentence) => s.source === 'extra'));
  assert.equal((await app.api('GET', '/api/usage')).body.gens, gensBefore + 1, '加练算一次出题');
  assert.equal((await app.api('POST', '/api/sentences/generate', { count: 11 })).status, 400);
});

test('难度不对的句子会被丢掉并补出', async () => {
  await app.api('PUT', '/api/settings/practice', { levels: ['CET-6'] });
  let round = 0;
  generateReplyGetter = (prompt) => {
    round += 1;
    // 第一次全写成四级（不要的），第二次按要求
    return round === 1 ? { sentences: [sentenceFor(seq++), sentenceFor(seq++)] } : followPlan(prompt);
  };
  const r = await app.api('POST', '/api/sentences/generate', { count: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(round, 2);
  const all = (await app.api('GET', '/api/sentences')).body.sentences;
  assert.ok(all.filter((s: Sentence) => r.body.added.includes(s.id)).every((s: Sentence) => s.level === 'CET-6'));
});

test('今日任务：已经生成够了返回 409；调大每天句数后可以补齐，编号接着排', async () => {
  generateReplyGetter = followPlan;
  await app.api('PUT', '/api/settings/practice', { levels: ['CET-4', 'CET-6'], dailyCount: 5 });
  const gensBefore = (await app.api('GET', '/api/usage')).body.gens;
  assert.equal((await app.api('POST', '/api/sentences/generate', { kind: 'daily' })).status, 409);
  await app.api('PUT', '/api/settings/practice', { dailyCount: 7 });
  const r = await app.api('POST', '/api/sentences/generate', { kind: 'daily' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.added.map((id: string) => id.replace(/^s-\d{8}-/, '')).sort(), ['d6', 'd7']);
  assert.equal((await app.api('GET', '/api/usage')).body.gens, gensBefore, '今日任务不算加练次数');
  assert.equal((await app.api('POST', '/api/sentences/generate', { kind: 'daily' })).status, 409);
});

test('编号被占用时顺延：删掉一句今日任务后补齐，同一秒内加练两次', async () => {
  generateReplyGetter = followPlan;
  const day = (await app.api('GET', '/api/usage')).body.day.replace(/-/g, '');
  assert.equal((await app.api('DELETE', `/api/sentences/s-${day}-d2`)).status, 200);
  const r = await app.api('POST', '/api/sentences/generate', { kind: 'daily' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.added.length, 1);
  assert.match(r.body.added[0], /-d8$/, 'd1–d7 里 d2 删了、d7 还在，新句子不能撞到已有编号');
  const [a, b] = await Promise.all([
    app.api('POST', '/api/sentences/generate', { count: 2 }),
    app.api('POST', '/api/sentences/generate', { count: 2 }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(new Set([...a.body.added, ...b.body.added]).size, 4);
});

// ---- 谓语标注：规则校验、AI 复核、做题时修正 ---------------------------------
const professor = (marks: string, trap = '从句中 conducted 是过去分词作定语，不是谓语。') =>
  sentenceFor(0, {
    segs: [
      { r: 'main', t: 'The professor *explained*', n: '主句主语和谓语。', k: 'main' },
      { r: 'noun', t: marks, n: '宾语从句。', k: 'noun_obj' },
    ],
    trap,
  });

test('规则校验：引导词、陷阱里说不是谓语的词被标成谓语时不通过', async () => {
  const { checkSentence } = await import('../src/validate.ts');
  const bad1 = checkSentence(
    professor(
      '^that^ the experiment, conducted last week, ^had failed^ due to a simple error in measuring the temperature.',
    ),
    { strict: true },
  );
  assert.ok(!bad1.ok);
  assert.match(bad1.reason, /that/);
  const bad2 = checkSentence(
    professor(
      'that the experiment, ^conducted^ last week, ^had failed^ due to a simple error in measuring the temperature.',
    ),
    { strict: true },
  );
  assert.ok(!bad2.ok);
  assert.match(bad2.reason, /陷阱/);
  const good = checkSentence(
    professor(
      'that the experiment, conducted last week, ^had failed^ due to a simple error in measuring the temperature.',
    ),
    { strict: true },
  );
  assert.ok(good.ok, good.ok ? '' : good.reason);
});

test('出题：复核发现标错时按复核结果改正，对不上的句子丢掉', async () => {
  const subtle = (i: number) =>
    professor(
      `that the study, ^conducted^ by team ${i} last week, ^had failed^ because of a simple error in measuring the room temperature.`,
      '',
    );
  await app.api('PUT', '/api/settings/practice', { levels: ['CET-4'] });
  generateReplyGetter = () => ({ sentences: [subtle(1), subtle(2)] });
  llmServer.handlers.review = () => ({
    items: [
      { i: 1, main: 'explained', sub: ['had failed'], changed: true, note: 'conducted 是分词作定语' },
      { i: 2, main: 'explained', sub: ['was broken'], changed: true, note: '' },
    ],
  });
  try {
    const ids = await ai.generate(await ownerAccount(), { source: 'extra', n: 1, levels: ['CET-4'] });
    assert.equal(ids.length, 1);
    const s = await repo.getSentence('owner', ids[0] ?? '');
    assert.ok(s);
    assert.equal(
      s.segs[1]?.t,
      'that the study, conducted by team 1 last week, ^had failed^ because of a simple error in measuring the room temperature.',
    );
  } finally {
    delete llmServer.handlers.review;
  }
});

test('做题时修正：按单词位置改谓语，或让 AI 复查这一句', async () => {
  const s = {
    ...professor(
      '^that^ the experiment, ^conducted^ last week, ^had failed^ due to a simple error in measuring the temperature.',
    ),
    id: 'fix-1',
    created: new Date().toISOString(),
    batch: '2026-10-14',
    source: 'extra' as SentenceSource,
  } as NewSentence;
  await repo.insertSentence(s);
  // 单词下标：0 The 1 professor 2 explained 3 that 4 the 5 experiment, 6 conducted 7 last 8 week, 9 had 10 failed
  let r = await app.api('PUT', '/api/sentences/fix-1/predicates', {
    spans: [
      { kind: 'main', a: 2, b: 2 },
      { kind: 'sub', a: 9, b: 10 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(
    r.body.sentence.segs[1].t,
    'that the experiment, conducted last week, ^had failed^ due to a simple error in measuring the temperature.',
  );
  assert.equal(
    (await app.api('PUT', '/api/sentences/fix-1/predicates', { spans: [{ kind: 'sub', a: 9, b: 10 }] })).status,
    400,
    '没有主句谓语',
  );
  assert.equal(
    (await app.api('PUT', '/api/sentences/fix-1/predicates', { spans: [{ kind: 'main', a: 1, b: 3 }] })).status,
    400,
    '跨片段',
  );

  await repo.updateSegs('owner', 'fix-1', s.segs);
  llmServer.handlers.review = () => ({
    items: [{ i: 1, main: 'explained', sub: ['had failed'], changed: true, note: 'that 是连接词' }],
  });
  try {
    r = await app.api('POST', '/api/sentences/fix-1/review');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changed, true);
    assert.equal(
      r.body.sentence.segs[1].t,
      'that the experiment, conducted last week, ^had failed^ due to a simple error in measuring the temperature.',
    );
    r = await app.api('POST', '/api/sentences/fix-1/review');
    assert.equal(r.body.changed, false, '已经对了就不再改');
    llmServer.handlers.review = () => ({ items: [{ i: 1, main: 'explains', sub: [] }] });
    assert.equal((await app.api('POST', '/api/sentences/fix-1/review')).status, 502);
  } finally {
    delete llmServer.handlers.review;
  }
});
