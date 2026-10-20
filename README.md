# 长难句拆解台（自用版）

四六级长难句练习网站：圈谓语 → 看结构（成分颜色 + 从句知识点）→ 翻译（AI 批改 + 选译文），带点词查义、朗读、学习记录和每日任务。

- 前端：TypeScript + Vite 构建，Tailwind CSS v4 + GSAP 动画
- 后端：TypeScript，Node.js 22 直接运行（Node 自带的类型擦除，不用先编译），唯一运行依赖是 `pg`；AI 走任何兼容 OpenAI 接口格式的国内大模型，你自己的账户还可以用 ChatGPT 套餐（Sign in with ChatGPT）出题改题
- 前后端共用的接口类型、句子文本工具、知识点放在 `shared/`
- 数据库：PostgreSQL 16
- 部署：Docker Compose（db / api / web 三个容器，api 和 web 的镜像在服务器上构建）
- 工程化：npm workspaces、ESLint、Prettier、TypeScript 严格模式、提交前自动检查（husky + lint-staged）、GitHub Actions

## 更新方式：GitHub 自动更新

代码放在公开仓库 https://github.com/MouQianDi0/sentence-site 。每次推送，GitHub Actions 都会检查代码格式、跑 ESLint、类型检查、后端测试、前端构建，再用 Docker 把整个网站起一遍（见 `.github/workflows/ci.yml`）。

服务器每 8 小时（0:20、8:20、16:20）检查一次，有新代码、而且 GitHub 上的检查全部通过才自动部署；检查没通过或还没跑完时这次跳过。想马上更新就运行：

```bash
sudo sentence-update            # 检查还在跑时最多等 10 分钟；没通过就不部署
sudo sentence-update --force    # 不看检查结果，强制部署（出问题时临时用）
```

更新只会改仓库里的文件，`.env`、`data/`（数据库）和 `backups/` 不会动。更新时在服务器上构建 api 和 web 两个镜像（npm 依赖走腾讯云镜像，可以在 `.env` 里用 `NPM_REGISTRY=` 换别的源）。部署前会先备份一次数据库（`scripts/backup.sh`，备份失败不挡更新）。新版本启动失败（健康检查不通过）会自动退回上一个版本，定时任务也不会反复尝试这个失败的版本。更新日志：`sudo tail -n 30 /var/log/sentence-site-update.log`。关掉自动更新：`sudo rm /etc/cron.d/sentence-site-update`。

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

开了 HTTPS 以后打开 `https://cet.tech-mou.top`（用 IP 开 HTTPS 时是 `https://服务器IP:8443`；还没开时是 `http://服务器IP:端口`，端口是 `.env` 里的 `WEB_PORT`），输入访问密码。练习、记录、设置各有自己的地址：`/practice`、`/records`、`/settings`（邀请码管理是 `/settings/invites`，Token 用量是 `/settings/usage`），刷新或收藏都会停在那一页；直接打开首页会回到上次停留的那一页。忘了密码可以看：

```bash
sudo grep ACCESS_PASSWORD /opt/sentence-site/.env
```

## HTTPS

服务器上本来就有一个 Nginx 占着 80 端口，HTTPS 由它来做：它在 8443 端口接住 HTTPS，把请求转给只在本机监听的网站容器；443 留给服务器上原来的网站，不去抢。证书用 Let's Encrypt，acme.sh 申请并自动续期。在项目目录下运行（先 `sudo sentence-update` 拿到最新代码）：

```bash
sudo bash scripts/enable-https.sh                    # 用公网 IP：https://公网IP:8443
sudo bash scripts/enable-https.sh --port 8444        # 换个 HTTPS 端口（443 没被别的网站占着时可以 --port 443，网址就不用带端口）
sudo bash scripts/enable-https.sh cet.tech-mou.top --port 443  # 换成备案好的域名，用 443，网址不带端口
sudo bash scripts/enable-https.sh --off              # 撤掉 HTTPS，回到 http://公网IP:8080
```

