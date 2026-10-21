# 变更日志

所有代码变更都记在这里，新的在最上面。时间是北京时间。

## 2026-10-22 03:47:36

**变更类型**：新功能

**变更概述**：记录页新增“AI 学习分析”。批改过 3 句以后点“开始分析”，后端汇总这个账户的批改和练习记录交给主力模型，写一份报告：总评、学习曲线怎么看、做得好的、要改的翻译习惯（带自己译文里的例子，能点回那句）、薄弱的结构、接下来怎么练。报告存下来，记录页显示最新一份；再分析时带上上一份的要点。每天限 `DAILY_ANALYZE_LIMIT` 次（默认 5）。

**修改的文件**

- 新增 `api/src/analysis.ts`、`api/src/migrations/0006_analyses.sql`、`api/test/analysis.test.ts`、`web/src/analysis.ts`
- 修改 `shared/src/types.ts`
- 修改 `api/src/ai.ts`、`api/src/app.ts`、`api/src/prompts.ts`、`api/src/repo.ts`、`api/src/spec.ts`、`api/src/config.ts`、`api/src/tokens.ts`、`api/src/chatgpt.ts`
- 修改 `web/src/records.ts`、`web/src/state.ts`、`web/src/lib/api.ts`、`web/src/settings/usage.ts`、`web/src/settings/chatgpt-settings.ts`
- 修改 `api/test/helpers.ts`
- 修改 `.env.example`、`README.md`、`CHANGELOG.md`

**具体内容**

- 表结构（0006，只扩）：新表 `analyses`（账户、时间、汇总数据 `stats`、报告 `report`、模型），`ai_usage` 加 `analyses` 列（默认 0）。上一版代码不读不写它们，退回上一版照常运行。
- `analysis.ts`：`learningStats()` 只按每句第一次提交算平均分、前一半 / 后一半句子对比、学习曲线（两周内按天、16 周内按周、再长分成约 16 段，日期按北京时间）、批注问题类型、含各结构（不算 main）的句子平均分、四六级、改了再交的提分、圈谓语和选译文的结果；`cleanReport()` 截断各字段，习惯的例子要能在这个账户的译文里找到（不管空格）才留下，并记下是哪一句。
- 提示词 `analysisPrompt()`：结构名称取自出题规范“知识点”一段（`specKbNames()`），学生译文和批注片段放在 `<student_material>` 里并提醒不要当成指令；最近 40 条批注问题、几句完整的例子（最近 4 句 + 分最低的 2 句的第一次提交）、上次分析的总评和习惯。
- `GET /api/analysis` 读最新一份，`POST /api/analysis` 分析一次：同一账户同时只跑一次（409），不到 3 句返回 400（不占次数），先占次数再调用模型（`withQuota` 从 `createAi` 里提出来共用），回复缺内容再试一次，失败退回次数。token 用量记为 `analyze`（“学习分析”）。
- 你自己的账户：学习分析跟着 ChatGPT 套餐的“改题”开关走；邀请账户照旧只用自己填的模型。
- 页面：记录页的走势图下面一张卡片，读报告时有占位，分析时显示进度（可以先去别的页面，写好了弹提示），报告可以收起（记在本机）；不够 3 句、没配模型、次数用完时按钮不可点并说明原因。
- 测试：汇总数据的各项（第一次提交、按天按周的曲线、北京时间换日、没分数和句子不在的批改不算）；整理报告；不到 3 句不调用模型；提示词内容；报告存取、用量和 token 记账；带上上次的要点；缺内容时重试并退回次数；同时点两次；用完次数 429；邀请账户只分析自己的数据、不会用到你的模型。

## 2026-10-21 02:31:43

**变更类型**：新功能

**变更概述**：数据库改进第 5 步（三）：从真题题库抽题。“设置 → 每日任务”新增“题目来源”：AI 出题（默认，行为不变）/ 真题题库 / 先题库不够再 AI。题库只有四级：四六级混出时四级从题库抽、六级照旧 AI 出。抽题不调用模型、不占每日出题次数，没配模型的邀请账户也能用题库做每日任务。练习页显示出处。

**修改的文件**

- 修改 `shared/src/types.ts`
- 修改 `api/src/repo.ts`、`api/src/ai.ts`、`api/src/practice.ts`、`api/src/daily.ts`、`api/src/app.ts`
- 修改 `web/index.html`、`web/src/state.ts`、`web/src/lib/api.ts`、`web/src/practice/task.ts`、`web/src/practice/sentence.ts`、`web/src/settings/task-settings.ts`
- 修改 `api/test/bank.test.ts`、`api/test/api.test.ts`
- 修改 `README.md`、`CHANGELOG.md`

**具体内容**

