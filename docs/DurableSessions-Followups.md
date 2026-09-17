# Durable Sessions — Follow-ups & Optimization Backlog

Companion to [`DurableSessions.md`](./DurableSessions.md). Captures issues and
optimization opportunities discovered while implementing P1–P4 and while
running the boxlite/blink end-to-end verification. Ordered roughly by impact.

Status legend: **[resolved]** landed, **[open]** not yet scheduled.

---

## 1. Resume state-dir resolution — start/resume consistency **[resolved: PR #29]**

**Symptom.** Under boxlite, an idle-hibernated session (P4) could never be
woken: every wake returned `409 session not resumable` and the session stayed
`idle` forever — strictly worse than not hibernating.

**Root cause.** The agent state dir was resolved *differently* at start vs.
resume:

- start (`server.js` → `ensureSessionStateDir` → `projectDir`) →
  `<WORKSPACE_ROOT>/<uid>/<pid>/.xensemble/state/<sid>` (host path).
- resume (`resumeSession.js`) → `resolveSafePath(project.serverPath, ref)`,
  where under boxlite `project.serverPath` is the *in-box* `/workspace`, i.e.
  `/workspace/.xensemble/state/<sid>` — then `fs.existsSync` was evaluated on
  the **host**, where `/workspace` does not exist → 409.

Even had the guard passed, the agent would have received a different `stateEnv`
value on resume than at start → it would not find its prior state → context
loss. Local was unaffected (`projectDir == serverPath`), which is why the P2 /
#27 Resume button verified fine on Local; P4 made it user-visible because
hibernation only happens under boxlite.

**Fix.** Resume now derives the state dir the same way start does, via
`resolveSessionStateDir(userId, projectId, sessionId)`, so the absolute path is
identical across start and resume.

**Deeper follow-up (see §2).** The fix keeps the current "host absolute path,
also reachable inside the box" behavior. That is correct today only because the
boxlite dev setup surfaces the workspace at the same path the control plane
uses. It should not depend on the control plane and the box agreeing on a host
filesystem layout.

## 2. State dir should be a runtime-FS contract, not a host-FS assumption **[open]**

The control plane resolves and `fs.existsSync`-checks the session state dir on
its **own** filesystem. For Local this is the workspace; for boxlite it happens
to work because the box shares the path, but conceptually the state dir lives on
the **box disk**. The control plane should never assume it can `stat`/`mkdir`
the box's filesystem directly.

Proposed: add `exists(path)` / `mkdirp(path)` (and a canonical
`resolveStateDir(session)`) to the runtime exec/FS abstraction, and have both
start and resume go through it. Local implements it against the host FS; boxlite
implements it against the box FS (via blink). This removes the last place where
the control plane reaches into a runtime's filesystem by host path, and makes
the P4 wake path correct even when the box disk is fully isolated from the host.

## 3. Per-agent boxlite images (glibc + node + agent CLI) **[open]**

> 构建流水线与 Admin 注册见 [`Agent-Images.md`](./Agent-Images.md)；本节跟踪 **真实 agent 在 boxlite 上的 e2e 验证** 仍未闭环。

Real agents cannot run in the stock box image: it is Alpine/musl, has no
`node`, and no egress, while e.g. `droid` is a ~150 MB glibc ELF. This is why
the P4 boxlite e2e had to use a shell stand-in agent — the mechanism under test
(idle detection → `stop` → wake via `--resume`) is agent-independent, but a
real-model transcript cannot be produced in-box today.

