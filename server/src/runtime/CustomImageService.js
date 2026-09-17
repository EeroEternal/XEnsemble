const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { eq, ne, and, or, desc, sql, inArray } = require('drizzle-orm');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { RuntimeError } = require('./interfaces');
const { imageRegistry: getImageRegistry, resolveExplicitAgentImage } = require('./agentBoxImages');
const { validateSelection, getComponentDiskSizeMb } = require('./customImageCatalog');
const { renderDockerfile } = require('./customImageRenderer');

const BUILD_LOG_DIR = process.env.CUSTOM_IMAGE_BUILD_LOG_DIR
  || path.join(process.cwd(), '.data', 'custom-image-builds');

const MAX_LOG_TAIL_BYTES = parseInt(
  process.env.CUSTOM_IMAGE_BUILD_LOG_MAX_BYTES || String(256 * 1024),
  10,
);

const MAX_GLOBAL_CONCURRENCY = parseInt(
  process.env.CUSTOM_IMAGE_BUILD_MAX_CONCURRENCY || '2',
  10,
);

const MAX_PER_USER = parseInt(
  process.env.CUSTOM_IMAGE_MAX_PER_USER || '10',
  10,
);

const MAX_CONCURRENT_PER_USER = parseInt(
  process.env.CUSTOM_IMAGE_BUILD_MAX_PER_USER || '1',
  10,
);

const BUILD_TIMEOUT_MS = parseInt(
  process.env.CUSTOM_IMAGE_BUILD_TIMEOUT_MS || String(30 * 60 * 1000),
  10,
);

let enabled = process.env.CUSTOM_IMAGE_BUILDS_ENABLED !== 'false';
let dockerAvailable = false;

class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.queue = [];
  }

  acquire() {
    return new Promise((resolve) => {
      if (this.count < this.max) {
        this.count += 1;
        resolve();
        return;
      }
      this.queue.push(resolve);
    });
  }

  release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    } else {
      this.count = Math.max(0, this.count - 1);
    }
  }
}

const globalSemaphore = new Semaphore(MAX_GLOBAL_CONCURRENCY);
const userSemaphores = new Map();

function getFeatureStatus() {
  return { enabled, dockerAvailable, maxConcurrency: MAX_GLOBAL_CONCURRENCY };
}

