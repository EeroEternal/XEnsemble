const { getAgentBoxInstallCommand } = require('./agentBoxImages');
const { AGENT_BOX_IMAGE_CATALOG } = require('./agentBoxImages');

const CATEGORY_AGENT = 'agent';
const CATEGORY_LANGUAGE = 'language';
const CATEGORY_DATABASE = 'database';
const CATEGORY_DEVOPS = 'devops';
const CATEGORY_PACKAGE_MANAGER = 'package-manager';
const CATEGORY_SHELL_TOOL = 'shell-tool';

const LANGUAGE_INSTALL = {
  python: {
    '3.11': { install: 'apt-get update && apt-get install -y python3.11 python3.11-venv python3.11-dev && rm -rf /var/lib/apt/lists/*', default: true, diskSizeMb: 200 },
    '3.12': {
      install: 'apt-get update && apt-get install -y build-essential libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev libncursesw5-dev xz-utils tk-dev libxml2-dev libxmlsec1-dev libffi-dev liblzma-dev && curl -fsSL https://mirrors.huaweicloud.com/python/3.12.9/Python-3.12.9.tar.xz | tar -xJ -C /tmp && cd /tmp/Python-3.12.9 && ./configure --enable-optimizations --with-ensurepip=install && make -j$(nproc) && make altinstall && cd / && rm -rf /tmp/Python-3.12.9 /var/lib/apt/lists/*',
      default: false, diskSizeMb: 500,
    },
    '3.13': {
      install: 'apt-get update && apt-get install -y build-essential libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev libncursesw5-dev xz-utils tk-dev libxml2-dev libxmlsec1-dev libffi-dev liblzma-dev && curl -fsSL https://mirrors.huaweicloud.com/python/3.13.3/Python-3.13.3.tar.xz | tar -xJ -C /tmp && cd /tmp/Python-3.13.3 && ./configure --enable-optimizations --with-ensurepip=install && make -j$(nproc) && make altinstall && cd / && rm -rf /tmp/Python-3.13.3 /var/lib/apt/lists/*',
      default: false, diskSizeMb: 500,
    },
  },
  go: {
    '1.21': { install: 'curl -fsSL https://go.dev/dl/go1.21.13.linux-amd64.tar.gz | tar -C /usr/local -xz && ln -sf /usr/local/go/bin/go /usr/local/bin/go && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt', default: false, diskSizeMb: 150 },
    '1.22': { install: 'curl -fsSL https://go.dev/dl/go1.22.12.linux-amd64.tar.gz | tar -C /usr/local -xz && ln -sf /usr/local/go/bin/go /usr/local/bin/go && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt', default: false, diskSizeMb: 150 },
    '1.23': { install: 'curl -fsSL https://go.dev/dl/go1.23.6.linux-amd64.tar.gz | tar -C /usr/local -xz && ln -sf /usr/local/go/bin/go /usr/local/bin/go && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt', default: true, diskSizeMb: 150 },
    '1.24': { install: 'curl -fsSL https://go.dev/dl/go1.24.0.linux-amd64.tar.gz | tar -C /usr/local -xz && ln -sf /usr/local/go/bin/go /usr/local/bin/go && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt', default: false, diskSizeMb: 150 },
    '1.25': { install: 'curl -fsSL https://go.dev/dl/go1.25.0.linux-amd64.tar.gz | tar -C /usr/local -xz && ln -sf /usr/local/go/bin/go /usr/local/bin/go && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt', default: false, diskSizeMb: 150 },
  },
  java: {
    '17': { install: 'apt-get update && apt-get install -y openjdk-17-jdk-headless && rm -rf /var/lib/apt/lists/*', default: false, diskSizeMb: 300 },
    '21': {
      install: 'curl -fsSL https://mirrors.huaweicloud.com/openjdk/21.0.2/openjdk-21.0.2_linux-x64_bin.tar.gz -o /tmp/jdk21.tar.gz && mkdir -p /usr/lib/jvm/java-21 && tar -xzf /tmp/jdk21.tar.gz -C /usr/lib/jvm/java-21 --strip-components=1 && update-alternatives --install /usr/bin/java java /usr/lib/jvm/java-21/bin/java 1 && update-alternatives --install /usr/bin/javac javac /usr/lib/jvm/java-21/bin/javac 1 && rm /tmp/jdk21.tar.gz',
      default: true, diskSizeMb: 300,
    },
    '24': {
      install: 'curl -fsSL https://mirrors.huaweicloud.com/openjdk/24.0.2/openjdk-24.0.2_linux-x64_bin.tar.gz -o /tmp/jdk24.tar.gz && mkdir -p /usr/lib/jvm/java-24 && tar -xzf /tmp/jdk24.tar.gz -C /usr/lib/jvm/java-24 --strip-components=1 && update-alternatives --install /usr/bin/java java /usr/lib/jvm/java-24/bin/java 2 && update-alternatives --install /usr/bin/javac javac /usr/lib/jvm/java-24/bin/javac 2 && rm /tmp/jdk24.tar.gz',
      default: false, diskSizeMb: 300,
    },
  },
  nodejs: {
    '18': { install: 'curl -fsSL https://nodejs.org/dist/v18.20.7/node-v18.20.7-linux-x64.tar.gz | tar -xz -C /usr/local --strip-components=1', default: false, diskSizeMb: 100 },
    '20': { install: 'curl -fsSL https://nodejs.org/dist/v20.20.2/node-v20.20.2-linux-x64.tar.gz | tar -xz -C /usr/local --strip-components=1', default: false, diskSizeMb: 100 },
    '22': { install: 'curl -fsSL https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.gz | tar -xz -C /usr/local --strip-components=1', default: true, diskSizeMb: 100 },
    '23': { install: 'curl -fsSL https://nodejs.org/dist/v23.11.1/node-v23.11.1-linux-x64.tar.gz | tar -xz -C /usr/local --strip-components=1', default: false, diskSizeMb: 100 },
    // Node 24 LTS (Krypton) + 25 Current — openclaw engines require
    // >=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0, so 23 is excluded but
    // 24.19.0 and 25.9.0 satisfy it. Use npmmirror for CN reliability.
    '24': { install: 'curl -fsSL https://npmmirror.com/mirrors/node/v24.19.0/node-v24.19.0-linux-x64.tar.gz | tar -xz -C /usr/local --strip-components=1', default: false, diskSizeMb: 100 },
    '25': { install: 'curl -fsSL https://npmmirror.com/mirrors/node/v25.9.0/node-v25.9.0-linux-x64.tar.gz | tar -xz -C /usr/local --strip-components=1', default: false, diskSizeMb: 100 },
  },
  rust: {
    'stable': { install: 'export RUSTUP_DIST_SERVER=https://rsproxy.cn RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup && curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable', default: true, diskSizeMb: 500 },
  },
  ruby: {
    '3.1': { install: 'apt-get update && apt-get install -y ruby-full && rm -rf /var/lib/apt/lists/*', default: true, diskSizeMb: 100 },
  },
  php: {
    '8.2': { install: 'apt-get update && apt-get install -y php-cli php-curl php-mbstring php-xml && rm -rf /var/lib/apt/lists/*', default: true, diskSizeMb: 100 },
  },
  cpp: {
    'latest': { install: 'apt-get update && apt-get install -y build-essential cmake gdb && rm -rf /var/lib/apt/lists/*', default: true, diskSizeMb: 500 },
  },
  dotnet: {
    '8.0': { install: 'curl -fsSL https://dotnetcli.azureedge.net/dotnet/Sdk/8.0.424/dotnet-sdk-8.0.424-linux-x64.tar.gz -o /tmp/dotnet-sdk.tar.gz && mkdir -p /usr/local/dotnet && tar -xzf /tmp/dotnet-sdk.tar.gz -C /usr/local/dotnet && ln -sf /usr/local/dotnet/dotnet /usr/local/bin/dotnet && rm /tmp/dotnet-sdk.tar.gz', default: true, diskSizeMb: 200 },
    '9.0': { install: 'curl -fsSL https://dotnetcli.azureedge.net/dotnet/Sdk/9.0.107/dotnet-sdk-9.0.107-linux-x64.tar.gz -o /tmp/dotnet-sdk.tar.gz && mkdir -p /usr/local/dotnet && tar -xzf /tmp/dotnet-sdk.tar.gz -C /usr/local/dotnet && ln -sf /usr/local/dotnet/dotnet /usr/local/bin/dotnet && rm /tmp/dotnet-sdk.tar.gz', default: false, diskSizeMb: 200 },
  },
};

