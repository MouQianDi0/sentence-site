// 外部题库：导入（新增、更新、下架、原文变了退回、整份全有或全无）。
// 题库文件和真题原句不放进仓库，这里用自己编的几行假数据。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setQueryImpl } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import * as repo from '../src/repo.ts';
import { CET4_BANK, initialStatus, originText, parseBankJsonl, parseBankLine, sameText } from '../src/bank.ts';
import { annotateItem, precheck } from '../src/annotate.ts';
import { specExample } from '../src/spec.ts';
import { plainText } from '../src/validate.ts';
import { LlmError, type Llm } from '../src/llm.ts';
import type { Sentence, SentenceBody } from '@sentence-site/shared';
import { createLlm } from '../src/llm.ts';
import { createAi } from '../src/ai.ts';
import { createDailyRunner } from '../src/daily.ts';
import { createPractice } from '../src/practice.ts';
import { shanghaiDate } from '../src/time.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { createTestDb, startApp, startFakeLlm, type TestApp, type TestDb } from './helpers.ts';

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

// ---- 标注 ---------------------------------------------------------------------------

/** 出题规范里的示例：自己编的句子，拿来当“题库原句”和模型的拆解 */
const EXAMPLE = specExample() as SentenceBody;
const EXAMPLE_TEXT = plainText(EXAMPLE.segs);
/** 改了一个词的拆解：能过严格校验，但拼回去和原句不一样 */
const WRONG = {
  ...EXAMPLE,
  segs: EXAMPLE.segs.map((g, i) => (i === 0 ? { ...g, t: g.t.replace('professor', 'teacher') } : g)),
};

/** 按提示词回复的假模型；复核谓语一律“没有意见” */
function stubLlm(reply: (prompt: string) => unknown, ready = true): Llm & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    ready: () => ready,
    models: () => ({ main: 'stub-main', light: 'stub-light' }),
    listModels: async () => [],
    async chatJson(o) {
      prompts.push(o.prompt);
      if (o.prompt.includes('逐句核对句子里'))
        return { data: { items: [] }, model: 'stub-main', usage: { input: 1, output: 1 } };
      const data = reply(o.prompt);
      if (data instanceof Error) throw data;
      return { data, model: 'stub-main', usage: { input: 10, output: 20 } };
    },
  };
}

test('标注一句：过了严格校验、拼回去等于原句才算 ready；拼回去不一样、太长、模型说不能拆的不要；模型出错留在 raw', async () => {
  const item = { text: EXAMPLE_TEXT, textFix: null, level: 'CET-4' as const };
  const ok = await annotateItem(
    stubLlm(() => ({ sentence: EXAMPLE })),
    item,
    1000,
  );
  assert.equal(ok.status, 'ready');
  assert.ok(ok.status === 'ready' && ok.body.level === 'CET-4' && plainText(ok.body.segs) === EXAMPLE_TEXT);

  // 回复里直接是句子对象、或者 {sentences:[…]} 也认
  assert.equal(
    (
      await annotateItem(
        stubLlm(() => EXAMPLE),
        item,
        1000,
      )
    ).status,
    'ready',
  );
  assert.equal(
    (
      await annotateItem(
        stubLlm(() => ({ sentences: [EXAMPLE] })),
        item,
        1000,
      )
    ).status,
    'ready',
  );

  // 拼回去和原句不一样：再问一次，还不一样就不要
  const wrong = stubLlm(() => ({ sentence: WRONG }));
  const bad = await annotateItem(wrong, item, 1000);
  assert.deepEqual(bad.status === 'rejected' && bad.reason, '拆出来的片段拼起来和原句不一样');
  assert.equal(wrong.prompts.length, 2);
  // 改过原文的用改过的原文比较
  assert.equal(
    (
      await annotateItem(
        stubLlm(() => ({ sentence: EXAMPLE })),
        { ...item, text: 'Something else entirely.', textFix: EXAMPLE_TEXT },
        1000,
      )
    ).status,
    'ready',
  );
  // 引号、破折号两边的空格不同也算一样
  const quoted = {
    ...EXAMPLE,
    segs: EXAMPLE.segs.map((g, i) => (i === 0 ? { ...g, t: g.t.replace('The professor', '“The professor') } : g)),
  };
  const quotedText = EXAMPLE_TEXT.replace('The professor', '"The professor');
  assert.equal(
    (
      await annotateItem(
        stubLlm(() => ({ sentence: quoted })),
        { ...item, text: quotedText },
        1000,
      )
    ).status,
    'ready',
  );

  // 过不了严格校验（选项不是 3 个）
  const two = await annotateItem(
    stubLlm(() => ({ sentence: { ...EXAMPLE, opts: EXAMPLE.opts.slice(0, 2) } })),
    item,
    1000,
  );
  assert.deepEqual(two.status === 'rejected' && two.reason, '选项必须是 3 个');

  // 太长、没有句号：不用问模型
  const none = stubLlm(() => ({ sentence: EXAMPLE }));
  const long = await annotateItem(none, { ...item, text: `${'word '.repeat(61).trim()}.` }, 1000);
  assert.deepEqual(long.status === 'rejected' && long.reason, '句子长度 61 词，不在 15–60 之间');
  assert.ok(precheck('This sentence has enough words but it never ends with a full stop at all, sadly'));
  assert.equal(precheck(`“${EXAMPLE_TEXT}”`), null, '弯引号结尾也算句号结尾');
  assert.equal(none.prompts.length, 0);

  const skip = await annotateItem(
    stubLlm(() => ({ skip: '主句是并列谓语' })),
    item,
    1000,
  );
  assert.deepEqual(skip.status === 'rejected' && skip.reason, '模型说不能拆：主句是并列谓语');

  const err = await annotateItem(
    stubLlm(() => new LlmError('timeout', '超时了')),
    item,
    1000,
  );
  assert.equal(err.status, 'raw');
});

