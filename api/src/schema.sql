-- 长难句拆解台 · 自用版数据表（与计划文档“数据模型”一节一致）

CREATE TABLE IF NOT EXISTS sentences (
  id         text PRIMARY KEY,              -- 沿用 s-20261013-01 这种格式
  created_at timestamptz NOT NULL DEFAULT now(),
  batch      date NOT NULL,
  source     text NOT NULL CHECK (source IN ('seed','daily','manual','extra')),  -- extra = 加练
  level      text,                          -- CET-4 / CET-6
  focus      text,
  segs       jsonb NOT NULL,                -- [{r,t,n,k}]，*主句谓语* ^从句谓语^ 标记不变
  trunk      text, trunk_zh text, trap text, tip text, ref text,
  opts       jsonb NOT NULL,                -- [{t,ok,why}]
  words      jsonb NOT NULL DEFAULT '[]',
  phrases    jsonb NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS records (
  sentence_id text PRIMARY KEY REFERENCES sentences(id) ON DELETE CASCADE,
  done        boolean NOT NULL DEFAULT false,
  verbs       jsonb,                        -- {ok,total,wrong}
  choice      jsonb,                        -- {pick,ok}
  draft       text,
  first_at    timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attempts (
  id            bigserial PRIMARY KEY,
  sentence_id   text REFERENCES sentences(id) ON DELETE CASCADE,
  text          text NOT NULL,
  acc smallint, flu smallint, comp smallint, total smallint,
  feedback      jsonb,                      -- level / good / issues / better；开着准确度提升时还有 runs（每次评分的分数）
  model         text,
  input_tokens  int, output_tokens int,      -- 这次批改所有模型请求加起来的用量
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attempts_created_at_idx ON attempts (created_at);

CREATE TABLE IF NOT EXISTS dict_cache (
  sentence_id text REFERENCES sentences(id) ON DELETE CASCADE,
  word        text,
  data        jsonb NOT NULL,               -- {lemma,ipa,pos,zh,more}
  PRIMARY KEY (sentence_id, word)
);

CREATE TABLE IF NOT EXISTS ai_usage (
  day     date PRIMARY KEY,
  grades  int NOT NULL DEFAULT 0,
  lookups int NOT NULL DEFAULT 0,
  gens    int NOT NULL DEFAULT 0
);

-- 页面上保存的设置（模型配置等）。API 密钥加密后再存。
CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 升级旧数据库：允许加练（extra）的句子。每次启动都会执行，重复执行没有影响
ALTER TABLE sentences DROP CONSTRAINT IF EXISTS sentences_source_check;
ALTER TABLE sentences ADD CONSTRAINT sentences_source_check CHECK (source IN ('seed','daily','manual','extra'));

-- ---- 账户：你自己（owner，用访问密码登录）+ 邀请账户（member，用邀请码登录）--------------
-- 每个账户的句库、练习记录、批改、查词缓存、AI 用量、每日任务设置和模型配置都互相独立；删除账户会连带删除它的全部数据。
CREATE TABLE IF NOT EXISTS accounts (
  id           text PRIMARY KEY,                -- 你自己固定是 owner；邀请账户是 m 开头的随机串
  role         text NOT NULL CHECK (role IN ('owner','member')),
  note         text NOT NULL DEFAULT '',        -- 备注名
  code_hash    text UNIQUE,                     -- 邀请码的 sha256（登录时按它查找）
  code_enc     text,                            -- 邀请码密文（管理页显示用，COOKIE_SECRET 加密）
  llm          jsonb,                           -- 邀请账户自己的模型配置（格式同 settings 表的 llm，API 密钥加密）；你自己的在 settings 表
  practice     jsonb,                           -- 每日任务设置 {levels,dailyCount,autoDaily,dailyAt,accuracyBoost}
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);
INSERT INTO accounts (id, role, note) VALUES ('owner', 'owner', '我') ON CONFLICT (id) DO NOTHING;

-- 已有数据全部归到 owner
ALTER TABLE sentences ADD COLUMN IF NOT EXISTS account_id text NOT NULL DEFAULT 'owner' REFERENCES accounts(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS sentences_account_idx ON sentences (account_id, created_at);
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS account_id text NOT NULL DEFAULT 'owner' REFERENCES accounts(id) ON DELETE CASCADE;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.key_column_usage
    WHERE table_name = 'ai_usage' AND constraint_name = 'ai_usage_pkey' AND column_name = 'account_id'
  ) THEN
    ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_pkey;
    ALTER TABLE ai_usage ADD PRIMARY KEY (account_id, day);
  END IF;
END $$;

-- 旧版把每日任务设置存在 settings 表的 practice 里，搬到 owner 账户上
UPDATE accounts SET practice = (SELECT value FROM settings WHERE key = 'practice')
  WHERE id = 'owner' AND practice IS NULL AND EXISTS (SELECT 1 FROM settings WHERE key = 'practice');
DELETE FROM settings WHERE key = 'practice' AND EXISTS (SELECT 1 FROM accounts WHERE id = 'owner' AND practice IS NOT NULL);

-- ---- 设备：每个邀请码最多能在几台设备（浏览器）上登录 -----------------------------------
-- 设备编号是网站第一次登录时发给这个浏览器的随机串（Cookie ss_device），不是手机硬件编号。
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS device_limit int NOT NULL DEFAULT 2;
CREATE TABLE IF NOT EXISTS devices (
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id  text NOT NULL,
  label      text NOT NULL DEFAULT '',            -- 例如 iPhone · 微信
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  last_ip    text,
  PRIMARY KEY (account_id, device_id)
);

-- ---- 邀请码有效期：从对方第一次登录开始算，到期后停用（登不进来，数据保留），管理员改有效期就能续上 --------------
-- valid_days：30 / 90 / 180 / 360，NULL 表示永久；activated_at：第一次登录的时间；
-- expires_at：到期时间（第一次登录时 = 登录时间 + valid_days；登录过之后再改有效期 = 改的时候 + valid_days；永久或还没登录过是 NULL）
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS valid_days int;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS activated_at timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS expires_at timestamptz;
-- 有效期功能上线前就登录过的邀请账户，用最早登录的设备时间（没有的话用最近使用时间）当作第一次登录
UPDATE accounts a
  SET activated_at = coalesce((SELECT min(d.first_seen) FROM devices d WHERE d.account_id = a.id), a.last_seen_at)
  WHERE a.role = 'member' AND a.activated_at IS NULL
    AND (a.last_seen_at IS NOT NULL OR EXISTS (SELECT 1 FROM devices d WHERE d.account_id = a.id));

-- ---- token 用量：每次调用模型都记一笔，按账户、日期（北京时间）、用途、模型累加 ------------------
-- kind：grade 批改 / lookup 查词 / generate 出题 / review 复核谓语 / test 测试连接
-- 删除句子不影响（token 已经花出去了）；删除邀请账户会连带删除它的用量。
-- 第一次建表时顺便把以前批改记录里存的用量补进来（查词、出题以前没记，补不了）；表已经在就什么都不做。
DO $$
BEGIN
  IF to_regclass('token_usage') IS NULL THEN
    CREATE TABLE token_usage (
      account_id    text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      day           date NOT NULL,
      kind          text NOT NULL,
      model         text NOT NULL DEFAULT '',
      calls         int NOT NULL DEFAULT 0,
      input_tokens  bigint NOT NULL DEFAULT 0,
      output_tokens bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, day, kind, model)
    );
    INSERT INTO token_usage (account_id, day, kind, model, calls, input_tokens, output_tokens)
    SELECT s.account_id, ((a.created_at AT TIME ZONE 'UTC') + interval '8 hours')::date, 'grade', coalesce(a.model, ''),
           count(*), coalesce(sum(a.input_tokens), 0), coalesce(sum(a.output_tokens), 0)
    FROM attempts a JOIN sentences s ON s.id = a.sentence_id
    WHERE a.input_tokens IS NOT NULL OR a.output_tokens IS NOT NULL
    GROUP BY 1, 2, 4;
  END IF;
END $$;
