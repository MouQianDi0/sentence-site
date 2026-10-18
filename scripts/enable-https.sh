#!/usr/bin/env bash
# 给网站加 HTTPS。用服务器上已有的 Nginx 接住 HTTPS 端口（默认 8443），证书来自 Let's Encrypt（acme.sh 申请、自动续期）。
#
#   sudo bash scripts/enable-https.sh                    用服务器的公网 IP：https://公网IP:8443
#                                                        （Let's Encrypt 的 IP 证书，每张 6 天有效，每 3 天自动续一次）
#   sudo bash scripts/enable-https.sh --port 8444        换一个 HTTPS 端口（记在 .env 的 HTTPS_PORT 里，以后重新运行沿用）
#   sudo bash scripts/enable-https.sh --port 443         用标准端口，网址里就不用写端口了
#   sudo bash scripts/enable-https.sh cet.example.com    以后有了备案好的域名（普通证书，90 天有效，自动续期）
#   sudo bash scripts/enable-https.sh --off              撤掉 HTTPS，回到原来的 http://公网IP:8080
#
# 做的事：
#   1. 在服务器的 Nginx 里加一份配置（/etc/nginx/conf.d/sentence-site.conf），只管这个 IP / 域名，不动原来的网站
#   2. 用 acme.sh 申请证书（HTTP 验证，固定走 80 端口，所以 80 要一直开着），装好每天检查一次的自动续期
#   3. 网站容器改成只在本机 8081 端口监听，外面只能走 https；以前的 http://IP:8080、用 http:// 打开 HTTPS 端口，都会跳到 https
#      用 IP 时，只输 IP 不加端口（http://IP）不跳转，照旧是服务器上原来的网站：80 端口平时不放这个网站的配置，
#      只在 acme.sh 申请或续期证书的那几秒，通过它的 pre-hook / post-hook 临时加上验证文件的路径，用完就删
#      用域名时，http://域名 跳到 https
#   4. .env 里打开 COOKIE_SECURE（登录状态只通过 HTTPS 传输）
# 可以重复运行：证书还没到续期时间就不会重新申请；换端口不用重新申请证书。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSL_DIR=/etc/nginx/ssl/sentence-site
WEBROOT=/var/www/acme
ACME_HOME=/root/.acme.sh
INNER_PORT="${INNER_PORT:-8081}" # 网站容器改成只在本机监听的端口
DEFAULT_PORT=8443                # 没指定时 HTTPS 用的端口：不和服务器上原来网站的 443 抢
HOOK=$SSL_DIR/acme-hook.sh       # 用 IP 时：申请 / 续期证书前后临时打开、关掉 80 端口的验证路径

log() { echo "[https] $*"; }
die() { echo "[https] 失败：$*" >&2; exit 1; }