- `PracticeSettings.questionSource`：`ai` / `bank` / `bankFirst`，存在 `accounts.practice` 里（不改表），没设过的账户是 `ai`。
- `repo.drawFromBank(accountId, levels, n)`：从启用的题库里随机抽这个账户没抽过的 ready 句子（只读）；`insertSentence` 可以带 `bankItemId`，`ON CONFLICT DO NOTHING` 不写冲突列，编号撞了或这句已经抽过都跳过（抽过的不再换编号重试）。
- `ai.generate` 加 `from`：先按难度分好句数，四级从题库抽，剩下的交给 AI（`draftAi`），最后打乱一起写入（`store`，编号规则和原来一样，来源照旧是 daily / extra）。只有 AI 那部分占加练出题次数；题库抽到了、AI 那部分没出成时先存抽到的；两边都没有时返回 409 并提示改成“先题库”。
- 每日定时任务：题目来源不是 AI、难度里有四级的账户，没配模型也照顾。
- `listSentences`、`getSentence`、`recentSentences` LEFT JOIN `bank_items`，给 `Sentence` 带上可选的 `origin`（出处文字）和 `cloze`（选词填空第几空、填的词），不直接返回 `bank_items` 的行。
- 页面：设置里的“题目来源”三选一和说明；没配模型但能从题库抽时，“现在生成”“加练”“补齐”照样能点；练习页句子上方显示出处，选词填空的句子说明原题第几空。
- 测试：没配模型的邀请账户从题库出题；只抽 ready 的四级、不重复、抽完返回 409；不占出题次数；接口不返回 `bank_items` 的字段；owner 和邀请账户各抽各的，删掉自己的那份不影响别人、还能再抽到；停用的题库不抽；先题库模式四级抽题库、六级 AI 出，占一次出题次数，题库抽完由 AI 补上；只选六级照旧 AI；每日定时任务给没配模型的邀请账户从题库生成。

## 2026-10-21 02:23:07

**变更类型**：新功能

**变更概述**：数据库改进第 5 步（二）：标注题库和管理页。后台用你自己配的国内模型把题库句子逐句拆解成和 AI 出题一样格式的题，必须过同样的严格校验、片段拼回去等于原句才能抽；标注永远不走 ChatGPT（哪怕是你自己），有测试守着。设置下面新增“真题题库”页面（`/settings/bank`，只有你自己看得到）。

**修改的文件**

- 新增 `api/src/annotate.ts`、`api/scripts/annotate-bank.ts`、`web/src/settings/exam-bank.ts`
- 修改 `shared/src/types.ts`
- 修改 `api/src/app.ts`、`api/src/ai.ts`、`api/src/prompts.ts`、`api/src/repo.ts`、`api/src/bank.ts`、`api/src/llm-route.ts`、`api/src/settings.ts`、`api/src/tokens.ts`、`api/src/validate.ts`
- 修改 `web/index.html`、`web/src/router.ts`、`web/src/lib/api.ts`、`web/src/settings/index.ts`、`web/src/settings/usage.ts`
- 修改 `api/test/bank.test.ts`、`api/test/chatgpt.test.ts`、`api/test/helpers.ts`
- 修改 `README.md`、`CHANGELOG.md`

**具体内容**

- 新的 token 用途 `annotate`（“标注题库”），记在 owner 名下。`llmFor` 对 annotate 不套 ChatGPT 那一层，`routeLlm` 遇到 annotate 也不用套餐，两处都挡着。
- 标注提示词 `annotatePrompt` 用出题规范的全部几段，要求不改原句一个字；主句是并列谓语的让模型回复 skip。拆解过 `checkSentence(…, { strict: true })`，再比较片段拼回去和原句（`text_fix ?? text`，统一引号、破折号两边空格、空白），再像出题一样复核一遍谓语。校验没过再问一次，还不过 → rejected 并记原因；模型出错留在 raw；密钥无效、没配置、限流时整批停下。词数、结尾标点不对的不问模型直接不要。
- 存结果时只在这句还是 raw、原文没被改过时才存，标注期间在管理页改了原文的这次作废。
- 接口（只有 owner）：`GET /api/admin/bank`（各状态句数、标注进度、国内模型配好没有）、`GET /api/admin/bank/items?status=`、`POST …/items/:id/confirm`、`PUT …/items/:id`（改原文）、`POST …/items/:id/reject`、`POST …/items/:id/requeue`、`POST /api/admin/bank/annotate`（后台跑一批，同时只跑一批）、`PUT /api/admin/bank/:bankId`（启用 / 停用）。命令行 `scripts/annotate-bank.ts --limit N --concurrency N`。
- 句子结尾是弯引号（`.”`）也算句号结尾（`validate.ts`），真题里引语结尾的句子不会因此被拒。
- 测试：annotate 哪怕所有用途和后台都开着也不走 ChatGPT；拼回去不等于原句、过不了严格校验、太长、模型说拆不了的不要，模型出错留在 raw；改过原文的按改过的比较；标注期间原文被改，结果作废；邀请账户用不了 `/api/admin/bank/*`；管理页的各个操作；后台标注用你自己的密钥、token 记在你名下。

## 2026-10-21 02:09:11

**变更类型**：新功能（数据库）

**变更概述**：数据库改进第 5 步（一）：外部题库的表和导入。新增 `banks`、`bank_items` 两张表和 `sentences.bank_item_id`（可空），从服务器上的 JSONL 文件导入四级真题阅读长难句。只加表、加可空列，上一版代码跑在新库上照常能用。题库文件和真题原句不进仓库，测试用自己编的假数据。

