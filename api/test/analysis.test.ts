// AI 学习分析：汇总数据只按每句第一次提交算，报告里的例子必须摘自自己的译文，每天有次数上限，各账户互相看不到
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setQueryImpl } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { createLlm } from '../src/llm.ts';
import * as repo from '../src/repo.ts';
import { migrate } from '../src/migrate.ts';
import { cleanReport, learningStats } from '../src/analysis.ts';
import { createTestDb, startFakeLlm, startApp, type FakeLlm, type TestApp, type TestDb } from './helpers.ts';
import type { RequestListener } from 'node:http';
import type { Attempt, Feedback, PracticeRecord, Sentence } from '@sentence-site/shared';

const quiet = { log() {}, error() {}, warn() {} };
let db: TestDb, fake: FakeLlm, handler: RequestListener, owner: TestApp;

const fb = (issues: Feedback['issues'] = [], good: string[] = []): Feedback => ({
  level: '还行',
  good,
  issues,
  better: '',
});

/** 写一句（第 n 句）和它的几次批改：scores 是每次的 [准确, 通顺, 完整]，texts 是每次的译文，按时间先后 */
async function addPractice(
  accountId: string,
  id: string,
  n: number,
  day: string,
  scores: [number, number, number][],
  texts: string[],
  feedback: Feedback[] = [],
) {
  await repo.insertSentence({
    level: 'CET-4',
    focus: `让步状语从句 ${n}`,
    segs: [
      { r: 'adv', t: 'Although remote work ^offers^ flexibility,', n: '让步状语从句。', k: 'adv_concession' },
      { r: 'main', t: 'many employees *miss*', n: '主句主语和谓语。', k: 'main' },
      { r: 'main', t: 'the informal conversations', n: '宾语。', k: 'main' },
      { r: 'attr', t: `that ^used^ to happen in the office for team ${n}.`, n: '定语从句。', k: 'attr_r' },
    ],
    trunk: 'many employees miss the informal conversations',
    trunkZh: '许多员工怀念非正式的交谈。',
    trap: '',
    tip: '让步从句译成“尽管……，但……”。',
    ref: `尽管远程办公很灵活，但许多员工怀念过去在办公室里的闲聊（${n}）。`,
    opts: [
      { t: '尽管远程办公很灵活，但许多员工怀念过去的闲聊。', ok: true, why: '好' },
      { t: '虽然远程工作提供灵活性，许多雇员错过非正式的对话。', ok: false, why: '硬译' },
      { t: '远程办公很灵活，所以员工不想去办公室。', ok: false, why: '逻辑错' },
    ],
    words: [],
    phrases: [],
    id,
    created: `${day}T01:00:00Z`,
    batch: day,
    source: 'extra',
    accountId,
  });
  for (const [i, [acc, flu, comp]] of scores.entries()) {
    await repo.insertAttempt({
      accountId,
      sentenceId: id,
      text: texts[i] ?? `第 ${i + 1} 次的译文`,
      acc,
      flu,
      comp,
      total: acc + flu + comp,
      feedback: feedback[i] ?? fb(),
      createdAt: `${day}T0${2 + i}:00:00Z`,
    });
  }
}

/** 一份能用的报告：第一个例子摘自 s1 的译文，第二个是学生没写过的话（要被丢掉） */
const goodReport = () => ({
  summary: '你的准确度在稳步提高，通顺还要加强。',
  curve: '总分从 60 涨到 88，主要是准确分在涨。',
  strengths: ['让步关系理解准确'],
  habits: [
    {
      name: '逐词硬译',
      detail: '照着英文词序一个词一个词地译',
      examples: [
        { src: '远程工作提供灵活性', fix: '远程办公很灵活' },
        { src: '学生没写过的话', fix: '随便' },
      ],
      advice: '先弄懂意思，再按中文习惯说',
    },
  ],
  weak: [{ name: '定语从句', detail: '长定语全堆在名词前' }],
  plan: ['每句先找主干再翻译'],
});
let analyzeReply: (prompt: string) => unknown = goodReport;
const analyzeCalls = () => fake.calls.filter((c) => c.prompt?.includes('英译汉长难句练习的记录汇总'));