# 网址里的端口：443 不用写
port_suffix() { [[ $1 == 443 ]] || printf ':%s' "$1"; }
is_ipv4() { [[ $1 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }

# Nginx 1.25.1 起 HTTP/2 改成单独的 http2 指令，listen 里写 http2 会报“已弃用”；更老的版本只认 listen 里的写法
H2_LISTEN=" http2" H2_LINE=""
if command -v nginx >/dev/null; then
  v=$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)
  if [[ -n $v && $(printf '%s\n' 1.25.1 "$v" | sort -V | head -n1) == 1.25.1 ]]; then
    H2_LISTEN="" H2_LINE=$'\n    http2 on;'
  fi
fi

# ---- 生成服务器 Nginx 的配置 -----------------------------------------------------
# $1 地址（IP 或域名）  $2 HTTPS 端口  $3 网站容器的本机端口
# $4 以前对外的端口（访问它跳到 https，可以为空）  $5 HTTPS 端口上是否加 default_server
# 用 IP 时不写 80 端口：http://IP 留给服务器上原来的网站（续期证书时由 acme-hook.sh 临时加验证路径）
render_https() {
  local host=$1 port=$2 inner=$3 old=${4:-} def=${5:-}
  local url
  url="https://${host}$(port_suffix "$port")"
  cat <<CONF
# 长难句拆解台 · HTTPS（scripts/enable-https.sh 生成，重新运行脚本会覆盖，不要手改）
# 只管 ${host} 这个地址，服务器上原来的网站不受影响
CONF
  if is_ipv4 "$host"; then
    cat <<CONF
# http://${host}（80 端口）不在这里：照旧是服务器上原来的网站。
# 申请 / 续期证书时，acme.sh 会运行 ${HOOK} 临时加上验证文件的路径，用完就删。
CONF
  else
    cat <<CONF

server {
    listen 80;
    server_name ${host};

    # Let's Encrypt 验证和续期证书用的，要一直能访问
    location /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type text/plain;
    }

    location / {
        return 301 ${url}\$request_uri;
    }
}
CONF
  fi
  if [[ -n $old && $old != "$port" ]]; then
    cat <<CONF

# 以前的地址 http://${host}:${old} 也跳到 https
server {
    listen ${old};
    server_name ${host};
    return 301 ${url}\$request_uri;
}
CONF
  fi
  cat <<CONF

server {
    listen ${port} ssl${H2_LISTEN}${def:+ default_server};
    server_name ${host};${H2_LINE}

    # 用 http:// 打开这个端口时，跳到 https://
    error_page 497 =301 ${url}\$request_uri;

    ssl_certificate     ${SSL_DIR}/fullchain.pem;
    ssl_certificate_key ${SSL_DIR}/key.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:sentence_site_ssl:10m;
    ssl_session_timeout 1d;

    client_max_body_size 1m;

    location / {
        proxy_pass         http://127.0.0.1:${inner};
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto https;
        proxy_read_timeout 300s;   # AI 出题可能要一两分钟
        proxy_send_timeout 300s;
    }
}
CONF
}

# 用域名、还没有证书时：80 端口先只放验证文件，其他请求照常转给网站（用 IP 时改用 render_hook 的临时配置）
render_http() {
  local host=$1 inner=$2
  cat <<CONF
# 长难句拆解台 · 申请证书中（scripts/enable-https.sh 生成）
server {
    listen 80;
    server_name ${host};

    location /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type text/plain;
    }

    location / {
        proxy_pass       http://127.0.0.1:${inner};
        proxy_set_header Host      \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}
CONF
}

# 用 IP 时的钩子脚本：acme.sh 申请 / 续期证书前运行“on”，申请完（成功失败都会）运行“off”
# $1 IP  $2 临时配置的路径（和主配置同一个目录）
render_hook() {
  local host=$1 conf=$2
  cat <<HOOK
#!/usr/bin/env bash
# 长难句拆解台 · 申请 / 续期证书时临时打开 80 端口的验证路径（scripts/enable-https.sh 生成，重新运行会覆盖）
# acme.sh 申请证书前运行 "on"，申请完（成功或失败）运行 "off"。平时 http://${host} 照旧是服务器上原来的网站。
set -u
CONF='${conf}'
case \${1:-} in
  on)
    cat > "\$CONF" <<'CONF'
# 长难句拆解台 · 申请 / 续期证书中，只放 Let's Encrypt 的验证文件（${HOOK} 生成，申请完自动删掉）
server {
    listen 80;
    server_name ${host};

    location /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type text/plain;
    }

    location / {
        return 404;
    }
}
CONF
    ;;
  off) rm -f "\$CONF" ;;
  *) echo "用法：\$0 on|off" >&2; exit 2 ;;
esac
if ! nginx -t >/dev/null 2>&1; then
  nginx -t
  [ "\$1" = on ] && rm -f "\$CONF"
  exit 1
fi
systemctl reload nginx
# reload 不等新配置生效就返回，等一下再让 Let's Encrypt 来取验证文件
sleep 2
HOOK
}