**修改的文件**

- 新增 `api/src/migrations/0005_bank.sql`、`api/src/bank.ts`、`api/scripts/import-bank.ts`、`api/test/bank.test.ts`
- 修改 `api/src/repo.ts`
- 修改 `api/test/helpers.ts`、`api/test/migrate.test.ts`
- 修改 `README.md`、`CHANGELOG.md`

**具体内容**

- `banks`：一个题库一行（现在只有 `cet4-reading`“四级真题阅读长难句”），可以停用。`bank_items`：题库里的一句，按 `(bank_id, external_id)` 唯一；状态 review / raw / ready / rejected / retired，ready 必须有拆解（`body`）。`sentences.bank_item_id` 记账户复制的这句来自题库哪一句，`(account_id, bank_item_id)` 唯一，题库里的句子删掉时置空。
- `scripts/import-bank.ts` 从标准输入读 JSONL，`repo.importBank` 用一条语句（`jsonb_to_recordset` + `ON CONFLICT`）写入，同一条语句把文件里没有的标成 retired，整份要么都写进去、要么都不写；导入后打印各状态句数。
- 字段：`id` → `external_id`，`text_en` → `text`，第一个出处的年、月、套、Section → `exam_year`、`exam_month`、`paper`、`section`，`structures` → `tags`，`complexity_score` → `complexity`，`quality_status` → `src_quality`；`text_raw`、`cloze`、`text_source` 和全部出处（含篇章、位置、文件名）放 `meta`。
- 初筛：reviewed、cloze_filled → raw；incomplete_cloze → rejected；其余 → review。再次导入：原文没变保留改过的原文、拆解和状态（retired 的恢复）；原文变了清掉拆解和改过的原文，按新的质量状态重新初筛。
- 测试辅助：psql 替身支持带写入的 `WITH` 语句。
- 测试：0005 可重复执行，上一版代码写句子不受影响；导入新增、更新、下架、原文变了退回、下架后恢复；有一句写不进去时整份不生效。

## 2026-10-21 01:13:06

**变更类型**：重构（数据库）

**变更概述**：数据库改进第 4 步：给账户、句子、批改加 CHECK 约束，代码里一直遵守的规则交给数据库守着；每日批改、查词、加练出题次数改成调用模型前先占一次额度（判断和加 1 在同一条语句里），几个请求同时到也不会冲过上限，模型调用失败时退回，仍然“失败不算次数”。只加约束、不改数据，不依赖服务器是否已部署第 3 步；现有数据万一不满足，迁移整份失败、自动退回上一版，数据不变。

**修改的文件**

- 新增 `api/src/migrations/0004_checks.sql`
- 修改 `api/src/repo.ts`、`api/src/ai.ts`
- 修改 `api/test/migrate.test.ts`、`api/test/api.test.ts`
- 修改 `CHANGELOG.md`

**具体内容**

- `accounts`：只有 id 为 `owner` 的是 owner；邀请账户必须有邀请码；`valid_days` 只能是 30 / 90 / 180 / 360（NULL 是永久）；`device_limit` 1–10；有 `expires_at` 的必须有 `activated_at` 和 `valid_days`。
- `sentences`：`segs`、`opts`、`words`、`phrases` 都是 JSON 数组；`source` 只能是 seed / daily / manual / extra（0001 已有同样内容的 `sentences_source_check`，换成 `sentences_source`，不留两条）。
- `attempts`：准确 0–40、通顺 0–30、完整 0–30、总分 0–100，没有分数（NULL）的旧批改照常。
- `repo.bumpUsage` 换成 `reserveUsage`（`INSERT … ON CONFLICT DO UPDATE … WHERE 没到上限 RETURNING`，没返回行就是用完了）和 `releaseUsage`（减 1，不会减到负数）；`ai.ts` 的 `checkLimit` 换成 `withQuota`：先占，调用出错用同一天退回。上限、429 和提示文字不变，今日任务仍不算出题次数。请求进行中这一次已经算在当天用量里。
- 测试：0004 可重复执行、从 0001 整个重来也行；违反每条约束的写入报 23514；现有数据不满足时迁移整份不生效；上限 2 时同时批改 5 次只有 2 次成功；模型调用失败、出的题没通过校验时次数退回。

## 2026-10-21 00:19:14

**变更类型**：重构（数据库）

**变更概述**：数据库改进第 3 步（“收”）：练习记录、批改、查词缓存的 `account_id` 改成 NOT NULL，外键换成 `(account_id, sentence_id)` → `sentences(account_id, id)`，一个账户写不到别的账户的句子上由数据库保证；读也直接按 `account_id` 查。`sentences`、`ai_usage` 的 `account_id` 去掉默认值，忘了传账户会报错，不再悄悄记到 owner。要等服务器部署过第 2 步再合进 `main`（更新失败退回第 2 步时，第 2 步的代码已经会写 `account_id`）。

**修改的文件**

