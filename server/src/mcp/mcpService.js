// MCP servers (P1): user-managed Model Context Protocol servers.
//
// Scope: stdio transport only, injected into Claude Code's project-scoped
// `.mcp.json` at session start (see ./mcpInjector). HTTP/SSE transport and other
// agents are follow-ups.
//
// Secrets: env values are stored as-is in Postgres but never returned over the
// API — reads mask them (`••••`) and writes treat the mask as "keep existing".

const { randomBytes } = require('crypto');
const { eq, and, isNull, or, asc } = require('drizzle-orm');
const { db } = require('../db');
const schema = require('../db/schema');
const { RuntimeError } = require('../runtime/interfaces');
const { resolvePreset } = require('./mcpPresets');

const ENV_MASK = '••••';
const NAME_MAX = 64;
const COMMAND_MAX = 512;
const ARG_MAX = 64;
const ENV_MAX_KEYS = 32;
const VALUE_MAX = 4096;
const SUPPORTED_TRANSPORTS = new Set(['stdio']);

function newServerId() {
  return `mcp_${randomBytes(8).toString('hex')}`;
}

function normalizeName(raw) {
  return String(raw || '').trim().slice(0, NAME_MAX);
}

function normalizeStringList(raw, { max = ARG_MAX } = {}) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .slice(0, max)
    .map((v) => v.slice(0, VALUE_MAX));
}

function normalizeEnv(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    const k = String(key || '').trim();
    if (!k || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    const v = String(value ?? '').trim();
    if (!v) continue;
    out[k] = v.slice(0, VALUE_MAX);
    count += 1;
    if (count >= ENV_MAX_KEYS) break;
  }
  return out;
}

/** Hide env values on the way out; the UI re-sends the mask to mean "unchanged". */
function maskEnv(env) {
  const out = {};
  for (const key of Object.keys(env || {})) out[key] = ENV_MASK;
  return out;
}

function formatServer(row, { withSecrets = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    transport: row.transport || 'stdio',
    command: row.command || '',
    args: Array.isArray(row.args) ? row.args : [],
    env: withSecrets ? (row.env || {}) : maskEnv(row.env),
    enabled: Boolean(row.enabled),
    project_id: row.projectId || null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

async function assertProjectOwned(userId, projectId) {
  if (!projectId) return null;
  const rows = await db.select({ id: schema.projects.id }).from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, userId)))
    .limit(1);
  if (rows.length === 0) throw new RuntimeError('project not found', 404);
  return projectId;
}

async function assertNameAvailable(userId, projectId, name, excludeId = null) {
  const scope = projectId
    ? eq(schema.mcpServers.projectId, projectId)
    : isNull(schema.mcpServers.projectId);
  const rows = await db.select({ id: schema.mcpServers.id }).from(schema.mcpServers)
    .where(and(
      eq(schema.mcpServers.ownerUserId, userId),
      scope,
      eq(schema.mcpServers.name, name),
    ));
  const clash = rows.find((r) => r.id !== excludeId);
  if (clash) {
    throw new RuntimeError(`an MCP server named "${name}" already exists in this scope`, 409);
  }
}

function validateInput({ name, transport, command }) {
  if (!name) throw new RuntimeError('name is required', 400);
  if (!SUPPORTED_TRANSPORTS.has(transport)) {
    throw new RuntimeError(`unsupported transport: ${transport} (stdio only for now)`, 400);
  }
  if (!command) throw new RuntimeError('command is required for stdio servers', 400);
}

async function listServers(userId) {
  const rows = await db.select().from(schema.mcpServers)
    .where(eq(schema.mcpServers.ownerUserId, userId))
    .orderBy(asc(schema.mcpServers.createdAt));
  return { servers: rows.map((row) => formatServer(row)), count: rows.length };
}

async function getServer(userId, id) {
  const rows = await db.select().from(schema.mcpServers)
    .where(and(eq(schema.mcpServers.id, id), eq(schema.mcpServers.ownerUserId, userId)))
    .limit(1);
  if (rows.length === 0) throw new RuntimeError('MCP server not found', 404);
  return rows[0];
}

