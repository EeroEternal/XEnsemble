#!/bin/sh
# 首次初始化数据卷时收紧 pg_hba.conf：只允许 loopback 访问宿主数据库，
# 杜绝沙箱 guest / 内网机器直连（与 docker-compose 的 127.0.0.1 端口绑定配合，纵深防御）。
# 运行时机：postgres 镜像 entrypoint 在 initdb 之后、启动 postgres 之前调用本脚本。
set -e

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
HBA="$PGDATA/pg_hba.conf"

if [ ! -f "$HBA" ]; then
    echo "[pg-hba-secure] $HBA not found, skip" >&2
    exit 0
fi

# 1) 删除所有"任意来源"的 host 规则（host all all all ...）
sed -i '/^host[[:space:]]\+all[[:space:]]\+all[[:space:]]\+all[[:space:]]/d' "$HBA"

# 2) 确保存在仅限 loopback 的规则
grep -qE '^host[[:space:]]+all[[:space:]]+all[[:space:]]+127\.0\.0\.1/32' "$HBA" \
    || printf 'host all all 127.0.0.1/32 scram-sha-256\n' >> "$HBA"
grep -qE '^host[[:space:]]+all[[:space:]]+all[[:space:]]+::1/128' "$HBA" \
    || printf 'host all all ::1/128 scram-sha-256\n' >> "$HBA"

# 3) 放行 docker bridge 默认网关：宿主上经"127.0.0.1:5432 端口映射"连接本库的服务
#    （如宿主 node server）在容器内看到的源 IP 是 docker 网关（通常 172.18.0.1），
#    不在此规则则宿主控制面连不上库。端口已绑 127.0.0.1，外部/沙箱仍无法触达，
#    因此放行网关不降低隔离。网关 IP 动态探测（/proc/net/route 默认路由），网络重建自愈。
GW_HEX="$(awk '$2=="00000000" && $1=="eth0" {print $3}' /proc/net/route 2>/dev/null | head -1)"
if [ -n "$GW_HEX" ] && [ "$GW_HEX" != "00000000" ]; then
    GW_IP="$(printf '%d.%d.%d.%d' \
        "$((16#${GW_HEX:6:2}))" "$((16#${GW_HEX:4:2}))" "$((16#${GW_HEX:2:2}))" "$((16#${GW_HEX:0:2}))")"
    grep -qE "^host[[:space:]]+all[[:space:]]+all[[:space:]]+${GW_IP}/32" "$HBA" \
        || printf 'host all all %s/32 scram-sha-256\n' "$GW_IP" >> "$HBA"
fi

# 3) 保留 replication 规则的安全默认（避免误删复制配置，这里只处理主库规则）

chown postgres:postgres "$HBA"
echo "[pg-hba-secure] hardened $HBA (loopback only)" >&2