# 只看会生成什么配置，不动服务器：--render 地址 HTTPS端口 本机端口 [以前的端口] [default]
if [[ ${1:-} == --render ]]; then
  render_https "${2:?地址}" "${3:-$DEFAULT_PORT}" "${4:-$INNER_PORT}" "${5:-}" "${6:-}"
  exit 0
fi

OFF="" HOST_ARG="" PORT_ARG=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --off) OFF=1 ;;
    --port) PORT_ARG=${2:-}; shift ;;
    --port=*) PORT_ARG=${1#--port=} ;;
    -h | --help) sed -n '2,17p' "$0"; exit 0 ;;
    -*) die "不认识的参数：$1（用法见 bash scripts/enable-https.sh --help）" ;;
    *) HOST_ARG=$1 ;;
  esac
  shift
done

# ---- 工具 ----------------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "请用 sudo 运行"
cd "$DIR"
[[ -f .env ]] || die "找不到 $DIR/.env"

env_get() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | tr -d '[:space:]"'"'" || true; }
env_set() {
  if grep -qE "^$1=" .env; then sed -i -E "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
port_owner() { ss -ltnp "sport = :$1" 2>/dev/null | tail -n +2 | grep -o 'users:(("[^"]*"' | head -n1 | cut -d'"' -f2 || true; }

reload_nginx() {
  nginx -t >/dev/null 2>&1 || { nginx -t || true; return 1; }
  systemctl reload nginx
  # reload 不等新配置生效就返回，旧的 Nginx 进程还会再接一会儿请求（按旧配置回应），等一下
  sleep 2
}

# 给一个没人占着的端口当建议
free_port() {
  local p
  for p in 8443 8444 10443 18443 28443; do
    [[ $p == "${1:-}" ]] && continue
    [[ -z $(port_owner "$p") ]] && { echo "$p"; return; }
  done
  echo 18443
}

# acme.sh 给这张证书记下的 pre-hook（它存的是 base64，带前后标记；读法和 acme.sh 自己的 _read_conf 一样）
saved_pre_hook() {
  local f="$ACME_HOME/${HOST}_ecc/${HOST}.conf" v
  [[ -f $f ]] || return 0
  v=$(grep -E '^Le_PreHook=' "$f" | tail -n1 | cut -d= -f2-)
  v=${v#\'} v=${v%\'}
  if [[ $v == __ACME_BASE64__START_*__ACME_BASE64__END_ ]]; then
    v=${v#__ACME_BASE64__START_} v=${v%__ACME_BASE64__END_}
    v=$(printf '%s' "$v" | openssl base64 -d -A 2>/dev/null || true)
  fi
  printf '%s' "$v"
}

wait_healthy() {
  for _ in $(seq 1 40); do
    curl -fsS -m 5 "http://127.0.0.1:$1/api/health" >/dev/null 2>&1 && return 0
    sleep 3
  done
  return 1
}

# 服务器 Nginx 读哪个目录的配置
conf_path() {
  local dump
  dump=$(nginx -T 2>/dev/null || true)
  # 只认没被注释掉的 include
  if grep -qE '^\s*include\s+/etc/nginx/conf\.d/\*\.conf' <<<"$dump"; then
    echo /etc/nginx/conf.d/sentence-site.conf
  elif grep -qE '^\s*include\s+/etc/nginx/sites-enabled/' <<<"$dump"; then
    echo /etc/nginx/sites-enabled/sentence-site.conf
  else
    echo ""
  fi
}

# ---- 撤掉 HTTPS --------------------------------------------------------------------
if [[ -n $OFF ]]; then
  CONF=$(conf_path)
  host=$(env_get HTTPS_HOST)
  old=$(env_get HTTPS_OLD_PORT)
  [[ -n $CONF ]] && rm -f "${CONF%/*}/sentence-site-acme.conf"
  [[ -n $CONF && -f $CONF ]] && rm -f "$CONF" && reload_nginx && log "已删除服务器 Nginx 里的 HTTPS 配置"
  rm -f "$HOOK"
  if [[ -n $host && -x $ACME_HOME/acme.sh ]]; then
    "$ACME_HOME/acme.sh" --home "$ACME_HOME" --remove -d "$host" --ecc >/dev/null 2>&1 || true
    log "已停止 $host 的证书续期"
  fi
  env_set WEB_BIND 0.0.0.0
  env_set WEB_PORT "${old:-8080}"
  env_set COOKIE_SECURE 0
  docker compose up -d >/dev/null
  wait_healthy "${old:-8080}" || die "网站没有正常启动，看日志：sudo docker compose logs --tail 50"
  log "已撤掉 HTTPS，网站回到 http://${host:-公网IP}:${old:-8080}"
  exit 0
fi

# ---- 检查 ----------------------------------------------------------------------
command -v nginx >/dev/null && systemctl is-active --quiet nginx \
  || die "服务器上没有在运行的 Nginx（这个脚本用它来做 HTTPS）"
grep -q 'WEB_BIND' docker-compose.yml || die "代码还是旧的，先运行 sudo sentence-update 更新"
command -v docker >/dev/null || die "没有 Docker"
CONF=$(conf_path)
[[ -n $CONF ]] || die "认不出服务器 Nginx 的配置目录（既没有 conf.d 也没有 sites-enabled），请把 nginx -T 的前 30 行发给 Claude"
ACME_CONF="${CONF%/*}/sentence-site-acme.conf" # 用 IP 时，申请 / 续期证书那几秒的临时配置

# Nginx 里除了这个脚本自己写的两份配置以外的内容
other_confs() {
  nginx -T 2>/dev/null | awk -v me="$CONF" -v tmp="$ACME_CONF" \
    '/^# configuration file /{f=$4; sub(":$","",f)} f!=me && f!=tmp'
}

HOST=$HOST_ARG
if [[ -z $HOST ]]; then
  HOST=$(curl -s -m 3 http://metadata.tencentyun.com/latest/meta-data/public-ipv4 || true)
  [[ -n $HOST ]] || HOST=$(env_get HTTPS_HOST)
fi
[[ -n $HOST ]] || die "取不到公网 IP，请写在命令后面：sudo bash scripts/enable-https.sh 公网IP"
HOST=${HOST,,}
if is_ipv4 "$HOST"; then MODE=ip; else MODE=domain; fi
[[ $MODE == ip || $HOST =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "“$HOST”不像 IP 也不像域名"

CUR_PORT=$(env_get WEB_PORT)
CUR_PORT=${CUR_PORT:-80}
CUR_BIND=$(env_get WEB_BIND)
# 以前对外的端口（第一次运行时就是现在的 WEB_PORT）：以后访问它跳到 https
OLD_PORT=$(env_get HTTPS_OLD_PORT)
if [[ -z $OLD_PORT ]]; then
  if [[ $CUR_BIND == 127.0.0.1 ]]; then OLD_PORT=""; else OLD_PORT=$CUR_PORT; fi
fi
[[ $OLD_PORT == 80 || $OLD_PORT == 443 || $OLD_PORT == "$INNER_PORT" ]] && OLD_PORT=""

# HTTPS 端口：命令里的 --port，没写就沿用上次的（.env 的 HTTPS_PORT），都没有用 8443
PORT=${PORT_ARG:-$(env_get HTTPS_PORT)}
PORT=${PORT:-$DEFAULT_PORT}
[[ $PORT =~ ^[0-9]{1,5}$ ]] && ((PORT >= 1 && PORT <= 65535)) || die "端口“$PORT”不对，要写 1–65535 的数字"
[[ $PORT == 80 ]] && die "HTTPS 不能用 80 端口（80 要留给证书验证和跳转）"
[[ $PORT == "$INNER_PORT" ]] && die "HTTPS 端口不能和网站容器的本机端口 $INNER_PORT 一样"

ownerPort=$(port_owner "$PORT")
if [[ -n $ownerPort && $ownerPort != nginx ]]; then
  if [[ $ownerPort == docker-proxy && $PORT == "$CUR_PORT" && $CUR_BIND != 127.0.0.1 ]]; then
    : # 网站容器现在正在这个端口对外（比如 --port 8080）：下面会把它挪到本机 $INNER_PORT，端口就空出来了
  elif [[ -z $PORT_ARG && -z $(env_get HTTPS_PORT) ]]; then
    alt=$(free_port "$PORT")
    log "$PORT 端口被 $ownerPort 占着，改用 $alt"
    PORT=$alt
  else
    die "$PORT 端口被 $ownerPort 占用了，换一个：sudo bash scripts/enable-https.sh --port $(free_port "$PORT")"
  fi
fi
URL="https://$HOST$(port_suffix "$PORT")"
ownerInner=$(port_owner "$INNER_PORT")
[[ -z $ownerInner || $ownerInner == docker-proxy || $CUR_PORT == "$INNER_PORT" ]] \
  || die "$INNER_PORT 端口被 $ownerInner 占用了，换一个：sudo INNER_PORT=8082 bash scripts/enable-https.sh"

# IP 访问时浏览器不发送域名（SNI），服务器 Nginx 只会拿这个端口的“默认网站”的证书出来，
# 所以这里要是这个端口的默认网站。别的配置已经占了默认网站时没法两全，停下来说明。
# （默认的 8443 一般没有别的网站在用，不会碰到这种情况）
DEFAULT_SERVER=""
others=$(other_confs | grep -E "^\s*listen\s+(\S*:)?${PORT}([ ;]|$)" || true)
if [[ $MODE == ip && -n $others ]]; then
  if grep -q default_server <<<"$others"; then
    die "服务器 Nginx 里已经有别的网站是 $PORT 端口的默认网站，IP 证书没法和它共存。换个端口：sudo bash scripts/enable-https.sh --port $(free_port "$PORT")"
  fi
  DEFAULT_SERVER=1
fi
if other_confs | grep -E "^\s*server_name\s" | grep -w -- "$HOST" >/dev/null; then
  die "服务器 Nginx 里已经有别的配置用了 $HOST，先看看 sudo nginx -T | grep -n $HOST"
fi

log "地址：$URL（$([[ $MODE == ip ]] && echo 'IP 证书，6 天有效，每 3 天自动续' || echo '域名证书，90 天有效，自动续期')）"

# ---- 1. 先让 80 端口能放验证文件 ----------------------------------------------------
mkdir -p "$WEBROOT/.well-known/acme-challenge" "$SSL_DIR"
chmod 755 "$WEBROOT" "$WEBROOT/.well-known" "$WEBROOT/.well-known/acme-challenge"
backup=""
[[ -f $CONF ]] && backup=$(mktemp) && cp "$CONF" "$backup"
restore() {
  if [[ -n $backup ]]; then cp "$backup" "$CONF"; else rm -f "$CONF"; fi
  rm -f "$ACME_CONF"
  reload_nginx || true
}

if [[ $MODE == ip ]]; then
  # 用 IP：80 端口平时留给原来的网站，只在申请证书时由钩子临时加上验证路径（续期时 acme.sh 自己调用）
  render_hook "$HOST" "$ACME_CONF" > "$HOOK"
  chmod 700 "$HOOK"
  "$HOOK" on >/dev/null || { restore; die "Nginx 配置检查没通过，已经恢复原样（上面是 nginx -t 的输出）"; }
  READ_CONF=$ACME_CONF
else
  if [[ ! -s $SSL_DIR/fullchain.pem ]]; then
    render_http "$HOST" "$CUR_PORT" > "$CONF"
    reload_nginx || { restore; die "Nginx 配置检查没通过，已经恢复原样"; }
  fi
  READ_CONF=$CONF
fi
nginx -T 2>/dev/null | grep -qF "# configuration file $READ_CONF:" \
  || { restore; die "服务器 Nginx 没有读 $READ_CONF，请把 sudo nginx -T | head -40 的输出发给 Claude"; }

# 像 Let's Encrypt 那样从 80 端口取一个验证文件（多试几次，等 Nginx 换好配置）
token="sentence-site-check-$RANDOM$RANDOM"
echo "$token" > "$WEBROOT/.well-known/acme-challenge/$token"
got=""
for _ in 1 2 3 4 5; do
  got=$(curl -sS -m 5 -w '\n（HTTP %{http_code}）' -H "Host: $HOST" "http://127.0.0.1/.well-known/acme-challenge/$token" 2>&1 || true)
  [[ ${got%%$'\n'*} == "$token" ]] && break
  sleep 1
done
rm -f "$WEBROOT/.well-known/acme-challenge/$token"
if [[ ${got%%$'\n'*} != "$token" ]]; then
  restore
  echo "[https] 从 http://127.0.0.1/.well-known/acme-challenge/…（Host: $HOST）拿到的是：" >&2
  head -c 300 <<<"$got" >&2
  echo >&2
  die "80 端口上的验证文件访问不到，已经恢复原样。请把上面几行和 sudo nginx -T 的输出发给 Claude"
fi
log "80 端口的验证路径正常"

# ---- 2. 安装 acme.sh ---------------------------------------------------------------
ACME="$ACME_HOME/acme.sh"
if [[ ! -x $ACME ]]; then
  log "安装 acme.sh…"
  src=$(mktemp -d)
  git clone -q --depth 1 https://github.com/acmesh-official/acme.sh.git "$src" 2>/dev/null \
    || git clone -q --depth 1 https://gitee.com/neilpang/acme.sh.git "$src" \
    || die "下载 acme.sh 失败（GitHub 和 Gitee 都连不上），稍后再试"
  (cd "$src" && ./acme.sh --install --home "$ACME_HOME" ${HTTPS_EMAIL:+--accountemail "$HTTPS_EMAIL"} >/dev/null)
  rm -rf "$src"
else
  "$ACME" --home "$ACME_HOME" --upgrade >/dev/null 2>&1 || log "acme.sh 升级没成功，先用现在的版本"
fi
"$ACME" --home "$ACME_HOME" --set-default-ca --server letsencrypt >/dev/null

# ---- 3. 申请证书 -------------------------------------------------------------------
args=(--home "$ACME_HOME" --issue --server letsencrypt -d "$HOST" --webroot "$WEBROOT" --keylength ec-256)
# IP 证书只有短期的（160 小时），到第 3 天就续，留出几次失败重试的余地
if [[ $MODE == ip ]]; then
  args+=(--cert-profile shortlived --days 3 --pre-hook "$HOOK on" --post-hook "$HOOK off")
  # acme.sh 只在真的去申请时才把钩子记下来，证书没到期时直接跳过。以前申请的证书没记钩子（或者记的不是这个），
  # 续期时 80 端口上就没有验证路径了，所以强制重新申请一次，把钩子记进去
  if [[ $(saved_pre_hook) != "$HOOK on" && -s $SSL_DIR/fullchain.pem ]]; then
    log "证书的续期设置里还没有临时打开 80 端口的钩子，重新申请一次把它记上"
    args+=(--force)
  fi
fi
log "向 Let's Encrypt 申请证书…"
set +e
"$ACME" "${args[@]}"
rc=$?
set -e
# 用 IP 时，跳过申请（rc=2）不会运行 post-hook，这里自己关掉 80 端口的验证路径（已经关了再关一次也没事）
if [[ $MODE == ip ]]; then
  "$HOOK" off >/dev/null || log "关掉 80 端口的临时验证路径时 Nginx 配置检查没通过，看 sudo nginx -t"
fi
if [[ $rc -eq 2 ]]; then
  log "证书还没到续期时间，不用重新申请"
elif [[ $rc -ne 0 ]]; then
  [[ -s $SSL_DIR/fullchain.pem ]] || restore
  die "申请证书失败。最常见的原因：腾讯云防火墙没放行 TCP 80（Let's Encrypt 要从外网访问 http://$HOST/.well-known/…）。看上面的输出，或者把它发给 Claude"
fi

"$ACME" --home "$ACME_HOME" --install-cert -d "$HOST" --ecc \
  --key-file "$SSL_DIR/key.pem" \
  --fullchain-file "$SSL_DIR/fullchain.pem" \
  --reloadcmd "systemctl reload nginx" >/dev/null
chmod 600 "$SSL_DIR/key.pem"
log "证书已装好：$(openssl x509 -noout -enddate -in "$SSL_DIR/fullchain.pem" | cut -d= -f2) 到期，会自动续"

# ---- 4. 网站容器改成只在本机监听，打开 COOKIE_SECURE ------------------------------------
env_set HTTPS_HOST "$HOST"
env_set HTTPS_PORT "$PORT"
[[ -n $OLD_PORT ]] && env_set HTTPS_OLD_PORT "$OLD_PORT"
env_set WEB_BIND 127.0.0.1
env_set WEB_PORT "$INNER_PORT"
env_set COOKIE_SECURE 1
log "网站容器改到本机 $INNER_PORT 端口…"
docker compose up -d >/dev/null
wait_healthy "$INNER_PORT" || die "网站没有正常启动，看日志：sudo docker compose logs --tail 50"

# ---- 5. 打开 HTTPS -----------------------------------------------------------------
render_https "$HOST" "$PORT" "$INNER_PORT" "$OLD_PORT" "$DEFAULT_SERVER" > "$CONF"
if ! reload_nginx; then
  restore
  die "Nginx 配置检查没通过，已经恢复原样（网站暂时只能在服务器本机访问，运行 sudo bash scripts/enable-https.sh --off 可以回到 http）"
fi

# ---- 6. 检查 -----------------------------------------------------------------------
ok=""
for _ in 1 2 3 4 5; do
  curl -fsS -m 10 --connect-to "$HOST:$PORT:127.0.0.1:$PORT" "$URL/api/health" 2>/dev/null | grep -q '"db":true' && ok=1 && break
  sleep 1
done
[[ -n $ok ]] || die "HTTPS 检查没通过：curl -v --connect-to $HOST:$PORT:127.0.0.1:$PORT $URL/api/health"
log "HTTPS 检查通过，证书有效"
if [[ $MODE == ip ]]; then
  log "http://$HOST（不加端口）不跳转，照旧是服务器上原来的网站；续期证书时会临时打开验证路径"
else
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' -H "Host: $HOST" http://127.0.0.1/ || true)
  [[ $code == 301 ]] && log "http://$HOST 会跳到 $URL"
fi

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow 80/tcp >/dev/null && ufw allow "$PORT/tcp" >/dev/null && log "已在 ufw 防火墙放行 80、$PORT"
fi
crontab -l 2>/dev/null | grep -q acme.sh && log "自动续期：acme.sh 每天检查一次（crontab 里）"

OLD_NOTE=""
[[ -n $OLD_PORT && $OLD_PORT != "$PORT" ]] && OLD_NOTE="TCP $OLD_PORT 可以留着（旧链接会跳到 https），也可以关掉。"
cat <<DONE

================= HTTPS 已开启 =================
网址：    $URL
还要做：  腾讯云控制台 → 这台服务器 → 防火墙，放行 TCP $PORT；
          TCP 80 也要一直开着（申请和续期证书都只能走 80）；
          ${OLD_NOTE}
换端口：  sudo bash scripts/enable-https.sh --port 新端口
撤销：    sudo bash scripts/enable-https.sh --off
================================================
DONE
