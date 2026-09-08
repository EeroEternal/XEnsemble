#!/bin/bash
# XEnsemble 前端开发启动脚本（自动把 API 指向 WSL IP 的后端）
cd "$(dirname "$0")"
WSL_IP=$(hostname -I | awk '{print $1}')
export VITE_API_BASE="http://${WSL_IP}:3888"
echo "==> Frontend starting, API base = ${VITE_API_BASE}"
echo "==> Open in browser: http://${WSL_IP}:3889"
npx vite --host 0.0.0.0
