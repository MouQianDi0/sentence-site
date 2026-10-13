#!/usr/bin/env bash
# 从 GitHub 拉最新代码并重新部署；新版本启动失败会自动退回上一个版本。
#   立即更新：  sudo sentence-update            （等同于 sudo bash /opt/sentence-site/scripts/update.sh）
#   定时任务用：sudo sentence-update --if-changed   （没有新代码就什么都不做）
# 只会改动仓库里的文件，.env、data/（数据库）和 backups/ 不会动。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${BRANCH:-main}"
cd "$DIR"

log() { echo "[$(date '+%F %T')] $*"; }
die() { log "失败：$*"; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 sudo 运行"
[[ -d .git ]] || die "$DIR 还没接到 GitHub 仓库，先运行 README 里“接入 GitHub 自动更新”的命令"
[[ -f .env ]] || die "找不到 .env"

# 同一时间只跑一个更新（定时任务和手动更新撞在一起时）
exec 9>/var/lock/sentence-site-update.lock
flock -n 9 || { log "已经有一个更新正在运行，这次跳过"; exit 0; }

git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$DIR" || git config --global --add safe.directory "$DIR"

# 拉代码：GitHub 在国内偶尔连不上，最多试 3 次
fetched=0
for i in 1 2 3; do
  if timeout 120 git fetch -q --depth 1 origin "$BRANCH"; then fetched=1; break; fi
  log "第 $i 次连接 GitHub 失败，10 秒后重试"
  sleep 10
done
[[ $fetched -eq 1 ]] || die "连不上 GitHub，网站保持原样，下次再试"

old="$(git rev-parse -q --verify HEAD || echo none)"
new="$(git rev-parse FETCH_HEAD)"
failed_file=.git/sentence-failed-commit
if [[ "${1:-}" == "--if-changed" ]]; then
  if [[ "$old" == "$new" ]]; then
    log "没有新代码（${new:0:7}）"
    exit 0
  fi
  # 上次启动失败、已经退回的版本，定时任务不再反复尝试；手动更新会再试
  if [[ -f $failed_file && "$(cat "$failed_file")" == "$new" ]]; then
    log "${new:0:7} 上次没能正常启动，等新的代码再更新（手动更新可以强制重试）"
    exit 0
  fi
fi

port="$(grep -E '^WEB_PORT=' .env | tail -1 | cut -d= -f2 | tr -d '[:space:]"'"'"'')"
port="${port:-80}"

healthy() {
  for _ in $(seq 1 "${HEALTH_TRIES:-30}"); do
    curl -fsS -m 5 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1 && return 0
    sleep 3
  done
  return 1
}

deploy() {
  git reset -q --hard "$1"
  docker compose up -d --build --remove-orphans && healthy
}

log "更新 ${old:0:7} → ${new:0:7}：$(git log -1 --format=%s FETCH_HEAD)"
if deploy "$new"; then
  rm -f "$failed_file"
  docker image prune -f >/dev/null 2>&1 || true
  log "更新完成，网站正常运行（端口 ${port}）"
  exit 0
fi

if [[ "$old" == "none" ]]; then
  die "新版本没有正常启动，看看日志：sudo docker compose logs --tail 50 api"
fi
echo "$new" > "$failed_file"
log "新版本没有正常启动，退回 ${old:0:7}"
if deploy "$old"; then
  die "已退回上一个版本，网站正常运行。新版本的问题看日志：sudo docker compose logs --tail 50 api"
fi
die "退回后网站也没起来，看日志：sudo docker compose logs --tail 50 api"