async function probeDocker() {
  try {
    await execAsync('docker info', { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

async function initService() {
  dockerAvailable = await probeDocker();
  if (!dockerAvailable) {
    enabled = false;
  }
}

function getUserSemaphore(userId) {
  if (!userSemaphores.has(userId)) {
    userSemaphores.set(userId, new Semaphore(MAX_CONCURRENT_PER_USER));
  }
  return userSemaphores.get(userId);
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || `img-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Recipe identity. `baseImage` (the resolved agent image used as the build
 * parent) is part of the identity because the agent CLI is inherited from it —
 * otherwise a rebuilt/retagged agent image would keep matching a stale recipe.
 */
function selectionContentHash(components, baseImage = null) {
  const list = typeof components === 'string' ? JSON.parse(components) : components;
  const key = list.map((s) => `${s.component_id}@${s.version}`).sort().join('\n');
  return crypto.createHash('sha256')
    .update(baseImage ? `${key}\nbase:${baseImage}` : key)
    .digest('hex').slice(0, 12);
}

function buildImageRef(ownerUserId, slug, components, baseImage = null) {
  const registry = getImageRegistry();
  return `${registry}/custom-${ownerUserId}-${slug}:${selectionContentHash(components, baseImage)}`;
}

/**
 * Base image to build a recipe on: the agent's explicitly configured image
 * (active DB row or BLINK_IMAGE_<AGENT> override). Returns null when the agent
 * image was never built/registered, in which case the recipe falls back to
 * box-base + installing the agent CLI itself.
 */
async function resolveRecipeBaseImage(selection) {
  if (process.env.CUSTOM_IMAGE_FROM_AGENT_IMAGE === 'false') return null;
  const agentComponent = (selection || []).find((s) => (s.component_id || '').startsWith('agent:'));
  if (!agentComponent) return null;
  const agentId = agentComponent.component_id.slice('agent:'.length);
  try {
    return await resolveExplicitAgentImage(agentId);
  } catch (_) {
    return null;
  }
}

/**
 * A ready build with this content hash can be reused for any user — the hash is
 * derived from component_id@version pairs + the resolved base image, so an
 * identical recipe always produces identical layers. Indexed on
 * (content_hash, state) since P2.
 */
async function findReadyBuildByHash(contentHash) {
  if (!contentHash) return null;
  const rows = await db.select().from(schema.customImageBuilds)
    .where(and(
      eq(schema.customImageBuilds.contentHash, contentHash),
      eq(schema.customImageBuilds.state, 'ready'),
    ))
    .limit(1);
  return rows[0] || null;
}

/**
 * Insert one build row. Shared by every creation path so the row shape
 * (content_hash, ready timestamps) stays consistent.
 */
async function createBuildRow({
  customImageId,
  contentHash,
  state,
  imageRef = null,
  logsRef = null,
  failureReason = null,
}) {
  const buildId = `cbld_${crypto.randomBytes(8).toString('hex')}`;
  const now = Date.now();
  await db.insert(schema.customImageBuilds).values({
    id: buildId,
    customImageId,
    state,
    imageRef,
    contentHash,
    logsRef,
    failureReason,
    startedAt: state === 'ready' ? now : null,
    finishedAt: state === 'ready' ? now : null,
    createdAt: now,
  });
  return buildId;
}

/**
 * Auto-created rows are keyed by recipe hash (not by name), so their display
 * name can be a readable summary of the environment.
 */
async function findAutoRowByHash(ownerUserId, contentHash) {
  if (!contentHash) return null;
  const rows = await db.select({ image: schema.customImages })
    .from(schema.customImages)
    .innerJoin(
      schema.customImageBuilds,
      eq(schema.customImageBuilds.customImageId, schema.customImages.id),
    )
    .where(and(
      eq(schema.customImages.ownerUserId, ownerUserId),
      eq(schema.customImages.isAuto, true),
      eq(schema.customImageBuilds.contentHash, contentHash),
    ))
    .limit(1);
  return rows[0]?.image || null;
}

/**
 * Default name for an auto-created recipe row: `env-<content hash>`. Identity is
 * the content hash, so the name is only a label — users can rename it later.
 * The DB constraint is (owner_user_id, name) across all rows, so the taken set
 * includes user-named images too and collisions get a numeric suffix.
 */
async function nextAutoImageName(ownerUserId, contentHash) {
  const base = `env-${contentHash}`;
  const takenRows = await db.select({ name: schema.customImages.name })
    .from(schema.customImages)
    .where(eq(schema.customImages.ownerUserId, ownerUserId));
  const taken = new Set(takenRows.map((r) => r.name));
  let name = base;
  let n = 2;
  while (taken.has(name)) {
    name = `${base} (${n})`;
    n += 1;
  }
  return name;
}

/** A reused image is "alive" again: clear the GC marker and refresh idle time. */
async function reviveIfStale(imageRow) {
  if (!imageRow || !imageRow.staleAt) return;
  await db.update(schema.customImages)
    .set({ staleAt: null, updatedAt: Date.now() })
    .where(eq(schema.customImages.id, imageRow.id));
}

function ensureLogDir() {
  if (!fs.existsSync(BUILD_LOG_DIR)) {
    fs.mkdirSync(BUILD_LOG_DIR, { recursive: true });
  }
}

// Limits are read on the hot /check + /resolve paths; a short cache avoids one
// platform_settings query per keystroke-debounced check.
let _limitsCache = null;
let _limitsCacheAt = 0;
async function getLimits() {
  const now = Date.now();
  if (_limitsCache && (now - _limitsCacheAt) < 5000) return _limitsCache;
  const platformSettings = require('../admin/PlatformSettings');
  _limitsCache = await platformSettings.getCustomImageLimits();
  _limitsCacheAt = now;
  return _limitsCache;
}

/** Reject recipes that exceed the configured component count / disk budget. */
async function enforceRecipeLimits(selection) {
  const limits = await getLimits();
  const maxComponents = Number(limits.max_components_per_recipe) || 6;
  if (selection.length > maxComponents) {
    throw new RuntimeError(
      `recipe has ${selection.length} components; the limit is ${maxComponents}`,
      400,
    );
  }
  const maxDiskMb = (Number(limits.max_disk_gb) || 20) * 1024;
  const diskMb = selection.reduce(
    (sum, s) => sum + getComponentDiskSizeMb(s.component_id, s.version),
    0,
  );
  if (diskMb > maxDiskMb) {
    throw new RuntimeError(
      `recipe needs ${diskMb}MB of disk; the limit is ${maxDiskMb}MB`,
      400,
    );
  }
}

/**
 * Per-user image count limit. Every image the user owns counts (named + inline
 * recipe rows) against `max_custom_images`, using the exact same predicate as
 * `PolicyService.getUsage` so the displayed usage and the enforced limit agree.
 * Pre-epoch rows are grandfathered by the shared QUOTA_EPOCH_MS filter.
 * `max_env_images_per_user` remains an additional platform safety cap on the
 * auto-created recipe bucket.
 */
async function enforceImageQuota(ownerUserId, isAuto, role = null) {
  if (role === 'admin') return;

  const { ensureUserQuota, QUOTA_EPOCH_MS } = require('../auth/PolicyService');
  const quotaRow = await ensureUserQuota(ownerUserId);
  let limit = Number(quotaRow?.maxCustomImages);
  if (!Number.isFinite(limit)) limit = 10;

  // Curated images are excluded: publishing hands the image to the platform.
  const countRows = (extra) => db.select({ id: schema.customImages.id })
    .from(schema.customImages)
    .where(and(
      eq(schema.customImages.ownerUserId, ownerUserId),
      eq(schema.customImages.isPublished, false),
      sql`${schema.customImages.createdAt} >= ${QUOTA_EPOCH_MS}`,
      ...extra,
    ));

  const used = (await countRows([])).length;
  if (used >= limit) {
    throw new RuntimeError(
      `custom image limit reached (${used}/${limit})`,
      409,
    );
  }

  if (isAuto) {
    const limits = await getLimits();
    const autoLimit = Number(limits.max_env_images_per_user) || 50;
    const autoUsed = (await countRows([eq(schema.customImages.isAuto, true)])).length;
    if (autoUsed >= autoLimit) {
      throw new RuntimeError(
        `custom image limit reached (${autoUsed}/${autoLimit})`,
        409,
      );
    }
  }
}

/**
 * Mark an image as used so the GC idle window reflects real session usage.
 * Only writes when the image is stale or has not been touched in an hour, so
 * the session-start hot path stays read-only in the common case.
 */
async function touchImageUsage(imageId) {
  if (!imageId) return;
  const now = Date.now();
  await db.update(schema.customImages)
    .set({ staleAt: null, updatedAt: now })
    .where(and(
      eq(schema.customImages.id, imageId),
      or(
        sql`${schema.customImages.staleAt} IS NOT NULL`,
        sql`${schema.customImages.updatedAt} < ${now - 3600000}`,
      ),
    ));
}

function formatImageRow(row, latestBuild) {
  if (!row) return null;
  return {
    id: row.id,
    owner_user_id: row.ownerUserId,
    name: row.name,
    slug: row.slug,
    components: typeof row.components === 'string'
      ? JSON.parse(row.components)
      : row.components,
    image_ref: row.imageRef || null,
    is_published: Boolean(row.isPublished),
    is_auto: Boolean(row.isAuto),
    description: row.description || null,
    category: row.category || null,
    stale_at: row.staleAt || null,
    status: latestBuild ? latestBuild.state : null,
    latest_build: latestBuild ? formatBuildRow(latestBuild) : null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function formatBuildRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    custom_image_id: row.customImageId,
    state: row.state,
    image_ref: row.imageRef || null,
    logs_ref: row.logsRef || null,
    failure_reason: row.failureReason || null,
    started_at: row.startedAt || null,
    finished_at: row.finishedAt || null,
    created_at: row.createdAt,
  };
}

/**
 * Visibility: admins see everything; a user sees their own images plus the
 * admin-curated (`is_published`) ones. Admin-owned but unpublished images are
 * private to that admin.
 */
function canViewImage(image, userId, role) {
  if (role === 'admin') return true;
  if (image.ownerUserId === userId) return true;
  return Boolean(image.isPublished);
}

/**
 * Mutation (rebuild / delete): admins may touch anything; a user may only touch
 * their own images, and once an image is curated by an admin its lifecycle is
 * owned by the platform — the original owner can no longer edit or delete it.
 */
function canOperateImage(image, userId, role) {
  if (role === 'admin') return true;
  return image.ownerUserId === userId && !image.isPublished;
}

/**
 * Resolve an image for the given access mode.
 * Returns null when the image does not exist; throws 404 when it is invisible to
 * the caller and 403 when it is visible but not operable.
 */
async function assertImageAccess(userId, imageId, { role = null, mode = 'view' } = {}) {
  const rows = await db.select().from(schema.customImages)
    .where(eq(schema.customImages.id, imageId));
  if (rows.length === 0) return null;
  const image = rows[0];

  if (mode === 'operate') {
    if (canOperateImage(image, userId, role)) return image;
    if (canViewImage(image, userId, role)) {
      throw new RuntimeError('curated images are read-only', 403);
    }
  } else if (canViewImage(image, userId, role)) {
    return image;
  }

  throw new RuntimeError(`custom image not found (id=${imageId})`, 404);
}

async function getLatestBuild(imageId) {
  const rows = await db.select().from(schema.customImageBuilds)
    .where(eq(schema.customImageBuilds.customImageId, imageId))
    .orderBy(desc(schema.customImageBuilds.createdAt))
    .limit(1);
  return rows[0] || null;
}

async function createImage({ ownerUserId, name, selection, role = null }) {
  if (!enabled) {
    throw new RuntimeError('custom image builds are not available', 503);
  }

  if (!ownerUserId || !name || !Array.isArray(selection)) {
    throw new RuntimeError('ownerUserId, name, and selection are required', 400);
  }

  const validation = validateSelection(selection);
  if (!validation.ok) {
    throw new RuntimeError(`invalid selection: ${validation.error}`, 400);
  }
  await enforceRecipeLimits(selection);

  const trimmedName = name.trim();
  const slug = slugify(trimmedName);

  const existing = await db.select().from(schema.customImages)
    .where(and(
      eq(schema.customImages.ownerUserId, ownerUserId),
      eq(schema.customImages.name, trimmedName),
    ));
  if (existing.length > 0) {
    throw new RuntimeError(
      `custom image named "${trimmedName}" already exists`,
      409,
    );
  }
  await enforceImageQuota(ownerUserId, false, role);

  const now = Date.now();
  const imageId = `cimg_${crypto.randomBytes(8).toString('hex')}`;

  // Check if an image built from the exact same selection already exists.
  // Content hash = sorted component_id + version pairs (+ resolved base image).
  const baseImage = await resolveRecipeBaseImage(selection);
  const contentHash = selectionContentHash(selection, baseImage);

  const dup = await findReadyBuildByHash(contentHash);
  const canReuse = Boolean(dup && dup.imageRef);

  await db.insert(schema.customImages).values({
    id: imageId,
    ownerUserId,
    name: trimmedName,
    slug,
    components: JSON.stringify(selection),
    imageRef: canReuse ? dup.imageRef : null,
    createdAt: now,
    updatedAt: now,
  });

  const buildId = await createBuildRow({
    customImageId: imageId,
    contentHash,
    state: canReuse ? 'ready' : 'queued',
    imageRef: canReuse ? dup.imageRef : null,
  });

  if (!canReuse) setImmediate(() => processBuildQueue(ownerUserId));

  const image = await db.select().from(schema.customImages)
    .where(eq(schema.customImages.id, imageId));
  const build = await db.select().from(schema.customImageBuilds)
    .where(eq(schema.customImageBuilds.id, buildId));
  return {
    ...formatImageRow(image[0], build[0]),
    build: formatBuildRow(build[0]),
  };
}

/**
 * Read-only readiness probe for a recipe. Used by the launch dialog to show
 * "starts instantly" vs "needs a build" without creating a row or a build.
 */
async function checkSelection(selection) {
  const validation = validateSelection(selection);
  if (!validation.ok) {
    throw new RuntimeError(`invalid selection: ${validation.error}`, 400);
  }
  const baseImage = await resolveRecipeBaseImage(selection);
  const contentHash = selectionContentHash(selection, baseImage);
  const dup = await findReadyBuildByHash(contentHash);
  // Only the readiness flag + opaque hash are returned: the matched image_ref
  // embeds the owning user's id/slug and must not leak across tenants.
  return {
    ready: Boolean(dup && dup.imageRef),
    content_hash: contentHash,
  };
}

/**
 * Resolve a recipe to a ready-to-use custom image, creating (and queueing a
 * build for) the caller's image row when needed. Reuses any existing ready
 * build with the same content hash, so a previously built recipe is instant.
 *
 * The returned row may still be `queued`/`building`; callers that need the
 * image now should await `waitForReadyImageRef`.
 */
async function resolveOrCreateImage({ ownerUserId, selection, name = null, role = null }) {
  if (!ownerUserId || !Array.isArray(selection)) {
    throw new RuntimeError('ownerUserId and selection are required', 400);
  }
  const validation = validateSelection(selection);
  if (!validation.ok) {
    throw new RuntimeError(`invalid selection: ${validation.error}`, 400);
  }
  await enforceRecipeLimits(selection);

  const baseImage = await resolveRecipeBaseImage(selection);
  const contentHash = selectionContentHash(selection, baseImage);
  const explicitName = name && String(name).trim();
  const isAuto = !explicitName;

  // Never trust the name alone: a row must still hold the exact recipe —
  // including the resolved base (agent) image, so a row built from a since
  // rebuilt/retagged agent image is not treated as a match.
  const matchesRecipe = (imageRow) => {
    try {
      const stored = typeof imageRow.components === 'string'
        ? JSON.parse(imageRow.components)
        : imageRow.components;
      return selectionContentHash(stored, baseImage) === contentHash;
    } catch (_) {
      return false;
    }
  };

  const liveBuild = (imageRow) => getLatestBuild(imageRow.id).then((latest) =>
    (latest && (latest.state === 'ready' || latest.state === 'queued' || latest.state === 'building'))
      ? { ...formatImageRow(imageRow, latest), build: formatBuildRow(latest) }
      : null);

  // Auto rows are identified by recipe hash, so their display name is free-form
  // (and readable) rather than a hash-derived slug.
  const findExistingRow = async () => (isAuto
    ? findAutoRowByHash(ownerUserId, contentHash)
    : ((await db.select().from(schema.customImages).where(and(
      eq(schema.customImages.ownerUserId, ownerUserId),
      eq(schema.customImages.name, explicitName),
      eq(schema.customImages.isAuto, false),
    )))[0] || null));

  const existing = await findExistingRow();

  if (existing && matchesRecipe(existing)) {
    const reused = await liveBuild(existing);
    if (reused) {
      await reviveIfStale(existing);
      return reused;
    }
    // Same recipe but no usable build (latest is failed, or none at all):
    // re-queue instead of locking the recipe out forever.
    await reviveIfStale(existing);
    const retryBuildId = await createBuildRow({
      customImageId: existing.id,
      contentHash,
      state: 'queued',
    });
    setImmediate(() => processBuildQueue(ownerUserId));
    const retryBuild = await db.select().from(schema.customImageBuilds)
      .where(eq(schema.customImageBuilds.id, retryBuildId));
    return {
      ...formatImageRow(existing, retryBuild[0]),
      build: formatBuildRow(retryBuild[0]),
    };
  }

  if (existing) {
    throw new RuntimeError(
      explicitName
        ? `custom image named "${explicitName}" already exists with a different recipe`
        : 'custom image already exists with a different recipe',
      409,
    );
  }

  const imageName = explicitName || await nextAutoImageName(ownerUserId, contentHash);
  const slug = slugify(imageName);

  const dup = await findReadyBuildByHash(contentHash);
  const canReuse = Boolean(dup && dup.imageRef);
  if (!canReuse && (!enabled || !dockerAvailable)) {
    throw new RuntimeError('custom image builds are not available', 503);
  }

  // Atomic get-or-create: two concurrent resolves for the same user+recipe must
  // not both insert into the (owner_user_id, name) unique constraint.
  let imageRow = existing;
  if (!imageRow) {
    await enforceImageQuota(ownerUserId, isAuto, role);
    const inserted = await db.insert(schema.customImages).values({
      id: `cimg_${crypto.randomBytes(8).toString('hex')}`,
      ownerUserId,
      name: imageName,
      slug,
      components: JSON.stringify(selection),
      imageRef: canReuse ? dup.imageRef : null,
      isAuto,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).onConflictDoNothing().returning();
    if (inserted.length > 0) {
      imageRow = inserted[0];
    } else {
      imageRow = await findExistingRow();
      if (!imageRow) throw new RuntimeError('failed to resolve custom image', 500);
      const reused = await liveBuild(imageRow);
      if (reused) return reused;
    }
  }

  const now = Date.now();
  const buildId = await createBuildRow({
    customImageId: imageRow.id,
    contentHash,
    state: canReuse ? 'ready' : 'queued',
    imageRef: canReuse ? dup.imageRef : null,
  });
  if (canReuse) {
    await db.update(schema.customImages)
      .set({ imageRef: dup.imageRef, updatedAt: now })
      .where(eq(schema.customImages.id, imageRow.id));
  } else {
    setImmediate(() => processBuildQueue(ownerUserId));
  }

  const build = await db.select().from(schema.customImageBuilds).where(eq(schema.customImageBuilds.id, buildId));
  return { ...formatImageRow({ ...imageRow, imageRef: canReuse ? dup.imageRef : imageRow.imageRef }, build[0]), build: formatBuildRow(build[0]) };
}

/**
 * List images visible to the caller: admins see every user's images; regular
 * users see their own plus the admin-curated (published) ones. Each row carries
 * `can_operate` so the UI can hide actions without re-deriving the rule, and
 * admins additionally get the owner's username.
 */
async function listImages(ownerUserId, role = null) {
  const images = await db.select().from(schema.customImages)
    .where(role === 'admin'
      ? undefined
      : or(
        eq(schema.customImages.ownerUserId, ownerUserId),
        eq(schema.customImages.isPublished, true),
      ))
    .orderBy(desc(schema.customImages.createdAt));

  const { ensureUserQuota, getUsage } = require('../auth/PolicyService');
  const [quotaRow, usage, ownerRows] = await Promise.all([
    ensureUserQuota(ownerUserId),
    getUsage(ownerUserId),
    role === 'admin' && images.length > 0
      ? db.select({ id: schema.users.id, username: schema.users.username })
        .from(schema.users)
        .where(inArray(schema.users.id, [...new Set(images.map((i) => i.ownerUserId))]))
      : Promise.resolve([]),
  ]);
  const usernameById = new Map(ownerRows.map((u) => [u.id, u.username]));

  let latestBuildMap = new Map();
  if (images.length > 0) {
    const allBuilds = await db.select().from(schema.customImageBuilds)
      .where(inArray(schema.customImageBuilds.customImageId, images.map((img) => img.id)))
      .orderBy(desc(schema.customImageBuilds.createdAt));
    for (const build of allBuilds) {
      if (!latestBuildMap.has(build.customImageId)) {
        latestBuildMap.set(build.customImageId, build);
      }
    }
  }

  const result = images.map((image) => ({
    ...formatImageRow(image, latestBuildMap.get(image.id) || null),
    owner_username: usernameById.get(image.ownerUserId) || null,
    can_operate: canOperateImage(image, ownerUserId, role),
  }));

  // Admins are not quota-limited, so don't surface a misleading max for them.
  const max = role === 'admin' ? null : Number(quotaRow?.maxCustomImages);
  return {
    images: result,
    count: result.length,
    max: Number.isFinite(max) ? max : null,
    quota: {
      used: usage.custom_images ?? 0,
      max: Number.isFinite(max) ? max : null,
    },
  };
}

/**
 * Admin-curated catalog: published images that are actually ready. Visible to
 * every user so they can start instantly without triggering a build.
 */
async function listPresets() {
  const images = await db.select().from(schema.customImages)
    .where(and(
      eq(schema.customImages.isPublished, true),
      sql`EXISTS (
        SELECT 1 FROM custom_image_builds b
         WHERE b.custom_image_id = ${schema.customImages.id}
           AND b.state = 'ready'
      )`,
    ))
    .orderBy(desc(schema.customImages.updatedAt));

  if (images.length === 0) return { presets: [] };

  const imageIds = images.map((img) => img.id);
  const builds = await db.select().from(schema.customImageBuilds)
    .where(inArray(schema.customImageBuilds.customImageId, imageIds))
    .orderBy(desc(schema.customImageBuilds.createdAt));
  const latest = new Map();
  for (const build of builds) {
    if (!latest.has(build.customImageId)) latest.set(build.customImageId, build);
  }

  return {
    presets: images
      .map((image) => formatImageRow(image, latest.get(image.id) || null))
      .filter((image) => image.status === 'ready'),
  };
}

/**
 * GC: reclaim custom images nobody uses. Two-phase so an image is never deleted
 * while it is still referenced:
 *   1st pass → mark `stale_at`; 2nd pass (after the grace period) → delete.
 * Published presets, admin-owned images, active sessions and workspace defaults
 * are never candidates.
 */
async function collectStaleImages({ idleDays, graceHours, limit = 50 } = {}) {
  const limits = await getLimits();
  const days = idleDays !== undefined ? Number(idleDays) : (Number(limits.gc_idle_days) || 30);
  const grace = graceHours !== undefined ? Number(graceHours) : (Number(limits.gc_grace_hours) || 24);
  const now = Date.now();
  const cutoff = now - days * 86400000;

  const candidates = await db.select().from(schema.customImages)
    .where(and(
      eq(schema.customImages.isPublished, false),
      sql`${schema.customImages.updatedAt} < ${cutoff}`,
      sql`${schema.customImages.ownerUserId} NOT IN (SELECT id FROM users WHERE role = 'admin')`,
      sql`NOT EXISTS (SELECT 1 FROM projects p WHERE p.default_custom_image_id = ${schema.customImages.id})`,
      sql`NOT EXISTS (SELECT 1 FROM sessions s WHERE s.custom_image_id = ${schema.customImages.id} AND s.status <> 'exited')`,
      sql`NOT EXISTS (
        SELECT 1 FROM custom_image_builds b
         WHERE b.custom_image_id = ${schema.customImages.id}
           AND b.state IN ('queued', 'building')
      )`,
    ))
    .limit(limit);

  let marked = 0;
  let deleted = 0;
  for (const image of candidates) {
    if (!image.staleAt) {
      await db.update(schema.customImages)
        .set({ staleAt: now })
        .where(eq(schema.customImages.id, image.id));
      marked += 1;
      continue;
    }
    if (now - Number(image.staleAt) < grace * 3600000) continue;
    try {
      await deleteImage(image.ownerUserId, image.id);
      deleted += 1;
    } catch (err) {
      // A reference may have appeared between the query and the delete.
      if (!(err instanceof RuntimeError)) throw err;
    }
  }
  return { marked, deleted, scanned: candidates.length };
}

/**
 * Publish / unpublish a curated preset. Admin-only (enforced by the route).
 */
async function publishImage(imageId, { isPublished = true, description = null, category = null } = {}) {
  const rows = await db.select().from(schema.customImages)
    .where(eq(schema.customImages.id, imageId));
  if (rows.length === 0) throw new RuntimeError('custom image not found', 404);

  if (isPublished) {
    const latest = await getLatestBuild(imageId);
    if (!latest || latest.state !== 'ready') {
      throw new RuntimeError('only ready images can be published', 400);
    }
  }

  await db.update(schema.customImages)
    .set({
      isPublished: Boolean(isPublished),
      description: description === null ? rows[0].description : String(description).slice(0, 500),
      category: category === null ? rows[0].category : String(category).slice(0, 64),
      updatedAt: Date.now(),
    })
    .where(eq(schema.customImages.id, imageId));

  const image = (await db.select().from(schema.customImages)
    .where(eq(schema.customImages.id, imageId)))[0];
  return formatImageRow(image, await getLatestBuild(imageId));
}

const IMAGE_NAME_MAX_LENGTH = 80;

/**
 * Rename an image. Follows the same operate rule as rebuild/delete: admins may
 * rename anything, a user only their own non-curated images.
 */
async function renameImage(ownerUserId, imageId, name, role = null) {
  const image = await assertImageAccess(ownerUserId, imageId, { role, mode: 'operate' });
  if (!image) throw new RuntimeError('custom image not found', 404);

  const trimmed = String(name || '').trim();
  if (!trimmed) throw new RuntimeError('image name is required', 400);
  if (trimmed.length > IMAGE_NAME_MAX_LENGTH) {
    throw new RuntimeError(`image name must be at most ${IMAGE_NAME_MAX_LENGTH} characters`, 400);
  }

  const clash = await db.select({ id: schema.customImages.id }).from(schema.customImages)
    .where(and(
      eq(schema.customImages.ownerUserId, image.ownerUserId),
      eq(schema.customImages.name, trimmed),
    ));
  if (clash.length > 0 && clash[0].id !== imageId) {
    throw new RuntimeError(`custom image named "${trimmed}" already exists`, 409);
  }

  const updatedAt = Date.now();
  await db.update(schema.customImages)
    .set({ name: trimmed, slug: slugify(trimmed), updatedAt })
    .where(eq(schema.customImages.id, imageId));

  return formatImageRow(
    { ...image, name: trimmed, slug: slugify(trimmed), updatedAt },
    await getLatestBuild(imageId),
  );
}

async function getImage(ownerUserId, imageId, role = null) {
  const image = await assertImageAccess(ownerUserId, imageId, { role, mode: 'view' });
  if (!image) throw new RuntimeError('custom image not found', 404);

  const latestBuild = await getLatestBuild(image.id);
  return formatImageRow(image, latestBuild);
}

async function getBuild(ownerUserId, imageId, role = null) {
  const image = await assertImageAccess(ownerUserId, imageId, { role, mode: 'view' });
  if (!image) throw new RuntimeError('custom image not found', 404);

  const latestBuild = await getLatestBuild(image.id);
  if (!latestBuild) throw new RuntimeError('no build found for this image', 404);
  return formatBuildRow(latestBuild);
}

async function getBuildLog(ownerUserId, imageId, role = null) {
  const image = await assertImageAccess(ownerUserId, imageId, { role, mode: 'view' });
  if (!image) throw new RuntimeError('custom image not found', 404);

  const latestBuild = await getLatestBuild(image.id);
  if (!latestBuild || !latestBuild.logsRef) {
    return { logs: '', truncated: false, available: false };
  }

  const logPath = path.resolve(BUILD_LOG_DIR, latestBuild.logsRef);
  if (!logPath.startsWith(path.resolve(BUILD_LOG_DIR) + path.sep)) {
    return { logs: '', truncated: false, available: false };
  }

  let size;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return { logs: '', truncated: false, available: false };
  }

  if (size === 0) return { logs: '', truncated: false, available: true };

  const start = Math.max(0, size - MAX_LOG_TAIL_BYTES);
  try {
    const fd = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return {
        logs: buffer.toString('utf8'),
        truncated: start > 0,
        available: true,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { logs: '', truncated: false, available: false };
  }
}

async function rebuildImage(ownerUserId, imageId, role = null) {
  // Authorize before reporting build availability, so callers cannot probe
  // build state for images they may not operate.
  const image = await assertImageAccess(ownerUserId, imageId, { role, mode: 'operate' });
  if (!image) throw new RuntimeError('custom image not found', 404);

  if (!enabled) {
    throw new RuntimeError('custom image builds are not available', 503);
  }
  if (!dockerAvailable) {
    throw new RuntimeError('docker is not available', 503);
  }

  const latestBuild = await getLatestBuild(image.id);
  if (latestBuild && (latestBuild.state === 'queued' || latestBuild.state === 'building')) {
    throw new RuntimeError('image build already in progress', 409);
  }

  const selection = typeof image.components === 'string'
    ? JSON.parse(image.components)
    : image.components;
  const baseImage = await resolveRecipeBaseImage(selection);
  const contentHash = selectionContentHash(selection, baseImage);

  await db.update(schema.customImages)
    .set({ staleAt: null, updatedAt: Date.now() })
    .where(eq(schema.customImages.id, imageId));

  const buildId = await createBuildRow({
    customImageId: imageId,
    contentHash,
    state: 'queued',
  });

  setImmediate(() => processBuildQueue(ownerUserId));

  const buildRows = await db.select().from(schema.customImageBuilds)
    .where(eq(schema.customImageBuilds.id, buildId));
  return {
    ...formatImageRow(image, buildRows[0]),
    build: formatBuildRow(buildRows[0]),
  };
}

async function deleteImage(ownerUserId, imageId, role = null) {
  const image = await assertImageAccess(ownerUserId, imageId, { role, mode: 'operate' });
  if (!image) throw new RuntimeError('custom image not found', 404);

  // Check if any active session is using this image.
  const activeSessions = await db.select({ id: schema.sessions.id, projectId: schema.sessions.projectId })
    .from(schema.sessions)
    .where(and(
      eq(schema.sessions.customImageId, imageId),
      sql`${schema.sessions.status} NOT IN ('exited')`,
    ));
  if (activeSessions.length > 0) {
    throw new RuntimeError(
      `Cannot delete image: ${activeSessions.length} active session(s) are using it`,
      409,
    );
  }

  // Clear workspace defaults pointing at this image first, otherwise the
  // workspace would keep a dangling default and every later session start in it
  // would fail with a 404.
  const defaultedProjects = await db.select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.defaultCustomImageId, imageId));
  if (defaultedProjects.length > 0) {
    await db.update(schema.projects)
      .set({ defaultCustomImageId: null })
      .where(eq(schema.projects.defaultCustomImageId, imageId));
    try {
      const { invalidateProjectCache } = require('../projects/getProjectForUser');
      for (const project of defaultedProjects) invalidateProjectCache(project.id);
    } catch (_) {
      /* cache invalidation is best-effort */
    }
  }

  // Content-hash dedup means several rows (possibly across users) can point at
  // the same registry image. Only delete the manifest when this row is the last
  // reference, otherwise deleting one user's row would break every other user
  // still using the shared artifact.
  let imageRefShared = false;
  if (image.imageRef) {
    const [otherImages, otherBuilds] = await Promise.all([
      db.select({ id: schema.customImages.id }).from(schema.customImages)
        .where(and(
          eq(schema.customImages.imageRef, image.imageRef),
          ne(schema.customImages.id, imageId),
        ))
        .limit(1),
      db.select({ id: schema.customImageBuilds.id }).from(schema.customImageBuilds)
        .where(and(
          eq(schema.customImageBuilds.imageRef, image.imageRef),
          ne(schema.customImageBuilds.customImageId, imageId),
        ))
        .limit(1),
    ]);
    imageRefShared = otherImages.length > 0 || otherBuilds.length > 0;
  }

  // Delete from Docker registry (best-effort).
  if (image.imageRef && !imageRefShared) {
    try {
      const ref = image.imageRef;
      const lastColon = ref.lastIndexOf(':');
      const namePart = ref.slice(0, lastColon);
      const tag = ref.slice(lastColon + 1);
      const firstSlash = namePart.indexOf('/');
      const hostPort = namePart.slice(0, firstSlash);
      const repoName = namePart.slice(firstSlash + 1);
      const getDigest = await fetch(
        `http://${hostPort}/v2/${repoName}/manifests/${tag}`,
        { method: 'HEAD', headers: { Accept: 'application/vnd.oci.image.index.v1+json' } },
      );
      if (getDigest.ok) {
        const digest = getDigest.headers.get('docker-content-digest');
        if (digest) {
          await fetch(
            `http://${hostPort}/v2/${repoName}/manifests/${digest}`,
            { method: 'DELETE' },
          ).catch(() => {});
        }
      }
    } catch (_) { /* registry cleanup is best-effort */ }
  }

  await db.delete(schema.customImageBuilds)
    .where(eq(schema.customImageBuilds.customImageId, imageId));

  await db.delete(schema.customImages)
    .where(eq(schema.customImages.id, imageId));

  return { ok: true, id: imageId };
}

let buildLoopRunning = false;

async function processBuildQueue(ownerUserId) {
  if (!enabled || !dockerAvailable) return;

  if (buildLoopRunning) return;
  buildLoopRunning = true;

  try {
    while (true) {
      const next = await db.select().from(schema.customImageBuilds)
        .where(eq(schema.customImageBuilds.state, 'queued'))
        .orderBy(schema.customImageBuilds.createdAt)
        .limit(1);

      if (next.length === 0) break;

      const build = next[0];
      const imageRows = await db.select().from(schema.customImages)
        .where(eq(schema.customImages.id, build.customImageId));
      if (imageRows.length === 0) {
        await db.update(schema.customImageBuilds)
          .set({ state: 'failed', failureReason: 'custom image record not found', finishedAt: Date.now() })
          .where(eq(schema.customImageBuilds.id, build.id));
        continue;
      }

      const image = imageRows[0];
      const userSem = getUserSemaphore(image.ownerUserId);

      await globalSemaphore.acquire();
      await userSem.acquire();

      try {
        await db.update(schema.customImageBuilds)
          .set({ state: 'building', startedAt: Date.now() })
          .where(eq(schema.customImageBuilds.id, build.id));
      } catch (e) {
        userSem.release();
        globalSemaphore.release();
        continue;
      }

      setImmediate(() => executeBuild(image, build).finally(() => {
        userSem.release();
        globalSemaphore.release();
      }));
    }
  } finally {
    buildLoopRunning = false;
  }
}

async function executeBuild(image, build) {
  const buildId = build.id;
  const imageId = image.id;

  const startedAt = Date.now();

  let imageRef;
  let logsRef = null;
  let outputTail = '';
  const appendTail = (chunk) => {
    outputTail = (outputTail + chunk.toString()).slice(-2000);
  };
  try {
    const selection = typeof image.components === 'string'
      ? JSON.parse(image.components)
      : image.components;

    // Build FROM the agent's configured image so the agent CLI is inherited
    // rather than reinstalled. When no agent image was registered/overridden we
    // fall back to box-base + installing the agent CLI (no guessed refs).
    const baseImage = await resolveRecipeBaseImage(selection);
    const skipAgentInstall = Boolean(baseImage);

    const dockerfile = renderDockerfile(selection, { baseImage, skipAgentInstall });
    ensureLogDir();

    const logFile = path.join(BUILD_LOG_DIR, `${buildId}.log`);
    const contextDir = path.join(BUILD_LOG_DIR, buildId);
    const dockerfilePath = path.join(contextDir, 'Dockerfile');
    logsRef = path.relative(BUILD_LOG_DIR, logFile);

    fs.mkdirSync(contextDir, { recursive: true });
    fs.writeFileSync(dockerfilePath, dockerfile);

    imageRef = buildImageRef(image.ownerUserId, image.slug, image.components, baseImage);

    // Optional BuildKit registry cache (opt-in): lets layers be reused across
    // builds and build hosts. Requires a docker-container builder; left off
    // unless CUSTOM_IMAGE_BUILD_CACHE_REF is set, so the default path is unchanged.
    const cacheRef = (process.env.CUSTOM_IMAGE_BUILD_CACHE_REF || '').trim();
    const buildCmd = cacheRef
      ? `docker buildx build --load -t ${imageRef} -f ${dockerfilePath}`
        + ` --cache-from type=registry,ref=${cacheRef}`
        + ` --cache-to type=registry,ref=${cacheRef},mode=max`
        + ` ${contextDir}`
      : `docker build -t ${imageRef} -f ${dockerfilePath} ${contextDir}`;
    const pushCmd = `docker push ${imageRef}`;

    const logStream = fs.createWriteStream(logFile);
    logStream.write(`=== Build started at ${new Date(startedAt).toISOString()} ===\n`);
    logStream.write(`=== Image: ${imageRef} ===\n\n`);
    logStream.write(`=== Dockerfile ===\n${dockerfile}\n\n=== Build output ===\n`);

    await new Promise((resolve, reject) => {
      const proc = exec(buildCmd, {
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      });

      proc.stdout.on('data', appendTail);
      proc.stderr.on('data', appendTail);
      proc.stdout.pipe(logStream);
      proc.stderr.pipe(logStream);

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`docker build exited with code ${code}`));
        }
      });
      proc.on('error', reject);
    });
    await new Promise((resolve, reject) => {
      const proc = exec(pushCmd, {
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      });

      proc.stdout.on('data', appendTail);
      proc.stderr.on('data', appendTail);

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`docker push exited with code ${code}`));
        }
      });
      proc.on('error', reject);
    });
    logStream.end();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await db.execute(sql`SELECT 1`);
      } catch (_) {
        await new Promise((r) => setTimeout(r, 2000));
      }
      try {
        await db.update(schema.customImageBuilds)
          .set({ state: 'ready', imageRef, logsRef, finishedAt: Date.now() })
          .where(eq(schema.customImageBuilds.id, buildId));

        await db.update(schema.customImages)
          .set({ imageRef, updatedAt: Date.now() })
          .where(eq(schema.customImages.id, imageId));
        break;
      } catch (dbErr) {
        if (attempt === 3) throw dbErr;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    try { fs.rmSync(contextDir, { recursive: true }); } catch { /* ok */ }
  } catch (err) {
    const tail = outputTail.trim();
    const failureReason = (tail ? `${err.message}\n${tail}` : err.message).slice(-500);

    try {
      await db.update(schema.customImageBuilds)
        .set({
          state: 'failed',
          failureReason,
          logsRef,
          finishedAt: Date.now(),
        })
        .where(eq(schema.customImageBuilds.id, buildId));
    } catch { /* best effort */ }

    // Keep the log file for diagnosis; only drop the build context.
    try { fs.rmSync(path.join(BUILD_LOG_DIR, buildId), { recursive: true }); } catch { /* ok */ }
  }

  const imageRows = await db.select().from(schema.customImages)
    .where(eq(schema.customImages.id, imageId));
  if (imageRows.length > 0) {
    processBuildQueue(imageRows[0].ownerUserId).catch(() => {});
  }
}