test('saveAnnotation：标注期间原文被改了、或者不再是 raw，这次结果作废', async () => {
  db.raw('DELETE FROM bank_items');
  await repo.importBank(CET4_BANK, parseBankJsonl(fakeLine('t-save', EXAMPLE_TEXT)));
  const [item] = await repo.rawBankItems(10);
  assert.ok(item);
  db.raw(`UPDATE bank_items SET text_fix = 'Changed while annotating.' WHERE id = ${item.id}`);
  assert.equal(await repo.saveAnnotation(item, { status: 'ready', body: EXAMPLE, by: 'stub' }), false);
  const fresh = await repo.getBankItem(item.id);
  assert.ok(fresh);
  assert.equal(await repo.saveAnnotation(fresh, { status: 'rejected', reason: '不要' }), true);
  assert.equal(await repo.saveAnnotation(fresh, { status: 'ready', body: EXAMPLE, by: 'stub' }), false, '已经不是 raw');
});

// ---- 管理接口（只有你自己能用）--------------------------------------------------------

const quiet = { log() {}, error: (...a: unknown[]) => process.env.DEBUG_TEST && console.error(...a), warn() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 起一个网站：owner 和一个邀请账户各登录好 */
async function siteWithMember(): Promise<{ owner: TestApp; member: TestApp; memberId: string; close(): void }> {
  const cfg = loadConfig({ ACCESS_PASSWORD: 'pw-bank', COOKIE_SECRET: 'b'.repeat(64), DAILY_GENERATE: '0' });
  const handler = createApp(cfg, { log: quiet });
  const owner = await startApp(handler);
  const member = await startApp(handler);
  await owner.api('POST', '/api/unlock', { password: 'pw-bank' });
  const inv = (await owner.api('POST', '/api/admin/invites', { note: '题库测试' })).body.invite;
  assert.equal((await member.api('POST', '/api/unlock', { password: inv.code })).status, 200);
  return {
    owner,
    member,
    memberId: inv.id,
    close: () => {
      owner.close();
      member.close();
    },
  };
}

test('网站：邀请账户用不了题库管理接口', async () => {
  const site = await siteWithMember();
  try {
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/admin/bank'],
      ['GET', '/api/admin/bank/items?status=review'],
      ['POST', '/api/admin/bank/items/1/confirm'],
      ['PUT', '/api/admin/bank/items/1', { text: 'x' }],
      ['POST', '/api/admin/bank/items/1/reject'],
      ['POST', '/api/admin/bank/items/1/requeue'],
      ['POST', '/api/admin/bank/annotate', { limit: 1 }],
      ['PUT', `/api/admin/bank/${CET4_BANK.id}`, { enabled: false }],
    ];
    for (const [method, path, body] of calls) {
      assert.equal((await site.member.api(method, path, body)).status, 403, `${method} ${path}`);
    }
  } finally {
    site.close();
  }
});

