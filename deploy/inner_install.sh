#!/usr/bin/env bash
# Intranet / CN-network deployment for XEnsemble — single file carrying ALL
# environment-specific adaptations. The repo's deploy scripts stay pristine
# (upstream), so this file can be dropped on public deployments.
#
# Handles (openEuler / RHEL-like single-node intranet):
#   - run as root with a fixed repo path
#   - SELinux -> Permissive
#   - TUNA mirrors for rustup/cargo
#   - provision a local PostgreSQL role/database
#   - nginx on :8088 (port 80 busy), HTTP-only, conf.d layout
#   - systemd service for root + this repo path
#
# Usage: sudo bash deploy/inner_install.sh [APP_ROOT]
# APP_ROOT defaults to the repo root (git clone location).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_ROOT="${1:-$ROOT}"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run as root: sudo bash $0 $APP_ROOT" >&2
  exit 1
fi

echo "==> [inner] App root: $APP_ROOT"

# ---------------------------------------------------------------------------
# 1. SELinux: Enforcing blocks systemd from reading user_home_t files (env
#    file, working dir, node under ~/.nvm). Switch to Permissive and persist.
# ---------------------------------------------------------------------------
if command -v getenforce >/dev/null 2>&1; then
  if [ "$(getenforce)" = "Enforcing" ]; then
    echo "==> [inner] SELinux runtime Enforcing -> Permissive"
    setenforce 0
  fi
  # Always persist to config — even if runtime is already Permissive, the
  # config file may still say "enforcing" and a reboot would restore it.
  if grep -q '^SELINUX=enforcing' /etc/selinux/config 2>/dev/null; then
    sed -i 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config
    echo "==> [inner] SELinux config persisted -> Permissive"
  fi
fi
# Also allow nginx to bind :8088 (control plane) / :8099 (preview) in case
# SELinux is re-enabled later.
if command -v semanage >/dev/null 2>&1; then
  semanage port -a -t http_port_t -p tcp 8088 2>/dev/null || semanage port -m -t http_port_t -p tcp 8088 2>/dev/null || true
  semanage port -a -t http_port_t -p tcp 8099 2>/dev/null || semanage port -m -t http_port_t -p tcp 8099 2>/dev/null || true
fi

# Also open firewalld (if active) for :8088 / :8099 so nginx can serve both.
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
  firewall-cmd --permanent --add-port=8088/tcp >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-port=8099/tcp >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------------------