const TOOLS_INSTALL = {
  postgresql: {
    '16': { install: 'apt-get update && apt-get install -y postgresql-client && rm -rf /var/lib/apt/lists/*', default: true, diskSizeMb: 20 },
  },
  mysql: {
    'latest': { install: 'apt-get update && apt-get install -y default-mysql-client && rm -rf /var/lib/apt/lists/*', default: true, diskSizeMb: 20 },
  },
  redis: {
    'latest': { install: 'apt-get update && apt-get install -y redis-tools && rm -rf /var/lib/apt/lists/*', default: true, diskSizeMb: 20 },
  },
  kubectl: {
    'latest': { install: 'curl -fsSL https://storage.googleapis.com/kubernetes-release/release/v1.31.0/bin/linux/amd64/kubectl -o /usr/local/bin/kubectl && chmod +x /usr/local/bin/kubectl', default: true, diskSizeMb: 50 },
  },
  terraform: {
    '1.10': { install: 'apt-get update && apt-get install -y unzip && curl -fsSL https://releases.hashicorp.com/terraform/1.10.5/terraform_1.10.5_linux_amd64.zip -o /tmp/tf.zip && unzip -q /tmp/tf.zip -d /usr/local/bin && rm -rf /tmp/tf.zip /var/lib/apt/lists/*', default: true, diskSizeMb: 80 },
  },
  yarn: {
    'latest': { install: 'npm install -g yarn', default: true, diskSizeMb: 20 },
  },
  pnpm: {
    'latest': { install: 'npm install -g pnpm', default: true, diskSizeMb: 30 },
  },
  bun: {
    'latest': { install: 'npm install -g bun', default: true, diskSizeMb: 100 },
  },
  jq: {
    'latest': { install: 'apt-get update && apt-get install -y jq && rm -rf /var/lib/apt/lists/*', default: true, diskSizeMb: 5 },
  },
  ripgrep: {
    'latest': { install: 'apt-get update && apt-get install -y ripgrep && rm -rf /var/lib/apt/lists/*', default: true, diskSizeMb: 10 },
  },
  tree: {
    'latest': { install: 'apt-get update && apt-get install -y tree && rm -rf /var/lib/apt/lists/*', default: true, diskSizeMb: 5 },
  },
};