test('网站：看各状态句数、确认原文、改原文、不要、重新标注、停用题库', async () => {
  db.raw('DELETE FROM bank_items');
  await repo.importBank(
    CET4_BANK,
    parseBankJsonl(
      [
        fakeLine('t-review', 'This sentence needs a quick look at the original text before it can be used.', {
          quality_status: 'needs_review',
        }),
        fakeLine('t-raw', 'This sentence has already been checked and is waiting to be annotated today.'),
      ].join('\n'),
    ),
  );
  const site = await siteWithMember();
  try {
    const { owner } = site;
    const view = (await owner.api('GET', '/api/admin/bank')).body;
    assert.equal(view.banks[0].id, CET4_BANK.id);
    assert.equal(view.banks[0].enabled, true);
    assert.deepEqual(view.banks[0].counts, { review: 1, raw: 1, ready: 0, rejected: 0, retired: 0 });
    assert.equal(view.llmReady, false);

    const list = (await owner.api('GET', '/api/admin/bank/items?status=review')).body;
    assert.equal(list.total, 1);
    const item = list.items[0];
    assert.equal(item.externalId, 't-review');
    assert.equal(item.origin, '四级真题 2023 年 12 月第 2 套 · 仔细阅读');
    assert.equal((await owner.api('GET', '/api/admin/bank/items?status=nope')).status, 400);

    // 确认原文：review → raw；再确认一次状态不对
    assert.equal((await owner.api('POST', `/api/admin/bank/items/${item.id}/confirm`)).body.item.status, 'raw');
    assert.equal((await owner.api('POST', `/api/admin/bank/items/${item.id}/confirm`)).status, 409);
    // 改原文：存成 text_fix；改回和原文一样时清空
    const fixed = (await owner.api('PUT', `/api/admin/bank/items/${item.id}`, { text: '  Fixed   text here.  ' })).body
      .item;
    assert.deepEqual([fixed.status, fixed.textFix], ['raw', 'Fixed text here.']);
    const back = (await owner.api('PUT', `/api/admin/bank/items/${item.id}`, { text: item.text })).body.item;
    assert.equal(back.textFix, null);
    // 不要，再重新标注
    const rej = (await owner.api('POST', `/api/admin/bank/items/${item.id}/reject`, { reason: '太简单' })).body.item;
    assert.deepEqual([rej.status, rej.rejectReason], ['rejected', '太简单']);
    const again = (await owner.api('POST', `/api/admin/bank/items/${item.id}/requeue`)).body.item;
    assert.deepEqual([again.status, again.rejectReason], ['raw', null]);
    assert.equal((await owner.api('POST', '/api/admin/bank/items/999999/requeue')).status, 409);
    assert.equal((await owner.api('POST', '/api/admin/bank/items/abc/requeue')).status, 404);

    // 没配国内模型时不能开始标注
    assert.equal((await owner.api('POST', '/api/admin/bank/annotate', { limit: 5 })).status, 503);

    assert.equal((await owner.api('PUT', `/api/admin/bank/${CET4_BANK.id}`, { enabled: false })).status, 200);
    assert.equal((await owner.api('GET', '/api/admin/bank')).body.banks[0].enabled, false);
    assert.equal((await owner.api('PUT', '/api/admin/bank/nope', { enabled: false })).status, 404);
    await owner.api('PUT', `/api/admin/bank/${CET4_BANK.id}`, { enabled: true });
  } finally {
    site.close();
  }
});