- 换成域名（现在用的是 `cet.tech-mou.top`）：
  1. 先在 DNS 解析里加一条 A 记录，把域名指到这台服务器的公网 IP；脚本会先检查解析，没解析好就停下来说明。
  2. 运行 `sudo bash scripts/enable-https.sh 域名 --port 443`。用域名时可以和服务器上原来的网站共用 443：Nginx 按域名分开，不抢原来网站的默认网站，用 IP 或别的域名访问 443 还是原来的网站。
  3. 脚本申请好域名证书后，会停掉原来 IP 证书的续期（两张证书装在同一个位置，不停的话 IP 证书续期时会把域名证书覆盖掉），并删掉 IP 模式的钩子。以前的 `https://IP:8443` 不再能用，`http://IP:8080` 跳到 `https://域名`。新证书没申请成功时什么都不动，原来的网址照旧能用。
  4. 登录状态按网址分开，换域名后要重新登录一次；邀请用户也要改用新网址。
  5. 服务器在国内，域名要备案（已备案域名下的二级域名一般包含在原备案里）。
- 还没有备案的域名时用 IP 证书：Let's Encrypt 的 IP 证书每张只有 6 天，acme.sh 每天检查一次、满 3 天就续，不用管。
- 腾讯云防火墙要放行 HTTPS 端口（默认 TCP 8443）；TCP 80 也要一直开着，申请和续期证书时 Let's Encrypt 只会从外网访问 80 端口。
- 端口记在 `.env` 的 `HTTPS_PORT` 里，以后重新运行脚本沿用；换端口不用重新申请证书。
- 开了之后以前的 `http://IP:8080`、用 `http://` 打开 HTTPS 端口，都会跳到 https；网站容器改成只在本机 8081 端口监听（`.env` 里的 `WEB_BIND=127.0.0.1`、`WEB_PORT=8081`），`COOKIE_SECURE=1` 让登录状态只走 HTTPS。
- 只输 IP 不加端口（`http://IP`）**不跳转**，照旧是服务器上原来的网站：80 端口平时不放这个网站的配置，只在 acme.sh 申请或续期证书的那几秒，由钩子 `/etc/nginx/ssl/sentence-site/acme-hook.sh` 临时加上验证文件的路径（`sentence-site-acme.conf`），用完就删；这几秒里 `http://IP` 的其他地址会返回 404。用域名时 `http://域名` 照常跳到 https。
- 从旧版本更新过来（以前 `http://IP` 会跳到 8443）：`sudo sentence-update` 后再运行一次 `sudo bash scripts/enable-https.sh`。旧证书的续期设置里还没有那个钩子，脚本会强制重新申请一次证书把它记上，之后就不用管了。
- 脚本只加自己的 Nginx 配置（`/etc/nginx/conf.d/sentence-site.conf`，用 IP 时续期那几秒还有 `sentence-site-acme.conf`），服务器上原来的网站不受影响。可以重复运行，证书没到续期时间不会重新申请。
- 看证书什么时候到期：`sudo openssl x509 -noout -enddate -in /etc/nginx/ssl/sentence-site/fullchain.pem`

第一次启动时，数据库里还没有句子，api 会自动导入旧版页面导出的句子和练习记录（`api/seed/export.json`）。

## 邀请码账户

用访问密码登录的是你自己的账户（管理员）。在“设置”页点“邀请码管理”进入单独的邀请码页面，填个备注名、点“生成邀请码”，把邀请码（形如 `7H88-WVP7`）发给对方，对方在登录页输入邀请码就能用，大小写和横线都不影响。

