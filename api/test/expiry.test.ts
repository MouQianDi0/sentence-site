// 邀请码有效期：从第一次登录开始算；到期后登不进来、已登录的也退出，数据保留；管理员改有效期就续上
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setQueryImpl } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { createLlm } from '../src/llm.ts';
import * as repo from '../src/repo.ts';
import { migrate } from '../src/migrate.ts';
import { createTestDb, startFakeLlm, startApp, type FakeLlm, type TestApp, type TestDb } from './helpers.ts';
import type { RequestListener } from 'node:http';
import type { Invite } from '@sentence-site/shared';

const quiet = { log() {}, error() {}, warn() {} };
let db: TestDb, fake: FakeLlm, handler: RequestListener, owner: TestApp;
const DAY = 24 * 60 * 60 * 1000;

/** 到期时间离现在大约还有几天 */
const daysLeft = (iso: string | null) => (Date.parse(iso ?? '') - Date.now()) / DAY;
const invite = async (id: string): Promise<Invite> =>
  (await owner.api('GET', '/api/admin/invites')).body.invites.find((x: Invite) => x.id === id);
/** 让这个账户马上过期（假装时间过去了） */
const expireNow = (id: string) =>
  db.raw(`UPDATE accounts SET expires_at = now() - interval '1 minute' WHERE id = '${id}'`);

before(async () => {
  db = createTestDb(`sentence_expiry_${process.pid}`);
  setQueryImpl(db.query);
  await migrate();
  fake = await startFakeLlm({ grade: () => ({}), lookup: () => ({}), generate: () => ({}) });
  const cfg = loadConfig({ ACCESS_PASSWORD: 'owner-pw-1', COOKIE_SECRET: 'e'.repeat(64) });
  handler = createApp(cfg, { llm: createLlm(cfg), log: quiet });
  owner = await startApp(handler);
  await owner.api('POST', '/api/unlock', { password: 'owner-pw-1' });
});

after(() => {
  owner?.close();
  fake?.close();
  db?.drop();
});

