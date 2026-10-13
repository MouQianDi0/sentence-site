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
