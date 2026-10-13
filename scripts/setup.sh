#!/usr/bin/env bash
# =============================================================================
# 长难句拆解台 · 服务器初始化脚本
#
# 用法（在腾讯云服务器上，用 root 或 sudo 运行）：
#     sudo bash setup.sh
#
# 它会做这些事：
#   1. 安装基础工具，时区设为 Asia/Shanghai，内存小于 3G 时加 2G swap
#   2. 安装 Docker（走腾讯云镜像源），配置腾讯云的 Docker 镜像加速
#   3. 在 /opt/sentence-site 下生成项目目录、docker-compose.yml、Nginx 配置、
#      数据库建表语句、每日备份脚本，并生成带随机密码的 .env
#   4. 启动一套占位服务（Nginx + Node + PostgreSQL），检查能否互通
#   5. 最后打印一份报告，整段复制发给 Claude 即可
#
# 可以重复运行：配置文件会被覆盖成最新版，但不会动 .env 和数据库里的数据。
# 推荐系统：Ubuntu 22.04 / 24.04，或腾讯云的“Docker CE”应用镜像。
# =============================================================================
set -euo pipefail

APP_DIR=/opt/sentence-site
DOCKER_MIRROR=https://mirrors.cloud.tencent.com/docker-ce
REGISTRY_MIRROR=https://mirror.ccs.tencentyun.com

STEP="准备"
trap 'echo; echo -e "\033[1;31m[失败]\033[0m 在“${STEP}”这一步出错了（第 ${LINENO} 行）。把上面的输出整段复制给 Claude。"' ERR

log()  { echo -e "\033[1;34m==>\033[0m $*"; }
ok()   { echo -e "\033[1;32m  ✓\033[0m $*"; }
warn() { echo -e "\033[1;33m  !\033[0m $*"; }

