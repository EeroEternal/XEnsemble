#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

set_env_value() {
  local key="$1"
  local value="$2"
  local file="$3"
  if [ -z "${value:-}" ]; then
    return 0
  fi
  if [ -f "$file" ]; then
    grep -v "^${key}=" "$file" > "$file.tmp" || true
    mv "$file.tmp" "$file"
  fi
  echo "${key}=${value}" >> "$file"
}

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
[ -s "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

# CN 网络直连 nodejs.org 不稳定：nvm install <major> 每次都会解析远程版本索引，
# 拉取失败即报 "Version '22' not found"（即使本机已装该版本）。切到 npmmirror 消除该依赖。
export NVM_NODEJS_ORG_MIRROR="${NVM_NODEJS_ORG_MIRROR:-https://npmmirror.com/mirrors/node}"

# 关键：优先 nvm use（纯本地解析，不需要网络）——本机已装目标版本时零网络依赖，
# 避免外部索引临时不可达导致 CI 偶发失败；本地确实没有时才 nvm install（走上面镜像）。
NODE_VERSION="$(cat .nvmrc)"
echo "==> Node ${NODE_VERSION}"
if ! nvm use "$NODE_VERSION" >/dev/null 2>&1; then
  echo "==> Node ${NODE_VERSION} not installed; installing (mirror=${NVM_NODEJS_ORG_MIRROR:-default})"
  if ! nvm install "$NODE_VERSION" >&2; then
    echo "==> ERROR: nvm install ${NODE_VERSION} failed" >&2
    echo "    HOME=$HOME NVM_DIR=$NVM_DIR nvm_version=$(nvm --version 2>/dev/null || echo n/a)" >&2
    timeout 15 curl -sL -o /dev/null -w "    index.tab probe: http=%{http_code} size=%{size_download}\n" \
      "${NVM_NODEJS_ORG_MIRROR:-https://nodejs.org/dist}/index.tab" 2>&1 \
      || echo "    index.tab probe: unreachable"
    exit 1
  fi
  nvm use "$NODE_VERSION"
fi
node --version

echo "==> Build UniGateway"
(cd server && npm run build:gateway)

echo "==> Server dependencies"
(cd server && npm install)

echo "==> Web build"
(cd web && npm install && npm run build)

echo "==> Ensure data directory"
mkdir -p server/data

if [ ! -f deploy/xensemble.env ]; then
  echo "==> Creating deploy/xensemble.env from example (edit secrets!)"
  cp deploy/xensemble.env.example deploy/xensemble.env
  JWT=$(openssl rand -hex 32)
  ENC=$(openssl rand -hex 32)
  ADMIN=$(openssl rand -hex 32)
  if [[ "$(uname -s)" == "Darwin" ]]; then
    sed -i '' "s/change-me-to-a-long-random-string-min-32-chars/$JWT/" deploy/xensemble.env
    sed -i '' "s/change-me-to-a-64-char-hex-string/$ENC/" deploy/xensemble.env
    sed -i '' "s/change-me-to-a-long-random-admin-token/$ADMIN/" deploy/xensemble.env
  else
    sed -i "s/change-me-to-a-long-random-string-min-32-chars/$JWT/" deploy/xensemble.env
    sed -i "s/change-me-to-a-64-char-hex-string/$ENC/" deploy/xensemble.env
    sed -i "s/change-me-to-a-long-random-admin-token/$ADMIN/" deploy/xensemble.env
  fi
fi

# Inject secrets from CI/GitHub Actions without committing them to the repo.
set_env_value DEEPSEEK_API_KEY "${DEEPSEEK_API_KEY:-}" deploy/xensemble.env
set_env_value DATABASE_URL "${DATABASE_URL:-}" deploy/xensemble.env
set_env_value DATABASE_SSL "${DATABASE_SSL:-}" deploy/xensemble.env

echo "==> Database migrations"
set -a
# shellcheck disable=SC1091
source deploy/xensemble.env
set +a
if [ -n "${MIGRATE_DATABASE_URL:-}" ]; then
  (cd server && MIGRATE_DATABASE_URL="$MIGRATE_DATABASE_URL" npm run db:migrate)
else
  (cd server && npm run db:migrate)
fi

if [ "${SKIP_SERVICES:-0}" = "1" ]; then
  echo "==> SKIP_SERVICES=1; skipping systemd/nginx (caller sets them up)"
  echo "==> Done (build + migrate only). Check: curl -sI http://127.0.0.1:3888/api/v1/llm/health"
  exit 0
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "==> No systemd on this host; skipping systemd/nginx. Start manually:"
  echo "    set -a && source deploy/xensemble.env && set +a && node server/src/server.js"
  exit 0
fi

# Provision runtime data directories outside the source tree so workspace
# clones, git worktrees, skill volumes, and unigateway config never pollute
# the repo. These are the *defaults* the server falls back to when
# xensemble.env has no explicit override; users can still point any of them
# elsewhere via xensemble.env.
SERVICE_USER="$(id -un)"
RUNTIME_BASE="${XENSEMBLE_RUNTIME_BASE:-/var/lib/xensemble}"
for sub in workspaces repos unigateway; do
  if [ ! -d "$RUNTIME_BASE/$sub" ]; then
    sudo mkdir -p "$RUNTIME_BASE/$sub"
    sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$RUNTIME_BASE/$sub"
  fi
done

# Inject defaults into xensemble.env when missing (never overwrite explicit values).
for kv in \
  "WORKSPACE_ROOT=$RUNTIME_BASE/workspaces" \
  "BARE_REPO_ROOT=$RUNTIME_BASE/repos" \
  "UNIGATEWAY_DATA_DIR=$RUNTIME_BASE/unigateway"; do
  k="${kv%%=*}"; v="${kv#*=}"
  if ! grep -q "^${k}=" deploy/xensemble.env 2>/dev/null; then
    echo "${k}=${v}" >> deploy/xensemble.env
  fi
done

NODE_BIN="$(nvm which current)"
sed "s|/home/xinference/.nvm/versions/node/v20.19.2/bin/node|$NODE_BIN|g" \
  deploy/systemd/xensemble.service | sudo tee /etc/systemd/system/xensemble.service >/dev/null

sudo cp deploy/nginx/xensemble.conf /etc/nginx/sites-available/xensemble.conf
sudo ln -sf /etc/nginx/sites-available/xensemble.conf /etc/nginx/sites-enabled/xensemble.conf
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable xensemble nginx
sudo systemctl restart xensemble nginx

echo "==> Done. Check: curl -sI http://127.0.0.1:3888/api/v1/llm/health"
