const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { eq } = require('drizzle-orm');
const { bootstrapTestDb } = require('../test/db');

const { TranscriptStore } = require('./TranscriptStore');

function makeTempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'xe-transcript-'));
}

function cleanup(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

test('TranscriptStore assigns monotonic seqs and supports cursor replay', () => {
    const root = makeTempRoot();
    try {
        const store = new TranscriptStore({ workspaceRoot: root, db: null, schema: null });
        const first = store.append('local:pty:123', { kind: 'out', data: 'hello' });
        const second = store.append('local:pty:123', { kind: 'in', data: 'ping' });
        const third = store.append('local:pty:123', { kind: 'resize', data: { cols: 80, rows: 24 } });

        assert.equal(first.seq, 1);
        assert.equal(second.seq, 2);
        assert.equal(third.seq, 3);
        assert.equal(store.head('local:pty:123'), 3);
        assert.equal(store.bytes('local:pty:123'), first.bytes + second.bytes + third.bytes);

        const replay = store.readFrom('local:pty:123', 1);
        assert.deepEqual(replay.map((frame) => frame.seq), [2, 3]);
        assert.equal(replay[0].kind, 'in');
        assert.equal(replay[1].kind, 'resize');
    } finally {
        cleanup(root);
    }
});

test('TranscriptStore resumes seqs from an existing transcript file', () => {
    const root = makeTempRoot();
    try {
        const firstStore = new TranscriptStore({ workspaceRoot: root, db: null, schema: null });
        firstStore.append('local:pty:restart', { kind: 'out', data: 'one\n' });
        firstStore.append('local:pty:restart', { kind: 'out', data: 'two\n' });
        firstStore.flushSync('local:pty:restart');

        const secondStore = new TranscriptStore({ workspaceRoot: root, db: null, schema: null });
        assert.equal(secondStore.head('local:pty:restart'), 2);
        const third = secondStore.append('local:pty:restart', { kind: 'out', data: 'three\n' });
        assert.equal(third.seq, 3);
        assert.deepEqual(secondStore.readFrom('local:pty:restart', 2).map((frame) => frame.seq), [3]);
    } finally {
        cleanup(root);
    }
});

test('TranscriptStore derives reattach cursor from the current execution only', () => {
    const root = makeTempRoot();
    try {
        const store = new TranscriptStore({ workspaceRoot: root, db: null, schema: null });
        store.append('boxlite:p_proj:exec_1', { kind: 'out', data: 'first-1', rseq: 1 });
        store.append('boxlite:p_proj:exec_1', { kind: 'out', data: 'first-2', rseq: 2 });
        store.append('boxlite:p_proj:exec_1', { kind: 'exit', data: { code: 0 } });
        store.append('boxlite:p_proj:exec_1', { kind: 'out', data: 'second-1', rseq: 7 });
        store.append('boxlite:p_proj:exec_1', { kind: 'in', data: 'ignored', rseq: 8 });
        store.append('boxlite:p_proj:exec_1', { kind: 'resize', data: { cols: 100, rows: 40 } });
        store.append('boxlite:p_proj:exec_1', { kind: 'out', data: 'second-2', rseq: 9 });

        assert.equal(store.reattachCursor('boxlite:p_proj:exec_1'), 9);
    } finally {
        cleanup(root);
    }
});

test('readTail anchors sync-only streams (no alt screen) at the last complete repaint block', () => {
    const root = makeTempRoot();
    try {
        const store = new TranscriptStore({ workspaceRoot: root, db: null, schema: null });
        const ref = 'local:pty:sync';

        store.append(ref, { kind: 'out', data: 'prelude output\r\n' });

        // Earlier full repaint block (self-contained, worth falling back to).
        const fullRepaintHead =
            '\x1b[?2026h\x1b[2J\x1b[H\x1b[3J \x1b[38;2;79;168;255m╭── OLD SCREEN ──╮';
        store.append(ref, { kind: 'out', data: fullRepaintHead });
        for (let i = 0; i < 8; i++) {
            store.append(ref, { kind: 'out', data: `\x1b[?2026l\x1b[?2026h line ${i} of old screen` });
        }
        store.append(ref, { kind: 'out', data: '\x1b[?2026l done' });

        // Late micro-sync brackets WITHOUT a clear/home signature must not
        // be treated as anchors (this is what breaks opencode refresh today).
        store.append(ref, { kind: 'out', data: '\x1b[?2026h' });
        store.append(ref, { kind: 'out', data: '\x1b[1;1H cursor nudge \x1b[?2026l' });

        const { frames, omittedCount } = store.readTail(ref);
        assert.ok(omittedCount > 0);
        const first = frames.find((f) => f.kind === 'out');
        assert.ok(
            /^\x1b\[\?2026h\x1b\[2J/.test(first.data),
            `replay must begin at a complete repaint block start, got ${JSON.stringify(first.data.slice(0, 40))}`,
        );
        // The trailing cursor-nudge frames after the last complete block are kept.
        const joined = frames.map((f) => f.data || '').join('');
        assert.ok(joined.includes('cursor nudge'));
        assert.ok(joined.includes('OLD SCREEN'));
    } finally {
        cleanup(root);
    }
});

test('readTail still prefers the real alt-screen enter when present', () => {
    const root = makeTempRoot();
    try {
        const store = new TranscriptStore({ workspaceRoot: root, db: null, schema: null });
        const ref = 'local:pty:altscreen';

        store.append(ref, { kind: 'out', data: 'legacy scrollback before TUI\r\n' });
        store.append(ref, { kind: 'out', data: '\x1b[?1049h\x1b[H welcome pane' });
        store.append(ref, { kind: 'out', data: '\x1b[?2026h\x1b[2J\x1b[H sync repaint pane' });
        store.append(ref, { kind: 'out', data: '\x1b[?2026l' });

        const { frames } = store.readTail(ref);
        const first = frames.find((f) => f.kind === 'out');
        assert.ok(first.data.startsWith('\x1b[?1049h'), 'must anchor at alt-screen enter');
        const joined = frames.map((f) => f.data || '').join('');
        assert.ok(joined.includes('welcome pane') && joined.includes('sync repaint pane'));
        assert.ok(!joined.includes('legacy scrollback'));
    } finally {
        cleanup(root);
    }
});

test('readTail generic fallback (no TUI markers) keeps newest bytes and first frame', () => {
    const root = makeTempRoot();
    try {
        const store = new TranscriptStore({ workspaceRoot: root, db: null, schema: null });
        const ref = 'local:pty:plain';
        const chunk = 'x'.repeat(64 * 1024);
        store.append(ref, { kind: 'out', data: 'first-line\r\n' });
        for (let i = 0; i < 32; i++) store.append(ref, { kind: 'out', data: `${chunk}\r\n` });
        store.append(ref, { kind: 'out', data: 'the-latest-line\r\n' });

        const { frames, omittedCount } = store.readTail(ref, 256 * 1024);
        assert.ok(omittedCount > 0, 'older frames should be reported as omitted');
        const joined = frames.map((f) => f.data || '').join('');
        // The front of an oversized stream is trimmed down to the byte cap,
        // except the very first frame which is intentionally always kept.
        assert.ok(joined.includes('the-latest-line'), 'newest content must survive trimming');
        const keptBytes = frames.reduce((sum, f) => sum + (f.kind === 'out' ? f.data.length : 0), 0);
        assert.ok(keptBytes <= 512 * 1024 + 128 * 1024, `trimmed tail should be bounded, got ${keptBytes}`);
        assert.equal(frames.find((f) => f.kind === 'out').data.startsWith('first-line'), true, 'first frame preserved by design');
    } finally {
        cleanup(root);
    }
});

test('_syncFromFile reads only appended bytes (no full re-read)', () => {
    const root = makeTempRoot();
    try {
        const store = new TranscriptStore({ workspaceRoot: root, db: null, schema: null });
        const ref = 'local:pty:incremental';
        const file = store.transcriptPath(ref);

        // Seed a file on disk, then simulate an external writer appending to it
        // (as a previous server instance would have).
        store.append(ref, { kind: 'out', data: 'one\n' });
        store.flushSync(ref);

        // A fresh store cold-starts aligned to EOF, so nothing to sync yet.
        const fresh = new TranscriptStore({ workspaceRoot: root, db: null, schema: null });
        const state = fresh._state(ref);
        assert.equal(state._syncOffset, fs.statSync(file).size, 'cold start aligns cursor to EOF');
        assert.equal(state.frames.length, 1);
        fresh._syncFromFile(state);
        assert.equal(state.frames.length, 1, 'no-op when nothing was appended');

        // Simulate another writer appending frames directly to the file.
        const extra = [
            { seq: 2, ts: Date.now(), kind: 'out', data: 'two\n', bytes: 4 },
            { seq: 3, ts: Date.now(), kind: 'out', data: 'three\n', bytes: 6 },
        ].map((f) => `${JSON.stringify(f)}\n`).join('');
        fs.appendFileSync(file, extra);

        fresh._syncFromFile(state);
        assert.deepEqual(state.frames.map((f) => f.seq), [1, 2, 3]);
        assert.equal(state.headSeq, 3);
        assert.equal(state._syncOffset, fs.statSync(file).size, 'cursor advances to EOF');

        // A second sync with no new bytes must not duplicate anything.
        fresh._syncFromFile(state);
        assert.deepEqual(state.frames.map((f) => f.seq), [1, 2, 3]);
    } finally {
        cleanup(root);
    }
});

test('_syncFromFile leaves a trailing partial line for the next call', () => {
    const root = makeTempRoot();
    try {
        const store = new TranscriptStore({ workspaceRoot: root, db: null, schema: null });
        const ref = 'local:pty:partial';
        const file = store.transcriptPath(ref);
        store.append(ref, { kind: 'out', data: 'seed\n' });
        store.flushSync(ref);

        const fresh = new TranscriptStore({ workspaceRoot: root, db: null, schema: null });
        const state = fresh._state(ref);

        // A half-written line (write in progress) must NOT be parsed: parsing it
        // would drop that frame forever once the rest arrives.
        const whole = `${JSON.stringify({ seq: 2, ts: Date.now(), kind: 'out', data: 'complete\n', bytes: 9 })}\n`;
        fs.appendFileSync(file, whole.slice(0, Math.floor(whole.length / 2)));
        fresh._syncFromFile(state);
        assert.deepEqual(state.frames.map((f) => f.seq), [1], 'partial line not consumed');

        // The rest of the line arrives → now it must be picked up intact.
        fs.appendFileSync(file, whole.slice(Math.floor(whole.length / 2)));
        fresh._syncFromFile(state);
        assert.deepEqual(state.frames.map((f) => f.seq), [1, 2], 'complete line consumed');
        assert.equal(state.frames[1].data, 'complete\n', 'frame parsed whole, not truncated');
    } finally {
        cleanup(root);
    }
});

test('_syncFromFile detects a shrunk (rotated) file and resyncs', () => {
    const root = makeTempRoot();
    try {
        const store = new TranscriptStore({ workspaceRoot: root, db: null, schema: null });
        const ref = 'local:pty:rotate';
        const file = store.transcriptPath(ref);
        for (let i = 0; i < 5; i++) store.append(ref, { kind: 'out', data: `line-${i}\n` });
        store.flushSync(ref);

        const fresh = new TranscriptStore({ workspaceRoot: root, db: null, schema: null });
        const state = fresh._state(ref);
        assert.equal(state.frames.length, 5);
        const beforeSize = fs.statSync(file).size;

        // Rotation rewrites the file smaller with re-sequenced frames.
        const rotated = [
            { seq: 1, ts: Date.now(), kind: 'out', data: 'kept-a\n', bytes: 7 },
            { seq: 2, ts: Date.now(), kind: 'out', data: 'kept-b\n', bytes: 7 },
        ].map((f) => `${JSON.stringify(f)}\n`).join('');
        fs.writeFileSync(file, rotated);
        assert.ok(fs.statSync(file).size < beforeSize, 'rotated file must be smaller');

        fresh._syncFromFile(state);
        assert.deepEqual(state.frames.map((f) => f.data), ['kept-a\n', 'kept-b\n'], 'resynced from rotated file');
        assert.equal(state.headSeq, 2);
        assert.equal(state._syncOffset, fs.statSync(file).size);
    } finally {
        cleanup(root);
    }
});

test('_flushWrites advances the sync cursor so appended frames are not re-read', () => {
    const root = makeTempRoot();
    try {
        const store = new TranscriptStore({ workspaceRoot: root, db: null, schema: null });
        const ref = 'local:pty:cursor';
        const file = store.transcriptPath(ref);
        store.append(ref, { kind: 'out', data: 'a\n' });
        store.flushSync(ref);

        const state = store._state(ref);
        assert.equal(state._syncOffset, fs.statSync(file).size, 'flush keeps cursor aligned with the file');

        // Syncing after our own flush must be a pure no-op (nothing to read).
        const before = state.frames.length;
        store._syncFromFile(state);
        assert.equal(state.frames.length, before, 'own writes are not re-read');
    } finally {
        cleanup(root);
    }
});

test('TranscriptStore updates session_streams metadata on bind and exit', async () => {
    const root = makeTempRoot();
    let ctx;
    try {
        ctx = await bootstrapTestDb(['../db/schema'], __dirname, { seed: false });
        const { db, schema } = ctx;

        await db.insert(schema.users).values({
            id: 'u1',
            username: 'transcript_test_user',
            passwordHash: 'hash',
            createdAt: Date.now(),
        }).onConflictDoNothing();
        await db.insert(schema.sessions).values({ id: 'sess_1', userId: 'u1', agentId: 'a1', cwd: '/tmp', createdAt: Date.now() });

        const store = new TranscriptStore({
            workspaceRoot: root,
            db,
            schema: { sessionStreams: schema.sessionStreams },
        });

        store.bindSession('sess_1', 'local:pty:meta');
        store.append('local:pty:meta', { kind: 'out', data: 'hello' });
        store.append('local:pty:meta', { kind: 'exit', data: { code: 0 } });

        await new Promise((resolve) => setTimeout(resolve, 50));

        const rows = await db.select().from(schema.sessionStreams).where(eq(schema.sessionStreams.sessionId, 'sess_1'));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].headSeq, 2);
        assert.equal(rows[0].storageRef, 'local:pty:meta');
        assert.equal(rows[0].bytes, 5 + Buffer.byteLength(JSON.stringify({ code: 0 })));
    } finally {
        if (ctx) await ctx.teardown();
        cleanup(root);
    }
});
