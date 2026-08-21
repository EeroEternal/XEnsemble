const { selectionToInstallList } = require('./customImageCatalog');

function getBaseImage() {
  return process.env.BLINK_BASE_IMAGE?.trim()
    || process.env.BLINK_IMAGE?.trim()
    || 'xensemble/box-base:bookworm';
}

function renderInstallSteps(selection) {
  const installList = selectionToInstallList(selection).sort(
    (a, b) => a.component_id.localeCompare(b.component_id),
  );

  const steps = [];

  steps.push('# Base image layers');
  steps.push('# Custom image: ' + installList.map((i) => `${i.name}@${i.version}`).join(', '));
  steps.push('');

  // Each component is its own RUN layer so Docker can reuse
  // cached layers when the same component+version appears in a
  // different image build.
  for (const item of installList) {
    steps.push(`# ${item.name}`);
    steps.push(`RUN set -eux; \\\n  echo ">>> ${item.name} ${item.version}" && \\\n  ${item.install}`);
    steps.push('');
  }

  steps.push('# Cleanup');
  steps.push('RUN rm -rf /root/.npm /root/.cache /tmp/* /var/tmp/* 2>/dev/null; true \\');
  steps.push('  && find /usr/lib/node_modules -path "*/prebuilds/win32-*" -prune -exec rm -rf {} + 2>/dev/null || true \\');
  steps.push('  && find /usr/lib/node_modules -path "*/prebuilds/darwin-*" -prune -exec rm -rf {} + 2>/dev/null || true \\');
  steps.push('  && find /usr/lib/node_modules -name "*.pdb" -delete 2>/dev/null || true \\');
  steps.push('  && find /usr/lib/node_modules -maxdepth 4 -type d -name \'.*-*\' -exec rm -rf {} + 2>/dev/null || true \\');
  steps.push('  && mkdir -p /root/.config/opencode /root/.qwen \\');
  steps.push('  && echo \'{"autoupdate":false}\' > /root/.config/opencode/opencode.json \\');
  steps.push('  && echo \'{"general":{"enableAutoUpdate":false}}\' > /root/.qwen/settings.json');

  return steps.join('\n');
}

function npmRegistry() {
  return process.env.CUSTOM_IMAGE_NPM_REGISTRY?.trim()
    || process.env.NPM_CONFIG_REGISTRY?.trim()
    || 'https://registry.npmmirror.com';
}

function pipIndexUrl() {
  return process.env.CUSTOM_IMAGE_PIP_INDEX_URL?.trim()
    || process.env.PIP_INDEX_URL?.trim()
    || 'https://pypi.tuna.tsinghua.edu.cn/simple';
}

function renderDockerfile(selection) {
  const baseImage = getBaseImage();
  const installSteps = renderInstallSteps(selection);

  return `# syntax=docker/dockerfile:1.7
ARG BASE_IMAGE=${baseImage}
FROM \${BASE_IMAGE}

ENV PATH="/usr/local/bin:/root/.local/bin:/root/.cargo/bin:\${PATH}" HOME="/root" \
    KIMI_CODE_NO_AUTO_UPDATE=1 \
    DISABLE_UPDATES=1 \
    FACTORY_DROID_AUTO_UPDATE_ENABLED=false \
    OPENCLAW_NO_AUTO_UPDATE=1 \
    npm_config_registry=${npmRegistry()} \
    PIP_INDEX_URL=${pipIndexUrl()} \
    PIP_DISABLE_PIP_VERSION_CHECK=1

${installSteps}

WORKDIR /workspace
`;
}

function renderBuildContext(selection) {
  const dockerfile = renderDockerfile(selection);
  return { dockerfile, baseImage: getBaseImage() };
}

module.exports = {
  getBaseImage,
  renderInstallSteps,
  renderDockerfile,
  renderBuildContext,
};