async function createServer(userId, rawInput = {}) {
  // Preset flow: the UI only collects a preset id + a few values; the command
  // line and env map are resolved here so both sides agree.
  let input = rawInput;
  if (rawInput.preset_id) {
    const resolved = resolvePreset(rawInput.preset_id, rawInput.input_values || {});
    if (!resolved) throw new RuntimeError(`unknown preset: ${rawInput.preset_id}`, 400);
    if (resolved.missing.length > 0) {
      throw new RuntimeError(`missing required value(s): ${resolved.missing.join(', ')}`, 400);
    }
    input = {
      ...rawInput,
      name: rawInput.name || resolved.name,
      command: resolved.command,
      args: resolved.args,
      env: resolved.env,
    };
  }

  const name = normalizeName(input.name);
  const transport = String(input.transport || 'stdio').trim();
  const command = String(input.command || '').trim().slice(0, COMMAND_MAX);
  validateInput({ name, transport, command });

  const projectId = await assertProjectOwned(userId, input.project_id || null);
  await assertNameAvailable(userId, projectId, name);

  const now = Date.now();
  const row = {
    id: newServerId(),
    ownerUserId: userId,
    projectId: projectId || null,
    name,
    description: String(input.description || '').trim().slice(0, 500) || null,
    transport,
    command,
    args: normalizeStringList(input.args),
    env: normalizeEnv(input.env),
    enabled: input.enabled === false ? false : true,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.mcpServers).values(row);
  return formatServer(row);
}

async function updateServer(userId, id, patch = {}) {
  const existing = await getServer(userId, id);

  const name = patch.name === undefined ? existing.name : normalizeName(patch.name);
  const transport = patch.transport === undefined
    ? existing.transport
    : String(patch.transport || '').trim();
  const command = patch.command === undefined
    ? existing.command
    : String(patch.command || '').trim().slice(0, COMMAND_MAX);
  validateInput({ name, transport, command });

  const projectId = patch.project_id === undefined
    ? existing.projectId
    : await assertProjectOwned(userId, patch.project_id || null);
  if (name !== existing.name || projectId !== existing.projectId) {
    await assertNameAvailable(userId, projectId, name, id);
  }

  // The mask means "keep the stored value" so the UI never has to resend secrets.
  let env = existing.env || {};
  if (patch.env !== undefined) {
    const incoming = normalizeEnv(patch.env);
    const merged = {};
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = value === ENV_MASK ? (env[key] ?? '') : value;
    }
    env = merged;
  }

  const updates = {
    name,
    transport,
    command,
    projectId: projectId || null,
    description: patch.description === undefined
      ? existing.description
      : (String(patch.description || '').trim().slice(0, 500) || null),
    args: patch.args === undefined ? existing.args : normalizeStringList(patch.args),
    env,
    enabled: patch.enabled === undefined ? existing.enabled : Boolean(patch.enabled),
    updatedAt: Date.now(),
  };
  await db.update(schema.mcpServers).set(updates).where(eq(schema.mcpServers.id, id));
  return formatServer({ ...existing, ...updates });
}

async function deleteServer(userId, id) {
  await getServer(userId, id);
  await db.delete(schema.mcpServers).where(eq(schema.mcpServers.id, id));
  return { ok: true, id };
}

/**
 * Servers that apply to a session: the user's global ones plus the ones scoped
 * to this project, both enabled. Used at session start for config injection.
 */
async function listEnabledForSession(userId, projectId) {
  const scope = projectId
    ? or(isNull(schema.mcpServers.projectId), eq(schema.mcpServers.projectId, projectId))
    : isNull(schema.mcpServers.projectId);
  const rows = await db.select().from(schema.mcpServers)
    .where(and(
      eq(schema.mcpServers.ownerUserId, userId),
      eq(schema.mcpServers.enabled, true),
      scope,
    ))
    .orderBy(asc(schema.mcpServers.createdAt));
  return rows.map((row) => formatServer(row, { withSecrets: true }));
}

module.exports = {
  ENV_MASK,
  listServers,
  getServer,
  createServer,
  updateServer,
  deleteServer,
  listEnabledForSession,
  formatServer,
};
