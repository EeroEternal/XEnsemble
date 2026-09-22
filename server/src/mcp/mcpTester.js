// Connectivity test for an MCP server config.
//
// The server is started INSIDE the user's running sandbox (never on the control
// plane — a custom command is arbitrary code) and we drive one MCP handshake:
// write an `initialize` request to its stdin and read the JSON-RPC reply.
//
// Requires a running session, because the sandbox is where the agent will run
// the server (same node/npx, same network policy).

const { eq, and, desc } = require('drizzle-orm');
const { db } = require('../db');
const schema = require('../db/schema');
const { getRuntime } = require('../runtime/registry');
const { RuntimeError } = require('../runtime/interfaces');
const { buildTestScript, parseHandshake, splitOutput } = require('./mcpTestScript');

async function findRunningRuntime(userId) {
  const rows = await db.select({
    runtimeRef: schema.runtimes.runtimeRef,
    sessionId: schema.sessions.id,
  })
    .from(schema.sessions)
    .innerJoin(schema.runtimes, eq(schema.sessions.runtimeId, schema.runtimes.id))
    .where(and(eq(schema.sessions.userId, userId), eq(schema.sessions.status, 'running')))
    .orderBy(desc(schema.sessions.updatedAt))
    .limit(1);
  return rows[0] || null;
}

async function testMcpServer({ userId, command, args = [], env = {}, log = console }) {
  if (!command) throw new RuntimeError('command is required', 400);

  const running = await findRunningRuntime(userId);
  if (!running?.runtimeRef) {
    return {
      ok: false,
      code: 'no_running_session',
      error: 'No running session found. Start a session first, then test.',
    };
  }

  const runtime = getRuntime();
  const script = buildTestScript({ command, args, env });
  let res = null;
  try {
    res = await runtime.exec.exec('sh', ['-c', script], {}, {
      runtimeRef: running.runtimeRef,
      cwd: '/workspace',
      timeoutMs: 90000,
    });
  } catch (err) {
    log.warn?.({ err }, '[mcp] test exec failed');
    return { ok: false, code: 'exec_failed', error: err.message || 'failed to run the test' };
  }

  const { out, err } = splitOutput(res?.stdout);
  const handshake = parseHandshake(out);

  if (handshake?.serverInfo || handshake?.protocolVersion) {
    return {
      ok: true,
      server_info: handshake.serverInfo || null,
      protocol_version: handshake.protocolVersion || null,
    };
  }
  if (handshake?.rpcError) {
    return {
      ok: false,
      code: 'rpc_error',
      error: handshake.rpcError.message || 'server returned an error',
      output: out,
    };
  }

  // No usable reply: surface the first meaningful line of stderr (e.g.
  // "sh: 1: uvx: not found", npm errors) — that is what the user needs.
  const firstErrorLine = String(err || '').split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => !/^\s*(npm|node)?\s*warn\b/i.test(line)) || '';
  return {
    ok: false,
    code: 'no_response',
    error: firstErrorLine || 'the server did not answer the MCP handshake',
    output: out || err,
  };
}

module.exports = {
  testMcpServer,
  findRunningRuntime,
};
