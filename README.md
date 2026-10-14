# 长难句拆解台（自用版）

四六级长难句练习网站：圈谓语 → 看结构（成分颜色 + 从句知识点）→ 翻译（AI 批改 + 选译文），带点词查义、朗读、学习记录和每日任务。

- 前端：原生 JS 模块 + Tailwind CSS v4（已编译好 `web/css/app.css`）+ GSAP 动画，不需要构建
- 后端：Node.js 22，唯一依赖是 `pg`；AI 走任何兼容 OpenAI 接口格式的国内大模型
- 数据库：PostgreSQL 16
- 部署：Docker Compose（db / api / web 三个容器）

## 更新方式：GitHub 自动更新

代码放在公开仓库 https://github.com/MouQianDi0/sentence-site 。服务器每 8 小时（0:20、8:20、16:20）检查一次，有新代码就自动部署；想马上更新就运行：

```bash
sudo sentence-update
```

更新只会改仓库里的文件，`.env`、`data/`（数据库）和 `backups/` 不会动。新版本启动失败（健康检查不通过）会自动退回上一个版本，定时任务也不会反复尝试这个失败的版本。更新日志：`sudo tail -n 30 /var/log/sentence-site-update.log`。关掉自动更新：`sudo rm /etc/cron.d/sentence-site-update`。

### 第一次接入（已经用压缩包部署过的服务器，只需要做一次）

```bash
sudo apt-get install -y git
cd /opt/sentence-site
sudo git init -q -b main
sudo git remote add origin https://github.com/MouQianDi0/sentence-site.git
sudo git fetch --depth 1 origin main
sudo git reset -q --hard FETCH_HEAD
sudo bash scripts/enable-auto-update.sh
```

### 不用 GitHub 时

把压缩包上传到服务器，解压到项目目录（不会覆盖 `.env` 和数据库数据），再重新构建：

```bash
sudo unzip -o sentence-site.zip -d /opt/sentence-site     # 或 sudo tar xzf sentence-site.tar.gz -C /opt/sentence-site
cd /opt/sentence-site && sudo docker compose up -d --build
```

## 访问

打开 `http://服务器IP:端口`（端口是 `.env` 里的 `WEB_PORT`），输入访问密码。忘了密码可以看：

```bash
sudo grep ACCESS_PASSWORD /opt/sentence-site/.env
```

第一次启动时，数据库里还没有句子，api 会自动导入旧版页面导出的句子和练习记录（`api/seed/export.json`）。

## 邀请码账户

用访问密码登录的是你自己的账户（管理员）。在“设置”页点“邀请码管理”进入单独的邀请码页面，填个备注名、点“生成邀请码”，把邀请码（形如 `7H88-WVP7`）发给对方，对方在登录页输入邀请码就能用，大小写和横线都不影响。

- 每个邀请码对应一个独立账户：句库、练习记录、批改历史、每日任务设置和模型配置都和你的分开，互相看不到。
- 邀请账户用 AI（批改、查词、出题）时，用的是它自己在“设置”里填的模型和 API 密钥，不会用到你的；没填之前只能做已有的题。每天的批改、查词、加练次数上限和你一样（`.env` 里的 `DAILY_*_LIMIT`），各自单独计数。
- 每个邀请码最多能在 2 台设备（浏览器）上登录，管理页里可以按邀请码调成 1–10 台。超出的新设备登录时会被拒绝，提示找你移除旧设备。管理页能看到每台设备大概是什么（如“iPhone · 微信”）、最近使用时间和 IP；移除一台设备会让它马上退出、空出名额。
- 设备是按浏览器认的：网站第一次登录时给浏览器发一个随机编号（Cookie `ss_device`），读不到手机的硬件编号。同一个浏览器退出再登录不会多占名额；对方清除浏览器数据、换浏览器或用无痕模式，都算一台新设备。
- 只有你能生成、查看、删除邀请码；邀请账户的设置页里没有这一块。删除邀请码会立刻让对方退出，并删除这个账户和它的全部数据，不能恢复。
- 每天的自动出题（时间各账户自己设，默认 7:50）会照顾你自己和最近 7 天登录过、配好了模型的邀请账户；很久没来的账户回来后在练习页点一下就能生成。
- 登录页有一段“关于邀请码”的说明（设备名额、数据独立、要自己填 API 密钥、别转给别人），对方第一次登录前能看到。
- 设置页最下面有“退出登录”，点了会再问一次，确认后才退出，可以换一个账户登录。