- 新增 `api/src/migrations/0003_child_account_fk.sql`
- 修改 `api/src/repo.ts`、`api/src/ai.ts`、`api/src/importer.ts`
- 修改 `api/test/migrate.test.ts`、`api/test/accounts.test.ts`、`api/test/api.test.ts`
- 修改 `CHANGELOG.md`

**具体内容**

- 迁移先再回填一次 `account_id` 为空的行（退回上一版期间写入的），删掉 `sentence_id` 为空的批改，再设 NOT NULL（含 `attempts.sentence_id`）、换外键（删除句子仍连带删除）。整份可以重复执行。
- `listRecords`、`listAttempts` 改成 `WHERE account_id = $1`；`getDict`、`countAttemptsFor` 加上 `accountId` 参数。
- `insertSentence` 的 `accountId` 改成必填，导入旧数据时传 `'owner'`。
- 写入已有记录、查词缓存时也写一遍 `account_id`，别的账户的会因外键报 23503，改不掉。
- 测试：别的账户写练习记录、批改、查词缓存，接口返回 404、直接调 repo 报 23503；模拟第 2 步老库验证回填和删除；不传 `account_id` 插入句子、AI 用量报错。

## 2026-10-21 00:03:07

**变更类型**：测试

**变更概述**：修复“加练：四六级混合，超过 5 句分两次请求”测试偶尔失败。两批出题请求是同时发的，到达假模型的先后不固定，原来断言第一条出题提示词是 5 句那批；改成检查两条出题提示词分别是 5 句和 2 句，不依赖先后。业务代码不变。

**修改的文件**

- 修改 `api/test/api.test.ts`
- 修改 `CHANGELOG.md`

## 2026-10-20 15:37:01

**变更类型**：重构（数据库）

**变更概述**：练习记录、批改、查词缓存三张表加上 `account_id`，按句子回填，新写入时带上。这是数据库改进的第 2 步，只做“扩”：新列可空、没有默认值和外键，上一版代码不写它也照常读写。读数据还是按句子查，第 3 步再收紧。

**修改的文件**

- 新增 `api/src/migrations/0002_child_account_id.sql`
- 修改 `api/src/repo.ts`、`api/src/app.ts`、`api/src/ai.ts`、`api/src/importer.ts`
- 修改 `api/test/migrate.test.ts`、`api/test/accounts.test.ts`、`api/test/tokens.test.ts`
- 修改 `CHANGELOG.md`

**具体内容**

- 迁移 0002：`sentences` 加唯一约束 `(account_id, id)`（第 3 步的复合外键要引用它）；`records`、`attempts`、`dict_cache` 加可空的 `account_id text`，按 `sentence_id` 从 `sentences` 回填；`attempts_created_at_idx` 换成 `attempts_account_idx (account_id, created_at DESC)` 和 `attempts_sentence_idx (sentence_id, created_at DESC)`，新增 `records_account_idx (account_id, updated_at DESC)`。整份可以重复执行。
- `repo.upsertRecord(accountId, sentenceId, fields)`、`repo.putDict(accountId, sentenceId, word, data)` 第一个参数改成账户；`NewAttempt` 加必填的 `accountId`。写入时都带上 `account_id`，更新已有的练习记录、查词缓存时也补上。导入旧数据时账户是 `owner`。
- 读的查询（`listRecords`、`listAttempts`、`getDict`、`countAttemptsFor`）不变，仍按句子查。
- 更新失败退回上一版时，旧代码写的新行 `account_id` 为空；第 3 步会先再回填一次，再设 `NOT NULL`、外键换成 `(account_id, sentence_id) → sentences(account_id, id)`。
- 新测试：迁移前写入的老数据（owner 和邀请账户各一句）三张表都按句子回填了 `account_id`；owner 和邀请账户新写的练习记录、批改、查词缓存带着各自的 `account_id`。

## 2026-10-20 15:20:20

**变更类型**：重构（数据库）

**变更概述**：建表从每次启动整份执行 `schema.sql` 改成按编号执行迁移文件，执行过的记在 `schema_migrations` 表。数据库结构不变。这是数据库改进的第 1 步，后面改表结构都用新加迁移文件的方式。

**修改的文件**

- 移动 `api/src/schema.sql` → `api/src/migrations/0001_baseline.sql`（内容不变）
- 新增 `api/src/migrate.ts`
- 新增 `api/test/migrate.test.ts`
- 修改 `api/src/server.ts`、`api/src/repo.ts`
- 修改 `api/test/devserver.ts`、`api/test/accounts.test.ts`、`api/test/api.test.ts`、`api/test/chatgpt.test.ts`、`api/test/expiry.test.ts`、`api/test/settings.test.ts`、`api/test/tokens.test.ts`
- 修改 `scripts/update.sh`
- 修改 `README.md`、`AGENTS.md`、`CHANGELOG.md`

**具体内容**

