# syntax=docker/dockerfile:1.7

ARG BASE_IMAGE=xensemble/box-base:bookworm
FROM ${BASE_IMAGE}

ARG AGENT_ID=unknown
ARG AGENT_INSTALL="echo \"no AGENT_INSTALL provided for ${AGENT_ID}\""
ARG AGENT_VERIFY=""

# Copy optional patch scripts (only used by agents that reference them in AGENT_INSTALL).
COPY patch-zai-autosave.cjs /tmp/patch-zai-autosave.cjs

ENV PATH="/usr/local/bin:/root/.local/bin:${PATH}" \
    HOME="/root" \
    KIMI_CODE_NO_AUTO_UPDATE=1 \
    DISABLE_UPDATES=1 \
    FACTORY_DROID_AUTO_UPDATE_ENABLED=false \
    OPENCLAW_NO_AUTO_UPDATE=1

# Install the agent CLI. AGENT_INSTALL failure must fail the build.
RUN bash -lc "${AGENT_INSTALL}"
# Strip everything that is not needed at runtime (best-effort, never fail the build).
RUN rm -rf /root/.npm /root/.cache /tmp/* /var/tmp/* 2>/dev/null || true \
    && find /usr/lib/node_modules -path "*/prebuilds/win32-*" -prune -exec rm -rf {} + 2>/dev/null || true \
    && find /usr/lib/node_modules -path "*/prebuilds/darwin-*" -prune -exec rm -rf {} + 2>/dev/null || true \
    && find /usr/lib/node_modules -name "*.pdb" -delete 2>/dev/null || true \
    && find /usr/lib/node_modules -name "*.map" -not -path "*/bundled/*" -delete 2>/dev/null || true \
    && find /usr/lib/node_modules -type d \( -name "__tests__" -o -name "__test__" -o -name "__snapshots__" -o -name "test" -o -name "tests" -o -name "testdata" \) -not -path "*/bundled/*" -not -path "*/bundle/*" -exec rm -rf {} + 2>/dev/null || true \
    && find /usr/lib/node_modules -type d \( -name "examples" -o -name "bench" -o -name "benchmarks" \) -not -path "*/bundled/*" -not -path "*/bundle/*" -exec rm -rf {} + 2>/dev/null || true \
    && find /usr/lib/node_modules -type f \( -name "*.md" -o -name "*.markdown" -o -name "*.ts" -o -name "*.tsx" -o -name "*.coffee" -o -name "LICENSE*" -o -name "CHANGELOG*" \) -not -path "*/bundled/*" -not -path "*/bundle/*" -not -path "*/templates/*" -delete 2>/dev/null || true \
    && find /usr/lib/node_modules -maxdepth 4 -type d -name '.*-*' -exec rm -rf {} + 2>/dev/null || true \
    && mkdir -p /root/.config/opencode /root/.qwen \
    && echo '{"autoupdate":false}' > /root/.config/opencode/opencode.json \
    && echo '{"general":{"enableAutoUpdate":false}}' > /root/.qwen/settings.json \
    && true

RUN if [ -n "${AGENT_VERIFY}" ]; then bash -lc "${AGENT_VERIFY}"; fi

WORKDIR /workspace