const TOOLS_CATEGORIES = {
  postgresql: CATEGORY_DATABASE,
  mysql: CATEGORY_DATABASE,
  redis: CATEGORY_DATABASE,
  kubectl: CATEGORY_DEVOPS,
  terraform: CATEGORY_DEVOPS,
  yarn: CATEGORY_PACKAGE_MANAGER,
  pnpm: CATEGORY_PACKAGE_MANAGER,
  bun: CATEGORY_PACKAGE_MANAGER,
  jq: CATEGORY_SHELL_TOOL,
  ripgrep: CATEGORY_SHELL_TOOL,
  tree: CATEGORY_SHELL_TOOL,
};

const TOOLS_NAMES = {
  postgresql: 'PostgreSQL Client',
  mysql: 'MySQL Client',
  redis: 'Redis CLI',
  kubectl: 'kubectl',
  terraform: 'Terraform',
  yarn: 'Yarn',
  pnpm: 'pnpm',
  bun: 'Bun',
  jq: 'jq',
  ripgrep: 'ripgrep',
  tree: 'tree',
};

function buildCatalog() {
  const agents = Object.keys(AGENT_BOX_IMAGE_CATALOG)
    .filter((agentId) => {
      const entry = AGENT_BOX_IMAGE_CATALOG[agentId];
      if (entry.buildable === false) return false;
      return Boolean(getAgentBoxInstallCommand(agentId));
    })
    .map((agentId) => {
      const entry = AGENT_BOX_IMAGE_CATALOG[agentId];
      return {
        id: `agent:${agentId}`,
        name: entry.tag || agentId,
        category: CATEGORY_AGENT,
        versions: [{ version: 'latest', is_default: true }],
        defaultVersion: 'latest',
        ...(entry.minNodeVersion ? { minNodeVersion: entry.minNodeVersion } : {}),
      };
    });

  const languages = Object.keys(LANGUAGE_INSTALL).map((langId) => {
    const versions = LANGUAGE_INSTALL[langId];
    const names = { python: 'Python', go: 'Go', java: 'Java', nodejs: 'Node.js', rust: 'Rust', ruby: 'Ruby', php: 'PHP', cpp: 'C/C++', dotnet: '.NET' };
    const versionList = Object.keys(versions).map((v) => ({
      version: v,
      is_default: Boolean(versions[v].default),
    }));
    const defaultVer = versionList.find((v) => v.is_default)?.version || versionList[0]?.version;
    return {
      id: `lang:${langId}`,
      name: names[langId] || langId,
      category: CATEGORY_LANGUAGE,
      versions: versionList,
      defaultVersion: defaultVer,
    };
  });

  const tools = Object.keys(TOOLS_INSTALL).map((toolId) => {
    const versions = TOOLS_INSTALL[toolId];
    const versionList = Object.keys(versions).map((v) => ({
      version: v,
      is_default: Boolean(versions[v].default),
    }));
    const defaultVer = versionList.find((v) => v.is_default)?.version || versionList[0]?.version;
    return {
      id: `tool:${toolId}`,
      name: TOOLS_NAMES[toolId] || toolId,
      category: TOOLS_CATEGORIES[toolId] || CATEGORY_PACKAGE_MANAGER,
      versions: versionList,
      defaultVersion: defaultVer,
    };
  });

  return [...agents, ...languages, ...tools];
}