before(async () => {
  db = createTestDb(`sentence_analysis_${process.pid}`);
  setQueryImpl(db.query);
  await migrate();
  fake = await startFakeLlm({ analyze: (prompt) => analyzeReply(prompt) });
  const cfg = loadConfig({
    ACCESS_PASSWORD: 'owner-pw-1',
    COOKIE_SECRET: 'a'.repeat(64),
    LLM_BASE_URL: fake.url,
    LLM_API_KEY: 'test-key',
    LLM_MODEL_MAIN: 'fake-main',
    LLM_MODEL_LIGHT: 'fake-light',
    DAILY_ANALYZE_LIMIT: '3',
  });
  handler = createApp(cfg, { llm: createLlm(cfg), log: quiet });
  owner = await startApp(handler);
  await owner.api('POST', '/api/unlock', { password: 'owner-pw-1' });
});

after(() => {
  owner?.close();
  fake?.close();
  db?.drop();
});

// ---- 汇总数据 -----------------------------------------------------------------------
const sentence = (id: string, level: string, ks: string[]): Sentence =>
  ({ id, level, focus: '考点', segs: ks.map((k) => ({ r: 'adv', t: 'x', n: '', k })), ref: '参考' }) as Sentence;
const attempt = (id: number, sentenceId: string, createdAt: string, s: [number, number, number], f?: Feedback) =>
  ({
    id,
    sentenceId,
    text: `译文${id}`,
    acc: s[0],
    flu: s[1],
    comp: s[2],
    total: s[0] + s[1] + s[2],
    feedback: f ?? null,
    createdAt,
  }) as Attempt;
const issue = (type: string) => ({ src: '片段', type, why: '', fix: '' });

test('汇总数据：分数按每句第一次提交算，改了再交的另算；曲线按北京时间的日期，结构不算主干', () => {
  const ss = [
    sentence('a', 'CET-4', ['main', 'adv_concession']),
    sentence('b', 'CET-6', ['main', 'attr_r', 'adv_concession']),
    sentence('c', 'CET-4', ['main', 'attr_r']),
    sentence('d', 'CET-6', ['main']),
  ];
  const at = [
    attempt(1, 'a', '2026-10-01T02:00:00Z', [20, 15, 15], fb([issue('翻译腔'), issue('误译')])),
    attempt(2, 'a', '2026-10-01T03:00:00Z', [38, 28, 28]), // 改了再交：不算进平均分和曲线
    attempt(3, 'b', '2026-10-02T02:00:00Z', [30, 20, 20], fb([issue('翻译腔')])),
    attempt(4, 'c', '2026-10-03T02:00:00Z', [36, 26, 28], fb([issue('漏译')])),
    attempt(5, 'd', '2026-10-03T23:30:00Z', [34, 26, 26]), // 北京时间已经是 10 月 4 日
    { ...attempt(6, 'd', '2026-10-04T01:00:00Z', [0, 0, 0]), total: null }, // 没分数的不算
    attempt(7, 'gone', '2026-10-04T02:00:00Z', [40, 30, 30]), // 句子不在了
  ];
  const records = [
    { sentenceId: 'a', verbs: { ok: 2, total: 3, wrong: 1 }, choice: { pick: 0, ok: true } },
    { sentenceId: 'b', verbs: { ok: 2, total: 2, wrong: 0 }, choice: { pick: 1, ok: false } },
    { sentenceId: 'gone', verbs: { ok: 9, total: 9, wrong: 0 }, choice: null },
  ] as PracticeRecord[];
  const s = learningStats(ss, records, at);
  assert.equal(s.sentences, 4);
  assert.equal(s.attempts, 5);
  assert.equal(s.firstAt, '2026-10-01T02:00:00Z');
  assert.equal(s.lastAt, '2026-10-03T23:30:00Z');
  assert.deepEqual(s.avg, { total: 74, acc: 30, flu: 22, comp: 22 });
  assert.deepEqual(s.earlier, { total: 60, acc: 25, flu: 18, comp: 18 });
  assert.deepEqual(s.recent, { total: 88, acc: 35, flu: 26, comp: 27 });
  assert.equal(s.curveUnit, 'day');
  assert.deepEqual(
    s.curve.map((p) => [p.from, p.to, p.n, p.total]),
    [
      ['2026-10-01', '2026-10-01', 1, 50],
      ['2026-10-02', '2026-10-02', 1, 70],
      ['2026-10-03', '2026-10-03', 1, 90],
      ['2026-10-04', '2026-10-04', 1, 86],
    ],
  );
  assert.deepEqual(s.issues, [
    { type: '翻译腔', n: 2, earlier: 2, recent: 0 },
    { type: '误译', n: 1, earlier: 1, recent: 0 },
    { type: '漏译', n: 1, earlier: 0, recent: 1 },
  ]);
  assert.deepEqual(s.points, [
    { k: 'adv_concession', n: 2, avg: 60 },
    { k: 'attr_r', n: 2, avg: 80 },
  ]);
  assert.deepEqual(s.levels, [
    { level: 'CET-4', n: 2, avg: 70 },
    { level: 'CET-6', n: 2, avg: 78 },
  ]);
  assert.deepEqual(s.retry, { sentences: 1, gain: 44 });
  assert.deepEqual(s.verbs, { sentences: 2, ok: 4, total: 5, wrong: 1 });
  assert.deepEqual(s.choice, { sentences: 2, ok: 1 });
});

