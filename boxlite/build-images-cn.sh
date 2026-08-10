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
fi

build_agent() {
  local agent_id="$1"
  local install_cmd="$2"
  local image="${REGISTRY}/agent-${agent_id}:${TAG}"

  echo "Building agent image: ${image} (CN mirrors)"
  docker build \
    --build-arg "BASE_IMAGE=${BASE_IMAGE}" \
    --build-arg "AGENT_ID=${agent_id}" \
    --build-arg "AGENT_INSTALL=${install_cmd}" \
    -t "${image}" \
    -f "${ROOT_DIR}/boxlite/images/agent/Dockerfile.cn" \
    "${ROOT_DIR}/boxlite/images/agent"

  if [[ "${PUSH}" == "1" ]]; then
    docker push "${image}"
  fi
}

while IFS=$'\t' read -r agent_id install_cmd; do
  [[ -z "${agent_id}" ]] && continue
  # If specific agents were requested as args, skip others.
  if [ $# -gt 0 ]; then
    skip=true
    for selected in "$@"; do
      [ "$agent_id" = "$selected" ] && { skip=false; break; }
    done
    [ "$skip" = true ] && { echo "-- skip ${agent_id}"; continue; }
  fi
  build_agent "${agent_id}" "${install_cmd}"
done < <(
  node - <<'NODE'
const { listBuildableAgentImages } = require('./server/src/runtime/agentBoxImages');
for (const entry of listBuildableAgentImages()) {
  process.stdout.write(`${entry.agentId}\t${entry.install}\n`);
}
NODE
)

echo "Done. Set BLINK_BASE_IMAGE=${BASE_IMAGE} and BLINK_IMAGE_<AGENT>=${REGISTRY}/agent-<id>:${TAG} as needed."
