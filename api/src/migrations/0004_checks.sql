-- 数据库改进第 4 步：给账户、句子、批改加 CHECK 约束，把代码里一直遵守的规则交给数据库守着。
-- 只加约束、不改数据，上一版代码写的数据本来就满足；万一现有数据有不满足的，整份失败、新版本起不来、自动退回上一版，数据不变。

-- 整份可以重复执行（测试里会删掉 schema_migrations 模拟老库再迁移一遍）。

-- ---- accounts ----
-- 只有 id 为 owner 的是 owner
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_owner_id;
ALTER TABLE accounts ADD CONSTRAINT accounts_owner_id CHECK ((id = 'owner') = (role = 'owner'));
-- 邀请账户靠邀请码登录，必须有邀请码
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_member_code;
ALTER TABLE accounts ADD CONSTRAINT accounts_member_code CHECK (role = 'owner' OR code_hash IS NOT NULL);
-- 有效期只有这几档，NULL 是永久（accounts.ts 的 VALID_DAYS）
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_valid_days;
ALTER TABLE accounts ADD CONSTRAINT accounts_valid_days CHECK (valid_days IN (30, 90, 180, 360));
-- 设备数 1–10（accounts.ts 的 MAX_DEVICES）
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_device_limit;
ALTER TABLE accounts ADD CONSTRAINT accounts_device_limit CHECK (device_limit BETWEEN 1 AND 10);
-- 有到期时间的，一定登录过、有有效期
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_expiry;
ALTER TABLE accounts ADD CONSTRAINT accounts_expiry
  CHECK (expires_at IS NULL OR (activated_at IS NOT NULL AND valid_days IS NOT NULL));

-- ---- sentences ----
-- 片段、选项、单词、词组都是数组（shared/src/types.ts 的 Sentence）
ALTER TABLE sentences DROP CONSTRAINT IF EXISTS sentences_json_shape;
ALTER TABLE sentences ADD CONSTRAINT sentences_json_shape CHECK (
  jsonb_typeof(segs) = 'array' AND jsonb_typeof(opts) = 'array'
  AND jsonb_typeof(words) = 'array' AND jsonb_typeof(phrases) = 'array'
);
-- 来源（SentenceSource）。0001 建表时已有同样内容的 sentences_source_check，这里换成统一命名
ALTER TABLE sentences DROP CONSTRAINT IF EXISTS sentences_source_check;
ALTER TABLE sentences DROP CONSTRAINT IF EXISTS sentences_source;
ALTER TABLE sentences ADD CONSTRAINT sentences_source CHECK (source IN ('seed', 'daily', 'manual', 'extra'));

-- ---- attempts ----
-- 准确 0–40、通顺 0–30、完整 0–30、总分 0–100（ai.ts 的 cleanFeedback），导入的旧批改可能没有分数
ALTER TABLE attempts DROP CONSTRAINT IF EXISTS attempts_scores;
ALTER TABLE attempts ADD CONSTRAINT attempts_scores CHECK (
  acc BETWEEN 0 AND 40 AND flu BETWEEN 0 AND 30 AND comp BETWEEN 0 AND 30 AND total BETWEEN 0 AND 100
);
