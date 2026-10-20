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
import type { SentenceBody } from '@sentence-site/shared';
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