## 全新服务器

先运行 `sudo bash scripts/setup.sh`，它会装好 Docker、生成带随机密码的 `.env` 并设置每日备份；然后按上面“第一次接入”的步骤接到 GitHub。也可以手动 `cp .env.example .env` 再改。

## 常用命令（在 /opt/sentence-site 下执行）

| 要做的事 | 命令 |
| --- | --- |
| 看后端日志 | `sudo docker compose logs -f api` |
| 改了 `.env` 后生效 | `sudo docker compose up -d --force-recreate api` |
| 立即更新到 GitHub 上的最新代码 | `sudo sentence-update` |
| 看自动更新日志 | `sudo tail -n 30 /var/log/sentence-site-update.log` |
| 手动备份数据库 | `sudo bash scripts/backup.sh` |
| 导入旧页面导出的数据 | `sudo docker compose exec -T api node scripts/import.js < 导出文件.json` |
| 停止网站 | `sudo docker compose down`（数据保留在 `data/postgres`） |

## 每日任务

练习页最上面是“今日任务”：每天到了你设的时间（北京时间，默认 7:50）自动生成（也可以点“现在生成”），进度条显示完成了几句。一句在第 3 步选对译文就算完成；全部完成后练习页显示完成页，可以复习今天的句子，也可以选 1–10 句加练（加练的句子算进今天的任务）。

在“设置”页的“每日任务”里改：

- 难度：四级、六级可以多选。两个都选时各占一半，顺序随机。
- 每天几句：1–10 句。今天的任务已经生成后调多了，练习页会出现“补齐”按钮。
- 自动生成：可以关掉（之后每天在练习页手动点“现在生成”），也可以改成自己方便的时间（北京时间，精确到分钟）。改成比现在早的时间、而今天还没生成的话，一分钟内就会生成。服务器 `.env` 里 `DAILY_GENERATE=0` 时所有账户都不会自动生成，这个开关会变灰。

## 配置国内大模型

每个账户各配各的。打开网站，点右上角的“设置”：

1. 选平台（DeepSeek、通义千问、智谱 GLM、Kimi，或“其他平台”自己填接口地址）
2. 粘贴 API 密钥
3. 点“获取模型列表”选模型（平台不提供列表时手动填写）
4. 点“测试连接”，成功后点“保存”，立即生效，不用重启

“关闭深度思考”默认开着：DeepSeek 等新模型默认会先“思考”再回答，批改和查词用不到，开着会慢很多、也更费钱。DeepSeek 推荐主力用 `deepseek-v4-pro`、轻量用 `deepseek-flash`。

每个平台的接口地址、密钥、模型和开关分开保存：点平台就能切换，点“保存并使用”就换成这个平台，不用重新填密钥；已经保存过密钥的平台旁边有个绿点。改了接口地址的域名时要重新填密钥，免得把一个平台的密钥发到别的地址。

密钥加密后存在服务器的数据库里，页面上只显示打码后的样子。网页上保存的配置优先于 `.env`；在设置页点“改回使用服务器 .env 里的配置”可以撤销（各平台保存的配置还留着），也可以单独删除某个平台的配置。`.env` 里的模型配置只给你自己的账户用，邀请账户用不到。

也可以继续用 `.env` 配置（写法见 `.env.example`），改完执行 `sudo docker compose up -d --force-recreate api`。注意：网页保存的密钥用 `COOKIE_SECRET` 加密，改了 `COOKIE_SECRET` 之后要在设置页重新填一次密钥。

## 出题规范（给 AI 和 agent 读的统一标准）

句子数据的所有规则写在一份文件里：[`api/skills/sentence-spec/SKILL.md`](api/skills/sentence-spec/SKILL.md)（Agent Skills 格式）。谓语怎么标、片段怎么切、知识点键怎么选、主干怎么写都以它为准：

