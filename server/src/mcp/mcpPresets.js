// Built-in MCP server presets.
//
// Goal: a normal user should pick one of these and fill at most one or two
// fields (usually just an API token) instead of hand-writing a command line.
//
// Shape:
//   command      fixed executable (`npx` runs from the sandbox's Node install;
//                `sh` is used for presets that ship a small launcher script)
//   args         fixed args; `{input:<key>}` → user value, `{asset:<name>}` →
//                absolute path of the launcher script the injector writes
//   inputs[]     what we ask the user for
//                  kind: 'env'  → goes into the server's env map
//                  kind: 'arg'  → substituted into args
//                secret: mask in the UI; docsUrl: where to get the token
//   needs[]      prerequisites surfaced as chips in the UI: token | browser
//   env          non-secret defaults merged into the server env
//   asset        launcher script written into the workspace (per-preset)
//
// The reference servers from modelcontextprotocol/servers are partly archived;
// they still work and need no binary download, so they stay for now. GitHub uses
// GitHub's own Go server (the maintained implementation).

const GITHUB_ASSET = 'github';
const GITHUB_VERSION = '1.12.2';

const GITHUB_LAUNCHER = `#!/bin/sh
# Official GitHub MCP server (Go). Downloaded once per workspace, then run over
# stdio.
#
# github.com itself is unreachable from many sandboxes (CN networks), so the
# GitHub mirror is tried FIRST and every attempt has a short connect timeout —
# a hanging direct connection would make the MCP handshake time out and Claude
# Code would report the server as "failed".
set -e
V="${GITHUB_VERSION}"
case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  i386|i686) ARCH=i386 ;;
  *) ARCH=x86_64 ;;
esac
BIN="__WORKSPACE__/.agents/mcp/bin/github-mcp-server"

download() {
  mkdir -p "$(dirname "$BIN")"
  REL="github/github-mcp-server/releases/download/v\${V}/github-mcp-server_Linux_\${ARCH}.tar.gz"
  TMP="$(mktemp -d)"
  curl -fsSL --connect-timeout 8 --max-time 300 "https://ghfast.top/https://github.com/\${REL}" -o "$TMP/gh.tgz" \
    || curl -fsSL --connect-timeout 8 --max-time 300 "https://github.com/\${REL}" -o "$TMP/gh.tgz"
  tar -xzf "$TMP/gh.tgz" -C "$TMP"
  install -m 755 "$TMP/github-mcp-server" "$BIN"
  rm -rf "$TMP"
}

[ -x "$BIN" ] || download

# --prepare only warms the cache: the platform runs this at session start so the
# MCP handshake never waits for a ~25MB download (some clients allow only a few
# seconds for the initialize request).
if [ "\${1:-}" = "--prepare" ]; then
  exit 0
fi

exec "$BIN" stdio
`;

const MCP_PRESETS = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Issues, pull requests, reviews and cross-repository code search.',
    command: 'sh',
    args: ['{asset:github}'],
    needs: ['token'],
    asset: { name: GITHUB_ASSET, path: '.agents/mcp/github.sh', content: GITHUB_LAUNCHER },
    inputs: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        kind: 'env',
        label: 'GitHub token',
        placeholder: 'ghp_… / github_pat_…',
        secret: true,
        required: true,
        docsUrl: 'https://github.com/settings/tokens',
      },
    ],
  },
  {
    id: 'playwright',
    name: 'Browser (Playwright)',
    description: 'Browser automation for the agent: navigate, interact and capture screenshots to verify front-end changes.',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--headless'],
    needs: ['browser'],
    // First run downloads a browser; point it at the CN mirror.
    env: { PLAYWRIGHT_DOWNLOAD_HOST: 'https://cdn.npmmirror.com/binaries/playwright' },
    inputs: [],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Read-only database access: inspect schemas and run SQL queries.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', '{input:connection}'],
    inputs: [
      {
        key: 'connection',
        kind: 'arg',
        label: 'Connection string (from inside the sandbox)',
        placeholder: 'postgresql://user:pass@host:5432/db',
        secret: true,
        required: true,
      },
    ],
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Persistent cross-session memory for project conventions and past decisions.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    inputs: [],
  },
];

function getPreset(id) {
  return MCP_PRESETS.find((p) => p.id === id) || null;
}

/** Launcher script for `{asset:<name>}` placeholders (written by the injector). */
function getAsset(name) {
  for (const preset of MCP_PRESETS) {
    if (preset.asset && preset.asset.name === name) return preset.asset;
  }
  return null;
}

/** Preset catalogue for the UI (no secrets involved — pure templates). */
function listPresets() {
  return {
    presets: MCP_PRESETS.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      command: p.command,
      args: p.args,
      // Non-secret defaults (e.g. a download mirror) so the UI can show them.
      env: p.env || {},
      needs: p.needs || [],
      inputs: (p.inputs || []).map((i) => ({
        key: i.key,
        kind: i.kind,
        label: i.label,
        placeholder: i.placeholder || '',
        default: i.default || '',
        secret: Boolean(i.secret),
        required: Boolean(i.required),
        docs_url: i.docsUrl || null,
      })),
    })),
  };
}

/**
 * Resolve a preset + user input values into a concrete server definition.
 * `{asset:<name>}` placeholders stay in args — the injector turns them into the
 * workspace path at session start (it is the only place that knows it).
 */
function resolvePreset(presetId, values = {}) {
  const preset = getPreset(presetId);
  if (!preset) return null;

  const pick = (key) => String(values?.[key] ?? '').trim();
  const args = (preset.args || []).map((arg) => arg.replace(/\{input:([A-Za-z0-9_]+)\}/g, (_, key) => {
    const input = (preset.inputs || []).find((i) => i.key === key);
    return pick(key) || (input?.default || '');
  }));
  const env = { ...(preset.env || {}) };
  const missing = [];
  for (const input of preset.inputs || []) {
    const value = pick(input.key);
    if (input.required && !value) missing.push(input.key);
    if (input.kind !== 'env') continue;
    if (value) env[input.key] = value;
  }
  return { name: preset.name, command: preset.command, args, env, presetId: preset.id, missing };
}

module.exports = { MCP_PRESETS, getPreset, getAsset, listPresets, resolvePreset };
