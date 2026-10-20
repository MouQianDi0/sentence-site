// token 用量：每次调用模型都记到当前账户名下；统计接口只给自己的；管理员在邀请码页看到各账户的用量
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setQueryImpl } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { createLlm } from '../src/llm.ts';
import * as repo from '../src/repo.ts';
import { migrate } from '../src/migrate.ts';
import { importExport } from '../src/importer.ts';
import { daysAgo } from '../src/tokens.ts';
import { createTestDb, startFakeLlm, startApp, type FakeLlm, type TestApp, type TestDb } from './helpers.ts';
import type { RequestListener } from 'node:http';
import type { TokenStats } from '@sentence-site/shared';

const quiet = { log() {}, error() {}, warn() {} };
let db: TestDb, fake: FakeLlm, handler: RequestListener, owner: TestApp;
let gradeReply: () => unknown = () => ({ acc: 30, flu: 20, comp: 20, issues: [], good: [], level: 'ok', better: '' });

const sentenceFor = (i: number, level: string) => ({
  level,
  focus: `考点${i}`,
  segs: [
    { r: 'adv', t: 'Although remote work ^offers^ flexibility,', n: '让步状语从句。', k: 'adv_concession' },
    { r: 'main', t: 'many employees *miss*', n: '主句主语和谓语。', k: 'main' },
    { r: 'main', t: 'the informal conversations', n: '宾语。', k: 'main' },
    {
      r: 'attr',
      t: `that ^used^ to happen in the office every single day for group ${i}.`,
      n: '定语从句。',
      k: 'attr_r',
    },
  ],
  trunk: 'many employees miss the informal conversations',
  trunkZh: '许多员工怀念非正式的交谈。',
  trap: '',
  tip: '让步从句译成“尽管……，但……”。',
  ref: '尽管远程办公很灵活，但许多员工怀念过去的闲聊。',
  opts: [
    { t: '尽管远程办公很灵活，但许多员工怀念过去的闲聊。', ok: true, why: '好' },
    { t: '虽然远程工作提供灵活性，许多雇员错过非正式的对话。', ok: false, why: '硬译' },
    { t: '远程办公很灵活，所以员工不想去办公室。', ok: false, why: '逻辑错' },
  ],
  words: [],
  phrases: [],
});
let seq = 500;