- 每个邀请码对应一个独立账户：句库、练习记录、批改历史、每日任务设置和模型配置都和你的分开，互相看不到。
- 邀请账户用 AI（批改、查词、出题）时，用的是它自己在“设置”里填的模型和 API 密钥，不会用到你的；没填之前只能做已有的题。每天的批改、查词、加练次数上限和你一样（`.env` 里的 `DAILY_*_LIMIT`），各自单独计数。
- 生成邀请码时选有效期：30 天、90 天、180 天、360 天或永久（默认永久）。有效期**从对方第一次登录开始算**，还没登录过的邀请码不会白白过期。到期后对方登不进来，已经登录的也会退出（登录页上说明是过期了），但账户和数据都保留，也不再自动出题；在管理页给它选一个有效期或点“续期”就续上了，**登录过的账户改有效期都从改的那天重新算**。快到期（7 天内）时，对方登录后会看到提醒，设置页里也能看到自己哪天到期。有效期功能上线前就登录过的邀请账户都是永久有效，想限制的话在管理页改一下。
- 每个邀请码最多能在 2 台设备（浏览器）上登录，管理页里可以按邀请码调成 1–10 台。超出的新设备登录时会被拒绝，提示找你移除旧设备。管理页能看到每台设备大概是什么（如“iPhone · 微信”）、最近使用时间和 IP；移除一台设备会让它马上退出、空出名额。
- 设备是按浏览器认的：网站第一次登录时给浏览器发一个随机编号（Cookie `ss_device`），读不到手机的硬件编号。同一个浏览器退出再登录不会多占名额；对方清除浏览器数据、换浏览器或用无痕模式，都算一台新设备。
- 只有你能生成、查看、删除邀请码；邀请账户的设置页里没有这一块。删除邀请码会立刻让对方退出，并删除这个账户和它的全部数据，不能恢复。
- 每天的自动出题（时间各账户自己设，默认 7:50）会照顾你自己和最近 7 天登录过、配好了模型的邀请账户；很久没来的账户回来后在练习页点一下就能生成。
- 登录页有一段“关于邀请码”的说明（设备名额、数据独立、要自己填 API 密钥、有效期、别转给别人），对方第一次登录前能看到。
- 设置页最下面有“退出登录”，点了会再问一次，确认后才退出，可以换一个账户登录。

## 全新服务器

先运行 `sudo bash scripts/setup.sh`，它会装好 Docker、生成带随机密码的 `.env` 并设置每日备份；然后按上面“第一次接入”的步骤接到 GitHub。也可以手动 `cp .env.example .env` 再改。

## 常用命令（在 /opt/sentence-site 下执行）

| 要做的事 | 命令 |
| --- | --- |
| 看后端日志 | `sudo docker compose logs -f api` |
| 开 HTTPS / 换 HTTPS 端口 / 撤掉 HTTPS | `sudo bash scripts/enable-https.sh` / `… --port 8444` / `… --off` |
| 改了 `.env` 后生效 | `sudo docker compose up -d --force-recreate api` |
| 立即更新到 GitHub 上的最新代码 | `sudo sentence-update` |
| 看自动更新日志 | `sudo tail -n 30 /var/log/sentence-site-update.log` |
| 手动备份数据库 | `sudo bash scripts/backup.sh` |
| 导入旧页面导出的数据 | `sudo docker compose exec -T api node --experimental-strip-types scripts/import.ts < 导出文件.json` |
| 导入 / 更新四级真题题库 | `sudo docker compose exec -T api node --experimental-strip-types scripts/import-bank.ts < cet4_long_sentences.jsonl` |
| 停止网站 | `sudo docker compose down`（数据保留在 `data/postgres`） |

## 四级真题题库

除了让 AI 原创句子，还可以用四级真题阅读里的长难句。题库全站一份，只有你自己能导入和管理；题库文件不放进仓库（仓库是公开的），在服务器上导入。

1. 把题库的 JSONL 文件（`cet4_long_sentences.jsonl`，每行一句）传到服务器的 `/opt/sentence-site` 下，比如 `scp cet4_long_sentences.jsonl 服务器:/tmp/`，再 `sudo mv /tmp/cet4_long_sentences.jsonl /opt/sentence-site/`。
2. 导入（可以重复运行，题库更新了就再导一次）：

   ```bash
   cd /opt/sentence-site
   sudo docker compose exec -T api node --experimental-strip-types scripts/import-bank.ts < cet4_long_sentences.jsonl
   ```

   导入完会打印各状态的句数。整份要么都写进去、要么都不写，中途出错题库不变。

导入时按题库自己的质量状态初筛：核对过的（`reviewed`、`cloze_filled`）等着标注；拿不准的（`needs_review`）和没核对过的新句子先等你看一眼原文；选词填空还有空没填的（`incomplete_cloze`）不要。再次导入时按编号更新出处和标签；同一个编号原文变了，清掉原来的拆解、等重新标注；文件里已经没有的句子下架（已经抽给账户的那份不受影响）。


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