test('汇总数据：练了一个月按周画曲线；没有批改时什么都是空的', () => {
  const ss = ['a', 'b', 'c', 'd'].map((id) => sentence(id, 'CET-4', ['main']));
  const at = [
    attempt(1, 'a', '2026-09-01T02:00:00Z', [30, 20, 20]),
    attempt(2, 'b', '2026-09-03T02:00:00Z', [30, 20, 20]),
    attempt(3, 'c', '2026-09-20T02:00:00Z', [30, 20, 20]),
    attempt(4, 'd', '2026-10-01T02:00:00Z', [30, 20, 20]),
  ];
  const s = learningStats(ss, [], at);
  assert.equal(s.curveUnit, 'week');
  assert.deepEqual(
    s.curve.map((p) => [p.from, p.to, p.n]),
    [
      ['2026-09-01', '2026-09-07', 2],
      ['2026-09-15', '2026-09-21', 1],
      ['2026-09-29', '2026-10-01', 1],
    ],
  );
  const empty = learningStats([], [], []);
  assert.equal(empty.sentences, 0);
  assert.deepEqual(empty.curve, []);
  assert.equal(empty.firstAt, '');
});

test('整理报告：例子要能在自己的译文里找到（不管空格），记下最近写过它的那句；字段有长度和条数上限', () => {
  const at = [
    { ...attempt(1, 'old', '2026-10-01T02:00:00Z', [30, 20, 20]), text: '尽管远程办公很灵活' },
    { ...attempt(2, 'new', '2026-10-02T02:00:00Z', [30, 20, 20]), text: '尽管远程办公 很灵活，但员工怀念闲聊' },
  ];
  const habit = (name: string) => ({
    name,
    detail: '表现',
    advice: '改法',
    examples: [
      { src: '远程办公很灵活', fix: '改一' },
      { src: '编出来的', fix: '改二' },
      { src: '员工怀念闲聊', fix: '' }, // 没给改法
      { src: '尽管', fix: '改三' },
      { src: '但员工', fix: '改四' },
    ],
  });
  const r = cleanReport(
    {
      summary: '长'.repeat(300),
      habits: [habit('一'), { name: '', detail: '没名字' }, habit('二'), habit('三'), habit('四'), habit('五')],
      strengths: ['好', '', '好', '好', '好'],
      weak: 'not a list',
      plan: ['一', '二', '三', '四', '五', '六'],
    },
    at,
  );
  assert.equal(r.summary.length, 200);
  assert.equal(r.curve, '');
  assert.deepEqual(
    r.habits.map((h) => h.name),
    ['一', '二', '三', '四'],
  );
  assert.deepEqual(r.habits[0]?.examples, [
    { src: '远程办公很灵活', fix: '改一', sentenceId: 'new' },
    { src: '尽管', fix: '改三', sentenceId: 'new' },
  ]);
  assert.equal(r.strengths.length, 3);
  assert.deepEqual(r.weak, []);
  assert.equal(r.plan.length, 5);
});

// ---- 接口 ---------------------------------------------------------------------------
test('批改不到 3 句不能分析，不占次数、不调用模型', async () => {
  assert.deepEqual((await owner.api('GET', '/api/analysis')).body, { analysis: null });
  const t1 = ['虽然远程工作提供灵活性，许多雇员错过非正式的对话。', '尽管远程办公很灵活，但许多员工怀念过去的闲聊。'];
  const issue1 = { src: '远程工作提供灵活性', type: '翻译腔', why: '照搬英文结构', fix: '远程办公很灵活' };
  await addPractice(
    'owner',
    'an-s1',
    1,
    '2026-10-01',
    [
      [20, 15, 15],
      [36, 26, 27],
    ],
    t1,
    [fb([issue1])],
  );
  await addPractice('owner', 'an-s2', 2, '2026-10-02', [[28, 20, 22]], ['远程办公灵活，员工想念闲聊。']);
  const r = await owner.api('POST', '/api/analysis');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /至少批改 3 句之后才能分析（现在批改过 2 句）/);
  assert.equal((await owner.api('GET', '/api/usage')).body.analyses, 0);
  assert.equal(analyzeCalls().length, 0);
});

