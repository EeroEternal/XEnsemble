// Pure helpers for the MCP connectivity test: build the guest-side script and
// parse the handshake reply. Kept free of DB/runtime imports so they can be unit
// tested without a database.

const path = require('path');
const { getAsset } = require('./mcpPresets');

const INIT_REQUEST = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'xensemble', version: '1.0.0' },
  },
});
const TEST_DIR = '/tmp/mcp-test';
const OUT_MARK = '---XE_MCP_OUT---';
const ERR_MARK = '---XE_MCP_ERR---';
const ASSET_TOKEN_RE = /\{asset:([A-Za-z0-9_-]+)\}/g;

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "'\\''")}'`;
}

/**
 * Build the guest-side script: stage any `{asset:*}` launchers in /tmp, then
 * pipe the initialize request into the server and capture both streams.
 */
function buildTestScript({ command, args = [], env = {} }) {
  const assets = new Map();
  const resolvedArgs = (args || []).map((arg) => String(arg).replace(ASSET_TOKEN_RE, (_, name) => {
    const asset = getAsset(name);
    if (!asset) return '';
    const target = `${TEST_DIR}/${path.basename(asset.path)}`;
    assets.set(name, { target, content: String(asset.content).replace(/__WORKSPACE__/g, TEST_DIR) });
    return target;
  }));

  const lines = ['set -e', `rm -rf ${TEST_DIR}`, `mkdir -p ${TEST_DIR}`];
  for (const { target, content } of assets.values()) {
    lines.push(`cat > ${shellQuote(target)} <<'XE_MCP_ASSET'`);
    lines.push(content.replace(/\n+$/, ''));
    lines.push('XE_MCP_ASSET');
    lines.push(`chmod 755 ${shellQuote(target)}`);
  }

  const envPrefix = Object.entries(env || {})
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ');
  const cmdline = [command, ...resolvedArgs].map(shellQuote).join(' ');
  // Keep stdin open for a few seconds: some servers (e.g. the Go GitHub server)
  // only answer once they have finished starting up, and closing stdin
  // immediately made them exit without replying (false "no response").
  lines.push(
    `{ printf '%s\\n' ${shellQuote(INIT_REQUEST)}; sleep 6; } | timeout 45 `
    + `${envPrefix ? `env ${envPrefix} ` : ''}${cmdline}`
    + ` > ${TEST_DIR}/out.json 2> ${TEST_DIR}/err.txt || true`,
  );
  lines.push(`echo ${shellQuote(OUT_MARK)}`);
  lines.push(`head -c 8000 ${TEST_DIR}/out.json 2>/dev/null || true`);
  lines.push('echo');
  lines.push(`echo ${shellQuote(ERR_MARK)}`);
  lines.push(`tail -c 1500 ${TEST_DIR}/err.txt 2>/dev/null || true`);
  return lines.join('\n');
}

function splitOutput(stdout) {
  const text = String(stdout || '');
  const outIdx = text.indexOf(OUT_MARK);
  const errIdx = text.indexOf(ERR_MARK);
  const out = outIdx >= 0 ? text.slice(outIdx + OUT_MARK.length, errIdx >= 0 ? errIdx : undefined) : text;
  const err = errIdx >= 0 ? text.slice(errIdx + ERR_MARK.length) : '';
  return { out: out.trim(), err: err.trim() };
}

/** Pull the first JSON-RPC object out of the server's stdout. */
function parseHandshake(out) {
  for (const line of String(out || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.result) {
        return {
          serverInfo: parsed.result.serverInfo || null,
          protocolVersion: parsed.result.protocolVersion || null,
        };
      }
      if (parsed && parsed.error) {
        return { rpcError: parsed.error };
      }
    } catch (_) {
      /* keep scanning */
    }
  }
  return null;
}

module.exports = {
  TEST_DIR,
  buildTestScript,
  parseHandshake,
  splitOutput,
  shellQuote,
};
