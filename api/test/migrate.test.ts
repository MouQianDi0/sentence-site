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

test('0002：老数据的练习记录、批改、查词缓存按句子回填 account_id', async () => {
  db.raw(`INSERT INTO accounts (id, role, note) VALUES ('mig-m', 'member', '邀请账户')`);
  db.raw(`INSERT INTO sentences (id, account_id, batch, source, segs, opts) VALUES
    ('mig-s-owner', 'owner', '2026-10-01', 'seed', '[]', '[]'),
    ('mig-s-member', 'mig-m', '2026-10-01', 'extra', '[]', '[]')`);
  // 上一版代码写入时不带 account_id
  db.raw(`INSERT INTO records (sentence_id, done) VALUES ('mig-s-owner', true), ('mig-s-member', true)`);
  db.raw(`INSERT INTO attempts (sentence_id, text) VALUES ('mig-s-owner', '译文'), ('mig-s-member', '译文')`);
  db.raw(
    `INSERT INTO dict_cache (sentence_id, word, data) VALUES ('mig-s-owner', 'work', '{}'), ('mig-s-member', 'work', '{}')`,
  );
  db.raw('DELETE FROM schema_migrations WHERE version = 2');
  assert.deepEqual(await migrate(() => {}), ['0002_child_account_id.sql']);

  for (const table of ['records', 'attempts', 'dict_cache']) {
    const rows = db.raw(`SELECT sentence_id || '=' || coalesce(account_id, '空') FROM ${table}
      WHERE sentence_id LIKE 'mig-s-%' ORDER BY sentence_id`);
    assert.deepEqual(rows.trim().split('\n'), ['mig-s-member=mig-m', 'mig-s-owner=owner'], table);
  }
  assert.equal(db.raw(`SELECT to_regclass('attempts_created_at_idx') IS NULL`).trim(), 't');
  assert.equal(db.raw(`SELECT to_regclass('attempts_account_idx') IS NOT NULL`).trim(), 't');
  assert.equal(db.raw(`SELECT count(*) FROM pg_constraint WHERE conname = 'sentences_account_id_id_key'`).trim(), '1');
});