test('分析一次：汇总数据和自己的译文交给主力模型，报告存下来，例子能点回原句', async () => {
  await addPractice(
    'owner',
    'an-s3',
    3,
    '2026-10-03',
    [[36, 27, 27]],
    ['尽管远程办公很灵活，但许多员工怀念过去的闲聊。'],
  );
  const r = await owner.api('POST', '/api/analysis');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.body.analysis;
  assert.equal(a.model, 'fake-main');
  assert.equal(a.stats.sentences, 3);
  assert.equal(a.stats.attempts, 4);
  assert.equal(a.report.summary, goodReport().summary);
  assert.deepEqual(a.report.habits[0].examples, [
    { src: '远程工作提供灵活性', fix: '远程办公很灵活', sentenceId: 'an-s1' },
  ]);

  const [call] = analyzeCalls();
  assert.equal(call?.data.model, 'fake-main');
  const prompt = call?.prompt ?? '';
  assert.match(prompt, /批改了 3 句（一共提交 4 次）/);
  assert.match(prompt, /让步状语从句：3 句/, '结构用出题规范里的名称');
  assert.match(prompt, /<student_material>[\s\S]*虽然远程工作提供灵活性[\s\S]*<\/student_material>/);
  assert.match(prompt, /“远程工作提供灵活性” → “远程办公很灵活”：照搬英文结构/);
  assert.doesNotMatch(prompt, /【上次分析】/);

  assert.deepEqual((await owner.api('GET', '/api/analysis')).body.analysis, a);
  const usage = (await owner.api('GET', '/api/usage')).body;
  assert.equal(usage.analyses, 1);
  assert.equal(usage.limits.analyze, 3);
  const tokens = (await owner.api('GET', '/api/usage/tokens')).body;
  assert.equal(tokens.byKind.find((k: { kind: string }) => k.kind === 'analyze')?.calls, 1);
});

test('再分析时带上上次的要点；回复缺内容时再试一次，还不行就报错、不占次数；同时点两次只分析一次；用完次数返回 429', async () => {
  let r = await owner.api('POST', '/api/analysis');
  assert.equal(r.status, 200);
  const prompt = analyzeCalls().at(-1)?.prompt ?? '';
  assert.match(prompt, /【上次分析】.*当时批改了 3 句/);
  assert.match(prompt, /当时指出的翻译习惯：逐词硬译/);

  const before = analyzeCalls().length;
  analyzeReply = () => ({ summary: '', habits: [], plan: [] });
  r = await owner.api('POST', '/api/analysis');
  assert.equal(r.status, 502);
  assert.match(r.body.error, /缺少内容/);
  assert.equal(analyzeCalls().length - before, 2, '再试了一次');
  assert.equal((await owner.api('GET', '/api/usage')).body.analyses, 2, '没成功的不算次数');
  analyzeReply = goodReport;

  const both = await Promise.all([owner.api('POST', '/api/analysis'), owner.api('POST', '/api/analysis')]);
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 409]);
  r = await owner.api('POST', '/api/analysis');
  assert.equal(r.status, 429);
  assert.match(r.body.error, /今天的学习分析次数用完了（3 次）/);
});

test('邀请账户只看得到、只分析自己的数据，也不会用到你的模型', async () => {
  const inv = (await owner.api('POST', '/api/admin/invites', { note: '小王' })).body.invite;
  const m = await startApp(handler);
  try {
    await m.api('POST', '/api/unlock', { password: inv.code });
    assert.deepEqual((await m.api('GET', '/api/analysis')).body, { analysis: null });
    let r = await m.api('POST', '/api/analysis');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /现在批改过 0 句/);
    for (const n of [1, 2, 3]) {
      await addPractice(inv.id, `${inv.id}-an-s${n}`, n, '2026-10-05', [[30, 20, 20]], ['我自己的译文']);
    }
    r = await m.api('POST', '/api/analysis');
    assert.equal(r.status, 503);
    assert.match(r.body.error, /填写你自己的模型和 API 密钥/);
    assert.equal((await m.api('GET', '/api/usage')).body.analyses, 0);
  } finally {
    m.close();
  }
});
