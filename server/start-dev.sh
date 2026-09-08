#!/bin/bash
# XEnsemble 后端开发启动脚本（自动加载 .env）
cd "$(dirname "$0")"
set -a
source <(grep -v '^\s*#' .env | grep -v '^\s*$' | sed 's/\r$//')
set +a
echo "==> Backend starting with LISTEN_HOST=${LISTEN_HOST:-127.0.0.1}, RUNTIME_PROVIDER=${RUNTIME_PROVIDER:-boxlite}"
npm run dev
