#!/usr/bin/env bash
# 从 GitHub 拉最新代码并重新部署；新版本启动失败会自动退回上一个版本。
# 只部署 GitHub Actions 检查（代码检查、类型检查、测试、构建）通过的提交。
#   立即更新：  sudo sentence-update            （等同于 sudo bash /opt/sentence-site/scripts/update.sh）
#                                              检查还在跑时最多等 10 分钟；没通过就不部署
#   强制更新：  sudo sentence-update --force    （不看检查结果，出问题时临时用）
#   定时任务用：sudo sentence-update --if-changed   （没有新代码、或检查没通过 / 还没跑完时什么都不做）
# 只会改动仓库里的文件，.env、data/（数据库）和 backups/ 不会动。
# 部署新版本前先运行 scripts/backup.sh 备份数据库（新版本启动时会执行数据库迁移）。
set -euo pipefail

SCHEDULED=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --if-changed) SCHEDULED=1 ;;
    --force) FORCE=1 ;;
    *) echo "不认识的参数：$arg（可以用 --if-changed、--force）" >&2; exit 2 ;;
  esac
done

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
if [[ $SCHEDULED -eq 1 ]]; then
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

# ---- GitHub Actions 的检查结果 ------------------------------------------------
# 输出 success / failure / pending（还没跑完）/ unknown（连不上 GitHub 或解析不了）
ci_state() {
  local repo json
  repo="${GITHUB_REPO:-$(git config --get remote.origin.url | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')}"
  json="$(curl -fsS -m 20 -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/${repo}/commits/$1/check-runs?per_page=100" 2>/dev/null)" || { echo unknown; return; }
  command -v python3 >/dev/null 2>&1 || { echo unknown; return; }
  printf '%s' "$json" | python3 -c '
import json, sys
runs = json.load(sys.stdin).get("check_runs", [])
if not runs or any(r.get("status") != "completed" for r in runs):
    print("pending")
elif all(r.get("conclusion") in ("success", "skipped", "neutral") for r in runs):
    print("success")
else:
    print("failure")
' 2>/dev/null || echo unknown
}

if [[ $FORCE -eq 1 ]]; then
  log "加了 --force，不看 GitHub 上的检查结果"
else
  state="$(ci_state "$new")"
  if [[ $SCHEDULED -eq 0 && $state == pending ]]; then
    log "GitHub 上的检查还在跑，最多等 10 分钟…"
    for _ in $(seq 1 30); do
      sleep 20
      state="$(ci_state "$new")"
      [[ $state == pending ]] || break
    done
  fi
  case "$state" in
    success)
      log "GitHub 上的检查通过（${new:0:7}）"
      ;;
    failure)
      msg="${new:0:7} 没通过 GitHub 上的检查（代码检查、类型检查、测试或构建出错），网站保持原样。修好再推送；确定要部署就加 --force"
      [[ $SCHEDULED -eq 1 ]] && { log "$msg"; exit 0; }
      die "$msg"
      ;;
    pending)
      [[ $SCHEDULED -eq 1 ]] && { log "${new:0:7} 的检查还没跑完，下次再更新"; exit 0; }
      die "等了 10 分钟检查还没跑完，稍后再试；确定要部署就加 --force"
      ;;
    *)
      [[ $SCHEDULED -eq 1 ]] && { log "查不到 GitHub 上的检查结果（连不上 api.github.com），这次先不更新"; exit 0; }
      log "查不到 GitHub 上的检查结果（连不上 api.github.com），按手动更新继续部署"
      ;;
  esac
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
# 新版本启动时会执行数据库迁移，先备份一次；备份失败只记下来，不挡更新（每天凌晨还有定时备份）
if [[ "$old" != "none" ]]; then
  if timeout 600 bash "$DIR/scripts/backup.sh"; then
    log "更新前已备份数据库"
  else
    log "更新前备份数据库失败，继续更新（手动备份：sudo bash scripts/backup.sh）"
  fi
fi
if deploy "$new"; then
  rm -f "$failed_file"
  docker image prune -f >/dev/null 2>&1 || true
  log "更新完成，网站正常运行（端口 ${port}）"
  exit 0
fi

if [[ "$old" == "none" ]]; then
  die "新版本没有正常启动，看看日志：sudo docker compose logs --tail 50 api web"
fi
echo "$new" > "$failed_file"
log "新版本没有正常启动，退回 ${old:0:7}"
if deploy "$old"; then
  die "已退回上一个版本，网站正常运行。新版本的问题看日志：sudo docker compose logs --tail 50 api"
fi
die "退回后网站也没起来，看日志：sudo docker compose logs --tail 50 api"
