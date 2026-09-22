// Injects the user's enabled MCP servers into the agent's config at session
// start.
//
// Each agent reads MCP servers from its own file/format, so injection goes
// through a small per-agent adapter table (verified against each CLI's own
// `mcp add` output):
//   claude-code  .mcp.json             { mcpServers: { name: { command, args, env } } }
//   cursor       .cursor/mcp.json      { mcpServers: ... }
//   qwen-code    .qwen/settings.json   { mcpServers: ... }
//   opencode     opencode.json         { mcp: { name: { type:'local', command:[...], environment:{...} } } }
//
// Merge strategy: user-authored entries are preserved; the names we injected
// last time are tracked per agent in `.agents/mcp-injected.json` and removed
// before re-adding the current set, so disabling/deleting a server takes effect
// on the next session. (A user entry that shares a name with a managed server is
// treated as managed.)
//
// Agents without an adapter are skipped — the UI lists the supported ones.

const path = require('path');
const { getAsset } = require('./mcpPresets');

const MANAGED_MARKER_PATH = path.join('.agents', 'mcp-injected.json');
// `{asset:<name>}` in args → a launcher script the injector writes into the
// workspace (used by presets whose server is not a plain npx package).
const ASSET_TOKEN_RE = /\{asset:([A-Za-z0-9_-]+)\}/g;

/**
 * agentId → { name, kind, file | userFile }.
 * `file`     : workspace-relative path (project-scoped config)
 * `userFile` : `~/...` path inside the sandbox (user-scoped config)
 *
 * Every format was verified by running the CLI's own `mcp add` in its image:
 *   claude-code/kimi-code/commandcode → .mcp.json       { mcpServers: { name: { command, args, env } } }
 *   codebuddy                         → .mcp.json       { mcpServers: { name: { …, type:'stdio' } } }
 *   cursor                            → .cursor/mcp.json
 *   qwen-code                         → .qwen/settings.json
 *   opencode                          → opencode.json   { mcp: { name: { type:'local', command:[…], environment } } }
 *   amp                               → .amp/settings.json  { "amp.mcpServers": { … } }
 *   glm-agent                         → .zai/settings.json  { mcpServers: { name: { transport: { type, command:<string>, args, env } } } }
 *   cline                             → ~/.cline/data/settings/cline_mcp_settings.json { mcpServers: { name: { transport: { type, command, args, env } } } }
 *   droid                             → ~/.factory/mcp.json { mcpServers: { name: { type, command, args, env, disabled } } }
 *
 * Not supported on purpose:
 *   commandcode's CLI is interactive for stdio (we write the compatible .mcp.json instead).
 *   pi / minimax-cli / openclaw / hermes / github-copilot — no usable MCP config found.
 */
const MCP_AGENT_ADAPTERS = {
  'claude-code': { name: 'Claude Code', file: '.mcp.json', kind: 'mcpServers' },
  'kimi-code': { name: 'Kimi Code', file: '.mcp.json', kind: 'mcpServers' },
  commandcode: { name: 'CommandCode', file: '.mcp.json', kind: 'commandcode' },
  codebuddy: { name: 'CodeBuddy', file: '.mcp.json', kind: 'codebuddy' },
  cursor: { name: 'Cursor', file: path.join('.cursor', 'mcp.json'), kind: 'mcpServers' },
  'qwen-code': { name: 'Qwen Code', file: path.join('.qwen', 'settings.json'), kind: 'mcpServers' },
  opencode: { name: 'OpenCode', file: 'opencode.json', kind: 'opencode' },
  amp: { name: 'Amp', file: path.join('.amp', 'settings.json'), kind: 'amp' },
  'glm-agent': { name: 'GLM Agent', file: path.join('.zai', 'settings.json'), kind: 'glm' },
  // User-scoped configs: the platform redirects these CLIs' config roots into
  // the session state dir (CLINE_DATA_DIR / FACTORY_HOME_OVERRIDE), so the path
  // MUST be built from there — `~/...` would be the host default and never read.
  cline: {
    name: 'Cline',
    kind: 'cline',
    stateDirFile: 'settings/cline_mcp_settings.json',
    userFile: '~/.cline/data/settings/cline_mcp_settings.json',
  },
  droid: {
    name: 'Droid',
    kind: 'droid',
    stateDirFile: '.factory/mcp.json',
    userFile: '~/.factory/mcp.json',
  },
  // Hermes keeps MCP servers in a YAML file (mcp_servers:) under HERMES_HOME.
  hermes: {
    name: 'Hermes',
    kind: 'hermes',
    format: 'yaml',
    stateDirFile: 'config.yaml',
    userFile: '~/.hermes/config.yaml',
  },
};

