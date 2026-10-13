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
  feedback      jsonb,                      -- level / good / issues / better
  model         text,
  input_tokens  int, output_tokens int,
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
