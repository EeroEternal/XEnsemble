const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { eq } = require('drizzle-orm');

const LocalFsAdapter = require('../runtime/LocalFsAdapter');
const localFs = new LocalFsAdapter();
const { bootstrapTestDb } = require('../test/db');

let ctx;
let db;
let schema;
let transcriptStore;
let sessionManager;
let subscribeTerminal;
let resumeSession;
const { buildSessionStateDirRef } = require('./stateDirRef');

before(async () => {
    ctx = await bootstrapTestDb([
        '../db/index',
        '../runtime/TranscriptStore',
        './SessionManager',
        './resumeSession',
        './terminalBridge',
    ], __dirname);
    ({ db, schema } = ctx);
    transcriptStore = ctx.reloaded['../runtime/TranscriptStore'];
    sessionManager = ctx.reloaded['./SessionManager'];
    subscribeTerminal = ctx.reloaded['./terminalBridge'].subscribeTerminal;
    resumeSession = ctx.reloaded['./resumeSession'].resumeSession;
});

after(async () => {
    if (ctx) await ctx.teardown();
});

class FakeHandle {
    constructor(streamRef) {
        this.streamRef = streamRef;
        this.dataListeners = new Set();
        this.exitListeners = new Set();
    }

    onData(cb) {
        this.dataListeners.add(cb);
        return { dispose: () => this.dataListeners.delete(cb) };
    }

    onExit(cb) {
        this.exitListeners.add(cb);
        return () => this.exitListeners.delete(cb);
    }

    write() {}
    resize() {}
    kill() {}
    async getMetrics() { return { cpu: 0, memory: 0 }; }

    emitData(data) {
        for (const cb of [...this.dataListeners]) {
            cb(data);
        }
    }

    emitExit(exitCode = 0, signal = null) {
        for (const cb of [...this.exitListeners]) {
            cb({ exitCode, signal });
        }
    }
}

