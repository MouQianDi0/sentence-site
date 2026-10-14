// 所有 SQL 都在这里。日期和时间统一在 SQL 里转成字符串，接口返回的格式稳定。
import { query } from './db.js';

const SENTENCE_COLS = `id, to_json(created_at)#>>'{}' AS created, batch::text AS batch, source, level, focus,
  segs, trunk, trunk_zh AS "trunkZh", trap, tip, ref, opts, words, phrases`;
const RECORD_COLS = `sentence_id AS "sentenceId", done, verbs, choice, draft,
  to_json(first_at)#>>'{}' AS "firstAt", to_json(updated_at)#>>'{}' AS "updatedAt"`;
const ATTEMPT_COLS = `id::int AS id, sentence_id AS "sentenceId", text, acc, flu, comp, total, feedback, model,
  input_tokens AS "inputTokens", output_tokens AS "outputTokens", to_json(created_at)#>>'{}' AS "createdAt"`;

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

// ---- schema ------------------------------------------------------------------
export async function ensureSchema(sql) {
  await query(sql);
}

// ---- sentences ---------------------------------------------------------------
export async function listSentences(since = null) {
  const { rows } = await query(
    `SELECT ${SENTENCE_COLS} FROM sentences
     WHERE ($1::timestamptz IS NULL OR created_at > $1::timestamptz)
     ORDER BY created_at, id`,
    [since],
  );
  return rows;
}

export async function getSentence(id) {
  const { rows } = await query(`SELECT ${SENTENCE_COLS} FROM sentences WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function recentSentences(limit = 40) {
  const { rows } = await query(
    `SELECT ${SENTENCE_COLS} FROM sentences ORDER BY created_at DESC, id DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function countSentences() {
  const { rows } = await query('SELECT count(*)::int AS n FROM sentences');
  return rows[0].n;
}

export async function hasDailyFor(day) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM sentences WHERE source = 'daily' AND batch = $1::date`,
    [day],
  );
  return rows[0].n > 0;
}

export async function countDailyFor(day) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM sentences WHERE source = 'daily' AND batch = $1::date`,
    [day],
  );
  return rows[0].n;
}

