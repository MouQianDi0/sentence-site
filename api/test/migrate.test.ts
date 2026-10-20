// 数据库迁移：执行过的文件记在 schema_migrations，再启动不会重复执行
import { test, before, after } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { setQueryImpl } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { createTestDb, type TestDb } from './helpers.ts';

const MIGRATIONS = new URL('../src/migrations/', import.meta.url);

/** 模拟只升级到第 version 号迁移的老库（之后的文件还没发布），用完删掉 */
async function withOldDb(name: string, version: number, fn: (old: TestDb) => Promise<void>): Promise<void> {
  const old = createTestDb(`${name}_${process.pid}`);
  try {
    const files = fs
      .readdirSync(MIGRATIONS)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= version);
    for (const f of files.sort()) old.raw(fs.readFileSync(new URL(f, MIGRATIONS), 'utf8'));
    old.raw(`CREATE TABLE schema_migrations (version int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO schema_migrations (version, name) VALUES ${files.map((f) => `(${Number(f.slice(0, 4))}, '${f}')`).join(', ')}`);
    setQueryImpl(old.query);
    await fn(old);
  } finally {
    setQueryImpl(db.query);
    old.drop();
  }
}

/** 每行 “sentence_id=account_id”，按 sentence_id 排 */
const owners = (d: TestDb, table: string) =>
  d
    .raw(
      `SELECT sentence_id || '=' || coalesce(account_id, '空') FROM ${table} WHERE sentence_id LIKE 'mig-s-%' ORDER BY 1`,
    )
    .trim()
    .split('\n');

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
  await withOldDb('sentence_mig_v1', 1, async (old) => {
    old.raw(`INSERT INTO accounts (id, role, note) VALUES ('mig-m', 'member', '邀请账户');
      INSERT INTO sentences (id, account_id, batch, source, segs, opts) VALUES
        ('mig-s-owner', 'owner', '2026-10-01', 'seed', '[]', '[]'),
        ('mig-s-member', 'mig-m', '2026-10-01', 'extra', '[]', '[]');
      INSERT INTO records (sentence_id, done) VALUES ('mig-s-owner', true), ('mig-s-member', true);
      INSERT INTO attempts (sentence_id, text) VALUES ('mig-s-owner', '译文'), ('mig-s-member', '译文');
      INSERT INTO dict_cache (sentence_id, word, data) VALUES ('mig-s-owner', 'work', '{}'), ('mig-s-member', 'work', '{}')`);
    const applied = await migrate(() => {});
    assert.ok(applied.includes('0002_child_account_id.sql'));
    for (const table of ['records', 'attempts', 'dict_cache']) {
      assert.deepEqual(owners(old, table), ['mig-s-member=mig-m', 'mig-s-owner=owner'], table);
    }
    assert.equal(old.raw(`SELECT to_regclass('attempts_created_at_idx') IS NULL`).trim(), 't');
    assert.equal(old.raw(`SELECT to_regclass('attempts_account_idx') IS NOT NULL`).trim(), 't');
    assert.equal(
      old.raw(`SELECT count(*) FROM pg_constraint WHERE conname = 'sentences_account_id_id_key'`).trim(),
      '1',
    );
  });
});

test('0003：再回填退回上一版期间写的空 account_id，删掉没有句子的批改，收紧成 NOT NULL 和复合外键', async () => {
  await withOldDb('sentence_mig_v2', 2, async (old) => {
    // 第 2 步的库上跑过上一版代码：写入时不带 account_id
    old.raw(`INSERT INTO accounts (id, role, note) VALUES ('mig-m', 'member', '邀请账户');
      INSERT INTO sentences (id, account_id, batch, source, segs, opts) VALUES
        ('mig-s-owner', 'owner', '2026-10-01', 'seed', '[]', '[]'),
        ('mig-s-member', 'mig-m', '2026-10-01', 'extra', '[]', '[]');
      INSERT INTO records (sentence_id, done) VALUES ('mig-s-owner', true);
      INSERT INTO records (account_id, sentence_id, done) VALUES ('mig-m', 'mig-s-member', true);
      INSERT INTO attempts (sentence_id, text) VALUES ('mig-s-owner', '译文'), ('mig-s-member', '译文'), (NULL, '孤儿');
      INSERT INTO dict_cache (sentence_id, word, data) VALUES ('mig-s-owner', 'work', '{}'), ('mig-s-member', 'work', '{}')`);
    assert.deepEqual(await migrate(() => {}), ['0003_child_account_fk.sql']);

    for (const table of ['records', 'attempts', 'dict_cache']) {
      assert.deepEqual(owners(old, table), ['mig-s-member=mig-m', 'mig-s-owner=owner'], table);
    }
    assert.equal(old.raw(`SELECT count(*) FROM attempts WHERE sentence_id IS NULL`).trim(), '0');
    const notNull = old.raw(`SELECT table_name || '.' || column_name FROM information_schema.columns
      WHERE is_nullable = 'NO' AND (column_name = 'account_id' OR (table_name = 'attempts' AND column_name = 'sentence_id'))
        AND table_name IN ('records', 'attempts', 'dict_cache') ORDER BY 1`);
    assert.deepEqual(notNull.trim().split('\n'), [
      'attempts.account_id',
      'attempts.sentence_id',
      'dict_cache.account_id',
      'records.account_id',
    ]);
    const fks = old.raw(`SELECT conname FROM pg_constraint WHERE contype = 'f'
      AND conrelid IN ('records'::regclass, 'attempts'::regclass, 'dict_cache'::regclass) ORDER BY 1`);
    assert.deepEqual(fks.trim().split('\n'), [
      'attempts_sentence_fkey',
      'dict_cache_sentence_fkey',
      'records_sentence_fkey',
    ]);

    // 删除句子仍然连带删除它的记录、批改、查词缓存
    old.raw(`DELETE FROM sentences WHERE id = 'mig-s-member'`);
    for (const table of ['records', 'attempts', 'dict_cache']) {
      assert.deepEqual(owners(old, table), ['mig-s-owner=owner'], table);
    }

    // 文件可以重复执行
    old.raw('DELETE FROM schema_migrations WHERE version = 3');
    assert.deepEqual(await migrate(() => {}), ['0003_child_account_fk.sql']);
  });
});

test('不传 account_id 插入句子、AI 用量会报错，不会悄悄记到 owner', () => {
  assert.throws(
    () =>
      db.raw(
        `INSERT INTO sentences (id, batch, source, segs, opts) VALUES ('mig-no-acc', '2026-10-01', 'seed', '[]', '[]')`,
      ),
    (e: Error & { code?: string }) => e.code === '23502',
  );
  assert.throws(
    () => db.raw(`INSERT INTO ai_usage (day, grades) VALUES ('2026-10-01', 1)`),
    (e: Error & { code?: string }) => e.code === '23502',
  );
});