test('网站：后台标注用你自己的国内模型，token 记在你名下（标注题库），拼回去不对的不要', async () => {
  db.raw('DELETE FROM bank_items');
  db.raw(`DELETE FROM token_usage WHERE kind = 'annotate'`);
  await repo.importBank(
    CET4_BANK,
    parseBankJsonl(
      [
        fakeLine('t-good', EXAMPLE_TEXT),
        fakeLine('t-wrong', 'The model will answer this one with a different sentence, so it gets thrown away.'),
        fakeLine('t-later', 'This one stays raw because the batch only takes two sentences at a time today.'),
      ].join('\n'),
    ),
  );
  const fake = await startFakeLlm({
    annotate: (prompt) => ({ sentence: prompt.includes(EXAMPLE_TEXT) ? EXAMPLE : WRONG }),
  });
  const site = await siteWithMember();
  try {
    const { owner } = site;
    await owner.api('PUT', '/api/settings/llm', { baseUrl: fake.url, apiKey: 'k', mainModel: 'fake-main' });
    assert.equal((await owner.api('GET', '/api/admin/bank')).body.llmReady, true);
    const started = await owner.api('POST', '/api/admin/bank/annotate', { limit: 2 });
    assert.equal(started.status, 200);
    assert.equal(started.body.job.running, true);
    assert.equal((await owner.api('POST', '/api/admin/bank/annotate', { limit: 2 })).status, 409, '同时只跑一批');
    let job = started.body.job;
    for (let i = 0; i < 100 && job.running; i++) {
      await sleep(50);
      job = (await owner.api('GET', '/api/admin/bank')).body.job;
    }
    assert.deepEqual([job.running, job.total, job.done, job.ready, job.rejected, job.failed], [false, 2, 2, 1, 1, 0]);
    assert.equal(row('t-good', 'status'), 'ready');
    assert.equal(row('t-good', `body->>'level'`), 'CET-4');
    assert.equal(row('t-wrong', 'status || reject_reason'), 'rejected拆出来的片段拼起来和原句不一样');
    assert.equal(row('t-later', 'status'), 'raw');
    assert.equal(row('t-good', 'annotated_by'), 'fake-main');
    // token 记在 owner 名下，用途 annotate；邀请账户没有
    assert.equal(
      db.raw(`SELECT string_agg(DISTINCT account_id, ',') FROM token_usage WHERE kind = 'annotate'`).trim(),
      'owner',
    );
    const stats = (await owner.api('GET', '/api/usage/tokens')).body;
    assert.ok(stats.byKind.some((k: { kind: string }) => k.kind === 'annotate'));
    assert.ok(
      fake.calls.every((c) => c.auth === 'Bearer k'),
      '用的是你自己的密钥',
    );
  } finally {
    site.close();
    fake.close();
  }
});

// ---- 抽题 ---------------------------------------------------------------------------