/** 已存在同 id 时跳过；返回是否真的插入了 */
export async function insertSentence(s) {
  const { rows } = await query(
    `INSERT INTO sentences (id, created_at, batch, source, level, focus, segs, trunk, trunk_zh, trap, tip, ref, opts, words, phrases)
     VALUES ($1, $2::timestamptz, $3::date, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      s.id, s.created, s.batch, s.source, s.level || null, s.focus || null, json(s.segs),
      s.trunk || null, s.trunkZh || null, s.trap || null, s.tip || null, s.ref || null,
      json(s.opts), json(s.words || []), json(s.phrases || []),
    ],
  );
  return rows.length > 0;
}

/** 只改谓语标注（segs）；返回是否找到这句 */
export async function updateSegs(id, segs) {
  const { rowCount } = await query('UPDATE sentences SET segs = $2::jsonb WHERE id = $1', [id, json(segs)]);
  return rowCount > 0;
}

export async function deleteSentence(id) {
  const { rowCount } = await query('DELETE FROM sentences WHERE id = $1', [id]);
  return rowCount > 0;
}

// ---- records -----------------------------------------------------------------
export async function listRecords() {
  const { rows } = await query(`SELECT ${RECORD_COLS} FROM records ORDER BY updated_at DESC`);
  return rows;
}

const RECORD_FIELDS = {
  done: { col: 'done', cast: '::boolean', val: (v) => v },
  verbs: { col: 'verbs', cast: '::jsonb', val: json },
  choice: { col: 'choice', cast: '::jsonb', val: json },
  draft: { col: 'draft', cast: '::text', val: (v) => v },
  firstAt: { col: 'first_at', cast: '::timestamptz', val: (v) => v },
  updatedAt: { col: 'updated_at', cast: '::timestamptz', val: (v) => v },
};

/** 只写传进来的字段；记录不存在时新建。句子不存在时抛出外键错误（23503）。 */
export async function upsertRecord(sentenceId, fields) {
  const cols = ['sentence_id'];
  const vals = ['$1'];
  const params = [sentenceId];
  const sets = [];
  for (const [key, value] of Object.entries(fields)) {
    const f = RECORD_FIELDS[key];
    if (!f) continue;
    params.push(f.val(value));
    cols.push(f.col);
    vals.push(`$${params.length}${f.cast}`);
    if (key !== 'firstAt') sets.push(`${f.col} = EXCLUDED.${f.col}`);
  }
  if (!('updatedAt' in fields)) sets.push('updated_at = now()');
  const { rows } = await query(
    `INSERT INTO records (${cols.join(', ')}) VALUES (${vals.join(', ')})
     ON CONFLICT (sentence_id) DO UPDATE SET ${sets.join(', ')}
     RETURNING ${RECORD_COLS}`,
    params,
  );
  return rows[0];
}

export async function countRecords() {
  const { rows } = await query('SELECT count(*)::int AS n FROM records');
  return rows[0].n;
}

// ---- attempts ----------------------------------------------------------------
export async function listAttempts(sentenceId = null) {
  const { rows } = await query(
    `SELECT ${ATTEMPT_COLS} FROM attempts
     WHERE ($1::text IS NULL OR sentence_id = $1)
     ORDER BY created_at DESC, id DESC
     LIMIT 1000`,
    [sentenceId],
  );
  return rows;
}

export async function insertAttempt(a) {
  const { rows } = await query(
    `INSERT INTO attempts (sentence_id, text, acc, flu, comp, total, feedback, model, input_tokens, output_tokens, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, COALESCE($11::timestamptz, now()))
     RETURNING ${ATTEMPT_COLS}`,
    [
      a.sentenceId, a.text, a.acc, a.flu, a.comp, a.total, json(a.feedback), a.model || null,
      a.inputTokens ?? null, a.outputTokens ?? null, a.createdAt || null,
    ],
  );
  return rows[0];
}

export async function countAttemptsFor(sentenceId) {
  const { rows } = await query('SELECT count(*)::int AS n FROM attempts WHERE sentence_id = $1', [sentenceId]);
  return rows[0].n;
}

// ---- dict cache --------------------------------------------------------------
export async function getDict(sentenceId, word) {
  const { rows } = await query(
    'SELECT data FROM dict_cache WHERE sentence_id = $1 AND word = $2',
    [sentenceId, word],
  );
  return rows[0]?.data || null;
}

export async function putDict(sentenceId, word, data) {
  await query(
    `INSERT INTO dict_cache (sentence_id, word, data) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (sentence_id, word) DO UPDATE SET data = EXCLUDED.data`,
    [sentenceId, word, json(data)],
  );
}

// ---- settings ----------------------------------------------------------------
export async function getSetting(key) {
  const { rows } = await query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

export async function putSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, json(value)],
  );
}

export async function deleteSetting(key) {
  await query('DELETE FROM settings WHERE key = $1', [key]);
}

// ---- daily usage -------------------------------------------------------------
const USAGE_FIELDS = ['grades', 'lookups', 'gens'];

export async function getUsage(day) {
  const { rows } = await query(
    'SELECT grades, lookups, gens FROM ai_usage WHERE day = $1::date',
    [day],
  );
  return rows[0] || { grades: 0, lookups: 0, gens: 0 };
}

export async function bumpUsage(day, field) {
  if (!USAGE_FIELDS.includes(field)) throw new Error(`unknown usage field ${field}`);
  await query(
    `INSERT INTO ai_usage (day, ${field}) VALUES ($1::date, 1)
     ON CONFLICT (day) DO UPDATE SET ${field} = ai_usage.${field} + 1`,
    [day],
  );
}