设置页的“Token 用量”能看到这个账户调用模型用掉了多少 token（今天、近 7 天、近 30 天、累计，按天的柱状图，按用途和模型分开），每个账户只看得到自己的；你自己在邀请码管理页还能看到每个邀请账户近 30 天和累计的用量。批改、查词、出题、复核谓语、测试连接每次调用模型都会记一笔（存在 `token_usage` 表），数字来自模型平台返回的用量。

设置页的“AI 批改”里有个“准确度提升”开关（每个账户自己的，默认关）。关着时每次批改只调用 1 次模型；打开后在后台做 5 次独立评分（分数取平均，减少单次评分的偶然性），再用一次新的对话把这几次汇总成一份批注，所以一次批改会调用 6 次主力模型，慢一点、token 用量约是关着时的 6 倍。不管开没开，每日批改次数都按 1 次算。

“关闭深度思考”默认开着：DeepSeek 等新模型默认会先“思考”再回答，批改和查词用不到，开着会慢很多、也更费钱。DeepSeek 推荐主力用 `deepseek-v4-pro`、轻量用 `deepseek-flash`。

每个平台的接口地址、密钥、模型和开关分开保存：点平台就能切换，点“保存并使用”就换成这个平台，不用重新填密钥；已经保存过密钥的平台旁边有个绿点。改了接口地址的域名时要重新填密钥，免得把一个平台的密钥发到别的地址。

密钥加密后存在服务器的数据库里，页面上只显示打码后的样子。网页上保存的配置优先于 `.env`；在设置页点“改回使用服务器 .env 里的配置”可以撤销（各平台保存的配置还留着），也可以单独删除某个平台的配置。`.env` 里的模型配置只给你自己的账户用，邀请账户用不到。

也可以继续用 `.env` 配置（写法见 `.env.example`），改完执行 `sudo docker compose up -d --force-recreate api`。注意：网页保存的密钥用 `COOKIE_SECRET` 加密，改了 `COOKIE_SECRET` 之后要在设置页重新填一次密钥。

## ChatGPT 套餐（只给你自己用）

你有 ChatGPT Plus 或 Pro 的话，可以在“设置”→“ChatGPT 套餐”里用 Sign in with ChatGPT 连接，之后你自己账户的出题、改题用 ChatGPT 套餐里的额度（和 Codex 共用那份额度），不用另付 API 费用。ChatGPT 用不了的时候（没连、额度用完、授权失效、网络不通）这次请求自动改用上面配的国内模型，所以国内模型最好也配着。

**只有你自己的账户会用到。** OpenAI 的条款规定套餐的授权只能用于连接它的这个人自己的请求，所以邀请账户永远只用它们自己填的模型——哪怕它们没配，也不会退到你的 ChatGPT 上（有测试专门守着这一条）。

**地区。** OpenAI 不支持中国大陆、香港、澳门。服务器通过 Clash 把请求发出去可以解决“连不上”，但你本人在大陆使用不在 OpenAI 的支持范围内，ChatGPT 账号有被风控的可能，风险自己掂量。

### 服务器上先配好代理（只做一次）

下面按 mihomo（Clash.Meta）跑在 Docker 里来写：容器名 `mihomo`，在一个叫 `proxy-net` 的 Docker 网络上，HTTP 代理端口 7890。

1. **mihomo 的配置**：
   - `mixed-port: 7890`、`allow-lan: true`（网站容器的请求从 proxy-net 网段过来，对 mihomo 来说不算本机，不开连不上）；
   - `lan-allowed-ips` 填 proxy-net 的网段，只让这个网络里的容器用。网段用 `docker network inspect proxy-net -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}'` 查；
   - 规则模式下，把 `- DOMAIN-SUFFIX,openai.com,节点组` 和 `- DOMAIN-SUFFIX,chatgpt.com,节点组` 放在 `rules` 最前面。节点组里只放 **OpenAI 支持地区** 的节点（美国、日本、新加坡等，**不能是香港**），组名换成你自己的。
