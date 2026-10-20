# 给写代码的 agent

长难句拆解台：四六级长难句练习网站。npm workspaces 单仓库，全部是 TypeScript（严格模式）：

- `shared/`：前后端共用的接口数据类型（`types.ts`）、句子文本工具（`text.ts`）、知识点（`kb.ts`）。改接口返回的字段先改 `types.ts`，两边的类型检查会指出哪里要跟着改。
- `api/`：后端，Node.js 22 直接运行 `.ts`（类型擦除，不编译），唯一运行依赖 `pg`。只能用能被擦除的 TS 语法（`erasableSyntaxOnly`：不要 enum、namespace、构造函数参数属性），相对路径的 import 要写 `.ts` 后缀，只引入类型时用 `import type`。后端只从 `@sentence-site/shared` 引入类型，不引入运行代码（生产镜像里没有 shared）。
- `web/`：前端，Vite + Tailwind CSS v4 + GSAP。入口 `web/src/main.ts`；练习页在 `practice/`，设置页在 `settings/`，工具在 `lib/`。页面状态集中在 `state.ts`；练习、记录、设置各有地址（`/practice`、`/records`、`/settings`，设置下面的单独页面 `/settings/invites`、`/settings/usage`），对应关系在 `router.ts`，新加页面也要在那里加地址。Tailwind 类名要完整写出来（不能拼接），写在 `web/index.html` 或 `web/src` 里会被自动扫描。
- Docker Compose 部署，api 和 web 镜像在服务器上构建，构建上下文是仓库根目录。说明见 `README.md`。

## 先读出题规范

改任何和句子数据有关的东西之前（提示词、校验、知识点讲解、圈谓语 / 看结构页面），先读 `api/skills/sentence-spec/SKILL.md`。它是谓语标注、片段切分、知识点键、主干的唯一标准，后端会把其中 `<!-- prompt:… -->` 段放进给大模型的提示词。改规则时先改它，再同步 `api/src/validate.ts`、`api/src/predicates.ts`、`shared/src/kb.ts`。拆单词的规则在 `shared/src/text.ts` 的 `toks()` 和 `api/src/predicates.ts` 的 `wordsOf()` 两处，要保持一致。

## 改表结构

新增 `api/src/migrations/NNNN_说明.sql`（编号接着往下排），不改已发布的文件；启动时 `api/src/migrate.ts` 按编号执行没执行过的，记在 `schema_migrations` 表。文件里不写 `BEGIN`/`COMMIT`，不用 `CREATE INDEX CONCURRENTLY`（整份在一个事务里执行）。更新失败会退回上一个版本、旧代码跑在已升级的库上，所以会让旧代码写不进去的改动分扩、收两次发布。

## 账户

数据按账户隔离：`sentences.account_id` 指向 `accounts`，记录、批改、查词缓存跟着句子走，`ai_usage`、`token_usage` 也带 `account_id`。调用模型时用 `tokens.ts` 的 `metered()` 包一层，用掉的 token 才会记到账户名下。`api/src/repo.ts` 里查句子的函数第一个参数都是 `accountId`，新写的查询也要带上，不能让一个账户读到别的账户的数据。你自己是 `owner`（访问密码登录），邀请账户是 `member`（邀请码登录）；只有 owner 能用 `/api/admin/*`。邀请账户的登录 Cookie 里带设备编号，每次请求都核对 `devices` 表，设备被移除就失效；还会核对 `accounts.expires_at`，邀请码过期了就返回 401 并说明原因（有效期从第一次登录开始算，见 `accounts.ts`）。模型配置按账户（`createSettingsHub`），邀请账户只用它自己填的 API 密钥，不能退回 `.env`。

ChatGPT 套餐（Sign in with ChatGPT）只给 owner 用：`chatgpt.ts`（授权凭据、调用 `/v1/responses`）、`chatgpt-auth.ts`（OAuth、ID token 校验）、`openai-proxy.ts`（发往 OpenAI 的请求走 `.env` 的 `OPENAI_PROXY`，手写的 CONNECT 隧道，不加依赖）、`llm-route.ts`（按用途走 ChatGPT、出错回退到国内模型）。`createSettingsHub` 的 `llmFor(account, use)` 只给 owner 套 `routeOwner`，**邀请账户永远拿不到 ChatGPT**（OpenAI 条款：凭据只能用于连接它的这个人自己的请求），`api/test/chatgpt.test.ts` 守着这一条，不要改。调用模型时把用途传给 `llmFor`（`{ kind: 'grade' }` 等）；定时任务触发的传 `background: true`，owner 只有在设置里同意了才会用 ChatGPT。预览期的 `/v1/responses` 必须 `stream: true`、`store: false`，不支持 `temperature`、`max_output_tokens` 等参数。

## 改完要做

在仓库根目录运行 `npm run check`（格式、ESLint、类型检查、后端测试、前端构建，和 GitHub Actions 一样）。后端测试需要本机 PostgreSQL，连接方式见 `api/test/helpers.ts`。

- 格式不对：`npm run format`；ESLint 能自动修的：`npm run lint:fix`。
- 页面上的改动，用 `npm run dev:demo` + `API_URL=http://127.0.0.1:3100 npm run dev` 在浏览器里看一遍。
- 推到 `main` 后 GitHub Actions 全部通过，服务器 8 小时内自动部署；或在服务器上运行 `sudo sentence-update`。没通过的提交不会被部署。
