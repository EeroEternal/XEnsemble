#!/usr/bin/env bash
# CN-network variant of build-images.sh: builds agent sandbox images using
# CN mirrors (TUNA apt, npmmirror node, ghfast.top gh) via Dockerfile.cn.
# Usage:
#   bash boxlite/build-images-cn.sh                 # build all agents
#   bash boxlite/build-images-cn.sh claude-code opencode   # build specific agents
# Env: XENSEMBLE_AGENT_IMAGE_REGISTRY, XENSEMBLE_AGENT_IMAGE_TAG, PUSH_IMAGES=1
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="${XENSEMBLE_AGENT_IMAGE_REGISTRY:-xensemble}"
TAG="${XENSEMBLE_AGENT_IMAGE_TAG:-latest}"
BASE_IMAGE="${XENSEMBLE_BOX_BASE_IMAGE:-${REGISTRY}/box-base:bookworm}"
PUSH="${PUSH_IMAGES:-0}"
BOXLITE_DB="${BOXLITE_DB:-$HOME/.boxlite/db/boxlite.db}"

# blink-server (BoxLite) caches image tag -> manifest digest in its SQLite
# image_index table and does NOT re-resolve a tag when the registry content
# changes. After a rebuilt image is pushed under the same tag (e.g. :latest),
# the stale cache entry makes blink-server keep booting sessions from the OLD
# image. Best-effort: if the boxlite db is present on this host, drop the stale
# row so the next session re-pulls the new image. No-op on build-only hosts.
invalidate_blink_cache() {
  local image_ref="$1"
  if [[ -z "${image_ref}" ]] || ! command -v sqlite3 >/dev/null 2>&1 || [[ ! -f "${BOXLITE_DB}" ]]; then
    return 0
  fi
  sqlite3 "${BOXLITE_DB}" \
    "DELETE FROM image_index WHERE reference='${image_ref}';" 2>/dev/null && \
    echo "  invalidated blink-server image_index cache for ${image_ref}" || true
}

echo "Building base image: ${BASE_IMAGE} (CN mirrors)"
docker build \
  -t "${BASE_IMAGE}" \
  -f "${ROOT_DIR}/boxlite/images/base/Dockerfile.cn" \
  "${ROOT_DIR}/boxlite/images/base"

# Push the base BEFORE building agents so the agents' `FROM ${BASE_IMAGE}`
# resolves to the freshly built base in the registry. Pushing it at the end
# causes agents to build on a stale base (the registry still holds the old tag).
if [[ "${PUSH}" == "1" ]]; then
  docker push "${BASE_IMAGE}"
  invalidate_blink_cache "${BASE_IMAGE}"
fi

build_agent() {
  local agent_id="$1"
  local install_cmd="$2"
  local verify_cmd="$3"
  local image="${REGISTRY}/agent-${agent_id}:${TAG}"

  echo "Building agent image: ${image} (CN mirrors)"
  local build_args=(
    --build-arg "BASE_IMAGE=${BASE_IMAGE}"
    --build-arg "AGENT_ID=${agent_id}"
    --build-arg "AGENT_INSTALL=${install_cmd}"
  )
  if [[ -n "${verify_cmd}" ]]; then
    build_args+=(--build-arg "AGENT_VERIFY=${verify_cmd}")
  fi
  docker build "${build_args[@]}" \
    -t "${image}" \
    -f "${ROOT_DIR}/boxlite/images/agent/Dockerfile.cn" \
    "${ROOT_DIR}/boxlite/images/agent"

  if [[ "${PUSH}" == "1" ]]; then
    docker push "${image}"
    invalidate_blink_cache "${image}"
  fi
}

while IFS=$'\t' read -r agent_id install_cmd verify_cmd; do
  [[ -z "${agent_id}" ]] && continue
  # If specific agents were requested as args, skip others.
  if [ $# -gt 0 ]; then
    skip=true
    for selected in "$@"; do
      [ "$agent_id" = "$selected" ] && { skip=false; break; }
    done
    [ "$skip" = true ] && { echo "-- skip ${agent_id}"; continue; }
  fi
  build_agent "${agent_id}" "${install_cmd}" "${verify_cmd}"
done < <(
  node - <<'NODE'
const { listBuildableAgentImages } = require('./server/src/runtime/agentBoxImages');
for (const entry of listBuildableAgentImages()) {
  process.stdout.write(`${entry.agentId}\t${entry.install}\t${entry.verify || ''}\n`);
}
NODE
)

echo "Done. Set BLINK_BASE_IMAGE=${BASE_IMAGE} and BLINK_IMAGE_<AGENT>=${REGISTRY}/agent-<id>:${TAG} as needed."
