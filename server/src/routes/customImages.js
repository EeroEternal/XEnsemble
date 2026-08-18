const { sendPublicError } = require('../http/publicError');
const { RuntimeError } = require('../runtime/interfaces');
const { getCatalog } = require('../runtime/customImageCatalog');
const {
  getFeatureStatus,
  createImage,
  listImages,
  getImage,
  getBuild,
  getBuildLog,
  rebuildImage,
  deleteImage,
} = require('../runtime/CustomImageService');

function registerCustomImageRoutes(fastify) {
  const authPre = [fastify.authenticate];

  fastify.get('/api/v1/custom-images/catalog', { preValidation: authPre }, async () => {
    const status = getFeatureStatus();
    return {
      components: getCatalog(),
      enabled: status.enabled,
      docker_available: status.dockerAvailable,
    };
  });

  fastify.post('/api/v1/custom-images', { preValidation: authPre }, async (request, reply) => {
    try {
      const { name, selection } = request.body || {};
      const result = await createImage({
        ownerUserId: request.user.id,
        name,
        selection,
      });
      return reply.code(201).send(result);
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return sendPublicError(reply, err, 'Failed to create custom image', statusCode);
    }
  });

  fastify.get('/api/v1/custom-images', { preValidation: authPre }, async (request, reply) => {
    try {
      return await listImages(request.user.id);
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return sendPublicError(reply, err, 'Failed to list custom images', statusCode);
    }
  });

  fastify.get('/api/v1/custom-images/:id', { preValidation: authPre }, async (request, reply) => {
    try {
      return await getImage(request.user.id, request.params.id);
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return sendPublicError(reply, err, 'Failed to get custom image', statusCode);
    }
  });

  fastify.get('/api/v1/custom-images/:id/build', { preValidation: authPre }, async (request, reply) => {
    try {
      return await getBuild(request.user.id, request.params.id);
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return sendPublicError(reply, err, 'Failed to get build status', statusCode);
    }
  });

  fastify.get('/api/v1/custom-images/:id/log', { preValidation: authPre }, async (request, reply) => {
    try {
      return await getBuildLog(request.user.id, request.params.id);
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return sendPublicError(reply, err, 'Failed to get build log', statusCode);
    }
  });

  fastify.post('/api/v1/custom-images/:id/rebuild', { preValidation: authPre }, async (request, reply) => {
    try {
      const result = await rebuildImage(request.user.id, request.params.id);
      return reply.code(201).send(result);
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return sendPublicError(reply, err, 'Failed to rebuild custom image', statusCode);
    }
  });

  fastify.delete('/api/v1/custom-images/:id', { preValidation: authPre }, async (request, reply) => {
    try {
      return await deleteImage(request.user.id, request.params.id);
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return sendPublicError(reply, err, 'Failed to delete custom image', statusCode);
    }
  });
}

module.exports = { registerCustomImageRoutes };