test('生成时选有效期：只能是 30 / 90 / 180 / 360 天或永久；不传是永久', async () => {
  for (const bad of [45, 0, -30, 'abc', 30.5]) {
    const r = await owner.api('POST', '/api/admin/invites', { note: 'x', validDays: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.body.error, /30、90、180、360 天或永久/);
  }
  const plain = (await owner.api('POST', '/api/admin/invites', { note: '不传' })).body.invite;
  assert.equal(plain.validDays, null);
  const forever = (await owner.api('POST', '/api/admin/invites', { note: '永久', validDays: null })).body.invite;
  assert.equal(forever.validDays, null);
  for (const n of [30, 90, 180, 360]) {
    const inv = (await owner.api('POST', '/api/admin/invites', { note: `${n} 天`, validDays: n })).body.invite;
    assert.equal(inv.validDays, n);
    assert.equal(inv.activatedAt, null, '还没登录过');
    assert.equal(inv.expiresAt, null, '还没登录过就还没开始算');
    assert.equal(inv.expired, false);
  }
});

test('从第一次登录开始算；再次登录不会重新算', async () => {
  const inv = (await owner.api('POST', '/api/admin/invites', { note: '小周', validDays: 30 })).body.invite;
  const m = await startApp(handler);
  try {
    const login = await m.api('POST', '/api/unlock', { password: inv.code });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.ok(Math.abs(daysLeft(login.body.expiresAt) - 30) < 0.01, '登录时告诉页面到期时间');
    const after1 = await invite(inv.id);
    assert.ok(after1.activatedAt);
    assert.ok(Math.abs(daysLeft(after1.expiresAt) - 30) < 0.01);
    assert.equal((await m.api('GET', '/api/session')).body.expiresAt, after1.expiresAt);

    // 往前拨 10 天，再登录一次：到期时间不变
    db.raw(
      `UPDATE accounts SET activated_at = activated_at - interval '10 days', expires_at = expires_at - interval '10 days' WHERE id = '${inv.id}'`,
    );
    const before2 = (await invite(inv.id)).expiresAt;
    await m.api('POST', '/api/unlock', { password: inv.code });
    assert.equal((await invite(inv.id)).expiresAt, before2);
    assert.ok(Math.abs(daysLeft(before2) - 20) < 0.01);
  } finally {
    m.close();
  }
});

test('到期后：已登录的请求被挡住并说明原因，登不进来也不占设备名额，数据都还在；续期后接着用', async () => {
  const inv = (await owner.api('POST', '/api/admin/invites', { note: '小吴', validDays: 90 })).body.invite;
  const m = await startApp(handler);
  const other = await startApp(handler);
  try {
    await m.api('POST', '/api/unlock', { password: inv.code });
    assert.equal((await m.api('PUT', '/api/settings/practice', { dailyCount: 3 })).status, 200);

    expireNow(inv.id);
    const blocked = await m.api('GET', '/api/settings/practice');
    assert.equal(blocked.status, 401);
    assert.match(blocked.body.error, /过期了，请联系管理员续期/);
    const session = (await m.api('GET', '/api/session')).body;
    assert.equal(session.unlocked, false);
    assert.match(session.notice, /过期了/, '登录页能说明为什么要重新登录');

    // 用邀请码重新登录：403，说明过期；新设备不会被登记
    const again = await other.api('POST', '/api/unlock', { password: inv.code });
    assert.equal(again.status, 403);
    assert.match(again.body.error, /过期了/);
    const listed = await invite(inv.id);
    assert.equal(listed.expired, true);
    assert.equal(listed.devices.length, 1, '过期后登录不占设备名额');
    // 输入的是对的邀请码，不算输错（不会被锁）
    for (let i = 0; i < 6; i++)
      assert.equal((await other.api('POST', '/api/unlock', { password: inv.code })).status, 403);

    // 过期的账户每天不自动出题
    assert.ok(!(await repo.listActiveAccounts()).some((a) => a.id === inv.id));

    // 续期 30 天：从现在开始算
    const renewed = await owner.api('PUT', `/api/admin/invites/${inv.id}`, { validDays: 30 });
    assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
    assert.equal(renewed.body.invite.validDays, 30);
    assert.equal(renewed.body.invite.expired, false);
    assert.ok(Math.abs(daysLeft(renewed.body.invite.expiresAt) - 30) < 0.01);
    assert.ok(renewed.body.invite.tokens, '返回的那一项也带着用量');
    assert.equal((await other.api('POST', '/api/unlock', { password: inv.code })).status, 200);
    assert.equal((await other.api('GET', '/api/settings/practice')).body.dailyCount, 3, '数据都还在');
    assert.ok((await repo.listActiveAccounts()).some((a) => a.id === inv.id));
  } finally {
    m.close();
    other.close();
  }
});

test('改有效期：改成永久就不会过期；还没登录过的改了以后仍从第一次登录算；输错的值报错', async () => {
  const used = (await owner.api('POST', '/api/admin/invites', { note: '小郑', validDays: 30 })).body.invite;
  const m = await startApp(handler);
  try {
    await m.api('POST', '/api/unlock', { password: used.code });
    expireNow(used.id);
    const forever = await owner.api('PUT', `/api/admin/invites/${used.id}`, { validDays: null });
    assert.equal(forever.body.invite.validDays, null);
    assert.equal(forever.body.invite.expiresAt, null);
    assert.equal(forever.body.invite.expired, false);
    assert.equal((await m.api('GET', '/api/session')).body.unlocked, true, '改成永久后马上能用');
  } finally {
    m.close();
  }

  const fresh = (await owner.api('POST', '/api/admin/invites', { note: '小王' })).body.invite;
  const changed = await owner.api('PUT', `/api/admin/invites/${fresh.id}`, { validDays: 180 });
  assert.equal(changed.body.invite.validDays, 180);
  assert.equal(changed.body.invite.expiresAt, null, '还没登录过：仍从第一次登录算');
  const m2 = await startApp(handler);
  try {
    const login = await m2.api('POST', '/api/unlock', { password: fresh.code });
    assert.ok(Math.abs(daysLeft(login.body.expiresAt) - 180) < 0.01);
  } finally {
    m2.close();
  }

  assert.equal((await owner.api('PUT', `/api/admin/invites/${fresh.id}`, { validDays: 7 })).status, 400);
  assert.equal((await owner.api('PUT', `/api/admin/invites/${fresh.id}`, {})).status, 400);
  assert.equal((await owner.api('PUT', '/api/admin/invites/m-nope', { validDays: 30 })).status, 404);
  // 设备数和有效期可以一起改
  const both = await owner.api('PUT', `/api/admin/invites/${fresh.id}`, { validDays: 90, deviceLimit: 4 });
  assert.equal(both.body.invite.validDays, 90);
  assert.equal(both.body.invite.deviceLimit, 4);
});

test('邀请账户不能改有效期；你自己（管理员）没有有效期', async () => {
  const inv = (await owner.api('POST', '/api/admin/invites', { note: '小冯', validDays: 30 })).body.invite;
  const m = await startApp(handler);
  try {
    await m.api('POST', '/api/unlock', { password: inv.code });
    assert.equal((await m.api('PUT', `/api/admin/invites/${inv.id}`, { validDays: null })).status, 403);
  } finally {
    m.close();
  }
  const s = (await owner.api('GET', '/api/session')).body;
  assert.equal(s.role, 'owner');
  assert.equal('expiresAt' in s, false);
});

test('有效期功能上线前就登录过的账户：用最早登录的设备时间当作第一次登录', async () => {
  const inv = (await owner.api('POST', '/api/admin/invites', { note: '老账户' })).body.invite;
  const m = await startApp(handler);
  try {
    await m.api('POST', '/api/unlock', { password: inv.code });
  } finally {
    m.close();
  }
  db.raw(
    `UPDATE devices SET first_seen = '2026-09-01T00:00:00Z' WHERE account_id = '${inv.id}';
     UPDATE accounts SET activated_at = NULL WHERE id = '${inv.id}'`,
  );
  // 老库没有 schema_migrations：启动时 0001 会在已有数据上整份再执行一遍
  db.raw('DROP TABLE schema_migrations');
  await migrate();
  assert.equal(Date.parse((await invite(inv.id)).activatedAt ?? ''), Date.parse('2026-09-01T00:00:00Z'));
  // 没登录过的不受影响
  const fresh = (await owner.api('POST', '/api/admin/invites', { note: '新的' })).body.invite;
  // 老库没有 schema_migrations：启动时 0001 会在已有数据上整份再执行一遍
  db.raw('DROP TABLE schema_migrations');
  await migrate();
  assert.equal((await invite(fresh.id)).activatedAt, null);
});
