-- AI 学习分析（记录页）：每分析一次存一行，页面显示最新的一份；再分析时把上一份的要点交给模型，看改没改。
-- 只加新表、新列（有默认值），上一版代码不读不写它们，退回上一版也照常运行。

-- 整份可以重复执行（测试里会删掉 schema_migrations 模拟老库再迁移一遍）。

CREATE TABLE IF NOT EXISTS analyses (
  id          bigserial PRIMARY KEY,
  account_id  text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  stats       jsonb NOT NULL,                -- 分析时汇总的数据（shared/src/types.ts 的 LearningStats）
  report      jsonb NOT NULL,                -- 模型写的报告（LearningReport）
  model       text
);
CREATE INDEX IF NOT EXISTS analyses_account_idx ON analyses (account_id, created_at DESC);

-- 每天能分析几次（.env 的 DAILY_ANALYZE_LIMIT），和批改、查词、出题一样先占后调
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS analyses int NOT NULL DEFAULT 0;
