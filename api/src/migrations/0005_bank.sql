-- 数据库改进第 5 步：外部题库（四级真题阅读长难句）。
-- 题库全站一份（不带 account_id），只有 owner 能导入、管理；账户抽题时把句子复制一份进自己的 sentences，
-- 用 bank_item_id 记出处，之后的记录、批改都挂在复制的这份上。
-- 只加表、加可空列，上一版代码不写 bank_item_id 也照常能写入（多个 NULL 不算撞 UNIQUE）。

-- 整份可以重复执行（测试里会删掉 schema_migrations 模拟老库再迁移一遍）。

CREATE TABLE IF NOT EXISTS banks (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  license     text NOT NULL DEFAULT '',
  enabled     boolean NOT NULL DEFAULT true,
  imported_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- status：review 原文要人看一眼；raw 等着标注；ready 标注好、能抽；rejected 不要（reject_reason 说明原因）；
-- retired 最近一次导入的文件里已经没有这一句
CREATE TABLE IF NOT EXISTS bank_items (
  id            bigserial PRIMARY KEY,
  bank_id       text NOT NULL REFERENCES banks (id) ON DELETE CASCADE,
  external_id   text NOT NULL,
  text          text NOT NULL,
  -- 管理页上改过的原文；标注、校验用 text_fix ?? text
  text_fix      text,
  level         text NOT NULL DEFAULT 'CET-4' CHECK (level IN ('CET-4', 'CET-6')),
  exam_year     smallint,
  exam_month    smallint CHECK (exam_month BETWEEN 1 AND 12),
  paper         smallint,
  section       text,
  tags          text[] NOT NULL DEFAULT '{}',
  complexity    smallint,
  -- 题库自己的质量状态（quality_status）
  src_quality   text NOT NULL,
  meta          jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'raw' CHECK (status IN ('review', 'raw', 'ready', 'rejected', 'retired')),
  -- 拆解（格式同 sentences 的内容列，shared 的 SentenceBody）
  body          jsonb,
  reject_reason text,
  -- 标注用的模型
  annotated_by  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_items_bank_key UNIQUE (bank_id, external_id),
  CONSTRAINT bank_items_ready_body CHECK (status <> 'ready' OR body IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS bank_items_status_idx ON bank_items (status, level);

-- 题库里的句子被删掉时，账户复制过去的那份留着，只是不再知道出处
ALTER TABLE sentences ADD COLUMN IF NOT EXISTS bank_item_id bigint REFERENCES bank_items (id) ON DELETE SET NULL;
-- 同一句题库句子，一个账户只复制一次（抽题时靠它跳过抽过的）
ALTER TABLE sentences DROP CONSTRAINT IF EXISTS sentences_account_bank_key;
ALTER TABLE sentences ADD CONSTRAINT sentences_account_bank_key UNIQUE (account_id, bank_item_id);
