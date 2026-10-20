-- 数据库改进第 2 步（“扩”）：练习记录、批改、查词缓存加上 account_id，按句子回填。
-- 列可空、不加默认值和外键，上一版代码不写它也照常能写入；退回上一版期间新写的行 account_id 为空，
-- 第 3 步会再回填一次，然后设 NOT NULL、外键换成 (account_id, sentence_id) → sentences(account_id, id)。

-- 整份可以重复执行（测试里会删掉 schema_migrations 模拟老库再迁移一遍）。

-- 第 3 步的复合外键要引用它
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sentences_account_id_id_key') THEN
    ALTER TABLE sentences ADD CONSTRAINT sentences_account_id_id_key UNIQUE (account_id, id);
  END IF;
END $$;

ALTER TABLE records ADD COLUMN IF NOT EXISTS account_id text;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS account_id text;
ALTER TABLE dict_cache ADD COLUMN IF NOT EXISTS account_id text;

UPDATE records x SET account_id = s.account_id FROM sentences s WHERE s.id = x.sentence_id AND x.account_id IS NULL;
UPDATE attempts x SET account_id = s.account_id FROM sentences s WHERE s.id = x.sentence_id AND x.account_id IS NULL;
UPDATE dict_cache x SET account_id = s.account_id FROM sentences s WHERE s.id = x.sentence_id AND x.account_id IS NULL;

DROP INDEX IF EXISTS attempts_created_at_idx;
CREATE INDEX IF NOT EXISTS attempts_account_idx ON attempts (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS attempts_sentence_idx ON attempts (sentence_id, created_at DESC);
CREATE INDEX IF NOT EXISTS records_account_idx ON records (account_id, updated_at DESC);