function getInstallFragment(componentId, version) {
  if (componentId.startsWith('agent:')) {
    const agentId = componentId.slice('agent:'.length);
    return getAgentBoxInstallCommand(agentId);
  }
  if (componentId.startsWith('lang:')) {
    const langId = componentId.slice('lang:'.length);
    const versions = LANGUAGE_INSTALL[langId];
    if (!versions) return null;
    const entry = versions[version];
    return entry ? entry.install : null;
  }
  if (componentId.startsWith('tool:')) {
    const toolId = componentId.slice('tool:'.length);
    const versions = TOOLS_INSTALL[toolId];
    if (!versions) return null;
    const entry = versions[version];
    return entry ? entry.install : null;
  }
  return null;
}

function getComponentDiskSizeMb(componentId, version) {
  if (componentId.startsWith('lang:')) {
    const langId = componentId.slice('lang:'.length);
    const versions = LANGUAGE_INSTALL[langId];
    return versions?.[version]?.diskSizeMb || 0;
  }
  if (componentId.startsWith('tool:')) {
    const toolId = componentId.slice('tool:'.length);
    const versions = TOOLS_INSTALL[toolId];
    return versions?.[version]?.diskSizeMb || 0;
  }
  return 0;
}

function getCategory(componentId) {
  if (componentId.startsWith('agent:')) return CATEGORY_AGENT;
  if (componentId.startsWith('lang:')) return CATEGORY_LANGUAGE;
  if (componentId.startsWith('tool:')) {
    const toolId = componentId.slice('tool:'.length);
    return TOOLS_CATEGORIES[toolId] || null;
  }
  return null;
}

const CUSTOM_IMAGE_CATALOG = buildCatalog();

function getCatalog() {
  return CUSTOM_IMAGE_CATALOG;
}