async function getReadyImageRef(customImageId, userId, role = null) {
  const image = await assertImageAccess(userId, customImageId, { role, mode: 'view' });
  if (!image) throw new RuntimeError('custom image not found', 404);

  const latestBuild = await getLatestBuild(image.id);
  if (!latestBuild) {
    throw new RuntimeError('custom image has no build', 400);
  }
  if (latestBuild.state !== 'ready') {
    throw new RuntimeError(
      `custom image is not ready (status: ${latestBuild.state})`,
      400,
    );
  }
  return latestBuild.imageRef || image.imageRef || null;
}

/**
 * Wait for a queued/building custom image to become ready, then return its ref.
 * Used by async session provisioning so a recipe picked inline in the launch
 * dialog can finish building before the sandbox is created.
 *
 * The default deadline covers both `docker build` and `docker push` (each up to
 * BUILD_TIMEOUT_MS) plus semaphore queueing, so a valid build is not aborted
 * early. `shouldContinue` lets callers abort (e.g. the session was cancelled).
 */
async function waitForReadyImageRef(imageId, userId, {
  timeoutMs = parseInt(
    process.env.CUSTOM_IMAGE_WAIT_TIMEOUT_MS || String(BUILD_TIMEOUT_MS * 2 + 10 * 60 * 1000),
    10,
  ),
  pollMs = parseInt(process.env.CUSTOM_IMAGE_WAIT_POLL_MS || '2000', 10),
  shouldContinue = null,
  role = null,
} = {}) {
  const image = await assertImageAccess(userId, imageId, { role, mode: 'view' });
  if (!image) throw new RuntimeError('custom image not found', 404);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const build = await getLatestBuild(imageId);
    if (build && build.state === 'ready') {
      return build.imageRef || image.imageRef || null;
    }
    if (build && build.state === 'failed') {
      const reason = (build.failureReason || '').split('\n')[0];
      throw new RuntimeError(
        `custom image build failed${reason ? `: ${reason}` : ''}`,
        400,
      );
    }
    if (shouldContinue && !(await shouldContinue())) {
      const cancelled = new RuntimeError('custom image wait cancelled', 499);
      cancelled.cancelled = true;
      throw cancelled;
    }
    if (!enabled || !dockerAvailable) {
      throw new RuntimeError('custom image builds are not available', 503);
    }
    if (Date.now() > deadline) {
      throw new RuntimeError('custom image build timed out', 504);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

module.exports = {
  initService,
  getFeatureStatus,
  createImage,
  resolveOrCreateImage,
  checkSelection,
  listImages,
  listPresets,
  publishImage,
  renameImage,
  collectStaleImages,
  getImage,
  getBuild,
  getBuildLog,
  rebuildImage,
  deleteImage,
  getReadyImageRef,
  waitForReadyImageRef,
  touchImageUsage,
  selectionContentHash,
  formatImageRow,
  formatBuildRow,
  globalSemaphore,
};