function listSupportedAgents() {
  return Object.entries(MCP_AGENT_ADAPTERS).map(([id, adapter]) => ({ id, name: adapter.name }));
}

function getAgentAdapter(agentId) {
  return MCP_AGENT_ADAPTERS[agentId] || null;
}

/**
 * The sandbox can transiently reject exec calls right after boot (guest zygote
 * race, same as the other bootstrap writers). Retry before giving up.
 */
async function writeWithRetry(fsAdapter, rootDir, relativePath, content, runtimeRef, { attempts = 3, log } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fsAdapter.fsWrite(rootDir, relativePath, content, { runtimeRef });
    } catch (err) {
      lastError = err;
      log?.warn?.(`[mcp] write ${relativePath} attempt ${attempt}/${attempts} failed: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
  throw lastError;
}

/**
 * Expand a leading `~` inside the guest shell: the path is passed as an exec
 * ARGUMENT, which the shell does NOT expand — doing it in JS produced a literal
 * `$HOME` directory inside the workspace.
 */
const GUEST_PATH_RESOLVER = [
  'P="$1"',
  'case "$P" in',
  '  "~") P="${HOME:-/root}" ;;',
  '  "~/"*) P="${HOME:-/root}/${P#\"~/"}" ;;',
  'esac',
].join('\n');

/**
 * Concrete guest path of an adapter's config file. Prefers the session state
 * dir (agents whose config root is redirected there), falling back to `~/...`.
 */
function resolveGuestConfigPath(adapter, stateDirPath) {
  if (adapter.stateDirFile && stateDirPath) {
    return path.posix.join(String(stateDirPath).replace(/\/+$/, ''), adapter.stateDirFile);
  }
  return adapter.userFile || null;
}

async function readGuestFile(execAdapter, guestPath, runtimeRef) {
  const script = `${GUEST_PATH_RESOLVER}\ncat "$P" 2>/dev/null || true`;
  const res = await execAdapter.exec('sh', ['-c', script, 'sh', guestPath], {}, { runtimeRef });
  return String(res?.stdout || '');
}

async function writeGuestFile(execAdapter, guestPath, content, runtimeRef) {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const script = `${GUEST_PATH_RESOLVER}\nmkdir -p "$(dirname "$P")" && printf %s "$2" | base64 -d > "$P"`;
  await execAdapter.exec('sh', ['-c', script, 'sh', guestPath, b64], {}, { runtimeRef });
}

/**
 * Read a config file: workspace-relative for project-scoped adapters, guest
 * `~/...` (via exec) for user-scoped ones.
 * @returns {{ found: boolean, value: object|null, unparsable: boolean }}
 */
async function readJsonFile({ adapter, fsAdapter, execAdapter, workspaceRoot, runtimeRef, stateDirPath = null }) {
  let text = null;
  try {
    text = adapter.userFile || adapter.stateDirFile
      ? await readGuestFile(execAdapter, resolveGuestConfigPath(adapter, stateDirPath), runtimeRef)
      : await fsAdapter.fsRead(workspaceRoot, adapter.file, { runtimeRef });
  } catch (_) {
    return { found: false, value: null, unparsable: false };
  }
  if (!text) return { found: false, value: null, unparsable: false };
  if (YAML_KINDS.has(adapter.kind)) {
    // YAML configs are merged as text; no parser needed (and none is available
    // in production: the `yaml` package is only a devDependency).
    return { found: true, value: null, raw: String(text), unparsable: false };
  }
  try {
    return { found: true, value: JSON.parse(String(text)), unparsable: false };
  } catch (_) {
    // e.g. opencode.jsonc with comments — never overwrite what we cannot parse.
    return { found: true, value: null, unparsable: true };
  }
}

async function writeConfigFile({ adapter, fsAdapter, execAdapter, workspaceRoot, runtimeRef, stateDirPath = null, content, log }) {
  if (adapter.userFile || adapter.stateDirFile) {
    return writeGuestFile(execAdapter, resolveGuestConfigPath(adapter, stateDirPath), content, runtimeRef);
  }
  return writeWithRetry(fsAdapter, workspaceRoot, adapter.file, content, runtimeRef, { log });
}

/**
 * Warm a cache in the background. Session start must NOT wait for it: a slow
 * network made a first-run download take minutes, and blocking would delay the
 * agent. By the time the user opens `/mcp` the package/binary is usually cached.
 */
function warmUpInBackground(execAdapter, runtimeRef, cmd, args, log, label, env = {}) {
  if (!execAdapter || typeof execAdapter.exec !== 'function') return;
  execAdapter.exec(cmd, args, env, { runtimeRef, timeoutMs: 900000 })
    .then(() => log.info?.(`[mcp] warmed ${label}`))
    .catch((err) => log.warn?.(`[mcp] warm-up failed for ${label} (non-fatal): ${err.message}`));
}

/** `npx -y pkg --flag` → `pkg` (the package npx would download). */
function npxPackageFrom(command, args) {
  if (command !== 'npx') return null;
  return (args || []).map(String).find((arg) => arg && !arg.startsWith('-')) || null;
}

/** Launcher scripts referenced by a server's args, with their guest paths. */
function resolveAssetPaths(server, workspaceRoot) {
  const names = new Set();
  for (const arg of server.args || []) {
    for (const match of String(arg).matchAll(ASSET_TOKEN_RE)) names.add(match[1]);
  }
  const root = String(workspaceRoot || '').replace(/\/$/, '');
  const out = new Map();
  for (const name of names) {
    const asset = getAsset(name);
    if (!asset) continue;
    out.set(name, { asset, absPath: `${root}/${asset.path}` });
  }
  return out;
}

function resolveArgs(server, assetPaths) {
  return (server.args || []).map((arg) => String(arg).replace(
    ASSET_TOKEN_RE,
    (_, name) => assetPaths.get(name)?.absPath || '',
  ));
}

/** Claude Code / Cursor / Qwen Code share the `mcpServers` shape. */
function toMcpServersEntry(server, args) {
  const entry = { command: server.command };
  if (args.length > 0) entry.args = args;
  const env = server.env || {};
  if (Object.keys(env).length > 0) entry.env = env;
  return entry;
}

/** OpenCode: `{ type:'local', command:[...], environment:{...} }`. */
function toOpencodeEntry(server, args) {
  const entry = { type: 'local', command: [server.command, ...args] };
  const env = server.env || {};
  if (Object.keys(env).length > 0) entry.environment = env;
  return entry;
}

/** CodeBuddy: `mcpServers` plus an explicit stdio type. */
function toCodebuddyEntry(server, args) {
  return { ...toMcpServersEntry(server, args), type: 'stdio' };
}

/** GLM Agent: the whole command line is one string inside `transport`. */
function toGlmEntry(server, args) {
  const transport = { type: 'stdio', command: [server.command, ...args].join(' '), args: [] };
  const env = server.env || {};
  if (Object.keys(env).length > 0) transport.env = env;
  return { name: server.name, transport };
}

/** CommandCode: like Claude Code plus an explicit stdio transport. */
function toCommandcodeEntry(server, args) {
  return { ...toMcpServersEntry(server, args), transport: 'stdio', enabled: true };
}

/** Cline: everything hangs off a `transport` object. */
function toClineEntry(server, args) {
  const transport = { type: 'stdio', command: server.command, args };
  const env = server.env || {};
  if (Object.keys(env).length > 0) transport.env = env;
  return { transport };
}

/** Droid: flat entry with a disabled flag. */
function toDroidEntry(server, args) {
  const entry = { type: 'stdio', command: server.command, args };
  const env = server.env || {};
  if (Object.keys(env).length > 0) entry.env = env;
  entry.disabled = false;
  return entry;
}

function yamlQuote(value) {
  // Single-quoted YAML scalar; '' escapes an embedded quote.
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

/** Render one hermes `mcp_servers` entry (the shape `hermes mcp add` writes). */
function renderHermesServer(name, entry) {
  const lines = [`  ${name}:`, `    command: ${yamlQuote(entry.command)}`];
  if (Array.isArray(entry.args) && entry.args.length > 0) {
    lines.push('    args:');
    for (const arg of entry.args) lines.push(`      - ${yamlQuote(arg)}`);
  }
  const envKeys = Object.keys(entry.env || {});
  if (envKeys.length > 0) {
    lines.push('    env:');
    for (const key of envKeys) lines.push(`      ${key}: ${yamlQuote(entry.env[key])}`);
  }
  lines.push('    enabled: true');
  return lines.join('\n');
}

/**
 * Merge `mcp_servers` into a hermes `config.yaml` as TEXT: the file is a large
 * commented template, and a YAML round-trip would strip every comment. Only the
 * blocks of the names we manage (and are about to write) are replaced.
 */
function mergeHermesConfig(text, entries, managedNames) {
  const src = String(text || '');
  const lines = src.split('\n');
  const startIdx = lines.findIndex((line) => /^mcp_servers:\s*$/.test(line));
  const drop = new Set([...managedNames, ...entries.keys()]);
  const isServerKey = (line) => {
    const m = /^  ([A-Za-z0-9_.-]+):\s*(?:#.*)?$/.exec(line);
    return m ? m[1] : null;
  };

  let head = lines;
  let body = [];
  let tail = [];
  if (startIdx >= 0) {
    head = lines.slice(0, startIdx + 1);
    let i = startIdx + 1;
    for (; i < lines.length; i += 1) {
      if (/^[A-Za-z_#]/.test(lines[i])) break; // next top-level key or section comment
      body.push(lines[i]);
    }
    tail = lines.slice(i);
  } else {
    // No mcp_servers block yet — append one (keep the rest of the file intact).
    head = [...lines];
    while (head.length > 0 && head[head.length - 1].trim() === '') head.pop();
    head.push('mcp_servers:');
  }

  const kept = [];
  let dropping = false;
  for (const line of body) {
    const name = isServerKey(line);
    if (name) dropping = drop.has(name);
    if (!dropping) kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();

  const rendered = [...entries.entries()].map(([name, entry]) => renderHermesServer(name, entry));
  const block = [...kept, ...rendered];
  const out = [...head, ...block];
  if (tail.length > 0) {
    const tailLines = [...tail];
    while (tailLines.length > 0 && tailLines[0].trim() === '') tailLines.shift();
    out.push('', ...tailLines);
  }
  return `${out.join('\n').replace(/\n*$/, '')}\n`;
}

const CONTAINER_KEY_BY_KIND = {
  mcpServers: 'mcpServers',
  codebuddy: 'mcpServers',
  commandcode: 'mcpServers',
  cline: 'mcpServers',
  droid: 'mcpServers',
  opencode: 'mcp',
  amp: 'amp.mcpServers',
  glm: 'mcpServers',
  hermes: 'mcp_servers',
};

const YAML_KINDS = new Set(['hermes']);

const ENTRY_BUILDER_BY_KIND = {
  mcpServers: toMcpServersEntry,
  codebuddy: toCodebuddyEntry,
  commandcode: toCommandcodeEntry,
  cline: toClineEntry,
  droid: toDroidEntry,
  opencode: toOpencodeEntry,
  amp: toMcpServersEntry,
  glm: toGlmEntry,
};

function containerKeyFor(adapter) {
  return CONTAINER_KEY_BY_KIND[adapter.kind] || 'mcpServers';
}

function buildEntry(adapter, server, args) {
  const build = ENTRY_BUILDER_BY_KIND[adapter.kind] || toMcpServersEntry;
  return build(server, args);
}

/** Marker shape: { byAgent: { <agentId>: [names] } } (legacy: { names }). */
async function readManagedNames(fsAdapter, execAdapter, workspaceRoot, runtimeRef, agentId) {
  const marker = await readJsonFile({
    adapter: { file: MANAGED_MARKER_PATH },
    fsAdapter,
    execAdapter,
    workspaceRoot,
    runtimeRef,
  });
  const value = marker.value || {};
  if (value.byAgent && Array.isArray(value.byAgent[agentId])) return { byAgent: value.byAgent, names: value.byAgent[agentId] };
  // Legacy single-agent marker only ever described claude-code.
  if (!value.byAgent && Array.isArray(value.names) && agentId === 'claude-code') {
    return { byAgent: { 'claude-code': value.names }, names: value.names };
  }
  return { byAgent: value.byAgent || {}, names: [] };
}

/**
 * @returns {{ injected: number, names: string[], skipped: number, unsupported?: boolean }}
 */
async function injectMcpConfigForSession({
  agentId,
  fsAdapter,
  execAdapter = null,
  stateDirPath = null,
  workspaceRoot,
  runtimeRef,
  servers = [],
  log = console,
} = {}) {
  const adapter = getAgentAdapter(agentId);
  if (!adapter) {
    // No adapter for this agent (see MCP_AGENT_ADAPTERS).
    return { injected: 0, names: [], skipped: servers.length, unsupported: true };
  }
  const needsExec = Boolean(adapter.userFile || adapter.stateDirFile);
  if (needsExec && (!execAdapter || typeof execAdapter.exec !== 'function')) {
    log.warn?.(`[mcp] ${agentId} needs a user-scoped config write but no exec adapter was provided`);
    return { injected: 0, names: [], skipped: servers.length };
  }
  if (!needsExec && (!fsAdapter || typeof fsAdapter.fsWrite !== 'function')) {
    return { injected: 0, names: [], skipped: servers.length };
  }

  const managed = await readManagedNames(fsAdapter, execAdapter, workspaceRoot, runtimeRef, agentId);
  if (servers.length === 0 && managed.names.length === 0) {
    // Nothing to inject and nothing to clean up — don't create config files.
    return { injected: 0, names: [], skipped: 0 };
  }

  const existing = await readJsonFile({
    adapter, fsAdapter, execAdapter, workspaceRoot, runtimeRef, stateDirPath,
  });
  if (existing.unparsable) {
    log.warn?.(`[mcp] ${adapter.file} is not plain JSON; leaving it untouched`);
    return { injected: 0, names: [], skipped: servers.length };
  }
  const base = existing.value && typeof existing.value === 'object' ? existing.value : {};

  const containerKey = containerKeyFor(adapter);
  const isYaml = YAML_KINDS.has(adapter.kind);
  const entries = isYaml ? new Map() : { ...(base[containerKey] || {}) };
  if (!isYaml) for (const name of managed.names) delete entries[name];

  const names = [];
  let skipped = 0;
  for (const server of servers) {
    if (server.transport !== 'stdio' || !server.command || !server.name) {
      skipped += 1;
      continue;
    }
    const assetPaths = resolveAssetPaths(server, workspaceRoot);
    for (const { asset, absPath } of assetPaths.values()) {
      const content = String(asset.content).replace(/__WORKSPACE__/g, String(workspaceRoot || '').replace(/\/$/, ''));
      try {
        await writeWithRetry(fsAdapter, workspaceRoot, asset.path, content, runtimeRef, { log });
        log.info?.(`[mcp] wrote launcher ${absPath}`);
      } catch (err) {
        log.warn?.(`[mcp] launcher write failed for ${asset.path} (non-fatal): ${err.message}`);
      }
      // Warm the launcher in the background: clients give the MCP `initialize`
      // handshake only a few seconds, so the first-run download must not happen
      // at that moment — but session start must not block on it either.
      warmUpInBackground(execAdapter, runtimeRef, 'sh', [absPath, '--prepare'], log, `launcher ${absPath}`);
    }
    const resolvedArgs = resolveArgs(server, assetPaths);
    const npxPkg = npxPackageFrom(server.command, resolvedArgs);
    // Keep npx's package cache inside the workspace: the sandbox rootfs is
    // recreated per session, so the default cache would re-download every time.
    const npxCacheDir = npxPkg ? `${String(workspaceRoot || '').replace(/\/$/, '')}/.agents/mcp/npm-cache` : null;
    const entryServer = npxCacheDir
      ? { ...server, env: { npm_config_cache: npxCacheDir, ...(server.env || {}) } }
      : server;
    if (isYaml) entries.set(server.name, buildEntry(adapter, entryServer, resolvedArgs));
    else entries[server.name] = buildEntry(adapter, entryServer, resolvedArgs);
    names.push(server.name);

    // Pre-fill that cache in the background so the first handshake is fast.
    if (npxPkg) {
      warmUpInBackground(
        execAdapter,
        runtimeRef,
        'npx',
        ['--yes', '--package', npxPkg, 'true'],
        log,
        `npx ${npxPkg}`,
        { npm_config_cache: npxCacheDir },
      );
    }
  }

  const content = isYaml
    ? mergeHermesConfig(existing.raw, entries, managed.names)
    : `${JSON.stringify({ ...base, [containerKey]: entries }, null, 2)}\n`;
  await writeConfigFile({
    adapter,
    fsAdapter,
    execAdapter,
    workspaceRoot,
    runtimeRef,
    stateDirPath,
    content,
    log,
  });
  // The marker only drives cleanup of previously injected entries; a failure
  // here must not discard the config we just wrote.
  try {
    const byAgent = { ...managed.byAgent, [agentId]: names };
    await writeWithRetry(
      fsAdapter,
      workspaceRoot,
      MANAGED_MARKER_PATH,
      `${JSON.stringify({ byAgent, updatedAt: Date.now() }, null, 2)}\n`,
      runtimeRef,
      { log },
    );
  } catch (err) {
    log.warn?.(`[mcp] managed marker write failed (non-fatal): ${err.message}`);
  }

  log.info?.(`[mcp] injected ${names.length} server(s) for ${agentId}${skipped ? ` (${skipped} skipped)` : ''}`);
  return { injected: names.length, names, skipped };
}

module.exports = {
  MANAGED_MARKER_PATH,
  MCP_AGENT_ADAPTERS,
  listSupportedAgents,
  getAgentAdapter,
  resolveAssetPaths,
  resolveGuestConfigPath,
  mergeHermesConfig,
  renderHermesServer,
  npxPackageFrom,
  warmUpInBackground,
  readJsonFile,
  writeConfigFile,
  toMcpServersEntry,
  toOpencodeEntry,
  toCodebuddyEntry,
  toGlmEntry,
  toCommandcodeEntry,
  toClineEntry,
  toDroidEntry,
  injectMcpConfigForSession,
  writeWithRetry,
};
