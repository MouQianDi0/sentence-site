// 所有 SQL 都在这里。日期和时间统一在 SQL 里转成字符串，接口返回的格式稳定。
import type {
  AccountRole,
  Attempt,
  Feedback,
  PracticeRecord,
  RecordPatch,
  Sentence,
  SentenceBody,
  SentenceSource,
  Seg,
} from '@sentence-site/shared';
import { query } from './db.ts';

/** accounts 表的一行 */
export interface AccountRow {
  id: string;
  role: AccountRole;
  note: string;
  codeHash: string | null;
  codeEnc: string | null;
  /** 每日任务设置（格式见 practice.ts） */
  practice: unknown;
  deviceLimit: number;
  createdAt: string;
  lastSeenAt: string | null;
}

/** devices 表的一行 */
export interface DeviceRow {
  accountId: string;
  id: string;
  label: string;
  ip: string | null;
  firstSeen: string;
  lastSeen: string;
}

/** 要写入的句子：校验过的内容 + 编号、时间、来源 */
export interface NewSentence extends SentenceBody {
  id: string;
  created: string;
  batch: string;
  source: SentenceSource;
  /** 不传时归到 owner（导入旧数据用） */
  accountId?: string;
}

export interface NewAttempt {
  sentenceId: string;
  text: string;
  acc: number | null;
  flu: number | null;
  comp: number | null;
  total: number | null;
  feedback: Feedback | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  createdAt?: string | null;
}

export interface UsageRow {
  grades: number;
  lookups: number;
  gens: number;
}
export type UsageField = keyof UsageRow;

type Count = { n: number };

const SENTENCE_COLS = `id, to_json(created_at)#>>'{}' AS created, batch::text AS batch, source, level, focus,
  segs, trunk, trunk_zh AS "trunkZh", trap, tip, ref, opts, words, phrases`;
const RECORD_COLS = `sentence_id AS "sentenceId", done, verbs, choice, draft,
  to_json(first_at)#>>'{}' AS "firstAt", to_json(updated_at)#>>'{}' AS "updatedAt"`;
const ATTEMPT_COLS = `id::int AS id, sentence_id AS "sentenceId", text, acc, flu, comp, total, feedback, model,
  input_tokens AS "inputTokens", output_tokens AS "outputTokens", to_json(created_at)#>>'{}' AS "createdAt"`;

const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

// ---- schema ------------------------------------------------------------------
export async function ensureSchema(sql: string): Promise<void> {
  await query(sql);
}

// ---- sentences ---------------------------------------------------------------
// 句子都按账户隔离：除了全局计数，查询都要带 accountId，取不到别的账户的句子。
export async function listSentences(accountId: string, since: string | null = null): Promise<Sentence[]> {
  const { rows } = await query<Sentence>(
    `SELECT ${SENTENCE_COLS} FROM sentences
     WHERE account_id = $1 AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)
     ORDER BY created_at, id`,
    [accountId, since],
  );
  return rows;
}

export async function getSentence(accountId: string, id: string): Promise<Sentence | null> {
  const { rows } = await query<Sentence>(`SELECT ${SENTENCE_COLS} FROM sentences WHERE id = $1 AND account_id = $2`, [
    id,
    accountId,
  ]);
  return rows[0] || null;
}