# 2. TUNA mirrors for rustup + cargo (sh.rustup.rs / crates.io unreachable).
# ---------------------------------------------------------------------------
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Source cargo env first: rustup installs to ~/.cargo/bin which is NOT in PATH
# for non-interactive shells.
# shellcheck disable=SC1091
[ -s "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

if ! command -v cargo >/dev/null 2>&1; then
  echo "==> [inner] Install rustup/cargo via TUNA mirror"
  RUSTUP_INIT="$(mktemp -t rustup-init.XXXXXX)"
  curl -fsSL \
    https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup/dist/x86_64-unknown-linux-gnu/rustup-init \
    -o "$RUSTUP_INIT"
  RUSTUP_DIST_SERVER=https://mirrors.tuna.tsinghua.edu.cn/rustup \
    "$RUSTUP_INIT" -y
  rm -f "$RUSTUP_INIT"
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
mkdir -p "$CARGO_HOME"
if [ -f "$CARGO_HOME/config.toml" ] && grep -q "tuna" "$CARGO_HOME/config.toml" 2>/dev/null; then
  echo "==> [inner] cargo TUNA mirror already configured"
else
  echo "==> [inner] Configure cargo TUNA mirror ($CARGO_HOME/config.toml)"
  cat >> "$CARGO_HOME/config.toml" <<'TOML'

[source.crates-io]
replace-with = "tuna"

[source.tuna]
registry = "sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/"

[registries.tuna]
index = "sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/"
TOML
fi

# ---------------------------------------------------------------------------
# 3. Provision local PostgreSQL role/database (single-node intranet).
#    If DATABASE_URL is provided externally, use its credentials instead of
#    generating random ones; otherwise auto-provision with random password.
# ---------------------------------------------------------------------------
if command -v psql >/dev/null 2>&1; then
  echo "==> [inner] Ensure local PostgreSQL database"
  ENV_FILE="$APP_ROOT/deploy/xensemble.env"
  if [ ! -f "$ENV_FILE" ]; then
    cp "$APP_ROOT/deploy/xensemble.env.example" "$ENV_FILE"
  fi

  if [ -n "${DATABASE_URL:-}" ]; then
    # Parse DATABASE_URL: postgres://user:password@host:port/database
    DB_URL_USER="$(printf '%s' "$DATABASE_URL" | sed -nE 's|^postgres://([^:]+):.*|\1|p')"
    DB_URL_PASS="$(printf '%s' "$DATABASE_URL" | sed -nE 's|^postgres://[^:]+:([^@]+)@.*|\1|p')"
    DB_URL_HOST="$(printf '%s' "$DATABASE_URL" | sed -nE 's|.*@([^:]+):.*|\1|p')"
    DB_URL_PORT="$(printf '%s' "$DATABASE_URL" | sed -nE 's|.*:([0-9]+)/.*|\1|p')"
    DB_URL_NAME="$(printf '%s' "$DATABASE_URL" | sed -nE 's|.*/([^?]+).*|\1|p')"
    echo "    (using external DATABASE_URL: user=${DB_URL_USER} db=${DB_URL_NAME} host=${DB_URL_HOST}:${DB_URL_PORT})"

    for _llm_var in LLM_ANALYZE_API_URL LLM_ANALYZE_API_KEY LLM_ANALYZE_MODEL LLM_VERIFY_MODEL; do
      _llm_val="${!_llm_var:-}"
      [ -z "$_llm_val" ] && continue
      grep -v "^${_llm_var}=" "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
      mv "$ENV_FILE.tmp" "$ENV_FILE" 2>/dev/null || true
      echo "${_llm_var}=${_llm_val}" >> "$ENV_FILE"
    done

    # Create or update role with the provided password
    if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_URL_USER}'" 2>/dev/null | grep -q 1; then
      sudo -u postgres psql -c "CREATE ROLE ${DB_URL_USER} LOGIN PASSWORD '${DB_URL_PASS}'"
    else
      sudo -u postgres psql -c "ALTER ROLE ${DB_URL_USER} WITH PASSWORD '${DB_URL_PASS}'"
    fi

    # Create database if missing
    if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_URL_NAME}'" 2>/dev/null | grep -q 1; then
      sudo -u postgres createdb -O "${DB_URL_USER}" "${DB_URL_NAME}"
    fi

    # Write DATABASE_URL to env file (replace if exists)
    grep -v '^DATABASE_URL=' "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
    mv "$ENV_FILE.tmp" "$ENV_FILE" 2>/dev/null || true
    echo "DATABASE_URL=${DATABASE_URL}" >> "$ENV_FILE"
  else
    # No external DATABASE_URL: auto-provision with random password
    if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='xensemble'" 2>/dev/null | grep -q 1; then
      DB_PASSWORD=$(openssl rand -hex 16)
      sudo -u postgres psql -c "CREATE ROLE xensemble LOGIN PASSWORD '${DB_PASSWORD}'"
      echo "DATABASE_URL=postgres://xensemble:${DB_PASSWORD}@127.0.0.1:5432/xensemble" >> "$ENV_FILE"
    else
      echo "    (role xensemble exists; keeping existing password)"
    fi
    if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='xensemble'" 2>/dev/null | grep -q 1; then
      sudo -u postgres createdb -O xensemble xensemble
    fi
  fi

  # DATABASE_SSL: use external value if provided, else default false
  DB_SSL_VALUE="${DATABASE_SSL:-false}"
  grep -v '^DATABASE_SSL=' "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
  mv "$ENV_FILE.tmp" "$ENV_FILE" 2>/dev/null || true
  echo "DATABASE_SSL=${DB_SSL_VALUE}" >> "$ENV_FILE"
fi

# ---------------------------------------------------------------------------
# 4. Run the upstream installer (build + migrate only). SKIP_SERVICES=1 makes
#    install.sh skip its systemd/nginx tail (which targets the upstream
#    machine: xinference user / xensemble.dev HTTPS / sites-available layout)
#    so this script can re-install both with the intranet config below.
#    Errors from build/migrate are propagated (set -euo pipefail is active),
#    so a failed build/migrate now fails the CI job instead of being masked.
# ---------------------------------------------------------------------------
echo "==> [inner] Running upstream install.sh (build + migrate; services skipped)"
SKIP_SERVICES=1 bash "$APP_ROOT/deploy/install.sh"

