#!/usr/bin/env bash
# 重新生成 css/app.css。需要 Tailwind CSS v4 的独立命令行工具：
#   https://github.com/tailwindlabs/tailwindcss/releases （下载对应系统的 tailwindcss-* 文件）
# 用法：TAILWIND=/path/to/tailwindcss bash build-css.sh
set -euo pipefail
cd "$(dirname "$0")"
"${TAILWIND:-tailwindcss}" -i css/input.css -o css/app.css --minify