test('subscribeTerminal replays from cursor and continues live without duplicates', async () => {
    const sessionId = `sess_bridge_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const streamRef = `local:pty:${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const userId = `usr_bridge_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const handle = new FakeHandle(streamRef);
    const payloads = [];
    try {
        await db.insert(schema.users).values({
            id: userId,
            username: `bridge_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            passwordHash: 'hash',
            role: 'user',
            status: 'active',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
        await db.insert(schema.sessions).values({
            id: sessionId,
            userId,
            agentId: 'kimi-code',
            cwd: '/tmp',
            status: 'running',
            streamRef,
            createdAt: Date.now(),
        });

        sessionManager.createSession(sessionId, handle, 'kimi-code');
        handle.emitData('line-1\n');
        handle.emitData('line-2\n');

        const sub = await subscribeTerminal(sessionId, (payload) => {
            payloads.push(payload);
        }, { after: 1 });
        assert.equal(sub.ok, true);
        await new Promise((resolve) => setImmediate(resolve));

        const replayOutputs = payloads.filter((p) => p.type === 'output');
        assert.deepEqual(replayOutputs.map((p) => p.seq), [2]);
        assert.equal(replayOutputs[0].data, 'line-2\n');

        handle.emitData('line-3\n');
        await new Promise((resolve) => setTimeout(resolve, 50));

        const outputsAfterLive = payloads.filter((p) => p.type === 'output');
        assert.deepEqual(outputsAfterLive.map((p) => p.seq), [2, 3]);
        assert.equal(outputsAfterLive[1].data, 'line-3\n');

        handle.emitExit(0);
        await new Promise((resolve) => setImmediate(resolve));

        const exit = payloads.find((p) => p.type === 'exit');
        assert.ok(exit);
        assert.equal(exit.data, 0);
        assert.equal(exit.seq, 4);

        await new Promise((resolve) => setTimeout(resolve, 50));

        const streamRows = await db.select().from(schema.sessionStreams).where(eq(schema.sessionStreams.sessionId, sessionId));
        assert.equal(streamRows.length, 1);
        assert.equal(streamRows[0].headSeq, 4);

        sub.cleanup();
    } finally {
        sessionManager.deleteSession(sessionId);
        await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
        await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
});

test('subscribeTerminal chatOnly skips history replay but streams live output', async () => {
    const sessionId = `sess_chatonly_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const streamRef = `local:pty:${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const userId = `usr_chatonly_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const handle = new FakeHandle(streamRef);
    const payloads = [];
    try {
        await db.insert(schema.users).values({
            id: userId,
            username: `chatonly_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            passwordHash: 'hash',
            role: 'user',
            status: 'active',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
        await db.insert(schema.sessions).values({
            id: sessionId,
            userId,
            agentId: 'kimi-code',
            cwd: '/tmp',
            status: 'running',
            streamRef,
            createdAt: Date.now(),
        });

        sessionManager.createSession(sessionId, handle, 'kimi-code');
        // History produced BEFORE the chat subscriber attaches must not be
        // replayed — the chat view renders no terminal.
        handle.emitData('history-line\n');

        const sub = await subscribeTerminal(sessionId, (payload) => {
            payloads.push(payload);
        }, { after: 0, chatOnly: true });
        assert.equal(sub.ok, true);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(payloads.some((p) => p.type === 'output'), false);

        // Live output still streams: the chat view watches it for TUI
        // confirmation/selection prompts that never surface as chat events.
        handle.emitData('live-line\n');
        await new Promise((resolve) => setTimeout(resolve, 60));
        const outputs = payloads.filter((p) => p.type === 'output');
        assert.deepEqual(outputs.map((p) => p.data), ['live-line\n']);

        // Exit still ends the chat subscription.
        handle.emitExit(0);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.ok(payloads.some((p) => p.type === 'exit'));

        sub.cleanup();
    } finally {
        sessionManager.deleteSession(sessionId);
        await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
        await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
});

test('subscribeTerminal replay skips input and resize frames while advancing cursor', async () => {
    const sessionId = `sess_bridge_replay_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const streamRef = `local:pty:${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const userId = `usr_bridge_replay_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const handle = new FakeHandle(streamRef);
    const payloads = [];
    try {
        await db.insert(schema.users).values({
            id: userId,
            username: `bridge_replay_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            passwordHash: 'hash',
            role: 'user',
            status: 'active',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
        await db.insert(schema.sessions).values({
            id: sessionId,
            userId,
            agentId: 'kimi-code',
            cwd: '/tmp',
            status: 'running',
            streamRef,
            createdAt: Date.now(),
        });

        sessionManager.createSession(sessionId, handle, 'kimi-code');
        handle.emitData('out-1\n');
        transcriptStore.append(streamRef, { kind: 'in', data: 'typed-1\n' });
        transcriptStore.append(streamRef, { kind: 'resize', data: { cols: 120, rows: 40 } });
        handle.emitData('out-2\n');

        const sub = await subscribeTerminal(sessionId, (payload) => {
            payloads.push(payload);
        }, { after: 0 });
        assert.equal(sub.ok, true);
        await new Promise((resolve) => setImmediate(resolve));

        const outputs = payloads.filter((p) => p.type === 'output');
        // out frames are batched: out-1 and out-2 (separated by in/resize which are
        // skipped) become adjacent and are concatenated into a single output payload.
        assert.deepEqual(outputs.map((p) => p.data), ['out-1\nout-2\n']);
        assert.deepEqual(outputs.map((p) => p.seq), [4]);
        assert.ok(outputs.every((p) => typeof p.data !== 'object'));
        assert.equal(payloads.some((p) => p.type === 'output' && p.data?.cols), false);

        handle.emitExit(0);
        await new Promise((resolve) => setImmediate(resolve));
        sub.cleanup();
    } finally {
        sessionManager.deleteSession(sessionId);
        await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
        await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
});

test('subscribeTerminal wakes idle sessions before attach and replays transcript', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xe-terminal-wake-'));
    const projectDir = path.join(root, 'project');
    const sessionId = `sess_wake_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const userId = `usr_wake_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const projectId = `proj_wake_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const runtimeId = `rt_wake_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const stateDirRef = buildSessionStateDirRef(sessionId);
    const { stateDirPath } = localFs.resolveStateDir(projectDir, sessionId);
    fs.mkdirSync(stateDirPath, { recursive: true });

    const initialHandle = new FakeHandle(`stream_old_${Date.now()}`);
    const payloads = [];
    try {
        const now = Date.now();
        await db.insert(schema.users).values({
            id: userId,
            username: `wake_${now}`,
            passwordHash: 'hash',
            role: 'user',
            status: 'active',
            createdAt: now,
            updatedAt: now,
        });
        await db.insert(schema.projects).values({
            id: projectId,
            userId,
            name: 'Wake Project',
            serverPath: projectDir,
            workspaceMode: 'local',
            createdAt: now,
        });
        await db.insert(schema.runtimes).values({
            id: runtimeId,
            projectId,
            provider: 'local',
            runtimeRef: 'runtime_ref_1',
            role: 'default',
            status: 'ready',
            createdAt: now,
            updatedAt: now,
        });
        await db.insert(schema.sessions).values({
            id: sessionId,
            userId,
            projectId,
            agentId: 'claude-code',
            cwd: projectDir,
            streamRef: initialHandle.streamRef,
            stateDirRef,
            recoverable: true,
            status: 'idle',
            runtimeId,
            createdAt: now,
        });

        sessionManager.createSession(sessionId, initialHandle, 'claude-code', {
            projectId,
            runtimeId: 'runtime_1',
            runtimeRef: 'runtime_ref_1',
            transcriptRef: initialHandle.streamRef,
            userId,
        });
        initialHandle.emitData('seed line\n');
        sessionManager.beginHibernate(sessionId);
        sessionManager.completeHibernate(sessionId);

        let spawnCalls = 0;
        const runtimeWithCount = {
            fs: localFs,
            exec: {
                async spawn(cmd, args, env, options) {
                    spawnCalls += 1;
                    return new FakeHandle(`stream_new_${spawnCalls}`);
                },
            },
        };
        const sessionRow = (await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)))[0];
        const wakeSession = async () => resumeSession({
            db,
            schema,
            sessionManager,
            runtime: runtimeWithCount,
            project: {
                id: projectId,
                userId,
                serverPath: projectDir,
                repoProvider: 'none',
                repoDefaultBranch: 'main',
                currentBranch: '',
                githubFullName: '',
                workspaceMode: 'local',
            },
            session: sessionRow,
            agentMeta: {
                id: 'claude-code',
                name: 'Claude Code',
                cmd: process.execPath,
                args: [],
                env_required: [],
            },
            terminalThemeId: null,
            resolvedSpawnEnv: { env: { CLAUDE_CONFIG_DIR: stateDirPath }, spawn_env_preview: {} },
            requestLog: { warn() {}, error() {} },
            fastifyLog: { warn() {}, error() {} },
            ensureProjectRuntime: async () => {
                await new Promise((resolve) => setTimeout(resolve, 40));
                return {
                    runtime: { id: 'runtime_1', runtimeRef: 'runtime_ref_1' },
                    workspacePath: projectDir,
                };
            },
            issueSessionToken: () => null,
            agentGatewayConfig: {
                async getAgentAuthMode() { return 'byok'; },
                async getForAgent() { return null; },
            },
            requestUser: { id: userId, role: 'user' },
        });

        const sub = await subscribeTerminal(sessionId, (payload) => {
            payloads.push(payload);
        }, { after: 0, sessionRecord: sessionRow, wakeSession });
        assert.equal(sub.ok, true);
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(spawnCalls, 1);
        assert.equal(sessionManager.isAlive(sessionId), true);
        const outputs = payloads.filter((p) => p.type === 'output').map((p) => p.data);
        assert.deepEqual(outputs, ['seed line\n']);

        sub.cleanup();
    } finally {
        sessionManager.deleteSession(sessionId);
        await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
        await db.delete(schema.runtimes).where(eq(schema.runtimes.id, runtimeId));
        await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
        await db.delete(schema.users).where(eq(schema.users.id, userId));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('concurrent idle wake attaches only spawn one resumed session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xe-terminal-concurrent-'));
    const projectDir = path.join(root, 'project');
    const sessionId = `sess_concurrent_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const userId = `usr_concurrent_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const projectId = `proj_concurrent_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const runtimeId = `rt_concurrent_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const stateDirRef = buildSessionStateDirRef(sessionId);
    const { stateDirPath } = localFs.resolveStateDir(projectDir, sessionId);
    fs.mkdirSync(stateDirPath, { recursive: true });

    const initialHandle = new FakeHandle(`stream_old_${Date.now()}`);
    const payloadsA = [];
    const payloadsB = [];
    try {
        const now = Date.now();
        await db.insert(schema.users).values({
            id: userId,
            username: `concurrent_${now}`,
            passwordHash: 'hash',
            role: 'user',
            status: 'active',
            createdAt: now,
            updatedAt: now,
        });
        await db.insert(schema.projects).values({
            id: projectId,
            userId,
            name: 'Concurrent Wake Project',
            serverPath: projectDir,
            workspaceMode: 'local',
            createdAt: now,
        });
        await db.insert(schema.runtimes).values({
            id: runtimeId,
            projectId,
            provider: 'local',
            runtimeRef: 'runtime_ref_1',
            role: 'default',
            status: 'ready',
            createdAt: now,
            updatedAt: now,
        });
        await db.insert(schema.sessions).values({
            id: sessionId,
            userId,
            projectId,
            agentId: 'claude-code',
            cwd: projectDir,
            streamRef: initialHandle.streamRef,
            stateDirRef,
            recoverable: true,
            status: 'idle',
            runtimeId,
            createdAt: now,
        });

        sessionManager.createSession(sessionId, initialHandle, 'claude-code', {
            projectId,
            runtimeId: 'runtime_1',
            runtimeRef: 'runtime_ref_1',
            transcriptRef: initialHandle.streamRef,
            userId,
        });
        initialHandle.emitData('seed line\n');
        sessionManager.beginHibernate(sessionId);
        sessionManager.completeHibernate(sessionId);

        let spawnCalls = 0;
        const runtime = {
            fs: localFs,
            exec: {
                async spawn(cmd, args, env, options) {
                    spawnCalls += 1;
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    return new FakeHandle(`stream_new_${spawnCalls}`);
                },
            },
        };
        const sessionRow = (await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)))[0];
        const wakeSession = async () => resumeSession({
            db,
            schema,
            sessionManager,
            runtime,
            project: {
                id: projectId,
                userId,
                serverPath: projectDir,
                repoProvider: 'none',
                repoDefaultBranch: 'main',
                currentBranch: '',
                githubFullName: '',
                workspaceMode: 'local',
            },
            session: sessionRow,
            agentMeta: {
                id: 'claude-code',
                name: 'Claude Code',
                cmd: process.execPath,
                args: [],
                env_required: [],
            },
            terminalThemeId: null,
            resolvedSpawnEnv: { env: { CLAUDE_CONFIG_DIR: stateDirPath }, spawn_env_preview: {} },
            requestLog: { warn() {}, error() {} },
            fastifyLog: { warn() {}, error() {} },
            ensureProjectRuntime: async () => ({
                runtime: { id: 'runtime_1', runtimeRef: 'runtime_ref_1' },
                workspacePath: projectDir,
            }),
            issueSessionToken: () => null,
            agentGatewayConfig: {
                async getAgentAuthMode() { return 'byok'; },
                async getForAgent() { return null; },
            },
            requestUser: { id: userId, role: 'user' },
        });

        const [subA, subB] = await Promise.all([
            subscribeTerminal(sessionId, (payload) => {
                payloadsA.push(payload);
            }, { after: 0, sessionRecord: sessionRow, wakeSession }),
            subscribeTerminal(sessionId, (payload) => {
                payloadsB.push(payload);
            }, { after: 0, sessionRecord: sessionRow, wakeSession }),
        ]);
        assert.equal(subA.ok, true);
        assert.equal(subB.ok, true);
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(spawnCalls, 1);
        assert.equal(sessionManager.isAlive(sessionId), true);
        assert.deepEqual(payloadsA.filter((p) => p.type === 'output').map((p) => p.data), ['seed line\n']);
        assert.deepEqual(payloadsB.filter((p) => p.type === 'output').map((p) => p.data), ['seed line\n']);

        subA.cleanup();
        subB.cleanup();
    } finally {
        sessionManager.deleteSession(sessionId);
        await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
        await db.delete(schema.runtimes).where(eq(schema.runtimes.id, runtimeId));
        await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
        await db.delete(schema.users).where(eq(schema.users.id, userId));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
