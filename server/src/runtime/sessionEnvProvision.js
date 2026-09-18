// A+C: in-sandbox environment provisioning.
//
// A session always starts on the base agent image so the agent is available
// immediately. When the selected environment has no ready image yet, its
// components are installed inside the running sandbox in the background instead
// of blocking session start. The image build keeps running separately so later
// sessions hit the fast path (start from the built image, nothing to install).

const fs = require('fs');
const path = require('path');
const { eq } = require('drizzle-orm');
const { db } = require('../db');
const schema = require('../db/schema');
const { selectionToInstallList } = require('./customImageCatalog');

const LOG_DIR = process.env.SESSION_ENV_LOG_DIR || path.join(process.cwd(), '.data', 'session-env');
const COMPONENT_TIMEOUT_MS = Number(process.env.SESSION_ENV_COMPONENT_TIMEOUT_MS) || 15 * 60 * 1000;
const MAX_ATTEMPTS = 2;
const MARKER_REL = path.join('.agents', 'env-provisioning.json');

// One provisioning run per session at a time (process-local; the DB state is
// the durable source of truth).
const inFlight = new Set();

function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (_) { /* best effort */ }
}

async function setState(sessionId, patch) {
  try {
    await db.update(schema.sessions)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(schema.sessions.id, sessionId));
  } catch (_) { /* best effort */ }
}

function writeMarker(hostWorkspacePath, components) {
  if (!hostWorkspacePath) return;
  try {
    fs.mkdirSync(path.join(hostWorkspacePath, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(hostWorkspacePath, MARKER_REL),
      JSON.stringify({
        state: 'installing',
        components: components.map((c) => `${c.component_id}@${c.version}`),
        startedAt: Date.now(),
      }, null, 2),
    );
  } catch (_) { /* best effort */ }
}

function removeMarker(hostWorkspacePath) {
  if (!hostWorkspacePath) return;
  try { fs.rmSync(path.join(hostWorkspacePath, MARKER_REL), { force: true }); } catch (_) { /* best effort */ }
}

// The sandbox root disk can be small; reclaim pure caches before heavy installs
// (same mitigation as the deploy pipeline's apt helper).
const RECLAIM_CMD = 'export DEBIAN_FRONTEND=noninteractive; '
  + 'avail=$(df -k / | awk \'NR==2{print $4}\'); '
  + 'if [ "$avail" -lt 409600 ]; then '
  + 'apt-get clean 2>/dev/null || true; '
  + 'rm -rf /root/.npm/_cacache 2>/dev/null || true; '
  + 'rm -rf /root/.cache 2>/dev/null || true; '
  + 'find /tmp -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true; '
  + 'fi';

async function runInstallList({ runtime, runtimeRef, workspacePath, list, appendLog }) {
  await runtime.exec.exec('sh', ['-c', RECLAIM_CMD], {}, {
    runtimeRef,
    cwd: workspacePath,
    timeoutMs: 30000,
  }).catch(() => { /* best effort */ });

  for (const item of list) {
    appendLog(`\n>>> ${item.name} ${item.version} (${item.component_id})\n`);
    const res = await runtime.exec.exec('sh', ['-c', item.install], {}, {
      runtimeRef,
      cwd: workspacePath,
      timeoutMs: COMPONENT_TIMEOUT_MS,
    });
    const out = `${res?.stdout || ''}${res?.stderr || ''}`;
    if (out) appendLog(out);
    const exitCode = res?.exitCode;
    if (typeof exitCode === 'number' && exitCode !== 0) {
      throw new Error(`${item.name} ${item.version} install failed (exit ${exitCode})`);
    }
  }
}

/**
 * Install the given recipe components inside an already-running sandbox.
 * Never throws: failures are recorded on the session so the UI can offer a retry.
 */
async function provisionSessionEnvironment({
  sessionId,
  runtime,
  runtimeRef,
  workspacePath,
  hostWorkspacePath,
  components,
  log = console,
}) {
  if (!sessionId || !runtime) return { ok: false, error: 'runtime not available' };
  if (inFlight.has(sessionId)) return { ok: false, error: 'already running' };

  const list = selectionToInstallList(components || [])
    .filter((item) => !item.component_id.startsWith('agent:'));
  if (list.length === 0) {
    await setState(sessionId, { envProvisionState: 'skipped' });
    return { ok: true, skipped: true };
  }

  inFlight.add(sessionId);
  ensureLogDir();
  const logRef = path.join(LOG_DIR, `${sessionId}.log`);
  const appendLog = (chunk) => { try { fs.appendFileSync(logRef, String(chunk)); } catch (_) { /* best effort */ } };

  try {
    await setState(sessionId, {
      envProvisionState: 'installing',
      envProvisionError: null,
      envProvisionStartedAt: Date.now(),
      envProvisionLogRef: logRef,
    });
    writeMarker(hostWorkspacePath || workspacePath, components);

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        appendLog(`\n=== provisioning attempt ${attempt}/${MAX_ATTEMPTS} ===\n`);
        await runInstallList({ runtime, runtimeRef, workspacePath, list, appendLog });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        appendLog(`\n!! attempt ${attempt} failed: ${err.message}\n`);
      }
    }

    if (lastError) {
      await setState(sessionId, {
        envProvisionState: 'failed',
        envProvisionError: String(lastError.message || 'environment install failed').slice(0, 500),
        envProvisionFinishedAt: Date.now(),
      });
      log.warn?.(`[session-env] ${sessionId} failed: ${lastError.message}`);
      return { ok: false, error: lastError.message };
    }

    removeMarker(hostWorkspacePath || workspacePath);
    await setState(sessionId, {
      envProvisionState: 'ready',
      envProvisionError: null,
      envProvisionFinishedAt: Date.now(),
    });
    log.info?.(`[session-env] ${sessionId} ready (${list.length} component(s))`);
    return { ok: true };
  } finally {
    inFlight.delete(sessionId);
  }
}

/** Fire-and-forget entry point used by session provisioning. */
function startSessionEnvProvision(opts) {
  setImmediate(() => {
    provisionSessionEnvironment(opts).catch((err) => {
      (opts.log || console).error?.(`[session-env] ${opts.sessionId} uncaught: ${err.message}`);
    });
  });
}

module.exports = { provisionSessionEnvironment, startSessionEnvProvision };