export async function recentSentences(accountId: string, limit = 40): Promise<Sentence[]> {
  const { rows } = await query<Sentence>(
    `SELECT ${SENTENCE_COLS} FROM sentences WHERE account_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [accountId, limit],
  );
  return rows;
}

/** 所有账户的句子总数（健康检查、首次启动导入用） */
export async function countSentences(): Promise<number> {
  const { rows } = await query<Count>('SELECT count(*)::int AS n FROM sentences');
  return rows[0]?.n ?? 0;
}

export async function hasDailyFor(accountId: string, day: string): Promise<boolean> {
  return (await countDailyFor(accountId, day)) > 0;
}

export async function countDailyFor(accountId: string, day: string): Promise<number> {
  const { rows } = await query<Count>(
    `SELECT count(*)::int AS n FROM sentences WHERE account_id = $1 AND source = 'daily' AND batch = $2::date`,
    [accountId, day],
  );
  return rows[0]?.n ?? 0;
}

/** 已存在同 id 时跳过；返回是否真的插入了。accountId 不传时归到 owner（导入旧数据用） */
export async function insertSentence(s: NewSentence): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO sentences (id, created_at, batch, source, level, focus, segs, trunk, trunk_zh, trap, tip, ref, opts, words, phrases, account_id)
     VALUES ($1, $2::timestamptz, $3::date, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      s.id,
      s.created,
      s.batch,
      s.source,
      s.level || null,
      s.focus || null,
      json(s.segs),
      s.trunk || null,
      s.trunkZh || null,
      s.trap || null,
      s.tip || null,
      s.ref || null,
      json(s.opts),
      json(s.words || []),
      json(s.phrases || []),
      s.accountId || 'owner',
    ],
  );
  return rows.length > 0;
}

/** 只改谓语标注（segs）；返回是否找到这句 */
export async function updateSegs(accountId: string, id: string, segs: Seg[]): Promise<boolean> {
  const { rowCount } = await query('UPDATE sentences SET segs = $3::jsonb WHERE id = $1 AND account_id = $2', [
    id,
    accountId,
    json(segs),
  ]);
  return rowCount > 0;
}

export async function deleteSentence(accountId: string, id: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM sentences WHERE id = $1 AND account_id = $2', [id, accountId]);
  return rowCount > 0;
}

// ---- records -----------------------------------------------------------------
export async function listRecords(accountId: string): Promise<PracticeRecord[]> {
  const { rows } = await query<PracticeRecord>(
    `SELECT ${RECORD_COLS} FROM records
     WHERE sentence_id IN (SELECT id FROM sentences WHERE account_id = $1)
     ORDER BY updated_at DESC`,
    [accountId],
  );
  return rows;
}

/** 练习记录要写的字段；导入旧数据时还可以带上原来的时间 */
export type RecordFields = RecordPatch & { firstAt?: string; updatedAt?: string };

const same = (v: unknown) => v;
const RECORD_FIELDS: Record<keyof RecordFields, { col: string; cast: string; val: (v: unknown) => unknown }> = {
  done: { col: 'done', cast: '::boolean', val: same },
  verbs: { col: 'verbs', cast: '::jsonb', val: json },
  choice: { col: 'choice', cast: '::jsonb', val: json },
  draft: { col: 'draft', cast: '::text', val: same },
  firstAt: { col: 'first_at', cast: '::timestamptz', val: same },
  updatedAt: { col: 'updated_at', cast: '::timestamptz', val: same },
};

/** 只写传进来的字段；记录不存在时新建。句子不存在时抛出外键错误（23503）。调用前先确认句子属于当前账户 */
export async function upsertRecord(sentenceId: string, fields: RecordFields): Promise<PracticeRecord> {
  const cols = ['sentence_id'];
  const vals = ['$1'];
  const params: unknown[] = [sentenceId];
  const sets: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const f = RECORD_FIELDS[key as keyof RecordFields];
    if (!f) continue;
    params.push(f.val(value));
    cols.push(f.col);
    vals.push(`$${params.length}${f.cast}`);
    if (key !== 'firstAt') sets.push(`${f.col} = EXCLUDED.${f.col}`);
  }
  if (!('updatedAt' in fields)) sets.push('updated_at = now()');
  const { rows } = await query<PracticeRecord>(
    `INSERT INTO records (${cols.join(', ')}) VALUES (${vals.join(', ')})
     ON CONFLICT (sentence_id) DO UPDATE SET ${sets.join(', ')}
     RETURNING ${RECORD_COLS}`,
    params,
  );
  const row = rows[0];
  if (!row) throw new Error('数据库没有返回写入的行');
  return row;
}

export async function countRecords(): Promise<number> {
  const { rows } = await query<Count>('SELECT count(*)::int AS n FROM records');
  return rows[0]?.n ?? 0;
}

// ---- attempts ----------------------------------------------------------------
export async function listAttempts(accountId: string, sentenceId: string | null = null): Promise<Attempt[]> {
  const { rows } = await query<Attempt>(
    `SELECT ${ATTEMPT_COLS} FROM attempts
     WHERE sentence_id IN (SELECT id FROM sentences WHERE account_id = $1)
       AND ($2::text IS NULL OR sentence_id = $2)
     ORDER BY created_at DESC, id DESC
     LIMIT 1000`,
    [accountId, sentenceId],
  );
  return rows;
}

export async function insertAttempt(a: NewAttempt): Promise<Attempt> {
  const { rows } = await query<Attempt>(
    `INSERT INTO attempts (sentence_id, text, acc, flu, comp, total, feedback, model, input_tokens, output_tokens, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, COALESCE($11::timestamptz, now()))
     RETURNING ${ATTEMPT_COLS}`,
    [
      a.sentenceId,
      a.text,
      a.acc,
      a.flu,
      a.comp,
      a.total,
      json(a.feedback),
      a.model || null,
      a.inputTokens ?? null,
      a.outputTokens ?? null,
      a.createdAt || null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('数据库没有返回写入的行');
  return row;
}

export async function countAttemptsFor(sentenceId: string): Promise<number> {
  const { rows } = await query<Count>('SELECT count(*)::int AS n FROM attempts WHERE sentence_id = $1', [sentenceId]);
  return rows[0]?.n ?? 0;
}

// ---- dict cache --------------------------------------------------------------
export async function getDict(sentenceId: string, word: string): Promise<unknown> {
  const { rows } = await query<{ data: unknown }>('SELECT data FROM dict_cache WHERE sentence_id = $1 AND word = $2', [
    sentenceId,
    word,
  ]);
  return rows[0]?.data || null;
}

export async function putDict(sentenceId: string, word: string, data: unknown): Promise<void> {
  await query(
    `INSERT INTO dict_cache (sentence_id, word, data) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (sentence_id, word) DO UPDATE SET data = EXCLUDED.data`,
    [sentenceId, word, json(data)],
  );
}

// ---- settings ----------------------------------------------------------------
export async function getSetting(key: string): Promise<unknown> {
  const { rows } = await query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

export async function putSetting(key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, json(value)],
  );
}

export async function deleteSetting(key: string): Promise<void> {
  await query('DELETE FROM settings WHERE key = $1', [key]);
}

// ---- daily usage（按账户分别计数）----------------------------------------------
const USAGE_FIELDS: UsageField[] = ['grades', 'lookups', 'gens'];

export async function getUsage(accountId: string, day: string): Promise<UsageRow> {
  const { rows } = await query<UsageRow>(
    'SELECT grades, lookups, gens FROM ai_usage WHERE account_id = $1 AND day = $2::date',
    [accountId, day],
  );
  return rows[0] || { grades: 0, lookups: 0, gens: 0 };
}

export async function bumpUsage(accountId: string, day: string, field: UsageField): Promise<void> {
  if (!USAGE_FIELDS.includes(field)) throw new Error(`unknown usage field ${field}`);
  await query(
    `INSERT INTO ai_usage (account_id, day, ${field}) VALUES ($1, $2::date, 1)
     ON CONFLICT (account_id, day) DO UPDATE SET ${field} = ai_usage.${field} + 1`,
    [accountId, day],
  );
}

// ---- accounts ----------------------------------------------------------------
const ACCOUNT_COLS = `id, role, note, code_hash AS "codeHash", code_enc AS "codeEnc", practice, device_limit AS "deviceLimit",
  to_json(created_at)#>>'{}' AS "createdAt", to_json(last_seen_at)#>>'{}' AS "lastSeenAt"`;

export async function getAccount(id: string): Promise<AccountRow | null> {
  const { rows } = await query<AccountRow>(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function findAccountByCode(codeHash: string): Promise<AccountRow | null> {
  const { rows } = await query<AccountRow>(
    `SELECT ${ACCOUNT_COLS} FROM accounts WHERE code_hash = $1 AND role = 'member'`,
    [codeHash],
  );
  return rows[0] || null;
}

/** 邀请账户，新建的在前 */
export async function listMembers(): Promise<AccountRow[]> {
  const { rows } = await query<AccountRow>(
    `SELECT ${ACCOUNT_COLS} FROM accounts WHERE role = 'member' ORDER BY created_at DESC, id DESC`,
  );
  return rows;
}

/** 每日自动出题要照顾的账户：owner，加上最近 days 天里登录过的邀请账户 */
export async function listActiveAccounts(days = 7): Promise<AccountRow[]> {
  const { rows } = await query<AccountRow>(
    `SELECT ${ACCOUNT_COLS} FROM accounts
     WHERE role = 'owner' OR last_seen_at > now() - ($1::int * interval '1 day')
     ORDER BY role DESC, created_at`,
    [days],
  );
  return rows;
}

/** 新建邀请账户；邀请码撞上已有的返回 false */
export async function insertMember({
  id,
  note,
  codeHash,
  codeEnc,
}: {
  id: string;
  note: string;
  codeHash: string;
  codeEnc: string;
}): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO accounts (id, role, note, code_hash, code_enc)
     VALUES ($1, 'member', $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [id, note, codeHash, codeEnc],
  );
  return rows.length > 0;
}

/** 邀请账户自己的模型配置（没配过返回 null） */
export async function getAccountLlm(id: string): Promise<unknown> {
  const { rows } = await query<{ llm: unknown }>('SELECT llm FROM accounts WHERE id = $1', [id]);
  return rows[0]?.llm ?? null;
}

export async function setAccountLlm(id: string, value: unknown): Promise<void> {
  await query('UPDATE accounts SET llm = $2::jsonb WHERE id = $1', [id, json(value)]);
}

/** 删除邀请账户，连带它的句子、记录、批改、查词缓存和用量 */
export async function deleteMember(id: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM accounts WHERE id = $1 AND role = 'member'`, [id]);
  return rowCount > 0;
}

export async function setPractice(id: string, practice: unknown): Promise<void> {
  await query('UPDATE accounts SET practice = $2::jsonb WHERE id = $1', [id, json(practice)]);
}

export async function touchAccount(id: string): Promise<void> {
  await query('UPDATE accounts SET last_seen_at = now() WHERE id = $1', [id]);
}

export async function setDeviceLimit(id: string, n: number): Promise<boolean> {
  const { rowCount } = await query(`UPDATE accounts SET device_limit = $2 WHERE id = $1 AND role = 'member'`, [id, n]);
  return rowCount > 0;
}

// ---- devices（邀请账户登录过的设备）---------------------------------------------
const DEVICE_COLS = `account_id AS "accountId", device_id AS "id", label, last_ip AS "ip",
  to_json(first_seen)#>>'{}' AS "firstSeen", to_json(last_seen)#>>'{}' AS "lastSeen"`;

export async function getDevice(accountId: string, deviceId: string): Promise<DeviceRow | null> {
  const { rows } = await query<DeviceRow>(
    `SELECT ${DEVICE_COLS} FROM devices WHERE account_id = $1 AND device_id = $2`,
    [accountId, deviceId],
  );
  return rows[0] || null;
}

/** 所有邀请账户的设备，最近用过的在前（管理页用） */
export async function listMemberDevices(): Promise<DeviceRow[]> {
  const { rows } = await query<DeviceRow>(
    `SELECT ${DEVICE_COLS} FROM devices
     WHERE account_id IN (SELECT id FROM accounts WHERE role = 'member')
     ORDER BY last_seen DESC`,
  );
  return rows;
}

/** 登记一台新设备；这个账户的设备数已经到上限时不登记，返回 false */
export async function addDevice({
  accountId,
  deviceId,
  label,
  ip,
}: {
  accountId: string;
  deviceId: string;
  label: string;
  ip: string;
}): Promise<boolean> {
  const { rows } = await query<{ device_id: string }>(
    `INSERT INTO devices (account_id, device_id, label, last_ip)
     SELECT $1, $2, $3, $4
     WHERE (SELECT count(*) FROM devices WHERE account_id = $1) < (SELECT device_limit FROM accounts WHERE id = $1)
     ON CONFLICT DO NOTHING
     RETURNING device_id`,
    [accountId, deviceId, label, ip],
  );
  return rows.length > 0;
}

export async function touchDevice(accountId: string, deviceId: string, ip: string): Promise<void> {
  await query('UPDATE devices SET last_seen = now(), last_ip = $3 WHERE account_id = $1 AND device_id = $2', [
    accountId,
    deviceId,
    ip,
  ]);
}

export async function deleteDevice(accountId: string, deviceId: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM devices WHERE account_id = $1 AND device_id = $2', [
    accountId,
    deviceId,
  ]);
  return rowCount > 0;
}