# ---------------------------------------------------------------------------
# 5. Overwrite systemd unit for THIS intranet host (root + this path).
# ---------------------------------------------------------------------------
NODE_BIN="$(nvm which current)"
NODE_DIR="$(dirname "$NODE_BIN")"
cat > /etc/systemd/system/xensemble.service <<EOF
[Unit]
Description=XEnsemble control plane
After=network.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=$APP_ROOT/server
EnvironmentFile=$APP_ROOT/deploy/xensemble.env
Environment=PATH=$NODE_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$NODE_BIN src/server.js
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=30
Delegate=yes

[Install]
WantedBy=multi-user.target
EOF

# ---------------------------------------------------------------------------
# 6. Overwrite nginx config: HTTP-only on :8088 (control plane) + :8099
#    (preview portal), conf.d layout. Remove any upstream
#    sites-available/enabled leftovers to avoid duplicate servers.
# ---------------------------------------------------------------------------
sed -e "s|__HTTP_PORT__|8088|g" -e "s|__PREVIEW_PORT__|8099|g" > /etc/nginx/conf.d/xensemble.conf <<'CONF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

upstream xensemble_backend {
    server 127.0.0.1:3888;
    keepalive 32;
}

server {
    listen __HTTP_PORT__;
    listen [::]:__HTTP_PORT__;
    server_name localhost 127.0.0.1 _;

    client_max_body_size 100m;

    location / {
        proxy_pass http://xensemble_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_buffering off;
    }
}

# Preview portal (PREVIEW_PUBLIC_URL). All traffic on this port is preview:
# the server's preview gateway routes it to the deployment tunnel — it never
# reaches the control-plane API (see gateway.js onRequest: "never fall into
# the host console"). Keeps preview commands isolated from the host console.
server {
    listen __PREVIEW_PORT__;
    listen [::]:__PREVIEW_PORT__;
    server_name localhost 127.0.0.1 _;

    client_max_body_size 100m;

    location / {
        proxy_pass http://xensemble_backend;
        proxy_http_version 1.1;
        # 标记：本请求来自 preview 专用端口。后端网关据此强制路由到 preview
        # 隧道，绝不落入宿主控制台。只有经过本 preview 入口的请求才带此头。
        proxy_set_header X-Preview-Origin 1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_buffering off;
    }
}
CONF
rm -f /etc/nginx/sites-enabled/xensemble.conf /etc/nginx/sites-available/xensemble.conf

# ---------------------------------------------------------------------------
# 7. Auto-set CONTROL_PLANE_PUBLIC_URL to this server's primary IP + nginx port.
#    The default from xensemble.env.example is https://xensemble.dev (upstream),
#    which is unreachable from intranet/VM sandboxes. Override with the host's
#    primary IP so LLM gateway routing works inside sandbox VMs.
# ---------------------------------------------------------------------------
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ -n "$HOST_IP" ]; then
  grep -v '^CONTROL_PLANE_PUBLIC_URL=' "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
  mv "$ENV_FILE.tmp" "$ENV_FILE" 2>/dev/null || true
  echo "CONTROL_PLANE_PUBLIC_URL=http://${HOST_IP}:8088" >> "$ENV_FILE"
  echo "==> [inner] CONTROL_PLANE_PUBLIC_URL set to http://${HOST_IP}:8088"

  # Preview portal on its own port (8099): preview traffic never mixes with the
  # control-plane port, so gateway.js isPreviewPort correctly routes every
  # preview command to the deployment tunnel instead of the host console.
  grep -v '^PREVIEW_PUBLIC_URL=' "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
  mv "$ENV_FILE.tmp" "$ENV_FILE" 2>/dev/null || true
  echo "PREVIEW_PUBLIC_URL=http://${HOST_IP}:8099" >> "$ENV_FILE"
  echo "==> [inner] PREVIEW_PUBLIC_URL set to http://${HOST_IP}:8099"
fi

sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable xensemble nginx
sudo systemctl restart xensemble
sudo systemctl reload nginx 2>/dev/null || sudo systemctl start nginx

echo "==> [inner] Done. Backend: curl -sI http://127.0.0.1:3888/api/v1/llm/health"
echo "==>        Via nginx: curl -sI http://127.0.0.1:8088/"
echo "==> [inner] Optional intranet extras:"
echo "     - openEuler 5.10 KVM AMX workaround (sandbox guest crash):"
echo "         bash $APP_ROOT/deploy/seccomp/install-seccomp.sh"
echo "     - git proxy for github.com (fetch/clone timed out on CN networks):"
echo "         git config --global http.https://github.com.proxy socks5h://127.0.0.1:1234"
