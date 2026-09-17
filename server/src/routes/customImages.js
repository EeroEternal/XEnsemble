const { sendPublicError } = require('../http/publicError');
const { RuntimeError } = require('../runtime/interfaces');
const { t } = require('../i18n');
const { getCatalog } = require('../runtime/customImageCatalog');
const {
  getFeatureStatus,
  createImage,
  resolveOrCreateImage,
  checkSelection,
  listImages,
  listPresets,
  publishImage,
  renameImage,
  getImage,
  getBuild,
  getBuildLog,
  rebuildImage,
  deleteImage,
} = require('../runtime/CustomImageService');

/**
 * Content-hash dedup binds a row to whichever user built the image first, and
 * that ref embeds the builder's id/slug (`custom-<userId>-<slug>:<hash>`).
 * Redact by ref provenance, not by row owner — the row belongs to the caller
 * even when the ref does not.
 */
function redactForeignImageRef(result, userId) {
  if (!result || typeof result !== 'object') return result;
  const own = (ref) => typeof ref !== 'string' || ref.includes(`custom-${userId}-`);
  const redactBuild = (build) => (build && typeof build === 'object' && !own(build.image_ref)
    ? { ...build, image_ref: null }
    : build);

  if (own(result.image_ref) && own(result.latest_build?.image_ref) && own(result.build?.image_ref)) {
    return result;
  }
  return {
    ...result,
    image_ref: own(result.image_ref) ? result.image_ref : null,
    latest_build: redactBuild(result.latest_build),
    build: redactBuild(result.build),
  };
}

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
        role: request.user.role,
      });
      return reply.code(201).send(redactForeignImageRef(result, request.user.id));
    } catch (err) {
      // Localize the "name already exists" 409 so the toast matches the user's language.
      // Matches the error thrown by CustomImageService.createImage when a user reuses a name.
      if (err.statusCode === 409 && /custom image named "[^"]+" already exists/i.test(err.message || '')) {
        const existing = (err.message || '').match(/custom image named "([^"]+)" already exists/i);
        const name = existing ? existing[1] : '';
        return reply.code(409).send({
          error: t('errors:custom_image_name_exists', { name }, request.locale || 'en'),
          code: 'custom_image_name_exists',
        });
      }
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return sendPublicError(reply, err, 'Failed to create custom image', statusCode);
    }
  });

  // Read-only: report whether a recipe is already built (instant) or needs a build.
  fastify.post('/api/v1/custom-images/check', { preValidation: authPre }, async (request, reply) => {
    try {
      const { selection } = request.body || {};
      return await checkSelection(selection);
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return sendPublicError(reply, err, 'Failed to check selection', statusCode);
    }
  });

  // Resolve a recipe (agent + components) to a usable image, creating and
  // queueing a build when no identical image has been built before.
  fastify.post('/api/v1/custom-images/resolve', { preValidation: authPre }, async (request, reply) => {
    try {
      const { selection, name } = request.body || {};
      const resolved = await resolveOrCreateImage({
        ownerUserId: request.user.id,
        selection,
        name,
        role: request.user.role,
      });
      return redactForeignImageRef(resolved, request.user.id);
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return sendPublicError(reply, err, 'Failed to resolve custom image', statusCode);
    }
  });

  // Admin-curated presets, visible to every authenticated user.
  fastify.get('/api/v1/custom-images/presets', { preValidation: authPre }, async (request, reply) => {
    try {
      return await listPresets();
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return sendPublicError(reply, err, 'Failed to list image presets', statusCode);
    }
  });

  // Publish / unpublish a preset (admin only).
  fastify.post('/api/v1/custom-images/:id/publish', { preValidation: authPre }, async (request, reply) => {
    if (request.user.role !== 'admin') {
      return reply.code(403).send({ error: 'admin_required', code: 'admin_required' });
    }
    try {
      const { is_published, description, category } = request.body || {};
      return await publishImage(request.params.id, {
        isPublished: is_published !== false,
        description: description === undefined ? null : description,
        category: category === undefined ? null : category,
      });
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return sendPublicError(reply, err, 'Failed to publish custom image', statusCode);
    }
  });

  fastify.get('/api/v1/custom-images', { preValidation: authPre }, async (request, reply) => {
    try {
      return await listImages(request.user.id, request.user.role);
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return sendPublicError(reply, err, 'Failed to list custom images', statusCode);
    }
  });

  fastify.get('/api/v1/custom-images/:id', { preValidation: authPre }, async (request, reply) => {
    try {
      return await getImage(request.user.id, request.params.id, request.user.role);
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return sendPublicError(reply, err, 'Failed to get custom image', statusCode);
    }
  });

  fastify.get('/api/v1/custom-images/:id/build', { preValidation: authPre }, async (request, reply) => {
    try {
      return await getBuild(request.user.id, request.params.id, request.user.role);
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return sendPublicError(reply, err, 'Failed to get build status', statusCode);
    }
  });

  fastify.get('/api/v1/custom-images/:id/log', { preValidation: authPre }, async (request, reply) => {
    try {
      return await getBuildLog(request.user.id, request.params.id, request.user.role);
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return sendPublicError(reply, err, 'Failed to get build log', statusCode);
    }
  });

  // Rename (same operate rule as rebuild/delete).
  fastify.patch('/api/v1/custom-images/:id', { preValidation: authPre }, async (request, reply) => {
    try {
      const { name } = request.body || {};
      return await renameImage(request.user.id, request.params.id, name, request.user.role);
    } catch (err) {
      if (err.statusCode === 403) {
        return reply.code(403).send({
          error: t('errors:custom_image_curated_readonly', { defaultValue: 'Curated images are read-only' }, request.locale || 'en'),
          code: 'custom_image_curated_readonly',
        });
      }
      if (err.statusCode === 409 && /custom image named "[^"]+" already exists/i.test(err.message || '')) {
        const existing = (err.message || '').match(/custom image named "([^"]+)" already exists/i);
        return reply.code(409).send({
          error: t('errors:custom_image_name_exists', { name: existing ? existing[1] : '' }, request.locale || 'en'),
          code: 'custom_image_name_exists',
        });
      }
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return sendPublicError(reply, err, 'Failed to rename custom image', statusCode);
    }
  });

  fastify.post('/api/v1/custom-images/:id/rebuild', { preValidation: authPre }, async (request, reply) => {
    try {
      const result = await rebuildImage(request.user.id, request.params.id, request.user.role);
      return reply.code(201).send(result);
    } catch (err) {
      if (err.statusCode === 403) {
        return reply.code(403).send({
          error: t('errors:custom_image_curated_readonly', { defaultValue: 'Curated images are read-only' }, request.locale || 'en'),
          code: 'custom_image_curated_readonly',
        });
      }
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      return sendPublicError(reply, err, 'Failed to rebuild custom image', statusCode);
    }
  });

  fastify.delete('/api/v1/custom-images/:id', { preValidation: authPre }, async (request, reply) => {
    try {
      return await deleteImage(request.user.id, request.params.id, request.user.role);
    } catch (err) {
      const statusCode = err instanceof RuntimeError ? err.statusCode : 500;
      // Localize known errors (code stays machine-readable).
      if (err.statusCode === 409 && /active session/i.test(err.message || '')) {
        const count = Number((err.message || '').match(/^Cannot delete image: (\d+)/)?.[1]) || 0;
        return reply.code(409).send({
          error: t('errors:image_in_use', { count }, request.locale || 'en'),
          code: 'image_in_use',
        });
      }
      if (err.statusCode === 403) {
        return reply.code(403).send({
          error: t('errors:custom_image_curated_readonly', { defaultValue: 'Curated images are read-only' }, request.locale || 'en'),
          code: 'custom_image_curated_readonly',
        });
      }
      if (err.statusCode === 404 && /custom image not found/i.test(err.message || '')) {
        return reply.code(404).send({
          error: t('errors:custom_image_not_found', { defaultValue: 'Custom image not found' }, request.locale || 'en'),
          code: 'custom_image_not_found',
        });
      }
      return sendPublicError(reply, err, 'Failed to delete custom image', statusCode);
    }
  });
}

module.exports = { registerCustomImageRoutes, redactForeignImageRef };