- `migrate()`：建 `schema_migrations`（version、name、applied_at），读 `api/src/migrations/` 里 `NNNN_说明.sql` 格式的文件，按编号执行还没执行过的。每个文件和它那条 `schema_migrations` 记录拼成一次查询发出，在同一个事务里，出错整份不生效。迁移文件里不能写 `BEGIN`/`COMMIT`，不能用 `CREATE INDEX CONCURRENTLY`。只有一个 api 容器，不加锁。
- 老库（服务器上现在的库）没有 `schema_migrations`，第一次启动新版本时 0001 会在已有的表上再执行一遍。它本来就是每次启动都执行的，可以重复执行，结构和数据都不变；之后就只记一条 0001，不再重复执行。
- 退回上一个版本时，旧代码照旧整份执行 `schema.sql`，多出来的 `schema_migrations` 表不影响它。
- 去掉 `repo.ensureSchema()`；启动、本地演示服务器和测试都改用 `migrate()`。测试“老库升级”的地方（有效期补第一次登录时间、补以前批改的用量）改成删掉 `schema_migrations` 再 `migrate()`，模拟老库第一次升级。
- 新测试：同一个库连续 `migrate()` 两次，第二次什么都不执行；`schema_migrations` 里有 0001；没有 `schema_migrations` 的老库再执行 0001，已有数据不变。
- `scripts/update.sh`：部署新版本前先运行 `scripts/backup.sh` 备份数据库；备份失败只记日志，不挡更新。第一次部署（还没有旧版本）不备份。
- `AGENTS.md` 加“改表结构”一节：新增迁移文件、不改已发布的文件、会让旧代码写不进去的改动分扩、收两次发布。

## 2026-10-19 02:26:41

**变更类型**：修复问题（部署脚本）

**变更概述**：修复用 `enable-https.sh` 从 IP 换成域名时的两个问题，为换成 `https://cet.tech-mou.top`（443 端口，网址不带端口）做准备。

**修改的文件**

- 修改 `scripts/enable-https.sh`
- 修改 `.github/workflows/ci.yml`
- 修改 `README.md`
- 修改 `CHANGELOG.md`

**具体内容**

- 问题一：脚本只看服务器上有没有证书，不看证书是不是这个地址的。已经有 IP 证书时换域名，脚本以为不用先给新域名在 80 端口放验证路径，验证请求落到原来网站上被 301 跳走，检查失败、换不成功。
  - 修复：`.env` 里的 `HTTPS_HOST` 和这次的地址一样、并且有证书，才算“这个地址已经有证书”；换了地址就按第一次申请处理。申请失败时恢复成原来的配置，原来的网址照旧能用。
- 问题二：换地址后没有停掉旧地址证书的续期。两张证书装在同一个位置，IP 证书每 3 天续期一次，会把域名证书覆盖掉，域名打开就报证书错误。
  - 修复：新证书装好后，用 `acme.sh --remove` 停掉旧地址的续期（证书文件留在 acme.sh 目录里）；用域名时删掉 IP 模式的钩子脚本和临时配置。
- 新增：用域名时先检查域名有没有解析到这台服务器（解析不到，或者解析到的不是腾讯云元数据里的公网 IP，就停下来说明），免得白白请求 Let's Encrypt。
- 域名用 `--port 443` 时和服务器上原来的网站共用 443：按域名区分，不加 `default_server`，用 IP 或别的域名访问 443 还是原来的网站。脚本这部分本来就支持，这次在 CI 里覆盖到了。
- CI（HTTPS 那一步）：
  - 测试证书加上 `DNS:ci.test`，`ci.test` 写进 hosts；
  - 假的 acme.sh 按域名分别记“已经申请过”；
  - 新增从 IP 换成域名 `ci.test`、用 `--port 443` 的测试：旧 IP 证书停止续期，钩子和临时配置删掉，`https://ci.test/` 能打开，`http://ci.test`、`http://ci.test:443`、旧的 `http://IP:8080` 都跳到 `https://ci.test/…`，8444 不再用，`http://IP` 照旧是原来的网站，`.env` 记下新地址和 443。
- `README.md`：补“换成域名”的步骤（DNS、`--port 443`、旧 IP 地址失效、要重新登录、备案），访问地址改成 `https://cet.tech-mou.top`。
- 影响：只改部署脚本、CI 和文档。服务器上加好 DNS 解析后运行 `sudo bash scripts/enable-https.sh cet.tech-mou.top --port 443` 才会换过去。

## 2026-10-19 01:32:42

**变更类型**：优化代码（部署脚本）

**变更概述**：用 IP 开 HTTPS 时，只输 IP 不加端口（`http://IP`）不再跳到 `https://IP:8443`，照旧显示服务器上原来的网站；加了端口的 `http://IP:8080`、`http://IP:8443` 照旧跳到 https。

**修改的文件**

- 修改 `scripts/enable-https.sh`
- 修改 `.github/workflows/ci.yml`
- 修改 `README.md`
- 修改 `CHANGELOG.md`

**具体内容**