Needed: a build/publish pipeline that produces per-agent images (glibc base +
`node` + the agent CLI, credentials injected at spawn) and a way for blink to
load them (`BLINK_IMAGE` / rootfs URL per agent). Until then, real-agent boxlite
e2e is blocked; the real-model context-continuity guarantee is only verified on
Local (P2 / #27).

## 4. blink-server self-restart recovery of live executions **[open]**

blink PR #9 (durable reattach) makes an execution survive **control-plane**
restarts (buffered, seq-cursored, repeatable attach). It does **not** cover
blink-server restarting: `ExecRegistry` is in-memory, so a live execution is
lost if blink-server itself restarts. Closing this needs boxlite support for
re-opening the stdio of a still-running in-box process. Tracked as a blink-side
follow-up.

## 5. Terminal OSC/DA escape-sequence echo-loop **[resolved]**

**Symptom.** Switching back to an agent terminal (or reconnecting it) auto-types
junk into the foreground TUI, e.g. `11;rgb:ffff/ffff/ffff` (sometimes twice in a
row). Same class as the `1;2c … rgb:2e2e/3434/4040` flood observed while testing
#27: a terminal-query reply ends up as keystrokes on the PTY's stdin.

**Root cause.** Agent TUIs probe the host terminal at startup (`ESC ] 11 ; ? ST`
for the background color, `ESC [ 6 n` / `ESC [ c` for cursor position / device
attributes). xterm.js answers such queries through exactly one channel —
`onData` — which `AgentConsole` forwards to the PTY as *user input*, and the
OSC 10/11 handler does the same for color queries. So "answer a probe" and "user
typed a key" share one pipe.

The bug is not answering once, it is answering **again from replay**: on first
attach / session switch the client asks with `after=0`, `terminalBridge` replays
the transcript tail, and the historical query in that replay is re-parsed by
xterm → a fresh reply is pushed into the PTY. The TUI that asked has long since
stopped waiting, so the reply just sits in the foreground process's stdin — if
the foreground is another agent CLI (or the same CLI past its probe window), it
renders it as typed text.

**Fix.** Separate "live output" from "historical replay":

- `terminalBridge` sends `{ type: 'replay-done' }` once the transcript replay is
  finished and before any live frame is drained (chat-only subscriptions send it
  too, as they never replay).
- Both `AgentConsole`s track that boundary in `liveOutputRef`:
  - replayed `output` is passed through `stripTerminalQueries()`
    (`web/src/lib/terminalQueries.js`, same file under `desktop/`), which drops
    the reply-triggering query sequences (OSC 10/11/12 `?`, `CSI 5n/6n/?6n`,
    `CSI c`/`CSI >c`, `CSI 14t/18t`) before they reach xterm, so the parser
    cannot generate a reply for them at all;
  - `replyOscColor` additionally refuses to answer while not live — belt and
    braces for reply bytes that already entered xterm's parse queue.

**Why not answer historical probes.** A late reply is useless to the asker (its
probe window is over) but actively harmful as stdin noise; the cost of not
answering is only that the TUI falls back to its default (dark) rendering.
`COLORFGBG` spawn env remains the intended path for that
(`desktop/docs/terminal-theme-server-requirements.md`). Fresh sessions attach
before the agent boots, so their startup probe still arrives live and is still
answered.

Client/server skew is fail-safe: a client talking to an older server that never
sends `replay-done` simply never answers probes (theme-follow silently off)
instead of typing replies into the foreground TUI.

**Status.** Covered by `web/src/__tests__/terminalQueries.test.js` (vitest),
`desktop/src/renderer/lib/terminalQueries.test.js` (node --test) and the
`replay-done` ordering assertions in `server/src/session/terminalBridge.test.js`.
Interactive verification against a real TUI still depends on real-agent boxlite
e2e (see §3).

## 6. State-dir isolation for agents that hardcode `$HOME` **[open]**

P2 L2 integration relies on an agent exposing a **dedicated** state-dir env var
(`stateEnv`, e.g. `CLAUDE_CONFIG_DIR`, `FACTORY_HOME_OVERRIDE`). Agents that
hardcode `os.homedir()/.<tool>` (e.g. CommandCode → `~/.commandcode`) have no
such knob; the only redirect is `HOME`, which our P2 design deliberately does
not touch (broad blast radius: git/ssh/npm config the agent reads from `HOME`).
Such agents are therefore CLI-level L2 but not L2-integrable as-is.

Options to evaluate: per-session `HOME` overlay inside the sandbox (cheap under
boxlite, where the box already isolates `HOME`), or a small per-agent "state
relocation" shim. Decision deferred; CommandCode left at L0 for now.

## 7. More harness L2 verification **[open]**

Only Claude Code (doc-level) and Factory Droid (CLI-tested) are catalogued as
L2. Adding an agent to L2 requires verifying, with its real CLI + key, both its
state-dir redirect env var and its native resume flag. Backlog: Codex and
others, each gated on credentials.

## 8. Test suite: parallel runs share one sqlite DB **[resolved]**

Resolved by PostgreSQL migration: each DB-touching test file gets an isolated database via `server/src/test/db.js` (`setupTestDb` / `bootstrapTestDb`). See `docs/PostgreSQL-Migration.md` §5.2.

## 9. Hibernation for non-resumable (L0/L1) agents **[open]**

P4 uses a hard-stop model: `stop` frees CPU/RAM, wake does a full agent
`--resume`, so only L2 (natively resumable) agents survive hibernation with
context. L0/L1 agents must be excluded from hibernation (or they lose context on
wake). A future option is a true memory checkpoint/restore (blink already has
`checkpoint`/`restore`; `warm` is currently a no-op) so L0/L1 sessions can also
be suspended and resumed without agent-native support.

## 10. P5 semantic events (optional enhancement) **[open]**

Level-tiered lifecycle events / webhooks (e.g. notify on hibernate/wake, expose
`recoverable`/`level` transitions to clients). Progressive enhancement, not
required by P1–P4.
