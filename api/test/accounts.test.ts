// 邀请码账户：只有 owner 能生成和管理；邀请码就是登录密码；每个账户的数据和模型配置互相独立；删除邀请码就删除账户和数据
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setQueryImpl } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { createLlm } from '../src/llm.ts';
import * as repo from '../src/repo.ts';
import { importExport } from '../src/importer.ts';
import { newCode, normalizeCode } from '../src/accounts.ts';
import { createTestDb, startFakeLlm, startApp, type FakeLlm, type TestApp, type TestDb } from './helpers.ts';
import type { AppConfig } from '../src/config.ts';
import type { RequestListener } from 'node:http';
import type { Device, Invite, PracticeRecord, Sentence } from '@sentence-site/shared';

const quiet = { log() {}, error() {}, warn() {} };
let db: TestDb, fake: FakeLlm, handler: RequestListener, owner: TestApp, cfg: AppConfig;

const sentenceFor = (i: number) => ({
  level: 'CET-4',
  focus: `考点${i}`,
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
let seq = 100;

/** 新开一个“浏览器”（独立的 Cookie），连到同一个服务 */
const client = () => startApp(handler);
/** 邀请账户在自己的设置页填模型配置（用自己的密钥） */
const configure = (m: TestApp, apiKey = 'member-key') =>
  m.api('PUT', '/api/settings/llm', { provider: 'custom', baseUrl: fake.url, apiKey, mainModel: 'fake-main' });

before(async () => {
  db = createTestDb(`sentence_accounts_${process.pid}`);
  setQueryImpl(db.query);
  await repo.ensureSchema(await fs.readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  await importExport(JSON.parse(await fs.readFile(new URL('../seed/export.json', import.meta.url), 'utf8')));
  fake = await startFakeLlm({
    grade: () => ({ acc: 30, flu: 20, comp: 20, issues: [], good: [], level: 'ok', better: '' }),
    lookup: () => ({ lemma: 'x', pos: 'n.', zh: '测试' }),
    // 按提示词要的难度出，否则会被当成“难度不对”丢掉
    generate: (prompt: string) => ({
      sentences: [{ ...sentenceFor(seq++), level: /第 1 句 (CET-[46])/.exec(prompt)?.[1] || 'CET-4' }],
    }),
  });
  cfg = loadConfig({
    ACCESS_PASSWORD: 'owner-pw-1',
    COOKIE_SECRET: 'k'.repeat(64),
    LLM_BASE_URL: fake.url,
    LLM_API_KEY: 'test-key',
    LLM_MODEL_MAIN: 'fake-main',
    DAILY_GRADE_LIMIT: '50',
  });
  handler = createApp(cfg, { llm: createLlm(cfg), log: quiet });
  owner = await client();
  await owner.api('POST', '/api/unlock', { password: 'owner-pw-1' });
});

after(() => {
  owner?.close();
  fake?.close();
  db?.drop();
});

test('邀请码格式：8 位、去掉易混字符，输入时大小写和横线都不影响', () => {
  for (let i = 0; i < 50; i++) assert.match(newCode(), /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(normalizeCode(' abcd-efgh '), 'ABCDEFGH');
});

test('只有 owner 能生成、查看、删除邀请码；邀请码登录后是 member', async () => {
  const created = await owner.api('POST', '/api/admin/invites', { note: '小王' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const inv = created.body.invite;
  assert.equal(inv.note, '小王');
  assert.match(inv.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(inv.lastSeenAt, null);

  const list = await owner.api('GET', '/api/admin/invites');
  assert.equal(list.body.invites[0].code, inv.code, '管理页能看到邀请码原文');

  const m = await client();
  try {
    const login = await m.api('POST', '/api/unlock', { password: inv.code.toLowerCase().replace('-', '') });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.deepEqual(login.body, { ok: true, unlocked: true, role: 'member', name: '小王' });
    assert.deepEqual((await m.api('GET', '/api/session')).body, { unlocked: true, role: 'member', name: '小王' });
    for (const [method, path] of [
      ['GET', '/api/admin/invites'],
      ['POST', '/api/admin/invites'],
      ['DELETE', `/api/admin/invites/${inv.id}`],
    ]) {
      const r = await m.api(method, path, method === 'POST' ? {} : undefined);
      assert.equal(r.status, 403, `${method} ${path}`);
    }
    assert.ok((await owner.api('GET', '/api/admin/invites')).body.invites[0].lastSeenAt, '登录后记下最近使用时间');
  } finally {
    m.close();
  }
});

test('每个账户的句库、记录、批改、用量、每日任务设置互相独立', async () => {
  const inv = (await owner.api('POST', '/api/admin/invites', { note: '小李' })).body.invite;
  const m = await client();
  try {
    await m.api('POST', '/api/unlock', { password: inv.code });
    await configure(m);
    const ownerSentences = (await owner.api('GET', '/api/sentences')).body.sentences;
    assert.ok(ownerSentences.length >= 6);
    assert.deepEqual((await m.api('GET', '/api/sentences')).body.sentences, [], '新账户句库是空的');

    // 别的账户的句子：看不到、删不掉、写不了记录、不能批改查词
    const sid = ownerSentences[0].id;
    assert.equal((await m.api('DELETE', `/api/sentences/${sid}`)).status, 404);
    assert.equal((await m.api('PUT', `/api/records/${sid}`, { done: true })).status, 404);
    assert.equal((await m.api('POST', '/api/grade', { sentenceId: sid, text: '译文' })).status, 404);
    assert.equal((await m.api('POST', '/api/lookup', { sentenceId: sid, word: 'work' })).status, 404);
    assert.equal((await m.api('POST', `/api/sentences/${sid}/review`)).status, 404);
    assert.deepEqual((await m.api('GET', '/api/records')).body.records, []);
    assert.deepEqual((await m.api('GET', '/api/attempts')).body.attempts, []);

    // 自己出题：id 带账户前缀，owner 看不到
    const gen = await m.api('POST', '/api/sentences/generate', { kind: 'extra', count: 1 });
    assert.equal(gen.status, 200, JSON.stringify(gen.body));
    const [mid] = gen.body.added;
    assert.match(mid, /^m[0-9a-f]{10}-s-\d{8}-\d{6}-1$/);
    assert.ok(!(await owner.api('GET', '/api/sentences')).body.sentences.some((s: Sentence) => s.id === mid));
    assert.equal((await owner.api('DELETE', `/api/sentences/${mid}`)).status, 404, 'owner 也不能动别人的句子');

    // 记录、批改、用量
    assert.equal((await m.api('PUT', `/api/records/${mid}`, { done: true })).status, 200);
    assert.equal((await m.api('POST', '/api/grade', { sentenceId: mid, text: '尽管远程办公很灵活' })).status, 200);
    assert.equal((await m.api('GET', '/api/records')).body.records.length, 1);
    assert.equal((await m.api('GET', '/api/attempts')).body.attempts.length, 1);
    const mu = (await m.api('GET', '/api/usage')).body;
    assert.equal(mu.grades, 1);
    assert.equal(mu.gens, 1);
    assert.ok(!(await owner.api('GET', '/api/records')).body.records.some((r: PracticeRecord) => r.sentenceId === mid));

    // 今日任务：各出各的，编号互不冲突
    await m.api('PUT', '/api/settings/practice', { dailyCount: 1 });
    const daily = await m.api('POST', '/api/sentences/generate', { kind: 'daily' });
    assert.equal(daily.status, 200, JSON.stringify(daily.body));
    assert.match(daily.body.added[0], /^m[0-9a-f]{10}-s-\d{8}-d1$/);

    // 每日任务设置
    await owner.api('PUT', '/api/settings/practice', { levels: ['CET-6'], dailyCount: 4 });
    await m.api('PUT', '/api/settings/practice', { levels: ['CET-4'], dailyCount: 2 });
    assert.equal((await owner.api('GET', '/api/settings/practice')).body.dailyCount, 4);
    assert.deepEqual((await m.api('GET', '/api/settings/practice')).body.levels, ['CET-4']);

    // 准确度提升也各管各的：你开了，邀请账户还是关着，它批改只调用 1 次
    await owner.api('PUT', '/api/settings/practice', { accuracyBoost: true });
    assert.equal((await m.api('GET', '/api/settings/practice')).body.accuracyBoost, false);
    const n0 = fake.calls.length;
    assert.equal((await m.api('POST', '/api/grade', { sentenceId: mid, text: '再批一次' })).status, 200);
    assert.equal(fake.calls.length - n0, 1);
    await owner.api('PUT', '/api/settings/practice', { accuracyBoost: false });
  } finally {
    m.close();
  }
});

test('邀请账户用自己填的模型和 API 密钥，看不到也用不到你的', async () => {
  const inv = (await owner.api('POST', '/api/admin/invites', { note: '自带密钥' })).body.invite;
  const m = await client();
  try {
    await m.api('POST', '/api/unlock', { password: inv.code });
    // 还没填：看不到你的配置，AI 用不了，不会偷偷用你的密钥
    const before = (await m.api('GET', '/api/settings/llm')).body;
    assert.equal(before.source, 'none');
    assert.equal(before.hasKey, false);
    assert.equal(before.envAvailable, false, '邀请账户没有 .env 可用');
    assert.deepEqual(before.providers, {});
    assert.equal((await m.api('GET', '/api/usage')).body.aiReady, false);
    const calls0 = fake.calls.length;
    const no = await m.api('POST', '/api/sentences/generate', { count: 1 });
    assert.equal(no.status, 503);
    assert.match(no.body.error, /填写你自己的模型和 API 密钥/);
    assert.equal(fake.calls.length, calls0, '没有发出任何请求');
    assert.equal((await m.api('DELETE', '/api/settings/llm')).status, 200, '改回 .env 也只是变成没配置');

    // 填上自己的：用自己的密钥调用，你的配置不变
    const saved = await configure(m, 'member-key-xyz');
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.source, 'page');
    assert.equal((await m.api('GET', '/api/usage')).body.aiReady, true);
    const n0 = fake.calls.length;
    const [mid] = (await m.api('POST', '/api/sentences/generate', { count: 1 })).body.added;
    await m.api('POST', '/api/grade', { sentenceId: mid, text: '译文' });
    const memberAuth = new Set(fake.calls.slice(n0).map((c) => c.auth));
    assert.deepEqual([...memberAuth], ['Bearer member-key-xyz']);

    const ownerView = (await owner.api('GET', '/api/settings/llm')).body;
    assert.equal(ownerView.source, 'env');
    assert.equal(ownerView.hasKey, true);
    const n1 = fake.calls.length;
    const [oid] = (await owner.api('POST', '/api/sentences/generate', { count: 1 })).body.added;
    await owner.api('POST', '/api/grade', { sentenceId: oid, text: '译文' });
    assert.deepEqual([...new Set(fake.calls.slice(n1).map((c) => c.auth))], ['Bearer test-key'], 'owner 还是用自己的');

    // 测试连接、模型列表也只用自己的配置
    assert.equal((await m.api('POST', '/api/settings/llm/models', {})).status, 200);
    const probe = await m.api('POST', '/api/settings/llm/test', {});
    assert.equal(probe.status, 200, JSON.stringify(probe.body));
    assert.equal(fake.calls.at(-1)?.auth, 'Bearer member-key-xyz');
  } finally {
    m.close();
  }
});

test('删除邀请码：账户立刻登不上，它的句子、记录、批改全部删除', async () => {
  const inv = (await owner.api('POST', '/api/admin/invites', { note: '要删的' })).body.invite;
  const m = await client();
  try {
    await m.api('POST', '/api/unlock', { password: inv.code });
    await configure(m);
    const [mid] = (await m.api('POST', '/api/sentences/generate', { count: 1 })).body.added;
    await m.api('POST', '/api/grade', { sentenceId: mid, text: '译文' });
    assert.equal((await owner.api('DELETE', `/api/admin/invites/${inv.id}`)).status, 200);
    assert.equal((await owner.api('DELETE', `/api/admin/invites/${inv.id}`)).status, 404);
    assert.equal((await m.api('GET', '/api/sentences')).status, 401, '旧 Cookie 失效');
    assert.deepEqual((await m.api('GET', '/api/session')).body, { unlocked: false });
    assert.equal((await m.api('POST', '/api/unlock', { password: inv.code })).status, 401, '邀请码不能再登录');
    const left = db.raw(
      `SELECT (SELECT count(*) FROM sentences WHERE id = '${mid}') + (SELECT count(*) FROM attempts WHERE sentence_id = '${mid}') + (SELECT count(*) FROM ai_usage WHERE account_id = '${inv.id}') + (SELECT count(*) FROM accounts WHERE id = '${inv.id}')`,
    );
    assert.equal(left.trim(), '0');
    assert.ok(!(await owner.api('GET', '/api/admin/invites')).body.invites.some((x: Invite) => x.id === inv.id));
    assert.equal((await owner.api('DELETE', '/api/admin/invites/owner')).status, 404, '不能删 owner');
  } finally {
    m.close();
  }
});

test('每个邀请码默认最多 2 台设备；同一个浏览器重复登录不多占名额；移除设备会让它马上退出', async () => {
  const inv = (await owner.api('POST', '/api/admin/invites', { note: '设备' })).body.invite;
  assert.equal(inv.deviceLimit, 2);
  assert.deepEqual(inv.devices, []);
  const IPHONE_WX =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.47';
  const WIN_EDGE =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0';
  const a = await startApp(handler, { ua: IPHONE_WX });
  const b = await startApp(handler, { ua: WIN_EDGE });
  const c = await client();
  const devicesOf = async () =>
    (await owner.api('GET', '/api/admin/invites')).body.invites.find((x: Invite) => x.id === inv.id)
      .devices as Device[];
  try {
    assert.equal((await a.api('POST', '/api/unlock', { password: inv.code })).status, 200);
    assert.ok(a.cookies().ss_device, '发了设备编号');
    const devs = await devicesOf();
    assert.equal(devs.length, 1);
    assert.equal(devs[0].label, 'iPhone · 微信');
    assert.ok(devs[0].ip && devs[0].firstSeen && devs[0].lastSeen);

    // 同一个浏览器退出再登录：还是那台设备
    await a.api('POST', '/api/lock');
    assert.equal((await a.api('GET', '/api/sentences')).status, 401);
    assert.equal((await a.api('POST', '/api/unlock', { password: inv.code })).status, 200);
    assert.equal((await devicesOf()).length, 1);

    // 第二台可以，第三台被拒绝（不算输错密码）
    assert.equal((await b.api('POST', '/api/unlock', { password: inv.code })).status, 200);
    const third = await c.api('POST', '/api/unlock', { password: inv.code });
    assert.equal(third.status, 403);
    assert.match(third.body.error, /已经在 2 台设备上登录过了/);
    assert.equal((await c.api('GET', '/api/sentences')).status, 401);
    assert.equal((await b.api('GET', '/api/sentences')).status, 200);

    // 移除 iPhone：它马上退出，空出的名额给第三台
    const phone = (await devicesOf()).find((d) => d.label === 'iPhone · 微信');
    assert.ok(phone);
    const rm = await owner.api('DELETE', `/api/admin/invites/${inv.id}/devices/${phone.id}`);
    assert.equal(rm.status, 200, JSON.stringify(rm.body));
    assert.equal(rm.body.invite.devices.length, 1);
    assert.equal((await a.api('GET', '/api/sentences')).status, 401, '被移除的设备马上退出');
    assert.equal((await c.api('POST', '/api/unlock', { password: inv.code })).status, 200);
    assert.equal((await owner.api('DELETE', `/api/admin/invites/${inv.id}/devices/${phone.id}`)).status, 404);

    // 调大上限后，被移除的设备可以重新登录；清除浏览器数据算新设备
    const up = await owner.api('PUT', `/api/admin/invites/${inv.id}`, { deviceLimit: 3 });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.invite.deviceLimit, 3);
    assert.equal((await a.api('POST', '/api/unlock', { password: inv.code })).status, 200);
    b.clearCookies();
    assert.equal((await b.api('POST', '/api/unlock', { password: inv.code })).status, 403, '清了浏览器数据就是新设备');
    for (const bad of [0, 11, 1.5, 'x']) {
      assert.equal(
        (await owner.api('PUT', `/api/admin/invites/${inv.id}`, { deviceLimit: bad })).status,
        400,
        String(bad),
      );
    }
    assert.equal(
      (await c.api('PUT', `/api/admin/invites/${inv.id}`, { deviceLimit: 9 })).status,
      403,
      '邀请账户不能改',
    );
    assert.equal((await owner.api('PUT', '/api/admin/invites/nope', { deviceLimit: 2 })).status, 404);
  } finally {
    a.close();
    b.close();
    c.close();
  }
});
