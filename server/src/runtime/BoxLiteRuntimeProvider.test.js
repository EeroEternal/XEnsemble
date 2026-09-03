const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const BoxLiteRuntimeProvider = require('./BoxLiteRuntimeProvider');
const workspace = require('../workspace');
const agentBootstrap = require('../workspace/agentBootstrap');

class MockBoxLiteClient {
    constructor() {
        this.deleted = [];
        this.stopped = [];
        this.opened = [];
        this.execResults = [{ exitCode: 0, stdout: '', stderr: '' }];
    }

    async deleteSession(name) {
        this.deleted.push(name);
    }

    async stopSession(name) {
        this.stopped = this.stopped || [];
        this.stopped.push(name);
    }

    async openSession(name, image, warm = false, options = {}) {
        this.opened.push({
            name,
            image,
            warm,
            volumes: options.volumes || [],
            network: options.network || null,
        });
        return { event: 'session_opened' };
    }

    async execForResult(sessionName, command, args = [], env = {}, workingDir = null) {
        this.execCalls = this.execCalls || [];
        this.execCalls.push({ sessionName, command, args, env, workingDir });
        if (typeof this.execHandler === 'function') {
            return this.execHandler({ sessionName, command, args, env, workingDir });
        }
        return this.execResults.shift() || { exitCode: 0, stdout: '', stderr: '' };
    }
}

let originalEnsureBootstrap;

before(() => {
    originalEnsureBootstrap = agentBootstrap.ensureAgentBootstrap;
    agentBootstrap.ensureAgentBootstrap = async () => ({ status: 'skipped' });
});

after(() => {
    agentBootstrap.ensureAgentBootstrap = originalEnsureBootstrap;
});

test('ensureReady recreates blink session when stored image differs', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    const project = { id: 'proj_image_swap', userId: 'usr_swap' };
    const result = await provider.ensureReady(project, {
        runtimeId: 'rt_swap',
        agentId: 'droid',
        image: 'xensemble/agent-droid:latest',
        storedImage: 'xensemble/box-base:bookworm',
    });

    assert.deepEqual(client.deleted, ['rt_swap']);
    assert.equal(client.opened.length, 1);
    assert.equal(client.opened[0].name, 'rt_swap');
    assert.equal(client.opened[0].image, 'xensemble/agent-droid:latest');
    assert.equal(client.opened[0].volumes.length, 1);
    assert.match(client.opened[0].volumes[0].host_path, /usr_swap[/\\]proj_image_swap$/);
    assert.equal(client.opened[0].volumes[0].guest_path, '/workspace');
    assert.deepEqual(client.opened[0].network, { mode: 'enabled', allow_net: [] });
    assert.equal(result.runtimeRef, 'rt_swap');
    assert.equal(result.image, 'xensemble/agent-droid:latest');
    assert.match(result.mountKey, /=>[/\\]workspace$/);
});

test('ensureReady recreates blink session when stored image is missing', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    const project = { id: 'proj_first_agent', userId: 'usr_first' };
    await provider.ensureReady(project, {
        runtimeId: 'rt_first',
        agentId: 'kimi-code',
        image: 'xensemble/agent-kimi-code:latest',
        storedImage: null,
    });

    assert.deepEqual(client.deleted, ['rt_first']);
    assert.equal(client.opened[0].image, 'xensemble/agent-kimi-code:latest');
});

test('ensureReady forceRecreate deletes blink session when image differs', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    const image = 'xensemble/agent-kimi-code:latest';
    const project = { id: 'proj_force', userId: 'usr_force' };
    await provider.ensureReady(project, {
        runtimeId: 'rt_force',
        agentId: 'kimi-code',
        image,
        storedImage: 'xensemble/agent-old:latest',
        storedMount: resultMountKey(project),
        forceRecreate: true,
    });

    assert.deepEqual(client.deleted, ['rt_force']);
});

test('ensureReady keeps existing session when image is unchanged', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    const image = 'xensemble/agent-claude-code:latest';
    const project = { id: 'proj_same_image', userId: 'usr_same' };
    await provider.ensureReady(project, {
        runtimeId: 'rt_same',
        agentId: 'claude-code',
        image,
        storedImage: image,
        storedMount: resultMountKey(project),
    });

    assert.deepEqual(client.deleted, []);
    assert.equal(client.opened[0].image, image);
});

