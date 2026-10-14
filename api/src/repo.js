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
// 句子都按账户隔离：除了全局计数，查询都要带 accountId，取不到别的账户的句子。
export async function listSentences(accountId, since = null) {
  const { rows } = await query(
    `SELECT ${SENTENCE_COLS} FROM sentences
     WHERE account_id = $1 AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)
     ORDER BY created_at, id`,
    [accountId, since],
  );
  return rows;
}

export async function getSentence(accountId, id) {
  const { rows } = await query(`SELECT ${SENTENCE_COLS} FROM sentences WHERE id = $1 AND account_id = $2`, [id, accountId]);
  return rows[0] || null;
}

export async function recentSentences(accountId, limit = 40) {
  const { rows } = await query(
    `SELECT ${SENTENCE_COLS} FROM sentences WHERE account_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [accountId, limit],
  );
  return rows;
}

/** 所有账户的句子总数（健康检查、首次启动导入用） */
export async function countSentences() {
  const { rows } = await query('SELECT count(*)::int AS n FROM sentences');
  return rows[0].n;
}

export async function hasDailyFor(accountId, day) {
  return (await countDailyFor(accountId, day)) > 0;
}

export async function countDailyFor(accountId, day) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM sentences WHERE account_id = $1 AND source = 'daily' AND batch = $2::date`,
    [accountId, day],
  );
  return rows[0].n;
}

/** 已存在同 id 时跳过；返回是否真的插入了。accountId 不传时归到 owner（导入旧数据用） */
export async function insertSentence(s) {
  const { rows } = await query(
    `INSERT INTO sentences (id, created_at, batch, source, level, focus, segs, trunk, trunk_zh, trap, tip, ref, opts, words, phrases, account_id)
     VALUES ($1, $2::timestamptz, $3::date, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      s.id, s.created, s.batch, s.source, s.level || null, s.focus || null, json(s.segs),
      s.trunk || null, s.trunkZh || null, s.trap || null, s.tip || null, s.ref || null,
      json(s.opts), json(s.words || []), json(s.phrases || []), s.accountId || 'owner',
    ],
  );
  return rows.length > 0;
}

/** 只改谓语标注（segs）；返回是否找到这句 */
export async function updateSegs(accountId, id, segs) {
  const { rowCount } = await query('UPDATE sentences SET segs = $3::jsonb WHERE id = $1 AND account_id = $2', [id, accountId, json(segs)]);
  return rowCount > 0;
}

export async function deleteSentence(accountId, id) {
  const { rowCount } = await query('DELETE FROM sentences WHERE id = $1 AND account_id = $2', [id, accountId]);
  return rowCount > 0;
}

// ---- records -----------------------------------------------------------------
export async function listRecords(accountId) {
  const { rows } = await query(
    `SELECT ${RECORD_COLS} FROM records
     WHERE sentence_id IN (SELECT id FROM sentences WHERE account_id = $1)
     ORDER BY updated_at DESC`,
    [accountId],
  );
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

/** 只写传进来的字段；记录不存在时新建。句子不存在时抛出外键错误（23503）。调用前先确认句子属于当前账户 */
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
export async function listAttempts(accountId, sentenceId = null) {
  const { rows } = await query(
    `SELECT ${ATTEMPT_COLS} FROM attempts
     WHERE sentence_id IN (SELECT id FROM sentences WHERE account_id = $1)
       AND ($2::text IS NULL OR sentence_id = $2)
     ORDER BY created_at DESC, id DESC
     LIMIT 1000`,
    [accountId, sentenceId],
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

// ---- daily usage（按账户分别计数）----------------------------------------------
const USAGE_FIELDS = ['grades', 'lookups', 'gens'];

export async function getUsage(accountId, day) {
  const { rows } = await query(
    'SELECT grades, lookups, gens FROM ai_usage WHERE account_id = $1 AND day = $2::date',
    [accountId, day],
  );
  return rows[0] || { grades: 0, lookups: 0, gens: 0 };
}

export async function bumpUsage(accountId, day, field) {
  if (!USAGE_FIELDS.includes(field)) throw new Error(`unknown usage field ${field}`);
  await query(
    `INSERT INTO ai_usage (account_id, day, ${field}) VALUES ($1, $2::date, 1)
     ON CONFLICT (account_id, day) DO UPDATE SET ${field} = ai_usage.${field} + 1`,
    [accountId, day],
  );
}

// ---- accounts ----------------------------------------------------------------
const ACCOUNT_COLS = `id, role, note, code_hash AS "codeHash", code_enc AS "codeEnc", practice,
  to_json(created_at)#>>'{}' AS "createdAt", to_json(last_seen_at)#>>'{}' AS "lastSeenAt"`;

export async function getAccount(id) {
  const { rows } = await query(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function findAccountByCode(codeHash) {
  const { rows } = await query(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE code_hash = $1 AND role = 'member'`, [codeHash]);
  return rows[0] || null;
}

/** 邀请账户，新建的在前 */
export async function listMembers() {
  const { rows } = await query(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE role = 'member' ORDER BY created_at DESC, id DESC`);
  return rows;
}

/** 每日自动出题要照顾的账户：owner，加上最近 days 天里登录过的邀请账户 */
export async function listActiveAccounts(days = 7) {
  const { rows } = await query(
    `SELECT ${ACCOUNT_COLS} FROM accounts
     WHERE role = 'owner' OR last_seen_at > now() - ($1::int * interval '1 day')
     ORDER BY role DESC, created_at`,
    [days],
  );
  return rows;
}

/** 新建邀请账户；邀请码撞上已有的返回 false */
export async function insertMember({ id, note, codeHash, codeEnc }) {
  const { rows } = await query(
    `INSERT INTO accounts (id, role, note, code_hash, code_enc)
     VALUES ($1, 'member', $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [id, note, codeHash, codeEnc],
  );
  return rows.length > 0;
}

/** 邀请账户自己的模型配置（没配过返回 null） */
export async function getAccountLlm(id) {
  const { rows } = await query('SELECT llm FROM accounts WHERE id = $1', [id]);
  return rows[0]?.llm ?? null;
}

export async function setAccountLlm(id, value) {
  await query('UPDATE accounts SET llm = $2::jsonb WHERE id = $1', [id, json(value)]);
}

/** 删除邀请账户，连带它的句子、记录、批改、查词缓存和用量 */
export async function deleteMember(id) {
  const { rowCount } = await query(`DELETE FROM accounts WHERE id = $1 AND role = 'member'`, [id]);
  return rowCount > 0;
}

export async function setPractice(id, practice) {
  await query('UPDATE accounts SET practice = $2::jsonb WHERE id = $1', [id, json(practice)]);
}

export async function touchAccount(id) {
  await query('UPDATE accounts SET last_seen_at = now() WHERE id = $1', [id]);
}