/** 当前账户的用量统计 */
const stats = async (app: TestApp, days?: number): Promise<TokenStats> => {
  const r = await app.api('GET', `/api/usage/tokens${days === undefined ? '' : `?days=${days}`}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const kindOf = (s: TokenStats, kind: string) => s.byKind.find((k) => k.kind === kind);

before(async () => {
  db = createTestDb(`sentence_tokens_${process.pid}`);
  setQueryImpl(db.query);
  await migrate();
  await importExport(JSON.parse(await fs.readFile(new URL('../seed/export.json', import.meta.url), 'utf8')));
  fake = await startFakeLlm({
    grade: () => gradeReply(),
    lookup: () => ({ lemma: 'publish', ipa: '/ˈpʌblɪʃ/', pos: 'v.', zh: '发表', more: '出版' }),
    generate: (prompt: string) => ({
      sentences: [sentenceFor(seq++, /第 1 句 (CET-[46])/.exec(prompt)?.[1] || 'CET-4')],
    }),
  });
  const cfg = loadConfig({
    ACCESS_PASSWORD: 'owner-pw-1',
    COOKIE_SECRET: 't'.repeat(64),
    LLM_BASE_URL: fake.url,
    LLM_API_KEY: 'test-key',
    LLM_MODEL_MAIN: 'fake-main',
    LLM_MODEL_LIGHT: 'fake-light',
    DAILY_GRADE_LIMIT: '50',
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

test('还没用过时：全是 0，每天补零，since 是 null', async () => {
  const s = await stats(owner);
  assert.equal(s.days, 30);
  assert.deepEqual(s.total, { input: 0, output: 0, calls: 0 });
  assert.equal(s.daily.length, 30);
  assert.equal(s.daily.at(-1)?.day, daysAgo(0));
  assert.ok(s.daily.every((d) => d.calls === 0));
  assert.deepEqual(s.byKind, []);
  assert.equal(s.since, null);
});

test('批改、查词、测试连接都记到自己名下，按用途和模型分开', async () => {
  assert.equal((await owner.api('POST', '/api/grade', { sentenceId: 's-20261013-01', text: '一段译文' })).status, 200);
  assert.equal((await owner.api('POST', '/api/lookup', { sentenceId: 's-20261013-01', word: 'publish' })).status, 200);
  const t = await owner.api('POST', '/api/settings/llm/test', {
    baseUrl: fake.url,
    apiKey: 'good-key',
    mainModel: 'fake-main',
    lightModel: '',
  });
  assert.equal(t.body.ok, true, JSON.stringify(t.body));

  const s = await stats(owner);
  // 假模型每次回复都报 700 输入、600 输出
  assert.deepEqual(s.today, { input: 2100, output: 1800, calls: 3 });
  assert.deepEqual(s.last7, s.today);
  assert.deepEqual(s.total, s.today);
  assert.equal(s.since, daysAgo(0));
  assert.deepEqual(s.daily.at(-1), { day: daysAgo(0), input: 2100, output: 1800, calls: 3 });
  assert.deepEqual(s.byKind.map((k) => k.kind).sort(), ['grade', 'lookup', 'test'], '批改、查词、测试连接分开');
  assert.deepEqual(
    s.byModel.map((m) => [m.model, m.calls]),
    [
      ['fake-main', 2],
      ['fake-light', 1],
    ],
    '查词用的是轻量模型；多的排在前面',
  );

  // 查过的词走缓存，不调用模型也不记
  await owner.api('POST', '/api/lookup', { sentenceId: 's-20261013-01', word: 'publish' });
  assert.equal((await stats(owner)).today.calls, 3);
});

test('准确度提升：后台 6 次请求都算进用量', async () => {
  await owner.api('PUT', '/api/settings/practice', { accuracyBoost: true });
  const before = kindOf(await stats(owner), 'grade');
  await owner.api('POST', '/api/grade', { sentenceId: 's-20261013-01', text: '第二段译文' });
  await owner.api('PUT', '/api/settings/practice', { accuracyBoost: false });
  const after = kindOf(await stats(owner), 'grade');
  assert.equal((after?.calls ?? 0) - (before?.calls ?? 0), 6);
  assert.equal((after?.input ?? 0) - (before?.input ?? 0), 6 * 700);
});

test('模型回复格式不对时，token 照样花了，也要记', async () => {
  const replies: unknown[] = ['抱歉我不太明白'];
  gradeReply = () => replies.shift() ?? { acc: 30, flu: 20, comp: 20, issues: [], good: [], level: 'ok', better: '' };
  const before = kindOf(await stats(owner), 'grade')?.calls ?? 0;
  assert.equal((await owner.api('POST', '/api/grade', { sentenceId: 's-20261013-02', text: '再来一段' })).status, 200);
  assert.equal((kindOf(await stats(owner), 'grade')?.calls ?? 0) - before, 2, '格式不对的那次 + 重试的那次');
});

test('出题和出题后的谓语复核分开记', async () => {
  const before = await stats(owner);
  const r = await owner.api('POST', '/api/sentences/generate', { count: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = await stats(owner);
  assert.equal((kindOf(after, 'generate')?.calls ?? 0) - (kindOf(before, 'generate')?.calls ?? 0), 1);
  assert.equal((kindOf(after, 'review')?.calls ?? 0) - (kindOf(before, 'review')?.calls ?? 0), 1);
});

test('统计范围：7 / 30 / 90 天，今天、近 7 天、近 30 天、累计各算各的', async () => {
  const base = await stats(owner);
  const put = (n: number, kind: string, input: number) =>
    repo.addTokens({ accountId: 'owner', day: daysAgo(n), kind, model: 'old-model', input, output: 0 });
  await put(10, 'lookup', 1000);
  await put(40, 'generate', 50_000);

  const week = await stats(owner, 7);
  assert.equal(week.days, 7);
  assert.equal(week.daily.length, 7);
  assert.equal(week.daily[0]?.day, daysAgo(6));
  assert.ok(!week.byModel.some((m) => m.model === 'old-model'), '10 天前的不在近 7 天的分类里');
  assert.equal(week.last30.input - base.last30.input, 1000, '近 30 天包含 10 天前的');
  assert.equal(week.total.input - base.total.input, 51_000, '累计包含 40 天前的');
  assert.equal(week.since, daysAgo(40));

  const month = await stats(owner, 30);
  assert.equal(month.daily.find((d) => d.day === daysAgo(10))?.input, 1000);
  assert.ok(!month.byModel.some((m) => m.model === 'old-model' && m.input > 1000), '40 天前的不在近 30 天里');

  const quarter = await stats(owner, 90);
  assert.equal(quarter.daily.length, 90);
  assert.equal(quarter.byModel.find((m) => m.model === 'old-model')?.input, 51_000);
  assert.equal(quarter.byKind[0]?.kind, 'generate', '多的排在前面');

  assert.equal((await stats(owner, 12345)).days, 30, '不认识的范围按 30 天');
});

test('各账户只看得到自己的用量；管理员在邀请码页看到每个邀请账户的用量', async () => {
  const inv = (await owner.api('POST', '/api/admin/invites', { note: '小张' })).body.invite;
  assert.deepEqual(inv.tokens, { last30: 0, total: 0 });
  const m = await startApp(handler);
  try {
    await m.api('POST', '/api/unlock', { password: inv.code });
    assert.equal((await stats(m)).total.calls, 0, '新账户看不到你的用量');
    await m.api('PUT', '/api/settings/llm', {
      provider: 'custom',
      baseUrl: fake.url,
      apiKey: 'member-key',
      mainModel: 'fake-main',
    });
    const ownerBefore = (await stats(owner)).total;
    assert.equal((await m.api('POST', '/api/grade', { sentenceId: 's-20261013-01', text: '译文' })).status, 404);
    const [mid] = (await m.api('POST', '/api/sentences/generate', { count: 1 })).body.added;
    assert.equal((await m.api('POST', '/api/grade', { sentenceId: mid, text: '尽管远程办公很灵活' })).status, 200);

    const mine = await stats(m);
    assert.equal(mine.total.calls, 3, '出题 + 复核 + 批改');
    assert.deepEqual((await stats(owner)).total, ownerBefore, '邀请账户的用量不算到你头上');

    const listed = (await owner.api('GET', '/api/admin/invites')).body.invites.find(
      (x: { id: string }) => x.id === inv.id,
    );
    assert.deepEqual(listed.tokens, { last30: 3 * 1300, total: 3 * 1300 });
    assert.equal((await m.api('GET', '/api/admin/invites')).status, 403, '邀请账户看不到别人的');

    // 改设备数返回的那一项也带着用量，页面上不会变成 0
    const changed = await owner.api('PUT', `/api/admin/invites/${inv.id}`, { deviceLimit: 3 });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual(changed.body.invite.tokens, listed.tokens);

    // 删除邀请账户，它的用量一起删掉
    await owner.api('DELETE', `/api/admin/invites/${inv.id}`);
    assert.equal(db.raw(`SELECT count(*) FROM token_usage WHERE account_id = '${inv.id}'`).trim(), '0');
  } finally {
    m.close();
  }
});

test('第一次建表时，把以前批改记录里的用量补进来（只补一次）', async () => {
  db.raw('DROP TABLE token_usage');
  await repo.insertAttempt({
    sentenceId: 's-20261013-03',
    text: '以前的批改',
    acc: 30,
    flu: 20,
    comp: 20,
    total: 70,
    feedback: null,
    model: 'legacy-model',
    inputTokens: 1234,
    outputTokens: 567,
    createdAt: '2026-09-30T20:00:00Z', // 北京时间 10 月 1 日凌晨
  });
  // 老库没有 schema_migrations：启动时 0001 会在已有数据上整份再执行一遍；执行两遍也只补一次
  for (let i = 0; i < 2; i++) {
    db.raw('DROP TABLE schema_migrations');
    await migrate();
  }
  const row = await repo.listTokens('owner', '2026-10-01');
  const legacy = row.filter((r) => r.model === 'legacy-model');
  assert.deepEqual(legacy, [
    { day: '2026-10-01', kind: 'grade', model: 'legacy-model', calls: 1, input: 1234, output: 567 },
  ]);
  const s = await stats(owner);
  assert.ok(s.total.input >= 1234);
});
