const { sendPublicError } = require('../http/publicError');
const { RuntimeError } = require('../runtime/interfaces');
const { t } = require('../i18n');
const { listPresets, resolvePreset } = require('../mcp/mcpPresets');
const { testMcpServer } = require('../mcp/mcpTester');
const { listSupportedAgents } = require('../mcp/mcpInjector');
const {
  getServer,
  listServers,
  createServer,
  updateServer,
  deleteServer,
} = require('../mcp/mcpService');

function handleError(reply, err, request, fallback, statusCode) {
  if (err instanceof RuntimeError && err.statusCode === 409) {
    return reply.code(409).send({
      error: t('mcp:error.name_exists', {}, request.locale || 'en'),
      code: 'mcp_name_exists',
    });
  }
  return sendPublicError(reply, err, fallback, statusCode);
}

function registerMcpRoutes(fastify) {
  const authPre = [fastify.authenticate];

  // Built-in templates so users don't have to write a command line by hand.
  fastify.get('/api/v1/mcp-servers/presets', { preValidation: authPre }, async (request, reply) => {
    try {
      return { ...listPresets(), supported_agents: listSupportedAgents() };
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return handleError(reply, err, request, 'Failed to list MCP presets', statusCode);
    }
  });

  fastify.get('/api/v1/mcp-servers', { preValidation: authPre }, async (request, reply) => {
    try {
      return await listServers(request.user.id);
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return handleError(reply, err, request, 'Failed to list MCP servers', statusCode);
    }
  });

  // Connectivity test: runs the server inside the caller's running sandbox and
  // performs one MCP handshake.
  fastify.post('/api/v1/mcp-servers/test', { preValidation: authPre }, async (request, reply) => {
    try {
      const { id, preset_id, input_values, command, args, env } = request.body || {};
      let target = null;

      if (id) {
        const row = await getServer(request.user.id, id);
        target = { command: row.command, args: row.args || [], env: row.env || {} };
      } else if (preset_id) {
        const resolved = resolvePreset(preset_id, input_values || {});
        if (!resolved) throw new RuntimeError(`unknown preset: ${preset_id}`, 400);
        if (resolved.missing.length > 0) {
          throw new RuntimeError(`missing required value(s): ${resolved.missing.join(', ')}`, 400);
        }
        target = { command: resolved.command, args: resolved.args, env: resolved.env };
      } else {
        target = {
          command: String(command || '').trim(),
          args: Array.isArray(args) ? args : [],
          env: env && typeof env === 'object' ? env : {},
        };
      }

      return await testMcpServer({ userId: request.user.id, ...target, log: request.log });
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return handleError(reply, err, request, 'Failed to test MCP server', statusCode);
    }
  });

  fastify.post('/api/v1/mcp-servers', { preValidation: authPre }, async (request, reply) => {
    try {
      const server = await createServer(request.user.id, request.body || {});
      return reply.code(201).send(server);
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return handleError(reply, err, request, 'Failed to create MCP server', statusCode);
    }
  });

  fastify.patch('/api/v1/mcp-servers/:id', { preValidation: authPre }, async (request, reply) => {
    try {
      return await updateServer(request.user.id, request.params.id, request.body || {});
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return handleError(reply, err, request, 'Failed to update MCP server', statusCode);
    }
  });

  fastify.delete('/api/v1/mcp-servers/:id', { preValidation: authPre }, async (request, reply) => {
    try {
      return await deleteServer(request.user.id, request.params.id);
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return handleError(reply, err, request, 'Failed to delete MCP server', statusCode);
    }
  });
}

module.exports = { registerMcpRoutes };
