#!/usr/bin/env bash
# install-seccomp.sh
# 编译并部署 seccomp CPUID 过滤方案（openEuler 5.10 KVM AMX workaround）。
# 幂等：重复执行安全。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

BIN_DIR="/opt/xensemble"
UNIT="/etc/systemd/system/seccomp-trace.service"
BLINK_UNIT="/etc/systemd/system/blink-server.service"

echo "==> Build seccomp CPUID filter"
mkdir -p "${BIN_DIR}"
gcc -shared -fPIC -O2 -o "${BIN_DIR}/seccomp-trace-inject.so" \
    deploy/seccomp/seccomp-trace-inject.c
gcc -O2 -o "${BIN_DIR}/seccomp-trace-daemon" \
    deploy/seccomp/seccomp-trace-daemon.c
echo "    built: ${BIN_DIR}/seccomp-trace-inject.so, ${BIN_DIR}/seccomp-trace-daemon"

echo "==> Install seccomp-trace.service"
cat > "${UNIT}" <<'EOF'
[Unit]
Description=XEnsemble seccomp CPUID filter daemon
Before=blink-server.service

[Service]
Type=simple
ExecStart=/opt/xensemble/seccomp-trace-daemon
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

echo "==> Update blink-server.service (LD_PRELOAD + dependency)"
if [ -f "${BLINK_UNIT}" ]; then
    # After/Wants 依赖（幂等）
    if ! grep -q "seccomp-trace.service" "${BLINK_UNIT}"; then
        sed -i '/^\[Unit\]/a After=network.target seccomp-trace.service\nWants=seccomp-trace.service' "${BLINK_UNIT}"
    fi
    # LD_PRELOAD（幂等）
    if ! grep -q "LD_PRELOAD" "${BLINK_UNIT}"; then
        sed -i '/^ExecStart=/a Environment=LD_PRELOAD=/opt/xensemble/seccomp-trace-inject.so' "${BLINK_UNIT}"
    fi
else
    echo "    WARN: ${BLINK_UNIT} not found; install blink-server first"
fi

echo "==> Enable and start seccomp-trace"
systemctl daemon-reload
systemctl enable seccomp-trace >/dev/null 2>&1 || true
systemctl restart seccomp-trace

echo "==> Done. Restart blink-server to apply filter:"
echo "    sudo systemctl restart blink-server"
