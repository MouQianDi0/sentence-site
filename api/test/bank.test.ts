// 外部题库：导入（新增、更新、下架、原文变了退回、整份全有或全无）。
// 题库文件和真题原句不放进仓库，这里用自己编的几行假数据。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setQueryImpl } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import * as repo from '../src/repo.ts';
import { CET4_BANK, initialStatus, originText, parseBankJsonl, parseBankLine, sameText } from '../src/bank.ts';
import { createTestDb, type TestDb } from './helpers.ts';

let db: TestDb;

before(async () => {
  db = createTestDb(`sentence_bank_${process.pid}`);
  setQueryImpl(db.query);
  await migrate(() => {});
});

after(() => {
  db?.drop();
});

/** 编一行题库 JSONL（字段和真实题库一样） */
function fakeLine(id: string, text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    text_en: text,
    word_count: text.split(' ').length,
    complexity_score: 30,
    structures: ['adverbial_clause'],
    quality_status: 'reviewed',
    is_incomplete: false,
    level: 'CET-4',
    text_source: 'docx',
    cloze: [],
    sources: [
      {
        sentence_id: id,
        source_id: 'src1',
        section: 'C',
        passage: 'One',
        locator: 'paragraph:10',
        file: 'fake.docx',
        year: 2023,
        month: 12,
        set_number: 2,
      },
    ],
    ...extra,
  });
}

/** 某一句的几列，用 | 分开 */
const row = (id: string, cols = "status, text, coalesce(text_fix, ''), body IS NOT NULL") =>
  db.raw(`SELECT ${cols} FROM bank_items WHERE bank_id = '${CET4_BANK.id}' AND external_id = '${id}'`).trim();

test('整理题库的一行：出处、标签、选词填空、初筛状态', () => {
  const r = parseBankLine(
    JSON.parse(
      fakeLine('t-1', '  The   students who were tired went home early because it rained.', {
        quality_status: 'cloze_filled',
        cloze: [{ no: 31, word: 'tired' }],
        text_raw: 'The students who weretired went home early because it rained.',
        sources: [
          { section: 'A', passage: 'cloze', locator: 'p:1', file: 'a.docx', year: 2024, month: 6, set_number: 1 },
          { section: 'A', passage: 'cloze', locator: 'p:9', file: 'b.docx', year: 2024, month: 6, set_number: 3 },
        ],
      }),
    ),
  );
  assert.equal(r.external_id, 't-1');
  assert.equal(r.text, 'The students who were tired went home early because it rained.');
  assert.deepEqual([r.exam_year, r.exam_month, r.paper, r.section], [2024, 6, 1, 'A']);
  assert.deepEqual(r.tags, ['adverbial_clause']);
  assert.equal(r.status, 'raw');
  assert.deepEqual(r.meta.cloze, [{ no: 31, word: 'tired' }]);
  assert.equal((r.meta.sources as unknown[]).length, 2);
  assert.equal(r.meta.text_raw, 'The students who weretired went home early because it rained.');

  assert.deepEqual(initialStatus('reviewed'), { status: 'raw', reason: null });
  assert.equal(initialStatus('needs_review').status, 'review');
  assert.equal(initialStatus('ocr_review_required').status, 'review');
  assert.equal(initialStatus('incomplete_cloze').status, 'rejected');

  assert.throws(() => parseBankLine({ id: 'x' }), /text_en/);
  assert.throws(() => parseBankLine(JSON.parse(fakeLine('x', 'A b.', { level: 'CET-5' }))), /level/);
  assert.throws(() => parseBankJsonl(`${fakeLine('a', 'A b.')}\n{坏的`), /第 2 行/);
  assert.equal(
    originText({ year: 2023, month: 12, paper: 2, section: 'C' }),
    '四级真题 2023 年 12 月第 2 套 · 仔细阅读',
  );
  assert.equal(originText({ year: null, month: null, paper: null, section: null }), '四级真题');
  assert.ok(sameText('It’s “fine” — really.', `It's "fine"—really.`));
  assert.ok(!sameText('It is fine.', 'It is fine'));
});

