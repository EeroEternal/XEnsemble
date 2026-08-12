#!/usr/bin/env bash
# Install blink-server from GitHub Release (prebuilt binary).
# Usage: ./deploy/install-blink-server.sh [version]   (default: latest)
set -euo pipefail

REPO="EeroEternal/blink"
INSTALL_BIN="/usr/local/bin/blink-server"
BLINK_ENV="${BLINK_ENV_FILE:-/etc/xensemble/blink.env}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [[ -n "${1:-}" ]]; then
  VERSION="$1"
else
  echo "==> Fetching latest release from ${REPO}"
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null | grep -m1 '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/' || true)"
  if [[ -z "${VERSION}" ]]; then
    echo "ERROR: could not determine latest release" >&2
    exit 1
  fi
fi

BASE="https://github.com/${REPO}/releases/download/${VERSION}"

echo "==> Download blink-server ${VERSION}"
curl -fsSL "${BASE}/blink-server" -o "${TMP}/blink-server"
curl -fsSL "${BASE}/blink-server.sha256" -o "${TMP}/blink-server.sha256"

echo "==> Verify checksum"
(
  cd "${TMP}"
  sed 's|target/release/blink-server|blink-server|' blink-server.sha256 | sha256sum -c -
)

echo "==> Install to ${INSTALL_BIN}"
sudo install -m 755 "${TMP}/blink-server" "${INSTALL_BIN}"

echo "==> Install systemd unit"
sudo mkdir -p /etc/xensemble
if [[ ! -f "${BLINK_ENV}" ]]; then
  echo "==> Tip: copy deploy/blink.env.example to ${BLINK_ENV} for local HTTP registries"
fi

# Adapt to current user (support both xinference and root deployments)
BLINK_USER="$(id -un)"
BLINK_GROUP="$(id -gn)"

sudo tee /etc/systemd/system/blink-server.service >/dev/null <<UNIT
[Unit]
Description=Blink sandbox execution plane
After=network.target

[Service]
Type=simple
User=${BLINK_USER}
Group=${BLINK_GROUP}
SupplementaryGroups=kvm
ExecStart=/usr/local/bin/blink-server
Environment=BLINK_BIND=127.0.0.1
EnvironmentFile=-/etc/xensemble/blink.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo usermod -aG kvm "${BLINK_USER}" 2>/dev/null || true
sudo systemctl daemon-reload
sudo systemctl enable blink-server
sudo systemctl restart blink-server

sleep 2
if ! curl -sf http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
  echo "blink-server health check failed (endpoint may differ in this version)" >&2
  journalctl -u blink-server -n 20 --no-pager >&2 || true
fi

echo "==> blink-server ${VERSION} installed"
echo "    $(curl -sf http://127.0.0.1:8787/api/health 2>/dev/null || echo 'health endpoint not available, check logs for status')"
