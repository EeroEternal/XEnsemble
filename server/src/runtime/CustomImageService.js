const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { eq, and, or, desc, sql, inArray } = require('drizzle-orm');
const { db } = require('../db/index');
const schema = require('../db/schema');
const { RuntimeError } = require('./interfaces');
const { imageRegistry: getImageRegistry } = require('./agentBoxImages');
const { validateSelection } = require('./customImageCatalog');
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

function buildImageRef(ownerUserId, slug, components) {
  const registry = getImageRegistry();
  const contentHash = crypto.createHash('sha256')
    .update((typeof components === 'string' ? JSON.parse(components) : components)
      .map((s) => `${s.component_id}@${s.version}`).sort().join('\n'))
    .digest('hex').slice(0, 12);
  return `${registry}/custom-${ownerUserId}-${slug}:${contentHash}`;
}

function ensureLogDir() {
  if (!fs.existsSync(BUILD_LOG_DIR)) {
    fs.mkdirSync(BUILD_LOG_DIR, { recursive: true });
  }
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

async function assertOwnership(userId, imageId, { allowAdminOwned = false } = {}) {
  const rows = await db.select().from(schema.customImages)
    .where(eq(schema.customImages.id, imageId));
  if (rows.length === 0) return null;
  if (rows[0].ownerUserId !== userId) {
    if (allowAdminOwned) {
      const owner = await db.select({ role: schema.users.role })
        .from(schema.users)
        .where(eq(schema.users.id, rows[0].ownerUserId));
      if (owner.length > 0 && owner[0].role === 'admin') {
        return rows[0];
      }
    }
    throw new RuntimeError(
      `custom image not found (id=${imageId})`,
      404,
    );
  }
  return rows[0];
}

async function getLatestBuild(imageId) {
  const rows = await db.select().from(schema.customImageBuilds)
    .where(eq(schema.customImageBuilds.customImageId, imageId))
    .orderBy(desc(schema.customImageBuilds.createdAt))
    .limit(1);
  return rows[0] || null;
}

async function createImage({ ownerUserId, name, selection }) {
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

  const agentCount = selection.filter((s) => (s.component_id || '').startsWith('agent:')).length;
  if (agentCount === 0) {
    throw new RuntimeError('custom image must include at least one agent', 400);
  }
  if (agentCount > 1) {
    throw new RuntimeError('custom image must contain at most one agent', 400);
  }

  const slug = slugify(name);

  const existing = await db.select().from(schema.customImages)
    .where(and(
      eq(schema.customImages.ownerUserId, ownerUserId),
      eq(schema.customImages.name, name.trim()),
    ));
  if (existing.length > 0) {
    throw new RuntimeError(
      `custom image named "${name.trim()}" already exists`,
      409,
    );
  }

  const now = Date.now();
  const imageId = `cimg_${crypto.randomBytes(8).toString('hex')}`;
  const buildId = `cbld_${crypto.randomBytes(8).toString('hex')}`;

  // Check if an image built from the exact same selection already exists.
  // Content hash = sorted component_id + version pairs, deterministic.
  const contentHash = crypto.createHash('sha256')
    .update(selection.map((s) => `${s.component_id}@${s.version}`).sort().join('\n'))
    .digest('hex').slice(0, 12);

  const dupBuild = await db.select().from(schema.customImageBuilds)
    .where(and(
      eq(schema.customImageBuilds.state, 'ready'),
      sql`${schema.customImageBuilds.imageRef} LIKE ${'%:' + contentHash}`,
    ))
    .limit(1);
  if (dupBuild.length > 0 && dupBuild[0].imageRef) {
    await db.insert(schema.customImages).values({
      id: imageId,
      ownerUserId,
      name: name.trim(),
      slug,
      components: JSON.stringify(selection),
      imageRef: dupBuild[0].imageRef,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.customImageBuilds).values({
      id: buildId,
      customImageId: imageId,
      state: 'ready',
      imageRef: dupBuild[0].imageRef,
      logsRef: null,
      failureReason: null,
      startedAt: now,
      finishedAt: now,
      createdAt: now,
    });
    return {
      ...formatImageRow(
        { id: imageId, ownerUserId, name: name.trim(), slug, components: JSON.stringify(selection), imageRef: dupBuild[0].imageRef, createdAt: now, updatedAt: now },
        { id: buildId, customImageId: imageId, state: 'ready', imageRef: dupBuild[0].imageRef, logsRef: null, failureReason: null, startedAt: now, finishedAt: now, createdAt: now },
      ),
    };
  }

  await db.insert(schema.customImages).values({
    id: imageId,
    ownerUserId,
    name: name.trim(),
    slug,
    components: JSON.stringify(selection),
    imageRef: null,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.customImageBuilds).values({
    id: buildId,
    customImageId: imageId,
    state: 'queued',
    imageRef: null,
    logsRef: null,
    failureReason: null,
    startedAt: null,
    finishedAt: null,
    createdAt: now,
  });

  setImmediate(() => processBuildQueue(ownerUserId));

  const image = await db.select().from(schema.customImages)
    .where(eq(schema.customImages.id, imageId));
  const build = await db.select().from(schema.customImageBuilds)
    .where(eq(schema.customImageBuilds.id, buildId));
  return {
    ...formatImageRow(image[0], build[0]),
    build: formatBuildRow(build[0]),
  };
}

async function listImages(ownerUserId) {
  const images = await db.select().from(schema.customImages)
    .where(or(
      eq(schema.customImages.ownerUserId, ownerUserId),
      sql`${schema.customImages.ownerUserId} IN (SELECT id FROM users WHERE role = 'admin')`,
    ))
    .orderBy(desc(schema.customImages.createdAt));

  if (images.length === 0) return { images: [], count: 0, max: null };

  const imageIds = images.map((img) => img.id);
  const allBuilds = await db.select().from(schema.customImageBuilds)
    .where(inArray(schema.customImageBuilds.customImageId, imageIds))
    .orderBy(desc(schema.customImageBuilds.createdAt));

  const latestBuildMap = new Map();
  for (const build of allBuilds) {
    if (!latestBuildMap.has(build.customImageId)) {
      latestBuildMap.set(build.customImageId, build);
    }
  }

  const result = images.map((image) =>
    formatImageRow(image, latestBuildMap.get(image.id) || null),
  );
  return { images: result, count: result.length, max: null };
}

async function getImage(ownerUserId, imageId) {
  const image = await assertOwnership(ownerUserId, imageId, { allowAdminOwned: true });
  if (!image) throw new RuntimeError('custom image not found', 404);

  const latestBuild = await getLatestBuild(image.id);
  return formatImageRow(image, latestBuild);
}

async function getBuild(ownerUserId, imageId) {
  const image = await assertOwnership(ownerUserId, imageId, { allowAdminOwned: true });
  if (!image) throw new RuntimeError('custom image not found', 404);

  const latestBuild = await getLatestBuild(image.id);
  if (!latestBuild) throw new RuntimeError('no build found for this image', 404);
  return formatBuildRow(latestBuild);
}

async function getBuildLog(ownerUserId, imageId) {
  const image = await assertOwnership(ownerUserId, imageId, { allowAdminOwned: true });
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

async function rebuildImage(ownerUserId, imageId) {
  if (!enabled) {
    throw new RuntimeError('custom image builds are not available', 503);
  }
  if (!dockerAvailable) {
    throw new RuntimeError('docker is not available', 503);
  }

  const image = await assertOwnership(ownerUserId, imageId, { allowAdminOwned: true });
  if (!image) throw new RuntimeError('custom image not found', 404);

  const latestBuild = await getLatestBuild(image.id);
  if (latestBuild && (latestBuild.state === 'queued' || latestBuild.state === 'building')) {
    throw new RuntimeError('image build already in progress', 409);
  }

  const now = Date.now();
  const buildId = `cbld_${crypto.randomBytes(8).toString('hex')}`;

  await db.insert(schema.customImageBuilds).values({
    id: buildId,
    customImageId: imageId,
    state: 'queued',
    imageRef: null,
    logsRef: null,
    failureReason: null,
    startedAt: null,
    finishedAt: null,
    createdAt: now,
  });

  setImmediate(() => processBuildQueue(ownerUserId));

  const buildRows = await db.select().from(schema.customImageBuilds)
    .where(eq(schema.customImageBuilds.id, buildId));
  return {
    ...formatImageRow(image, buildRows[0]),
    build: formatBuildRow(buildRows[0]),
  };
}

async function deleteImage(ownerUserId, imageId) {
  const image = await assertOwnership(ownerUserId, imageId, { allowAdminOwned: true });
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

  // Delete from Docker registry (best-effort).
  if (image.imageRef) {
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

    const dockerfile = renderDockerfile(selection);
    ensureLogDir();

    const logFile = path.join(BUILD_LOG_DIR, `${buildId}.log`);
    const contextDir = path.join(BUILD_LOG_DIR, buildId);
    const dockerfilePath = path.join(contextDir, 'Dockerfile');
    logsRef = path.relative(BUILD_LOG_DIR, logFile);

    fs.mkdirSync(contextDir, { recursive: true });
    fs.writeFileSync(dockerfilePath, dockerfile);

    imageRef = buildImageRef(image.ownerUserId, image.slug, image.components);

    const buildCmd = `docker build -t ${imageRef} -f ${dockerfilePath} ${contextDir}`;
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

async function getReadyImageRef(customImageId, userId) {
  const image = await assertOwnership(userId, customImageId, { allowAdminOwned: true });
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

module.exports = {
  initService,
  getFeatureStatus,
  createImage,
  listImages,
  getImage,
  getBuild,
  getBuildLog,
  rebuildImage,
  deleteImage,
  getReadyImageRef,
  formatImageRow,
  formatBuildRow,
  globalSemaphore,
};