2. **不要让外网用到这个代理**：运行 `docker port mihomo`，如果显示 `0.0.0.0:7890`，说明端口对公网开着（Docker 映射的端口会绕过 ufw，只剩腾讯云安全组拦着）。网站和其他容器都是通过 proxy-net 访问它，宿主机用不到的话，就去掉启动参数里的 `-p 7890:7890`；宿主机自己也要用的话，改成 `-p 127.0.0.1:7890:7890`。
3. **让 api 容器加入 proxy-net**：在 `/opt/sentence-site/` 下新建 `docker-compose.override.yml`：

   ```yaml
   services:
     api:
       networks:
         - default # 一定要写：写了 networks 后不会再自动加入默认网络，少了它 api 连不上数据库
         - proxy-net
   networks:
     proxy-net:
       external: true
   ```

   `docker compose up`（包括自动更新）会自动合并这个文件。更新时的 `git reset --hard` 不会删掉它，`.gitignore` 里也已经忽略了它。不要把 proxy-net 写进仓库里的 `docker-compose.yml`：GitHub Actions 里没有这个网络，检查会失败，自动部署就停了。
4. **`.env` 里加一行** `OPENAI_PROXY=http://mihomo:7890`，然后运行 `sudo docker compose up -d --force-recreate api`。只有发往 OpenAI 的请求走这个代理，国内模型照旧直连。**不要**给 api 设 `HTTP_PROXY` / `HTTPS_PROXY`：后端的 `fetch` 本来就不读这两个变量，以后要是读了，国内模型的请求也会被送进 Clash。
5. **检查**：运行 `sudo docker compose exec api node scripts/check-openai.ts`，会显示能不能连上 OpenAI，以及 OpenAI 看到的出口地区。全是 ✓ 再去网站上连接。

Clash 装在宿主机上（不在 Docker 里）时，不用第 3 步，`.env` 写 `OPENAI_PROXY=http://host.docker.internal:7890`（`docker-compose.yml` 里已经配好了 `host.docker.internal`）。Clash 那边同样要打开 `allow-lan`，并确认腾讯云安全组没放行 7890：在你自己电脑上执行 `curl -m 5 -x http://服务器公网IP:7890 https://www.example.com` 应该连不上。

不管哪种方式，Clash 设了用户名密码（`authentication`）时，地址写成 `http://用户名:密码@mihomo:7890` 这种格式。

### 连接（建议在电脑浏览器上做）

1. “设置”→“ChatGPT 套餐”→ 点 **Continue with ChatGPT**，会在新窗口打开 ChatGPT 的授权页。
2. 登录、选账号，**同意“使用 ChatGPT 套餐”**（不同意的话能连上但用不了）。
3. 同意后浏览器会跳到一个打不开的 `http://127.0.0.1:47391/auth/callback?...` 页面——这是正常的（OpenAI 规定回调地址必须是 127.0.0.1，而服务器在远端）。把地址栏里的**整段地址**复制下来，粘贴回设置页，点“完成连接”。10 分钟内有效，每个授权链接只能用一次。
4. 服务器通过代理换取授权、校验 OpenAI 的签名后加密保存，自动选第一个可用模型，之后可以换。授权一小时过期，服务器会自动续期，不用管。

### 用起来