- 原因：脚本在服务器 Nginx 里为 80 端口、`server_name 你的IP` 常驻了一段配置，既放 Let's Encrypt 的验证文件，又把其他请求全部 301 跳到 https，所以只输 IP 时原来的网站接不到请求。
- 改法（`enable-https.sh`）：
  - 用 IP 时生成的配置里不再有 80 端口那一段，`http://IP` 交回原来的网站；
  - 新生成钩子脚本 `/etc/nginx/ssl/sentence-site/acme-hook.sh`：`on` 写入只放验证文件的临时配置 `sentence-site-acme.conf`（和主配置同一个目录）并重载 Nginx，`off` 删掉它再重载。申请证书时传给 acme.sh 的 `--pre-hook` / `--post-hook`，以后自动续期时 acme.sh 自己调用；
  - acme.sh 只有真去申请时才记下钩子，没到期会直接跳过（看过它的源码）。所以发现这张证书没记钩子、或者记的不是这个时，加 `--force` 重新申请一次，以后就不用了；读钩子的方式和 acme.sh 自己一样（base64 加前后标记）；
  - 第一次申请前检查 80 端口验证路径时，也改用这份临时配置；跳过申请（不运行 post-hook）时脚本自己关掉；
  - 检查“别的配置有没有占用这个 IP / 端口”时，排除脚本自己的临时配置；顺手把 `grep -qw` 改成不提前退出的写法，避免 pipefail 下偶尔漏检；
  - `--off` 撤掉时一并删掉钩子脚本和临时配置；
  - 用域名时行为不变，`http://域名` 照常跳到 https。
- CI（HTTPS 那一步）：
  - 假的 acme.sh 改得和真的一样：没到期、没加 `--force` 就跳过且不记钩子；申请时记下钩子（base64），申请前后运行 pre-hook / post-hook；
  - 检查 `http://127.0.0.1/` 返回 200、内容和开 HTTPS 之前的原网站一样，临时配置已删掉；
  - 模拟续期：钩子打开后能取到验证文件，关掉后回到原网站；
  - 模拟旧证书没记钩子：重新运行会 `--force` 申请一次并记上钩子，再运行一次就“不用重新申请”；
  - 撤掉后钩子脚本和临时配置都不在了。
- `README.md`：HTTPS 一节写明只输 IP 不跳转、续期那几秒 `http://IP` 其他地址会返回 404，以及从旧版本更新后要再运行一次脚本。
- 影响：只改部署脚本、CI 和文档，网站代码不变。已经开了 HTTPS 的服务器要 `sudo sentence-update` 后再运行一次 `sudo bash scripts/enable-https.sh` 才会生效；不重新运行时一切照旧（包括续期）。

## 2026-10-17 16:01:10

**变更类型**：优化体验

**变更概述**：AI 老师批改时不用在原地等了：交上去以后可以去做别的句子（也可以同时批改好几句），批改好了在屏幕下方提醒，点“查看”回到那一句的第 3 步。

**修改的文件**

- 修改 `web/src/state.ts`
- 修改 `web/src/practice/translate.ts`
- 修改 `web/src/practice/nav.ts`
- 修改 `web/src/practice/panel.ts`
- 修改 `web/src/practice/bank.ts`
- 修改 `web/index.html`
- 修改 `CHANGELOG.md`

**具体内容**

- 原来的问题：批改状态只有一个全局开关。换句子会把它清掉，回到正在批改的那句时转圈没了、还能再点一次批改；另一句同时在批改时，先好的那句会把后一句的转圈也关掉；在别处时批改好了也没有任何提示。
- 批改状态改成按句子记（`state.grading`、`state.gradeErr`），换句子不清掉；每句同时只批改一份，不同句子可以同时批改。
- 批改中的卡片上写明“不用在这里等，可以先去做别的句子”，带一个“先做下一句 →”按钮。
- 批改好了：正看着那一句的第 3 步就直接出结果（和以前一样播分数动画）；没在看（在别的句子、第 1/2 步、记录页或设置页）就在屏幕下方提醒“第 N 句批改好了：xx 分”，点“查看”回到那一句的第 3 步。没批改成也会提醒原因。
- 句库圆点：正在批改的那句外面转一圈；批改好了还没看的右上角有个小点，打开第 3 步就消失。步骤标签“STEP 3”上也会转个小圈。
- 正在译文框里打字时结果回来，重画面板后光标留在原位。
- 顺手修了提示条：它是 `left: 50%` 的 fixed 元素，排版时只拿到半屏宽度，长一点的提示会提前折行；加了 `w-max`，现在按文字宽度显示，最宽仍不超过屏幕。
- 只改前端，接口和后端没有变化。

## 2026-10-16 23:21:47

**变更类型**：修复问题

**变更概述**：修复发往 OpenAI 的请求没有真正经过代理隧道的问题。之前的表现是：服务器容器里运行 `check-openai.ts` 时，「OpenAI 授权服务器」返回 400，后面两项也失败。

**修改的文件**

- 修改 `api/src/openai-proxy.ts`
- 修改 `api/test/chatgpt.test.ts`
- 修改 `CHANGELOG.md`

**具体内容**