# ---------------------------------------------------------------------------
# 写入项目文件（也可单独运行：bash setup.sh --write-only <目录>，只生成文件不安装）
# ---------------------------------------------------------------------------
write_files() {
  local dir="$1"
  mkdir -p "$dir"/{nginx,web,api,db/init,scripts,backups,data}

  # 已经部署了正式网站（有 api/Dockerfile）时，不再写占位文件，免得覆盖网站
  if [[ ! -f "$dir/api/Dockerfile" ]]; then

  # ---- docker-compose.yml -------------------------------------------------
  cat > "$dir/docker-compose.yml" <<'EOF'
# 长难句拆解台 · 服务编排
# 现在的 api 和 web 是占位服务，用来验证服务器环境；网站代码写好后替换。
name: sentence-site

services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      TZ: Asia/Shanghai
    volumes:
      - ./data/postgres:/var/lib/postgresql/data
      - ./db/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 5s
      retries: 12
    # 数据库端口不对外开放，只在内部网络里给 api 用

  api:
    image: node:22-alpine
    restart: unless-stopped
    working_dir: /app
    command: ["node", "server.js"]
    env_file: .env
    environment:
      DB_HOST: db
      PORT: "3000"
      TZ: Asia/Shanghai
    volumes:
      - ./api:/app:ro
    depends_on:
      db:
        condition: service_healthy

  web:
    image: nginx:1.27-alpine
    restart: unless-stopped
    ports:
      - "${WEB_PORT:-80}:80"   # 对外端口在 .env 的 WEB_PORT 里改
    volumes:
      - ./nginx/default.conf:/etc/nginx/conf.d/default.conf:ro
      - ./web:/usr/share/nginx/html:ro
    depends_on:
      - api
EOF

  # ---- Nginx ----------------------------------------------------------------
  cat > "$dir/nginx/default.conf" <<'EOF'
# 现在只开 HTTP（80 端口）。ICP 备案通过、绑定域名后，再加 HTTPS（443）配置。
server {
    listen 80 default_server;
    server_name _;

    client_max_body_size 1m;
    root  /usr/share/nginx/html;
    index index.html;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy same-origin always;

    location /api/ {
        proxy_pass         http://api:3000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;   # AI 批改可能要几十秒
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
EOF

  # ---- 占位后端：只做健康检查，不依赖任何 npm 包 --------------------------
  cat > "$dir/api/server.js" <<'EOF'
// 占位后端：确认 Nginx → Node → PostgreSQL 这条链路是通的。网站后端写好后替换掉。
const http = require('http');
const net = require('net');

const PORT = Number(process.env.PORT || 3000);
const DB_HOST = process.env.DB_HOST || 'db';

function checkDb() {
  return new Promise((resolve) => {
    const socket = net.connect(5432, DB_HOST);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2000);
    socket.on('connect', () => { clearTimeout(timer); socket.end(); resolve(true); });
    socket.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

http.createServer(async (req, res) => {
  if (req.url === '/api/health') {
    const db = await checkDb();
    res.writeHead(db ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: db, db, node: process.version, time: new Date().toISOString() }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not found' }));
}).listen(PORT, () => console.log(`placeholder api listening on ${PORT}`));
EOF

  # ---- 占位首页 -------------------------------------------------------------
  cat > "$dir/web/index.html" <<'EOF'
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>长难句拆解台 · 服务器检查</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
         background: #eaeef4; color: #18202d; }
  main { background: #fff; border: 1px solid #d3dae4; border-radius: 16px;
         padding: 28px 32px; max-width: 420px; margin: 16px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p  { margin: 6px 0; color: #596476; }
  b.ok { color: #1d8248; } b.bad { color: #c42f3c; }
</style>
</head>
<body>
<main>
  <h1>长难句拆解台</h1>
  <p>服务器已经搭好，网站代码还没部署。</p>
  <p>后端和数据库：<b id="s">检查中…</b></p>
</main>
<script>
  fetch('/api/health').then(r => r.json()).then(d => {
    const s = document.getElementById('s');
    s.textContent = d.ok ? '正常' : '数据库连不上';
    s.className = d.ok ? 'ok' : 'bad';
  }).catch(() => {
    const s = document.getElementById('s');
    s.textContent = '后端没有响应'; s.className = 'bad';
  });
</script>
</body>
</html>
EOF

  # ---- 数据库建表（只在数据库第一次初始化时执行）----------------------------
  cat > "$dir/db/init/01-schema.sql" <<'EOF'
-- 长难句拆解台 · 自用版数据表（与计划文档“数据模型”一节一致）

CREATE TABLE IF NOT EXISTS sentences (
  id         text PRIMARY KEY,              -- 沿用 s-20261013-01 这种格式
  created_at timestamptz NOT NULL DEFAULT now(),
  batch      date NOT NULL,
  source     text NOT NULL CHECK (source IN ('seed','daily','manual')),
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
EOF

  fi

  # ---- 每日备份脚本 ---------------------------------------------------------
  cat > "$dir/scripts/backup.sh" <<'EOF'
#!/usr/bin/env bash
# 每天凌晨 3:30 由 cron 调用：导出数据库，保留最近 30 天。
set -euo pipefail
cd /opt/sentence-site
set -a; . ./.env; set +a
ts=$(date +%Y%m%d-%H%M)
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" | gzip > "backups/db-$ts.sql.gz"
find backups -name 'db-*.sql.gz' -mtime +30 -delete
echo "$(date '+%F %T') backup ok: backups/db-$ts.sql.gz"
# 以后接腾讯云 COS 时，在这里加一行上传，例如：
# coscli cp "backups/db-$ts.sql.gz" "cos://<你的存储桶>/backups/"
EOF
  chmod +x "$dir/scripts/backup.sh"

  # ---- .env：只在第一次生成，之后不覆盖 ------------------------------------
  if [[ ! -f "$dir/.env" ]]; then
    local db_pass cookie access
    db_pass=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-32)
    cookie=$(openssl rand -hex 32)
    access=$(openssl rand -base64 48 | tr -dc 'a-km-np-z2-9' | cut -c1-10)
    cat > "$dir/.env" <<EOF
# 长难句拆解台 · 环境变量（不要提交到 Git，不要发给别人）

# 数据库
POSTGRES_DB=sentence
POSTGRES_USER=sentence
POSTGRES_PASSWORD=${db_pass}

# 访问密码：打开网站时输入的密码，想改就改这里，然后重启服务
ACCESS_PASSWORD=${access}
COOKIE_SECRET=${cookie}

# 国内大模型（选定模型后再填）
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL_MAIN=
LLM_MODEL_LIGHT=

# 每日上限
DAILY_GRADE_LIMIT=100
DAILY_LOOKUP_LIMIT=300
EOF
    chmod 600 "$dir/.env"
    ENV_CREATED=1
  else
    ENV_CREATED=0
  fi
}

# 只生成文件（用来在自己电脑上检查），不安装任何东西
if [[ "${1:-}" == "--write-only" ]]; then
  write_files "${2:?用法：bash setup.sh --write-only <目录>}"
  echo "文件已写入 ${2}"
  exit 0
fi

# ---------------------------------------------------------------------------
# 0. 基本检查
# ---------------------------------------------------------------------------
STEP="基本检查"
if [[ $EUID -ne 0 ]]; then
  echo "请用 root 运行：sudo bash setup.sh"; exit 1
fi
. /etc/os-release
OS_ID="${ID:-unknown}"; OS_VER="${VERSION_ID:-}"
log "系统：${PRETTY_NAME:-$OS_ID}"

if command -v apt-get >/dev/null 2>&1; then PKG=apt
elif command -v dnf >/dev/null 2>&1; then PKG=dnf
elif command -v yum >/dev/null 2>&1; then PKG=yum
else echo "不认识这个系统的包管理器，建议把服务器重装成 Ubuntu 22.04 或 24.04。"; exit 1
fi

# ---------------------------------------------------------------------------
# 1. 基础工具、时区、swap
# ---------------------------------------------------------------------------
STEP="安装基础工具"
log "安装基础工具"
if [[ $PKG == apt ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg openssl cron >/dev/null
  systemctl enable --now cron >/dev/null 2>&1 || true
else
  $PKG install -y -q curl ca-certificates openssl cronie >/dev/null
  systemctl enable --now crond >/dev/null 2>&1 || true
fi
ok "完成"

STEP="设置时区"
timedatectl set-timezone Asia/Shanghai 2>/dev/null || ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime
ok "时区：Asia/Shanghai"

STEP="设置 swap"
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [[ $MEM_MB -lt 3000 ]] && [[ -z "$(swapon --show --noheadings 2>/dev/null)" ]]; then
  log "内存 ${MEM_MB}MB，添加 2G swap"
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "swap 已添加"
else
  ok "内存 ${MEM_MB}MB，swap 无需调整"
fi

# ---------------------------------------------------------------------------
# 2. Docker
# ---------------------------------------------------------------------------
STEP="安装 Docker"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "Docker 已安装，跳过"
else
  log "安装 Docker（腾讯云镜像源）"
  if [[ $PKG == apt ]]; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "$DOCKER_MIRROR/linux/$OS_ID/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] $DOCKER_MIRROR/linux/$OS_ID ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  else
    curl -fsSL "$DOCKER_MIRROR/linux/centos/docker-ce.repo" -o /etc/yum.repos.d/docker-ce.repo
    sed -i "s+https://download.docker.com+$DOCKER_MIRROR+g" /etc/yum.repos.d/docker-ce.repo
    # OpenCloudOS / TencentOS 等兼容系统，把版本号换成对应的 CentOS 大版本
    case "$OS_ID" in
      centos|rhel|rocky|almalinux) ;;
      *)
        major="${OS_VER%%.*}"
        case "$OS_ID:$major" in
          tencentos:2) rv=7 ;; tencentos:3) rv=8 ;; tencentos:4) rv=9 ;;
          opencloudos:8) rv=8 ;; *) rv=9 ;;
        esac
        sed -i "s/\$releasever/$rv/g" /etc/yum.repos.d/docker-ce.repo
        ;;
    esac
    $PKG install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
  fi
  systemctl enable --now docker >/dev/null
  ok "Docker 安装完成"
fi

STEP="配置镜像加速"
if [[ ! -f /etc/docker/daemon.json ]]; then
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<EOF
{
  "registry-mirrors": ["$REGISTRY_MIRROR"],
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
  systemctl restart docker
  ok "已配置腾讯云镜像加速"
else
  warn "/etc/docker/daemon.json 已存在，没有改动它"
fi

# ---------------------------------------------------------------------------
# 3. 项目文件
# ---------------------------------------------------------------------------
STEP="生成项目文件"
log "生成项目文件：$APP_DIR"
write_files "$APP_DIR"
if [[ $ENV_CREATED == 1 ]]; then ok ".env 已生成（含随机密码）"; else ok ".env 已存在，保持不变"; fi

STEP="设置每日备份"
echo "30 3 * * * root $APP_DIR/scripts/backup.sh >> /var/log/sentence-backup.log 2>&1" > /etc/cron.d/sentence-site-backup
chmod 644 /etc/cron.d/sentence-site-backup
ok "每天 3:30 自动备份数据库"

# ---------------------------------------------------------------------------
# 4. 启动服务
# ---------------------------------------------------------------------------
STEP="拉取镜像"
cd "$APP_DIR"
log "拉取镜像（第一次可能要几分钟）"
docker compose pull -q --ignore-buildable
ok "镜像就绪"

STEP="选择对外端口"
# 先停掉自己的 web 容器（如果在跑），再看端口有没有被别的程序占用
docker compose stop web >/dev/null 2>&1 || true
port_busy() { ss -ltn "sport = :$1" 2>/dev/null | tail -n +2 | grep -q .; }
PORT80_OWNER=$(ss -ltnp "sport = :80" 2>/dev/null | tail -n +2 | grep -o 'users:(("[^"]*"' | head -n1 | cut -d'"' -f2 || true)
WEB_PORT=$(grep '^WEB_PORT=' .env | cut -d= -f2- || true)
if [[ -z "$WEB_PORT" ]]; then
  WEB_PORT=80
  if port_busy 80; then
    for p in 8080 8081 8088 8090; do
      if ! port_busy "$p"; then WEB_PORT=$p; break; fi
    done
    warn "80 端口已被 ${PORT80_OWNER:-其他程序} 占用，改用 ${WEB_PORT} 端口（没有动原来的程序）"
  fi
  printf '\n# 网站对外端口\nWEB_PORT=%s\n' "$WEB_PORT" >> .env
elif port_busy "$WEB_PORT"; then
  echo "WEB_PORT=${WEB_PORT} 已被其他程序占用。请在 $APP_DIR/.env 里换一个端口后重新运行。"; exit 1
fi
ok "网站端口：${WEB_PORT}"

STEP="启动服务"
log "启动服务"
docker compose up -d --build --remove-orphans
HEALTH="未通过"
for _ in $(seq 1 30); do
  resp=$(curl -fsS --max-time 3 "http://127.0.0.1:${WEB_PORT}/api/health" 2>/dev/null || true)
  if [[ $resp == *'"ok":true'* ]]; then
    HEALTH="通过"; break
  fi
  sleep 2
done
if [[ $HEALTH == "通过" ]]; then ok "健康检查通过"; else warn "健康检查没通过，见下方报告"; fi

# ---------------------------------------------------------------------------
# 5. 报告
# ---------------------------------------------------------------------------
STEP="生成报告"
PUBLIC_IP=$(curl -s --max-time 3 http://metadata.tencentyun.com/latest/meta-data/public-ipv4 || true)
ACCESS_PW=$(grep '^ACCESS_PASSWORD=' "$APP_DIR/.env" | cut -d= -f2-)

echo
echo "================= 把这一段整段复制发给 Claude ================="
echo "系统:     ${PRETTY_NAME:-$OS_ID} ($(uname -m))"
echo "内存:     ${MEM_MB}MB   swap: $(swapon --show --noheadings | awk '{print $3}' | head -n1)"
echo "磁盘:     $(df -h / | awk 'NR==2 {print $4 " 可用 / 共 " $2}')"
echo "Docker:   $(docker --version)"
echo "Compose:  $(docker compose version --short)"
echo "公网 IP:  ${PUBLIC_IP:-未取到}"
echo "网站端口: ${WEB_PORT}"
echo "80 端口:  ${PORT80_OWNER:-空闲}"
echo "健康检查: ${HEALTH}"
echo "--- 容器状态 ---"
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
if [[ $HEALTH != "通过" ]]; then
  echo "--- 最近日志 ---"
  docker compose logs --tail 20 --no-color
fi
echo "================================================================"
echo
echo "访问密码（之后打开网站要用，自己记下来，不用发给 Claude）：${ACCESS_PW}"
SITE_URL="http://${PUBLIC_IP:-服务器公网IP}"
[[ "$WEB_PORT" != 80 ]] && SITE_URL="${SITE_URL}:${WEB_PORT}"
echo "用浏览器打开 ${SITE_URL} ，看到“后端和数据库：正常”就说明搭好了。"
echo "打不开的话，到腾讯云控制台 → 这台服务器 → 防火墙，确认放行了 TCP ${WEB_PORT} 端口。"