- 默认改题、出题（包括出题后的谓语复核）走 ChatGPT，查词留给国内模型（频繁又简单，省 ChatGPT 的额度），都可以在卡片上改。开着“准确度提升”时一次改题会调用 6 次。
- **每日任务定时出题默认不用 ChatGPT**：OpenAI 要求后台调用（你不在的时候）必须经过你同意，卡片上单独有个开关，打开才算同意。你手动点“生成今日任务”不受影响。
- ChatGPT 返回“额度用完”时暂停一小时，期间直接用国内模型，到时间自动再试；卡片上可以“现在就恢复”，或者点“测试连接”，成功了也会取消暂停。Plus 套餐还有一个 5 小时的额度窗口，是所有用这份额度的地方（ChatGPT、Codex、这个网站……）共用的。每个应用每周能用多少，在 ChatGPT 的 [设置 → 用量](https://chatgpt.com/settings/usage) 里看和改（卡片上的 “Manage usage”）。
- Token 用量页里 ChatGPT 的调用记成 `chatgpt/模型名`，和国内模型分开统计。
- 授权失效（比如在 ChatGPT 设置里断开了这个应用）时卡片会提示“重新连接”，重新授权一次就好，会直接选原来的账号。
- 点“断开 ChatGPT”会到 OpenAI 吊销授权、删掉服务器上的凭据（模型和开关的设置保留）。OpenAI 没确认吊销时会提示你到 ChatGPT 设置里手动断开。
- 凭据（access / refresh / ID token）用 `COOKIE_SECRET` 加密后存在数据库的 `settings` 表里，和 API 密钥一样；改了 `COOKIE_SECRET` 要重新连接。没连过 ChatGPT 的话数据库里什么都不存。

## 出题规范（给 AI 和 agent 读的统一标准）

句子数据的所有规则写在一份文件里：[`api/skills/sentence-spec/SKILL.md`](api/skills/sentence-spec/SKILL.md)（Agent Skills 格式）。谓语怎么标、片段怎么切、知识点键怎么选、主干怎么写都以它为准：

- 网站里的 AI：后端每次出题、复核谓语时，把文件里 `<!-- prompt:名字 -->` 标出的几段原样放进提示词。改了规则，更新部署后 AI 就按新规则出题，不用改代码。
- 校验代码（`api/src/validate.ts`、`api/src/predicates.ts`）和知识点（`shared/src/kb.ts`）要和它保持一致，`npm test` 会核对知识点键和文件里的完整示例。
- 写代码的 agent：仓库根目录的 `.claude/skills/sentence-spec` 指向同一份文件，Claude Code 这类支持 Agent Skills 的工具改网站时会读到它；`AGENTS.md` 也指向这里。

## 接口

除了登录相关的接口，其他接口都只读写当前登录账户自己的数据。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/unlock | 输入访问密码或邀请码，换 30 天有效的 Cookie（连续错 5 次锁 15 分钟） |
| POST | /api/lock | 退出登录 |
| GET | /api/session | 是否已登录、是哪种账户（`role`：owner 是你自己，member 是邀请账户；`name`：备注名） |
| GET / POST | /api/admin/invites | 只有你自己能用：列出邀请码（含邀请码原文、创建时间、最近使用、近 30 天和累计 token 用量、有效期和到期时间）；`{"note":"小王","validDays":90}` 生成一个（`validDays` 是 30 / 90 / 180 / 360，不传或 `null` 是永久） |
| PUT | /api/admin/invites/:id | 只有你自己能用：`{"deviceLimit":3}` 改这个邀请码最多能在几台设备上登录（1–10）；`{"validDays":30}` 改有效期（`null` 是永久；对方登录过的从现在开始重新算，过期的就续上了） |
| DELETE | /api/admin/invites/:id | 只有你自己能用：删除邀请码，连带删除这个账户和它的全部数据 |
| DELETE | /api/admin/invites/:id/devices/:deviceId | 只有你自己能用：移除一台设备，它马上退出登录 |
| GET | /api/sentences?since= | 句库（带 since 只返回更新的） |
| POST | /api/sentences/generate | `{"kind":"daily"}` 生成或补齐今日任务；`{"kind":"extra","count":3}` 加练 1–10 句 |
| GET / PUT | /api/settings/practice | 每日任务设置：`levels`（CET-4 / CET-6，可多选）、`dailyCount`（1–10）、`autoDaily`（是否自动生成）、`dailyAt`（自动生成时间，北京时间 `HH:MM`）、`accuracyBoost`（AI 批改的准确度提升开关，默认 `false`）；读取时还返回 `serverDaily`（服务器有没有开每日出题） |
| DELETE | /api/sentences/:id | 删除一句（连带它的记录） |
| PUT | /api/sentences/:id/predicates | 修正谓语标注：`{"spans":[{"kind":"main","a":2,"b":2},{"kind":"sub","a":9,"b":10}]}`，a、b 是整句单词下标 |
| POST | /api/sentences/:id/review | 让 AI 按出题规范复查这一句的谓语，标错了就改正并保存 |
| GET | /api/records | 所有句子的练习状态 |
| PUT | /api/records/:sentenceId | 保存圈谓语结果、选项、草稿（只改传入的字段） |
| GET | /api/attempts?sentenceId= | AI 批改历史 |
| POST | /api/grade | AI 批改。默认调用 1 次模型；开了准确度提升时后台并行 5 次独立评分取平均分，再用一次新的对话汇总成一份批注（每次都是不带上下文的单独请求；都只算 1 次批改） |
| POST | /api/lookup | AI 查词（结果缓存在数据库） |
| GET | /api/usage | 今天的 AI 用量和上限 |
| GET | /api/usage/tokens?days=7\|30\|90 | 当前账户自己的 token 用量：今天、近 7 天、近 30 天、累计，按天、按用途、按模型分开 |
| GET / PUT / DELETE | /api/settings/llm | 当前账户自己的模型配置。读取各平台配置；保存某个平台并切换过去（`provider` 字段）；`?provider=` 删除某个平台，不带参数改回 .env（密钥只返回打码后的） |
| POST | /api/settings/llm/test | 用填写的配置测试连接（不保存） |
| POST | /api/settings/llm/models | 获取平台的模型列表 |
| GET / PUT / DELETE | /api/settings/chatgpt | 只有你自己能用：ChatGPT 套餐的状态；`{"mainModel","lightModel","use":{"grade","generate","lookup"},"background"}` 改设置；DELETE 断开（到 OpenAI 吊销授权，返回 `revoked`） |
| POST | /api/settings/chatgpt/start | 只有你自己能用：生成授权链接（10 分钟内有效） |
| POST | /api/settings/chatgpt/finish | 只有你自己能用：`{"callbackUrl":"http://127.0.0.1:47391/auth/callback?code=…"}` 完成连接 |
| POST | /api/settings/chatgpt/models | 只有你自己能用：这个 ChatGPT 账号能用的模型 |
| POST | /api/settings/chatgpt/test | 只有你自己能用：用主力、轻量模型各调用一次；都成功时取消暂停 |
| POST | /api/settings/chatgpt/resume | 只有你自己能用：取消暂停（额度恢复了、升级了套餐） |
| GET | /api/health | 健康检查 |

## 目录结构

```
shared/      前后端共用：接口数据类型（types.ts）、句子文本工具（text.ts）、知识点（kb.ts）
api/         后端（TypeScript，Node 直接运行）
  src/       接口、AI、数据库、每日出题
    migrations/  数据库迁移 NNNN_说明.sql，启动时按编号执行没执行过的（记在 schema_migrations 表）
  test/      测试（node --test）、本地演示服务器 devserver.ts
  skills/    出题规范 SKILL.md
web/         前端（Vite + TypeScript）
  index.html 页面骨架
  src/       main.ts 入口；practice/ 练习页；settings/ 设置页；lib/ 接口、动画、朗读等工具
nginx/       Nginx 配置（构建前端镜像时打包进去）
scripts/     服务器脚本：安装、自动更新、备份
```

## 本地开发

需要 Node.js 22.18 以上（能直接运行 `.ts`）。在仓库根目录：

```bash
npm install            # 第一次，或者 package.json 变了以后；会顺便装好提交前的检查
npm run dev:demo       # 演示后端：假的大模型 + 本机 PostgreSQL，端口 3100，密码 dev-password
API_URL=http://127.0.0.1:3100 npm run dev   # 另开一个终端：前端开发服务器 http://127.0.0.1:5173 ，改代码自动刷新
```

想连真的数据库和模型：`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db` 起一个数据库，`.env` 里把 `DB_HOST` 改成 `127.0.0.1`，然后 `npm run dev:api`（端口 3000）和 `npm run dev`。

| 要做的事 | 命令 |
| --- | --- |
| 全部检查一遍（和 GitHub 上一样） | `npm run check` |
| 后端测试 | `npm test`（测试用本机的 `psql` 连 PostgreSQL，地址见 `api/test/helpers.ts`，可以用 `TEST_PGHOST` 等环境变量改） |
| 类型检查 | `npm run typecheck` |
| 代码检查 / 自动修 | `npm run lint` / `npm run lint:fix` |
| 格式化 | `npm run format` |
| 构建前端 | `npm run build`（输出到 `web/dist`；`npm run dev:demo` 也会顺带提供它） |

`git commit` 时会自动对改动的文件跑 ESLint 和 Prettier（husky + lint-staged）。Tailwind 的类名直接写在 `web/index.html` 和 `web/src` 里，Vite 构建时自动生成 CSS，不用再手动编译。演示服务器加上 `DEV_NO_LLM=1` 可以模拟还没配置模型。
