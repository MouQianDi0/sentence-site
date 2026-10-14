# 给写代码的 agent

长难句拆解台：四六级长难句练习网站。后端 `api/`（Node.js 22 + PostgreSQL，唯一依赖 `pg`），前端 `web/`（原生 JS 模块 + 编译好的 Tailwind v4 CSS + GSAP），Docker Compose 部署。说明见 `README.md`。

## 先读出题规范

改任何和句子数据有关的东西之前（提示词、校验、知识点讲解、圈谓语 / 看结构页面），先读 `api/skills/sentence-spec/SKILL.md`。它是谓语标注、片段切分、知识点键、主干的唯一标准，后端会把其中 `<!-- prompt:… -->` 段放进给大模型的提示词。改规则时先改它，再同步 `api/src/validate.js`、`api/src/predicates.js`、`web/js/kb.js`。

## 账户

数据按账户隔离：`sentences.account_id` 指向 `accounts`，记录、批改、查词缓存跟着句子走，`ai_usage` 也带 `account_id`。`api/src/repo.js` 里查句子的函数第一个参数都是 `accountId`，新写的查询也要带上，不能让一个账户读到别的账户的数据。你自己是 `owner`（访问密码登录），邀请账户是 `member`（邀请码登录）；只有 owner 能用 `/api/admin/*`。邀请账户的登录 Cookie 里带设备编号，每次请求都核对 `devices` 表，设备被移除就失效。模型配置按账户（`createSettingsHub`），邀请账户只用它自己填的 API 密钥，不能退回 `.env`。

## 改完要做

- 跑测试：`cd api && npm test`（需要本机 PostgreSQL，连接方式见 `api/test/helpers.js`）。
- 改了页面里的 Tailwind 类名：用 Tailwind CSS v4 独立命令行工具重新生成 `web/css/app.css`（`TAILWIND=/path/to/tailwindcss bash web/build-css.sh`），把生成的文件一起提交。
- 推到 `main` 后服务器 8 小时内自动部署，或在服务器上运行 `sudo sentence-update`。
