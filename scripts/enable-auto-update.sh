#!/usr/bin/env bash
# 一次性设置：每 8 小时自动从 GitHub 拉取并部署，另外装一个立即更新的命令 sentence-update。
# 用法（在项目目录下）：sudo bash scripts/enable-auto-update.sh
# 想关掉自动更新：sudo rm /etc/cron.d/sentence-site-update
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ $EUID -eq 0 ]] || { echo "请用 sudo 运行"; exit 1; }
[[ -d "$DIR/.git" ]] || { echo "$DIR 还没接到 GitHub 仓库，先按 README 里的步骤接入"; exit 1; }
command -v flock >/dev/null || { echo "缺少 flock（util-linux），请先安装"; exit 1; }

# 立即更新的命令
cat > /usr/local/bin/sentence-update <<SH
#!/bin/sh
# 长难句拆解台：从 GitHub 拉最新代码并重新部署
exec bash "$DIR/scripts/update.sh" "\$@"
SH
chmod 755 /usr/local/bin/sentence-update

# 每 8 小时检查一次（0:20、8:20、16:20），有新代码才部署
cat > /etc/cron.d/sentence-site-update <<CRON
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
20 */8 * * * root bash $DIR/scripts/update.sh --if-changed >> /var/log/sentence-site-update.log 2>&1
CRON
chmod 644 /etc/cron.d/sentence-site-update

# 日志每周轮换，保留 4 份
cat > /etc/logrotate.d/sentence-site-update <<'ROT'
/var/log/sentence-site-update.log {
  weekly
  rotate 4
  missingok
  notifempty
  compress
}
ROT

systemctl enable --now cron >/dev/null 2>&1 || systemctl enable --now crond >/dev/null 2>&1 || true

echo "已开启自动更新：每天 0:20、8:20、16:20 检查 GitHub，有新代码就自动部署"
echo "立即更新：sudo sentence-update"
echo "更新日志：sudo tail -n 30 /var/log/sentence-site-update.log"
echo
echo "现在先部署一次最新代码："
bash "$DIR/scripts/update.sh"
