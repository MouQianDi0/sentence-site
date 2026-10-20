-- 数据库改进第 3 步（“收”）：练习记录、批改、查词缓存的 account_id 设 NOT NULL，
-- 外键换成 (account_id, sentence_id) → sentences(account_id, id)，一个账户的记录只能挂在它自己的句子上。
-- 第 2 步的代码写入时已经带 account_id，这一步更新失败退回第 2 步也写得进去。

-- 整份可以重复执行（测试里会删掉 schema_migrations 模拟老库再迁移一遍）。

-- 退回上一版期间写的行 account_id 是空的，再回填一次
UPDATE records x SET account_id = s.account_id FROM sentences s WHERE s.id = x.sentence_id AND x.account_id IS NULL;
UPDATE attempts x SET account_id = s.account_id FROM sentences s WHERE s.id = x.sentence_id AND x.account_id IS NULL;
UPDATE dict_cache x SET account_id = s.account_id FROM sentences s WHERE s.id = x.sentence_id AND x.account_id IS NULL;

-- 没有句子的批改哪个账户都查不到、也删不掉
DELETE FROM attempts WHERE sentence_id IS NULL;

ALTER TABLE records ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE attempts ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE attempts ALTER COLUMN sentence_id SET NOT NULL;
ALTER TABLE dict_cache ALTER COLUMN account_id SET NOT NULL;

-- 0001 建表时写的是 sentence_id REFERENCES sentences(id)，约束名是默认的 <表>_sentence_id_fkey
ALTER TABLE records DROP CONSTRAINT IF EXISTS records_sentence_id_fkey;
ALTER TABLE attempts DROP CONSTRAINT IF EXISTS attempts_sentence_id_fkey;
ALTER TABLE dict_cache DROP CONSTRAINT IF EXISTS dict_cache_sentence_id_fkey;
ALTER TABLE records DROP CONSTRAINT IF EXISTS records_sentence_fkey;
ALTER TABLE attempts DROP CONSTRAINT IF EXISTS attempts_sentence_fkey;
ALTER TABLE dict_cache DROP CONSTRAINT IF EXISTS dict_cache_sentence_fkey;
ALTER TABLE records ADD CONSTRAINT records_sentence_fkey
  FOREIGN KEY (account_id, sentence_id) REFERENCES sentences (account_id, id) ON DELETE CASCADE;
ALTER TABLE attempts ADD CONSTRAINT attempts_sentence_fkey
  FOREIGN KEY (account_id, sentence_id) REFERENCES sentences (account_id, id) ON DELETE CASCADE;
ALTER TABLE dict_cache ADD CONSTRAINT dict_cache_sentence_fkey
  FOREIGN KEY (account_id, sentence_id) REFERENCES sentences (account_id, id) ON DELETE CASCADE;

-- 忘了传账户要报错，不能悄悄记到 owner 名下
ALTER TABLE sentences ALTER COLUMN account_id DROP DEFAULT;
ALTER TABLE ai_usage ALTER COLUMN account_id DROP DEFAULT;