test('ensureReady recreates blink session when agent command probe fails', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;
    let probeAttempts = 0;
    client.execHandler = ({ command, args }) => {
        const shell = Array.isArray(args) ? args.join(' ') : '';
        if (command === 'sh' && shell.includes('command -v')) {
            probeAttempts += 1;
            return { exitCode: probeAttempts >= 2 ? 0 : 127, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
    };

    const project = { id: 'proj_probe', userId: 'usr_probe' };
    await provider.ensureReady(project, {
        runtimeId: 'rt_probe',
        agentId: 'kimi-code',
        image: 'xensemble/agent-kimi-code:latest',
        storedImage: 'xensemble/agent-kimi-code:latest',
        storedMount: resultMountKey(project),
    });

    assert.equal(probeAttempts, 2);
    assert.deepEqual(client.deleted, ['rt_probe']);
    assert.equal(client.opened.length, 2);
});

test('ensureReady keeps existing session when image differs but agentId is absent', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    const project = { id: 'proj_attach', userId: 'usr_attach' };
    await provider.ensureReady(project, {
        runtimeId: 'rt_attach',
        image: 'xensemble/box-base:bookworm',
        storedImage: 'xensemble/agent-kimi-code:latest',
        storedMount: resultMountKey(project),
    });

    assert.deepEqual(client.deleted, []);
    assert.equal(client.opened[0].image, 'xensemble/box-base:bookworm');
});

test('ensureReady recreates blink session when workspace mount differs', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    const project = { id: 'proj_mount', userId: 'usr_mount' };
    await provider.ensureReady(project, {
        runtimeId: 'rt_mount',
        storedMount: '/old/host=>/workspace',
    });

    assert.deepEqual(client.deleted, ['rt_mount']);
    assert.equal(client.opened.length, 1);
    assert.match(client.opened[0].volumes[0].host_path, /usr_mount[/\\]proj_mount$/);
});

test('ensureReady runs post-boot boxlite execs sequentially (no concurrent zygote race)', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    let inFlight = 0;
    let maxInFlight = 0;
    client.execHandler = async ({ command, args }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Widen the window so concurrency (if reintroduced) would be detected.
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        const shell = Array.isArray(args) ? args.join(' ') : '';
        if (command === 'sh' && shell.includes('command -v')) {
            return { exitCode: 0, stdout: '/root/.local/bin/agent', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
    };

    const project = { id: 'proj_serial', userId: 'usr_serial' };
    await provider.ensureReady(project, {
        runtimeId: 'rt_serial',
        agentId: 'cursor',
        image: 'xensemble/agent-cursor:latest',
        storedImage: 'xensemble/agent-cursor:latest',
        storedMount: resultMountKey(project),
    });

    assert.equal(maxInFlight, 1, `expected serialized boxlite execs (maxInFlight=1), got ${maxInFlight}`);
});

test('ensureWorkspacePath retries on transient spawn failure', async () => {
    const provider = new BoxLiteRuntimeProvider();
    const client = new MockBoxLiteClient();
    provider.client = client;

    let spawnAttempts = 0;
    client.execHandler = async ({ command, args }) => {
        const shell = Array.isArray(args) ? args.join(' ') : '';
        if (command === 'sh' && shell.includes('mkdir -p')) {
            spawnAttempts += 1;
            if (spawnAttempts < 2) {
                throw new Error('spawn failed: 500 {"error":"failed to spawn command in sandbox"}');
            }
        }
        return { exitCode: 0, stdout: '', stderr: '' };
    };

    await provider.ensureWorkspacePath('rt_retry', '/workspace');
    assert.equal(spawnAttempts, 2, 'expected ensureWorkspacePath to retry after first spawn failure');
});

function resultMountKey(project) {
    const guestPath = '/workspace';
    const hostPath = workspace.projectDir(project.userId, project.id);
    return `${hostPath}=>${guestPath}`;
}