/** 题库里放 6 句标注好的四级、1 句标注好的六级、1 句还没标注的 */
async function seedReadyBank(): Promise<void> {
  db.raw('DELETE FROM sentences WHERE bank_item_id IS NOT NULL');
  db.raw('DELETE FROM bank_items');
  const lines = Array.from({ length: 6 }, (_, i) =>
    fakeLine(`t-ok-${i}`, `Ready sentence number ${i} is waiting in the fake bank for someone to draw it.`),
  );
  lines.push(
    fakeLine('t-six', 'A ready sentence of level six that a level four draw must never pick up at all.', {
      level: 'CET-6',
    }),
  );
  lines.push(fakeLine('t-raw', 'A sentence that has not been annotated yet and so it cannot be drawn by anyone.'));
  lines.push(
    fakeLine('t-cloze', 'Ready cloze sentence with a filled blank that also waits in the fake bank for a draw.', {
      cloze: [{ no: 31, word: 'filled' }],
      sources: [{ section: 'A', year: 2024, month: 6, set_number: 1 }],
    }),
  );
  await repo.importBank(CET4_BANK, parseBankJsonl(lines.join('\n')));
  const body = JSON.stringify(EXAMPLE).replace(/'/g, "''");
  db.raw(`UPDATE bank_items SET status = 'ready', body = '${body}'::jsonb WHERE external_id <> 't-raw'`);
}

/** 这个账户从题库复制来的句子：题库编号 */
const copies = (accountId: string) =>
  db
    .raw(
      `SELECT b.external_id FROM sentences s JOIN bank_items b ON b.id = s.bank_item_id
       WHERE s.account_id = '${accountId}' ORDER BY 1`,
    )
    .trim()
    .split('\n')
    .filter(Boolean);

test('抽题：没配模型的邀请账户也能从题库出题，只抽标注好的四级，不重复，不占出题次数；账户之间互不影响', async () => {
  await seedReadyBank();
  const site = await siteWithMember();
  try {
    const { owner, member, memberId } = site;
    // 默认还是 AI 出题：没配模型就出不了
    assert.equal((await member.api('GET', '/api/settings/practice')).body.questionSource, 'ai');
    assert.equal((await member.api('POST', '/api/sentences/generate', { kind: 'extra', count: 2 })).status, 503);
    const bad = await member.api('PUT', '/api/settings/practice', { questionSource: 'nope' });
    assert.equal(bad.status, 400);
    const set = await member.api('PUT', '/api/settings/practice', { questionSource: 'bank', levels: ['CET-4'] });
    assert.equal(set.body.questionSource, 'bank');

    const first = await member.api('POST', '/api/sentences/generate', { kind: 'extra', count: 4 });
    assert.equal(first.status, 200);
    assert.equal(first.body.added.length, 4);
    assert.ok(
      first.body.added.every((id: string) => id.startsWith(`${memberId}-s-`)),
      '编号规则和 AI 出题一样',
    );
    // 再要 10 句：只剩 3 句标注好的四级
    const second = await member.api('POST', '/api/sentences/generate', { kind: 'extra', count: 10 });
    assert.equal(second.body.added.length, 3);
    const mine = copies(memberId);
    assert.equal(mine.length, 7);
    assert.equal(new Set(mine).size, 7, '不重复');
    assert.ok(!mine.includes('t-six') && !mine.includes('t-raw'), '不抽六级、不抽没标注好的');
    // 抽完了
    const empty = await member.api('POST', '/api/sentences/generate', { kind: 'extra', count: 1 });
    assert.equal(empty.status, 409);
    assert.match(empty.body.error, /题库里没有能抽的/);
    assert.equal((await member.api('GET', '/api/usage')).body.gens, 0, '从题库抽不占出题次数');

    // 页面上看到的：出处、选词填空第几空；不直接给 bank_items 的行
    const list = (await member.api('GET', '/api/sentences')).body.sentences as Sentence[];
    const fromBank = list.filter((s) => s.origin);
    assert.equal(fromBank.length, 7);
    assert.ok(fromBank.every((s) => s.source === 'extra' && s.level === 'CET-4'));
    assert.equal(fromBank.find((s) => s.cloze)?.origin, '四级真题 2024 年 6 月第 1 套 · 选词填空');
    assert.deepEqual(fromBank.find((s) => s.cloze)?.cloze, [{ no: 31, word: 'filled' }]);
    assert.ok(fromBank[0] && plainText(fromBank[0].segs) === EXAMPLE_TEXT);
    for (const key of ['fromBank', 'bYear', 'bCloze', 'bank_item_id', 'bankItemId', 'meta', 'body']) {
      assert.ok(!(key in (fromBank[0] as object)), key);
    }

    // owner 照样能抽到同样的句子（各复制各的）
    await owner.api('PUT', '/api/settings/practice', { questionSource: 'bank', levels: ['CET-4'] });
    assert.equal(
      (await owner.api('POST', '/api/sentences/generate', { kind: 'extra', count: 2 })).body.added.length,
      2,
    );
    assert.equal(copies('owner').length, 2);
    assert.equal(copies(memberId).length, 7);
    // 删掉自己复制的那句，别的账户的不受影响；删掉后可以再抽到
    const [ownerFirst] = (await owner.api('GET', '/api/sentences')).body.sentences.filter((s: Sentence) => s.origin);
    assert.equal((await owner.api('DELETE', `/api/sentences/${ownerFirst.id}`)).status, 200);
    assert.equal(copies('owner').length, 1);
    assert.equal(copies(memberId).length, 7);

    // 停用题库：不再抽到；启用后照常
    await owner.api('PUT', `/api/admin/bank/${CET4_BANK.id}`, { enabled: false });
    assert.equal((await owner.api('POST', '/api/sentences/generate', { kind: 'extra', count: 1 })).status, 409);
    await owner.api('PUT', `/api/admin/bank/${CET4_BANK.id}`, { enabled: true });
    assert.equal((await owner.api('POST', '/api/sentences/generate', { kind: 'extra', count: 1 })).status, 200);

    // 今日任务也能从题库出（没配模型）
    await seedReadyBank();
    const daily = await member.api('POST', '/api/sentences/generate', { kind: 'daily' });
    assert.equal(daily.status, 200);
    assert.ok(daily.body.added.every((id: string) => /-d\d+$/.test(id)));
  } finally {
    site.close();
  }
});

test('抽题：先题库不够再 AI——四六级混出时四级从题库抽、六级 AI 出；题库抽完了四级也由 AI 补上', async () => {
  await seedReadyBank();
  const fake = await startFakeLlm({
    generate: (prompt) => {
      const order = /按顺序出：(.*?)。/.exec(prompt)?.[1]?.match(/CET-[46]/g) || ['CET-4'];
      return { sentences: order.map((level) => ({ ...EXAMPLE, level })) };
    },
  });
  const site = await siteWithMember();
  try {
    const { owner } = site;
    db.raw(`DELETE FROM ai_usage WHERE account_id = 'owner'`);
    await owner.api('PUT', '/api/settings/llm', { baseUrl: fake.url, apiKey: 'k', mainModel: 'fake-main' });
    await owner.api('PUT', '/api/settings/practice', { questionSource: 'bankFirst', levels: ['CET-4', 'CET-6'] });
    const r = await owner.api('POST', '/api/sentences/generate', { kind: 'extra', count: 4 });
    assert.equal(r.body.added.length, 4);
    const added = (await owner.api('GET', '/api/sentences')).body.sentences.filter((s: Sentence) =>
      r.body.added.includes(s.id),
    ) as Sentence[];
    assert.deepEqual(
      added.filter((s) => s.origin).map((s) => s.level),
      ['CET-4', 'CET-4'],
    );
    assert.deepEqual(
      added.filter((s) => !s.origin).map((s) => s.level),
      ['CET-6', 'CET-6'],
    );
    const prompt = fake.calls.find((c) => c.prompt?.includes('按顺序出'))?.prompt ?? '';
    assert.match(prompt, /按顺序出：第 1 句 CET-6，第 2 句 CET-6。/, '四级不让 AI 出');
    assert.equal((await owner.api('GET', '/api/usage')).body.gens, 1, 'AI 出了题，占一次');

    // 只出四级、题库已经抽完：先题库模式由 AI 补上
    db.raw(`UPDATE bank_items SET status = 'rejected', reject_reason = '测试' WHERE status = 'ready'`);
    await owner.api('PUT', '/api/settings/practice', { levels: ['CET-4'] });
    const more = await owner.api('POST', '/api/sentences/generate', { kind: 'extra', count: 2 });
    assert.equal(more.body.added.length, 2);
    // 纯题库模式就没有了
    await owner.api('PUT', '/api/settings/practice', { questionSource: 'bank' });
    assert.equal((await owner.api('POST', '/api/sentences/generate', { kind: 'extra', count: 2 })).status, 409);
    // 只选六级：用不到题库，照旧 AI 出
    await owner.api('PUT', '/api/settings/practice', { levels: ['CET-6'] });
    assert.equal((await owner.api('POST', '/api/sentences/generate', { kind: 'extra', count: 1 })).status, 200);
  } finally {
    site.close();
    fake.close();
  }
});

test('每日定时任务：选了题库的邀请账户没配模型也会生成', async () => {
  await seedReadyBank();
  const site = await siteWithMember();
  try {
    await site.member.api('PUT', '/api/settings/practice', {
      questionSource: 'bank',
      levels: ['CET-4'],
      dailyCount: 3,
      dailyAt: '00:00',
    });
    const cfg = loadConfig({ ACCESS_PASSWORD: 'pw-bank', COOKIE_SECRET: 'b'.repeat(64) });
    const noLlm = createLlm(cfg);
    const runner = createDailyRunner({
      ai: createAi({ cfg, llm: noLlm, log: quiet }),
      llmFor: async () => noLlm,
      practice: createPractice(cfg),
      log: quiet,
    });
    await runner.tick();
    const today = shanghaiDate();
    assert.equal(
      db
        .raw(
          `SELECT count(*) FROM sentences WHERE account_id = '${site.memberId}' AND source = 'daily'
              AND batch = '${today}' AND bank_item_id IS NOT NULL`,
        )
        .trim(),
      '3',
    );
  } finally {
    site.close();
  }
});
