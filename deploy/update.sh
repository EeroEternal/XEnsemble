#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
[ -s "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

# 与 install.sh 保持一致：nvm 版本解析/下载走 npmmirror，避免 CN 网络直连 nodejs.org 不稳定
export NVM_NODEJS_ORG_MIRROR="${NVM_NODEJS_ORG_MIRROR:-https://npmmirror.com/mirrors/node}"

echo "==> Pull latest code from GitHub"
git pull origin "$(git rev-parse --abbrev-ref HEAD)"

echo "==> Node $(cat .nvmrc)"
nvm use "$(cat .nvmrc)"

echo "==> Server dependencies"
(cd server && npm install)

echo "==> Build UniGateway"
(cd server && npm run build:gateway)

echo "==> Web admin build"
(cd web && npm install && npm run build)

echo "==> Update systemd service (if changed)"
NODE_BIN="$(nvm which current)"
sed "s|/home/xinference/.nvm/versions/node/v20.19.2/bin/node|$NODE_BIN|g" \
  deploy/systemd/xensemble.service | sudo tee /etc/systemd/system/xensemble.service >/dev/null
sudo systemctl daemon-reload

echo "==> Restart control plane"
sudo systemctl restart xensemble

echo "==> Done"