- 网站里的 AI：后端每次出题、复核谓语时，把文件里 `<!-- prompt:名字 -->` 标出的几段原样放进提示词。改了规则，更新部署后 AI 就按新规则出题，不用改代码。
- 校验代码（`api/src/validate.js`、`api/src/predicates.js`）和页面知识点（`web/js/kb.js`）要和它保持一致，`npm test` 会核对知识点键和文件里的完整示例。
- 写代码的 agent：仓库根目录的 `.claude/skills/sentence-spec` 指向同一份文件，Claude Code 这类支持 Agent Skills 的工具改网站时会读到它；`AGENTS.md` 也指向这里。

## 接口

除了登录相关的接口，其他接口都只读写当前登录账户自己的数据。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/unlock | 输入访问密码或邀请码，换 30 天有效的 Cookie（连续错 5 次锁 15 分钟） |
| POST | /api/lock | 退出登录 |
| GET | /api/session | 是否已登录、是哪种账户（`role`：owner 是你自己，member 是邀请账户；`name`：备注名） |
| GET / POST | /api/admin/invites | 只有你自己能用：列出邀请码（含邀请码原文、创建时间、最近使用）；`{"note":"小王"}` 生成一个 |
| PUT | /api/admin/invites/:id | 只有你自己能用：`{"deviceLimit":3}` 改这个邀请码最多能在几台设备上登录（1–10） |
| DELETE | /api/admin/invites/:id | 只有你自己能用：删除邀请码，连带删除这个账户和它的全部数据 |
| DELETE | /api/admin/invites/:id/devices/:deviceId | 只有你自己能用：移除一台设备，它马上退出登录 |
| GET | /api/sentences?since= | 句库（带 since 只返回更新的） |
| POST | /api/sentences/generate | `{"kind":"daily"}` 生成或补齐今日任务；`{"kind":"extra","count":3}` 加练 1–10 句 |
| GET / PUT | /api/settings/practice | 每日任务设置：`levels`（CET-4 / CET-6，可多选）、`dailyCount`（1–10）、`autoDaily`（是否自动生成）、`dailyAt`（自动生成时间，北京时间 `HH:MM`）；读取时还返回 `serverDaily`（服务器有没有开每日出题） |
| DELETE | /api/sentences/:id | 删除一句（连带它的记录） |
| PUT | /api/sentences/:id/predicates | 修正谓语标注：`{"spans":[{"kind":"main","a":2,"b":2},{"kind":"sub","a":9,"b":10}]}`，a、b 是整句单词下标 |
| POST | /api/sentences/:id/review | 让 AI 按出题规范复查这一句的谓语，标错了就改正并保存 |
| GET | /api/records | 所有句子的练习状态 |
| PUT | /api/records/:sentenceId | 保存圈谓语结果、选项、草稿（只改传入的字段） |
| GET | /api/attempts?sentenceId= | AI 批改历史 |
| POST | /api/grade | AI 批改 |
| POST | /api/lookup | AI 查词（结果缓存在数据库） |
| GET | /api/usage | 今天的 AI 用量和上限 |
| GET / PUT / DELETE | /api/settings/llm | 当前账户自己的模型配置。读取各平台配置；保存某个平台并切换过去（`provider` 字段）；`?provider=` 删除某个平台，不带参数改回 .env（密钥只返回打码后的） |
| POST | /api/settings/llm/test | 用填写的配置测试连接（不保存） |
| POST | /api/settings/llm/models | 获取平台的模型列表 |
| GET | /api/health | 健康检查 |

## 本地开发

- 后端测试：`cd api && node --test test/*.test.js`。测试用本机的 `psql` 连 PostgreSQL（地址见 `api/test/helpers.js`），外加一个假的大模型接口，不需要装 npm 包。
- 本地预览：`cd api && node test/devserver.js`，打开 http://127.0.0.1:3100 ，密码 `dev-password`。加上 `DEV_NO_LLM=1` 可以模拟还没配置模型，在设置页里用日志打印的假模型地址试一遍。
- 改了页面里的 Tailwind 类名后重新生成 CSS：下载 [Tailwind CSS v4 独立命令行工具](https://github.com/tailwindlabs/tailwindcss/releases)，然后 `TAILWIND=/path/to/tailwindcss bash web/build-css.sh`。
