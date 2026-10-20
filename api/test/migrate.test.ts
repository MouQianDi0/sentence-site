// 数据库迁移：执行过的文件记在 schema_migrations，再启动不会重复执行
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setQueryImpl } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { createTestDb, type TestDb } from './helpers.ts';

let db: TestDb;

before(() => {
  db = createTestDb(`sentence_migrate_${process.pid}`);
  setQueryImpl(db.query);
});

after(() => {
  db?.drop();
});

test('新库执行全部迁移，再执行一次什么都不做', async () => {
  const quiet = () => {};
  const first = await migrate(quiet);
  assert.ok(first.includes('0001_baseline.sql'));
  assert.equal(db.raw('SELECT name FROM schema_migrations WHERE version = 1').trim(), '0001_baseline.sql');
  assert.equal(db.raw("SELECT to_regclass('sentences') IS NOT NULL").trim(), 't');

  assert.deepEqual(await migrate(quiet), []);
  assert.equal(db.raw('SELECT count(*) FROM schema_migrations').trim(), String(first.length));
});

test('还没有 schema_migrations 的老库：0001 在已有的表上再执行一遍，数据不变', async () => {
  db.raw(`INSERT INTO accounts (id, role, note) VALUES ('mig-old', 'member', '老账户')`);
  db.raw('DROP TABLE schema_migrations');
  const applied = await migrate(() => {});
  assert.ok(applied.includes('0001_baseline.sql'));
  assert.equal(db.raw(`SELECT note FROM accounts WHERE id = 'mig-old'`).trim(), '老账户');
});