test('导入：新增、再导入时更新出处、文件里没有的下架、原文变了退回重新标注', async () => {
  const first = parseBankJsonl(
    [
      fakeLine('t-a', 'Sentence A stays the same in every import of this fake bank.'),
      fakeLine('t-b', 'Sentence B will be changed by the next import of this fake bank.'),
      fakeLine('t-c', 'Sentence C will disappear from the next import of this fake bank.'),
      fakeLine('t-d', 'Sentence D needs someone to look at the original text first.', {
        quality_status: 'needs_review',
      }),
      fakeLine('t-e', 'Sentence E still has a blank in it.', { quality_status: 'incomplete_cloze' }),
    ].join('\n'),
  );
  assert.deepEqual(await repo.importBank(CET4_BANK, first), { added: 5, updated: 0, retired: 0 });
  assert.deepEqual(await repo.bankCounts(CET4_BANK.id), { review: 1, raw: 3, ready: 0, rejected: 1, retired: 0 });
  assert.equal(db.raw(`SELECT name FROM banks WHERE id = '${CET4_BANK.id}'`).trim(), CET4_BANK.name);
  assert.equal(row('t-e', 'reject_reason'), '选词填空还有没填的空');
  assert.equal(row('t-a', 'exam_year, exam_month, paper, section, tags'), '2023|12|2|C|{adverbial_clause}');

  // 模拟标注好了 A、B，管理页上改过 A 的原文
  db.raw(`UPDATE bank_items SET status = 'ready', body = '{"segs": []}', text_fix = 'Sentence A, fixed.'
          WHERE external_id IN ('t-a', 't-b')`);
  db.raw(`UPDATE bank_items SET text_fix = NULL WHERE external_id = 't-b'`);

  const second = parseBankJsonl(
    [
      fakeLine('t-a', 'Sentence A stays the same in every import of this fake bank.', {
        structures: ['noun_clause'],
        sources: [{ section: 'B', passage: 'E', locator: 'p:2', file: 'x.pdf', year: 2025, month: 6, set_number: 3 }],
      }),
      fakeLine('t-b', 'Sentence B was changed by this import of the fake bank.'),
      fakeLine('t-d', 'Sentence D needs someone to look at the original text first.', {
        quality_status: 'needs_review',
      }),
      fakeLine('t-e', 'Sentence E still has a blank in it.', { quality_status: 'incomplete_cloze' }),
      fakeLine('t-f', 'Sentence F is new in the second import of this fake bank.'),
    ].join('\n'),
  );
  assert.deepEqual(await repo.importBank(CET4_BANK, second), { added: 1, updated: 4, retired: 1 });
  // A：原文没变，保留标注、改过的原文；出处、标签换成新的
  assert.equal(row('t-a'), 'ready|Sentence A stays the same in every import of this fake bank.|Sentence A, fixed.|t');
  assert.equal(row('t-a', 'exam_year, exam_month, paper, section, tags'), '2025|6|3|B|{noun_clause}');
  // B：原文变了，拆解清掉，按质量状态重新初筛
  assert.equal(row('t-b'), 'raw|Sentence B was changed by this import of the fake bank.||f');
  // C：文件里没有了
  assert.equal(row('t-c', 'status'), 'retired');
  assert.equal(row('t-f', 'status'), 'raw');
  assert.deepEqual(await repo.bankCounts(CET4_BANK.id), { review: 1, raw: 2, ready: 1, rejected: 1, retired: 1 });

  // 下架的句子再出现：恢复（没有拆解的按质量状态初筛，有拆解的回到 ready）
  db.raw(`UPDATE bank_items SET status = 'retired' WHERE external_id = 't-a'`);
  const third = [
    ...second,
    ...parseBankJsonl(fakeLine('t-c', 'Sentence C will disappear from the next import of this fake bank.')),
  ];
  assert.deepEqual(await repo.importBank(CET4_BANK, third), { added: 0, updated: 6, retired: 0 });
  assert.equal(row('t-a', 'status'), 'ready');
  assert.equal(row('t-c', 'status'), 'raw');
  // 重复导入同一份：什么都不变
  assert.deepEqual(await repo.importBank(CET4_BANK, third), { added: 0, updated: 6, retired: 0 });
  assert.deepEqual(await repo.bankCounts(CET4_BANK.id), { review: 1, raw: 3, ready: 1, rejected: 1, retired: 0 });
});

test('导入：有一句写不进去时整份都不写（新增、更新、下架都不生效）', async () => {
  const snapshot = db.raw(
    `SELECT string_agg(external_id || ':' || status || ':' || text, ',' ORDER BY external_id) FROM bank_items`,
  );
  const rows = parseBankJsonl(
    [
      fakeLine('t-a', 'Sentence A was going to be changed but the import fails.'),
      fakeLine('t-new', 'A brand new sentence that should not be written at all.'),
    ].join('\n'),
  );
  // 月份 13 过不了 CHECK（parseBankLine 会挡掉，这里绕过它直接交给数据库）
  const good = rows[1];
  assert.ok(good);
  const bad = { ...good, external_id: 't-bad', exam_month: 13 };
  await assert.rejects(
    () => repo.importBank(CET4_BANK, [...rows, bad]),
    (e: Error & { code?: string }) => e.code === '23514',
  );
  assert.equal(
    db.raw(`SELECT string_agg(external_id || ':' || status || ':' || text, ',' ORDER BY external_id) FROM bank_items`),
    snapshot,
  );
});