function getComponentById(componentId) {
  return CUSTOM_IMAGE_CATALOG.find((c) => c.id === componentId) || null;
}

function validateSelection(selection) {
  if (!Array.isArray(selection) || selection.length === 0) {
    return { ok: false, error: 'selection must be a non-empty array' };
  }

  const seen = new Set();
  const unknowns = [];
  const errors = [];

  // Track selected agents and nodejs version for cross-compatibility checks
  const selectedAgents = [];
  let selectedNodejsVersion = null;

  for (let i = 0; i < selection.length; i++) {
    const item = selection[i];
    const { component_id: componentId, version } = item || {};

    if (!componentId || typeof componentId !== 'string') {
      errors.push(`selection[${i}]: component_id is required and must be a string`);
      continue;
    }
    if (!version || typeof version !== 'string') {
      errors.push(`selection[${i}]: version is required and must be a string`);
      continue;
    }
    if (
      !componentId.startsWith('agent:') && !componentId.startsWith('lang:') && !componentId.startsWith('tool:')
    ) {
      unknowns.push(componentId);
      continue;
    }

    const component = getComponentById(componentId);
    if (!component) {
      unknowns.push(componentId);
      continue;
    }

    const validVersion = component.versions.some((v) => v.version === version);
    if (!validVersion) {
      errors.push(
        `version "${version}" is not available for component "${component.name}" (${componentId})`,
      );
      continue;
    }

    const install = getInstallFragment(componentId, version);
    if (!install) {
      errors.push(
        `no install script available for component "${component.name}" (${componentId})@${version}`,
      );
    }

    if (seen.has(componentId)) {
      errors.push(`duplicate component: "${component.name}" (${componentId})`);
    }
    seen.add(componentId);

    if (componentId.startsWith('agent:')) {
      selectedAgents.push({ componentId, name: component.name });
    }
    if (componentId === 'lang:nodejs') {
      selectedNodejsVersion = version;
    }
  }

  if (unknowns.length > 0) {
    errors.push(
      `unknown component id(s): ${unknowns.join(', ')}`,
    );
  }

  // Cross-compatibility: check agent minNodeVersion requirements
  if (selectedNodejsVersion) {
    const selectedNodeMajor = parseInt(selectedNodejsVersion, 10);
    for (const agent of selectedAgents) {
      const agentId = agent.componentId.slice('agent:'.length);
      const catalogEntry = AGENT_BOX_IMAGE_CATALOG[agentId];
      if (catalogEntry?.minNodeVersion) {
        const requiredMajor = parseInt(catalogEntry.minNodeVersion, 10);
        if (!Number.isNaN(selectedNodeMajor) && !Number.isNaN(requiredMajor) && selectedNodeMajor < requiredMajor) {
          errors.push(
            `agent "${agent.name}" requires Node.js >= ${catalogEntry.minNodeVersion}, but Node.js ${selectedNodejsVersion} was selected`,
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join('; ') };
  }

  return { ok: true };
}

function selectionToInstallList(selection) {
  const result = [];
  for (const { component_id: componentId, version } of selection) {
    const install = getInstallFragment(componentId, version);
    const component = getComponentById(componentId);
    if (install) {
      result.push({
        component_id: componentId,
        name: component ? component.name : componentId,
        version,
        install,
        category: getCategory(componentId),
        diskSizeMb: getComponentDiskSizeMb(componentId, version),
      });
    }
  }
  return result;
}

module.exports = {
  CATEGORY_AGENT,
  CATEGORY_LANGUAGE,
  CATEGORY_DATABASE,
  CATEGORY_DEVOPS,
  CATEGORY_PACKAGE_MANAGER,
  CATEGORY_SHELL_TOOL,
  LANGUAGE_INSTALL,
  TOOLS_INSTALL,
  TOOLS_CATEGORIES,
  TOOLS_NAMES,
  CUSTOM_IMAGE_CATALOG,
  getCatalog,
  getComponentById,
  getInstallFragment,
  getComponentDiskSizeMb,
  validateSelection,
  selectionToInstallList,
};