- 根源：隧道建好后，发 HTTP 请求时写了 `agent: false`。在 Node 里，这会让请求新建一个 Agent，不使用我们传入的 `createConnection`，而是自己直连目标的 443 端口，并且发的是明文。结果是 CONNECT 发给了代理，但真正的请求绕过了代理；Cloudflare 收到发往 HTTPS 端口的明文请求，就回了 400。
- 修复（`openai-proxy.ts`）：
  - 去掉隧道上那个请求的 `agent: false`，Node 改为使用已经完成 TLS 握手的隧道连接；向代理发 CONNECT 的那个请求保留 `agent: false`；
  - 在代码里写明了不能加 `agent: false` 的原因；
  - `createOpenaiFetch` 增加一个只给测试用的可选参数 `ca`，用来信任测试里临时生成的证书。正式运行时不传，没设代理时的行为也不变。
- 测试漏洞补上（`chatgpt.test.ts`）：
  - 原来的测试只检查了代理有没有收到 CONNECT，没检查请求是不是真的经过了隧道，而且只测了 http；
  - 测试代理现在只认 `.invalid` 结尾的域名，代理测试和网站整体测试里的假 OpenAI 都改用这种域名，请求一旦绕过隧道就会因为域名解析不了而失败；
  - 新增一条 https 走隧道的测试：用临时生成的自签证书，GET 和流式 POST 都要通过隧道里的 TLS，证书不受信任时必须报错；
  - 新测试在修复前的代码上有 5 条失败，修复后后端测试 107 条全部通过。
- 影响：只影响设置了 `OPENAI_PROXY` 时发往 OpenAI 的请求，国内模型不受影响。

## 2026-10-16 22:36:08

**变更类型**：修复问题

**变更概述**：修复 GitHub Actions「检查页面和静态文件」一步会随机以 exit code 23 失败的问题。

**修改的文件**

- 修改 `.github/workflows/ci.yml`
- 修改 `CHANGELOG.md`

**具体内容**

- 现象：PR #1 上两次运行这一步都失败，退出码 23。两次 nginx 日志里最后一个请求分别是 `/records` 和 `/practice`，都返回 200，网站本身正常；同一提交的 push 运行是通过的。
- 根源：逐个检查页面的循环里用 `curl … | grep -q '长难句拆解台'`。`grep -q` 读到标题就退出，curl 还没写完的部分写不进管道，报 23（写入失败），工作流开了 `pipefail`，整步失败。能否撞上取决于时序，所以是随机的。
- 修复：先把整页存进变量 `page=$(curl -fsS …)`，再用 `grep -q … <<<"$page"` 查，检查内容不变。curl 失败、页面里没有标题时照样会让这一步失败（本地验证过）。
- 同一文件里其他几处 `curl | grep` 的回复只有几十字节，一次就写完了，不受影响，没有改。
- 影响：只改 CI 脚本，不影响网站。服务器只部署所有检查都通过的提交，这个修复可以避免合并后的自动部署被随机失败卡住。

## 2026-10-16 22:25:50

**变更类型**：优化代码（文档和配置说明）

**变更概述**：ChatGPT 套餐的代理配置说明改成以“mihomo 跑在 Docker 的 proxy-net 网络里”为主，服务器自己的 `docker-compose.override.yml` 不进仓库。

**修改的文件**

- 修改 `README.md`
- 修改 `.env.example`
- 修改 `.gitignore`
- 修改 `CHANGELOG.md`

**具体内容**

- `README.md` 重写「ChatGPT 套餐 → 服务器上先配好代理」，改为以下步骤：
  - mihomo 打开 `allow-lan`，`lan-allowed-ips` 限制为 proxy-net 的网段（附查网段的命令）；
  - 用 `docker port mihomo` 检查 7890 有没有对公网开放；
  - 在服务器上新建 `docker-compose.override.yml`，让 api 同时加入 `default` 和 `proxy-net`，并说明为什么必须写 `default`、为什么不能写进仓库的 `docker-compose.yml`；
  - `.env` 写 `OPENAI_PROXY=http://mihomo:7890`，并说明不要设 `HTTP_PROXY` / `HTTPS_PROXY`。
  - 原来的宿主机 Clash（`host.docker.internal`）写法保留为另一种方式。
- `.env.example`：`OPENAI_PROXY` 的注释写明容器里的 mihomo、宿主机 Clash、带用户名密码三种写法，示例改为 `http://mihomo:7890`。
- `.gitignore`：忽略 `docker-compose.override.yml`（服务器自己的 Compose 补充配置）。
- 用 `docker compose config` 验证过：合并 README 里的 override 写法后，api 同时在 `default` 和外部网络 `proxy-net` 上。代码和 `docker-compose.yml` 没有改动。

## 2026-10-16 19:14:09

**变更类型**：新增功能

**变更概述**：你自己（owner）的账户接入 ChatGPT 套餐（Sign in with ChatGPT）出题、改题；ChatGPT 用不了时自动回退到国内模型；邀请账户永远不会用到你的 ChatGPT 凭据。

**修改的文件**

- 新增 `api/src/openai-proxy.ts`
- 新增 `api/src/chatgpt-auth.ts`
- 新增 `api/src/chatgpt.ts`
- 新增 `api/src/llm-route.ts`
- 新增 `api/scripts/check-openai.ts`
- 新增 `api/test/chatgpt.test.ts`
- 新增 `web/src/settings/chatgpt-settings.ts`
- 新增 `CHANGELOG.md`
- 修改 `api/src/ai.ts`、`api/src/app.ts`、`api/src/config.ts`、`api/src/daily.ts`、`api/src/llm.ts`、`api/src/server.ts`、`api/src/settings.ts`
- 修改 `shared/src/types.ts`
- 修改 `web/index.html`、`web/src/lib/api.ts`、`web/src/settings/index.ts`
- 修改 `docker-compose.yml`、`.env.example`、`README.md`、`AGENTS.md`

**具体内容**

- 代理（`openai-proxy.ts`）：发往 OpenAI 的请求走 `.env` 里的 `OPENAI_PROXY`（服务器上的 Clash）。手写的 HTTP CONNECT 隧道，没有新增 npm 依赖，运行依赖仍然只有 `pg`；流式回复边到边读，超时和全局 `fetch` 一样报 `TimeoutError`。国内模型的请求不经过它。
- 授权（`chatgpt-auth.ts`）：OpenAI 开源 / 自托管应用的“套餐额度”流程，包括：
  - PKCE、state、nonce，第一次用 `dynamic_agent_client` 注册，之后用正式的 `oaiapp_` client_id；
  - 回调地址固定为 `http://127.0.0.1:47391/auth/callback`，在设置页粘贴回调地址完成授权，服务器通过代理换 token，token 不经过你的电脑；
  - 用 OpenAI 公布的公钥校验 ID token 的签名、签发方、受众、过期时间和 nonce，并检查是否同意了 `chatgpt.tokens.use.direct`；
  - 刷新 token（refresh token 会轮换），断开时到 OpenAI 吊销授权。
- ChatGPT 客户端（`chatgpt.ts`）：
  - 调用 `/v1/responses`，按预览期要求带 `stream: true`、`store: false`，不传 `temperature` 等不支持的参数；
  - 解析流式回复，只认 `response.completed`，并从中取 token 用量；
  - 不接受 JSON 输出模式时自动去掉重试；同一时间只刷新一次 token；收到 401 先刷新再试；
  - 额度用完时暂停一小时，账号不是 Plus / Pro 时标记出来，被 403 拒绝时暂停半小时；
  - 凭据用 `COOKIE_SECRET` 加密后存在 `settings` 表的 `chatgpt` 里，没连过就不存任何东西。
- 分流和回退（`llm-route.ts`）：
  - 按用途决定走 ChatGPT 还是国内模型：默认改题、出题（含谓语复核）走 ChatGPT，查词走国内模型；
  - ChatGPT 出错时这次请求改用国内模型，并把模型名换成国内对应的主力 / 轻量模型；
  - 回复格式不对不回退，交给原来的重试逻辑。
- 只给你自己用（`settings.ts`）：`createSettingsHub` 的 `llmFor(account, use)` 只给 owner 套上 ChatGPT 分流；邀请账户永远拿到它自己的客户端（OpenAI 条款要求凭据只能用于本人的请求）。
- 后台调用要同意（`daily.ts`、`ai.ts`）：每日任务的定时出题标记为后台调用，默认用国内模型；在设置里打开“每日任务定时出题也用 ChatGPT”才算同意。手动点“生成今日任务”不受影响。
- 接口（`app.ts`）：新增只有 owner 能用的 `/api/settings/chatgpt` 以及 `/start`、`/finish`、`/models`、`/test`、`/resume`；`/api/usage` 的 `aiReady` 把 ChatGPT 算在内。ChatGPT 的调用在 Token 用量里记成 `chatgpt/模型名`。
- 设置页（`chatgpt-settings.ts`）：只有你看得到的“ChatGPT 套餐”卡片，包括：
  - “Continue with ChatGPT”按钮、打开授权页、粘贴回调地址的两步引导；
  - 连接状态、主力 / 轻量模型下拉框、用途开关、后台出题开关；
  - 测试连接、恢复、断开；
  - 按 OpenAI 的界面规范显示 “Using ChatGPT plan” 和 “Manage usage” 链接。
- 部署：
  - `docker-compose.yml` 给 api 加上 `host.docker.internal:host-gateway`，让容器能访问宿主机上的 Clash；
  - `.env.example` 说明 `OPENAI_PROXY` 的写法；
  - `api/scripts/check-openai.ts` 在服务器上检查能不能连上 OpenAI，以及 OpenAI 看到的出口地区。
- 测试（`chatgpt.test.ts`，22 条）：用假的 OpenAI（授权、公钥、流式回复）和假的 Clash（CONNECT 代理）覆盖代理隧道、授权链接、回调解析、ID token 校验、刷新串行、401 重试、授权失效重连、额度用完暂停和回退、账号不能用套餐、断开吊销、按用途分流，以及“邀请账户在任何情况下都拿不到 ChatGPT”。后端测试共 106 条全部通过。
- 文档：
  - `README.md` 新增“ChatGPT 套餐”一节，包括 Clash 配置、安全组检查、连接步骤、用法和地区风险，并在接口表里补上新接口；
  - `AGENTS.md` 写明“ChatGPT 只给 owner”这条规则。
