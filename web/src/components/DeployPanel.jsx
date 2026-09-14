import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, AlertCircle, ChevronDown, ChevronUp, Globe, Hammer, Package, Rocket, Search, Wrench } from 'lucide-react';
import { apiFetch } from '../lib/api';
import WorkspacePreviewPane from './WorkspacePreviewPane';
import CreationProgress from './CreationProgress';
import { withSessionId } from '../lib/sessionContext';

/**
 * 一键部署面板（WorkspacePanel 的 'deploy' tab）。全自动，无任何模式切换。
 *
 * mount 后立即调 POST /api/v1/projects/:id/auto-deploy：
 *   阶段 1 用 LLM_ANALYZE_MODEL 出部署计划；阶段 2 用 LLM_VERIFY_MODEL
 *   在沙箱内准备环境 + 跑 install/build + 健康检查，失败时 agent 自主
 *   edit_file / run_shell 修复，循环直到通过。
 *
 * 成功 → 短暂显示完成状态后回调 onSuccess（父组件跳转到 Preview tab）；
 * 失败 → 显示错误 + 「重新部署」按钮。
 */
const DeployPanel = forwardRef(function DeployPanel({ projectId, sessionId, onSuccess, onDeployStatus, abortRequested, autoStartVersion = 0 }, ref) {
    const { t } = useTranslation();
    // 前端分步展示：阶段 A（分析）+ 阶段 B 内子阶段（由后端 SSE substage 驱动）+ preview。
    // 后端逻辑保持两阶段不变，这里只做更细的展示拆分。
    const deploySteps = [
        { id: 'analyze', label: t('deploy:steps.analyze'), icon: Search },
        { id: 'prepare', label: t('deploy:steps.prepare'), icon: Package },
        { id: 'build', label: t('deploy:steps.build'), icon: Hammer },
        { id: 'serve', label: t('deploy:steps.serve'), icon: Rocket },
        { id: 'check', label: t('deploy:steps.check'), icon: Activity },
        { id: 'fix', label: t('deploy:steps.fix'), icon: Wrench },
        { id: 'preview', label: t('deploy:steps.preview'), icon: Globe },
    ];
    // 阶段 B 子阶段：后端按工具/命令推断透传（prepare/build/serve/check/fix），
    // 长任务期间有心跳复报；无 substage 时保持步骤顺序推进。
    // 注意：verify agent 是迭代式工作（check 失败 → fix → 重新 build → 再 check），
    // 子阶段信号会来回跳。进度条必须"只进不退"——记录最远到达的步骤，新 substage 比它靠后才前进。
    // 部署进度：7 步统一索引，任何事件只允许前进（含 analyze/preview 全序）。
    // 之前只对 substage 做"只进不退"，仍有四处倒退：
    // ① startRun 不重置上次的最远步骤（重试时先跳回旧步骤再卡住）；
    // ② 迟到/重放的 stage A 事件把 currentStep 拉回 analyze；
    // ③ 恢复轮询用 DB stage 反复 setPhase，可把已到 preview 的界面拉回 B；
    // ④ 切走再切回 session 时组件重挂载，恢复播种只有 DB 的粗粒度阶段（B→build），
    //    会把已到 fix 的进度拉回 build（长部署中途切 session 必现）。
    // 统一为单调 furthestStep：事件只前进，startRun（新一次部署）时重置；
    // 并持久化到 sessionStorage，重挂载恢复时取 max(存储值, DB 阶段播种)。
    const STEP_ORDER = ['analyze', 'prepare', 'build', 'serve', 'check', 'fix', 'preview'];
    const stepIndex = (id) => STEP_ORDER.indexOf(id);
    const stepStoreKey = `xe_deploy_step_${projectId || 'p'}_${sessionId || 's'}`;
    const [furthestStep, setFurthestStep] = useState(null);
    const advanceTo = (id) => setFurthestStep((prev) => {
        const ni = stepIndex(id);
        if (ni < 0) return prev;
        const pi = prev ? stepIndex(prev) : -1;
        if (ni <= pi) return prev;
        try { sessionStorage.setItem(stepStoreKey, id); } catch { /* ignore */ }
        return id;
    });
    const [runState, setRunState] = useState('idle');
    const [result, setResult] = useState(null);
    // 当前部署阶段：null（初始）| 'A'（分析）| 'B'（部署/验证）| 'preview'（开预览）
    const [phase, setPhase] = useState(null);
    // ── 部署确认闭环 ──
    // startedAtRef：本次点击时刻；confirmedIdRef：服务端确认的 deploymentId
    //（started 事件或轮询到本次点击之后创建的记录）。确认前绝不把旧记录的
    // 终态当成"本次部署"的结果（旧记录冒充当前状态的修复点）。
    const startedAtRef = useRef(0);
    const confirmedIdRef = useRef(null);
    const confirmTimerRef = useRef(null);
    const runStateRef = useRef(runState);
    runStateRef.current = runState;
    const DEPLOY_CONFIRM_TIMEOUT_MS = 5000;
    // 挂载时先查该 session 的部署状态：有进行中/已完成的 kind='deploy' 则恢复展示，不重复触发
    const [recoveredId, setRecoveredId] = useState(null);
    const jumpTimerRef = useRef(null);

    // 外部中止信号（右上角 Stop）：立即显示"已中止"，不必等后端 abort 返回
    useEffect(() => {
        if (abortRequested) setRunState('aborted');
    }, [abortRequested]);

    // 上报部署状态：running / finished / aborted / idle（驱动右上角状态与中止按钮）
    useEffect(() => {
        const s = runState === 'running' ? 'running'
            : (runState === 'success') ? 'finished'
            : (runState === 'failed') ? 'failed'
            : (runState === 'aborted' ? 'aborted' : 'idle');
        onDeployStatus?.(s);
    }, [runState, onDeployStatus]);

    const startRun = useCallback(async (opts = {}) => {
        // 确认闭环：记录点击时刻 + 清空确认状态。部署是否"生效"以两个信号为准：
        //  (1) SSE started 事件（服务端创建记录即推送，<1s）；
        //  (2) 兜底轮询到 created_at >= startedAt 的 building 记录。
        // 确认超时（DEPLOY_CONFIRM_TIMEOUT_MS）仍未确认 → 明确报"未生效"，
        // 不再把旧记录的状态冒充本次部署的结果。
        startedAtRef.current = Date.now();
        confirmedIdRef.current = null;
        if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
        setRunState('running');
        setResult(null);
        setPhase(null);
        setRecoveredId(null);
        confirmTimerRef.current = setTimeout(() => {
            if (!confirmedIdRef.current && runStateRef.current === 'running') {
                setRunState('failed');
                setResult({ ok: false, error: t('deploy:error.deploy_not_effective') });
            }
        }, DEPLOY_CONFIRM_TIMEOUT_MS);
        const finish = (data) => {
            if (data.ok) {
                setResult(data);
                setRunState('success');
                jumpTimerRef.current = setTimeout(() => onSuccess?.(data), 800);
            } else if (data.aborted) {
                setResult(data);
                setRunState('aborted');
            } else {
                setResult(data);
                setRunState('failed');
            }
        };
        try {
            const res = await apiFetch(
                withSessionId(`/api/v1/projects/${encodeURIComponent(projectId)}/auto-deploy`),
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resume: !!opts.resume }) },
            );
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `Auto-deploy failed (${res.status})`);
            }
            // SSE 流式：started 确认生效，progress 事件驱动分阶段展示，result 事件收尾
            const handleEvent = (evt) => {
                if (!evt || typeof evt !== 'object') return;
                if (evt.type === 'started') {
                    // 服务端已创建部署记录 → 点击确认生效。reattached=true 表示
                    // 第二次点击命中了在飞部署（服务端重入），同样回到进度展示。
                    if (evt.deploymentId) {
                        confirmedIdRef.current = evt.deploymentId;
                        if (confirmTimerRef.current) { clearTimeout(confirmTimerRef.current); confirmTimerRef.current = null; }
                        setRecoveredId(evt.deploymentId);
                        // 确认兜底此前若已判"未生效"，此处重新回到运行态
                        if (runStateRef.current !== 'running') setRunState('running');
                    }
                    return;
                }
                if (evt.type === 'progress') {
                    if (evt.stage === 'A') {
                        advanceTo('analyze');
                    } else if (evt.stage === 'B') {
                        // 后端透传子阶段（prepare/build/serve/check/fix），驱动更细的步骤高亮。
                        // 单调前进：迟到/重放的事件不会把进度拉回去。
                        advanceTo(evt.substage || 'prepare');
                    } else if (evt.stage === 'preview') {
                        advanceTo('preview');
                    }
                } else if (evt.type === 'result') {
                    finish(evt.result);
                } else if (evt.type === 'error') {
                    finish({ ok: false, error: evt.error });
                }
            };
            const reader = res.body?.getReader?.();
            if (!reader) {
                // 无流（兜底）：一次性 JSON
                handleEvent({ type: 'result', result: await res.json().catch(() => ({})) });
                return;
            }
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (value) buffer += decoder.decode(value, { stream: !done });
                let idx;
                while ((idx = buffer.indexOf('\n\n')) !== -1) {
                    const chunk = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
                    if (!dataLine) continue;
                    try { handleEvent(JSON.parse(dataLine.slice(6))); } catch { /* skip bad frame */ }
                }
                if (done) break;
            }
        } catch (e) {
            finish({ ok: false, error: e.message || String(e) });
        }
    }, [projectId, sessionId, onSuccess]);

    // 主动部署请求（父组件"Deploy"按钮触发）：跳过"查状态恢复"，强制重新部署。
    // 触发通道改为 autoStartVersion prop（见下方 effect）——旧实现用
    // setTimeout(() => ref.current?.requestDeploy?.(), 0)，DeployPanel 尚未
    // 挂载完成时 ref 为 null，可选链静默吞掉调用，点击被无声丢弃。
    const requestedRef = useRef(false);
    const requestDeploy = useCallback(() => {
        requestedRef.current = true;
        startRun();
    }, [startRun]);
    useImperativeHandle(ref, () => ({ requestDeploy }), [requestDeploy]);

    // autoStartVersion：父组件"Deploy"按钮自增，本组件以它为 key 重挂载。
    // 挂载 effect 里直接 startRun——挂载与发起在同一生命周期内，无 ref 时序
    // 竞态。必须在挂载恢复 effect 之前声明（先置 requestedRef 才能跳过恢复）。
    // ⚠️ 重放防护（实测事故）：本组件 key 含 sessionId，切 session / 重挂载时
    // lastAutoStartRef 归零，会把"用户在别的 session 点的那一次 Deploy"当成新指令
    // 重放——一次点击后切 session/刷新导致连续多次 auto-deploy，同 session 的重放
    // 与在飞部署共享同一 VM，重放启动时的 revert worktree/杀服务会毁掉正在验证的
    // 环境。autoStartVersion 按项目持久化到 sessionStorage：消费过即不再重放，
    // 重新部署必须再次点击火箭（version 递增）。
    const autoStartStoreKey = `xe_deploy_autostart_${projectId || 'p'}`;
    const lastAutoStartRef = useRef(0);
    useEffect(() => {
        if (!autoStartVersion || autoStartVersion === lastAutoStartRef.current) return;
        try {
            const consumed = Number(sessionStorage.getItem(autoStartStoreKey)) || 0;
            if (autoStartVersion <= consumed) {
                lastAutoStartRef.current = autoStartVersion;
                return;
            }
            sessionStorage.setItem(autoStartStoreKey, String(autoStartVersion));
        } catch { /* ignore */ }
        lastAutoStartRef.current = autoStartVersion;
        requestDeploy();
    }, [autoStartVersion, requestDeploy, autoStartStoreKey]);

    // 挂载先查该 session 的部署状态：有进行中/已完成的 kind='deploy' 则恢复展示，不重复触发。
    // 主动部署（requestedRef=true，由 requestDeploy 触发）时跳过本逻辑。
    // 无该 session 的部署记录 → 保持 idle 空态，等用户点"Deploy"再部署，绝不自动重新部署。
    // 新鲜度守卫只约束"终态"记录（一小时前手动停掉的孤儿不展示）；进行中的 building/pending
    // 不受窗口限制——部署的长阶段（LLM 慢轮次/大构建）可能 5 分钟以上不更新记录，切走再
    // 切回必须仍能恢复（否则"部署页面消失但部署还在跑"）。
    const RECOVER_FRESH_MS = 5 * 60 * 1000;
    const isFresh = (d) => (Date.now() - Number(d.updated_at || d.created_at || 0)) < RECOVER_FRESH_MS;
    useEffect(() => {
        if (requestedRef.current) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await apiFetch(withSessionId(`/api/v1/deployments?project_id=${encodeURIComponent(projectId)}`));
                const data = await res.json();
                if (cancelled || requestedRef.current) return;
                const list = Array.isArray(data) ? data : (data?.deployments || []);
                // 部署与 session 强绑定：只查该 session 的部署记录
                const deployRows = list
                    .filter((d) => d.kind === 'deploy' && (!sessionId || d.session_id === sessionId))
                    .sort((a, b) => b.created_at - a.created_at);
                const active = deployRows.find((d) => d.status === 'building' || d.status === 'pending');
                if (active) {
                    setRunState('running');
                    // 恢复时 DB 只有阶段（A/B/preview），没有子阶段；按阶段下限播种，
                    // 再与 sessionStorage 里持久化的最远步骤取 max（同标签页切走再切回的场景），
                    // advanceTo 单调，后续轮询不会把进度拉回。
                    let seed = active.stage === 'B' ? 'build' : active.stage === 'preview' ? 'preview' : 'analyze';
                    try {
                        const stored = sessionStorage.getItem(stepStoreKey);
                        if (stored && stepIndex(stored) > stepIndex(seed)) seed = stored;
                    } catch { /* ignore */ }
                    advanceTo(seed);
                    setRecoveredId(active.id);
                } else if (deployRows.length > 0 && isFresh(deployRows[0])) {
                    const last = deployRows[0];
                    if (last.status === 'running') {
                        setRunState('success');
                        // 恢复部署耗时（updated_at - created_at = 部署总时长），否则成功态里"本次部署用时"不显示
                        setResult({ ok: true, deploymentId: last.id, elapsedMs: (last.updated_at - last.created_at) || 0 });
                    }
                    else if (last.status === 'failed') { setRunState('failed'); setResult({ ok: false, error: last.stage_message || '上次部署失败', stage: last.stage }); }
                    else if (last.status === 'stopped') {
                        setRunState('aborted');
                        setResult({ ok: false, aborted: true, code: last.last_error_code || undefined, error: last.last_error_message || undefined });
                    }
                }
                // 无该 session 记录，或最新记录已过新鲜度窗口 → 保持 idle（空态）
            } catch {
                // 查状态失败 → 保持 idle（空态），不自动部署
            }
        })();
        return () => { cancelled = true; };
    }, [projectId, sessionId]);

    // 恢复"进行中"部署时轮询刷新阶段（SSE 已断开，改轮询 deployment 记录）
    useEffect(() => {
        if (!recoveredId) return undefined;
        const id = setInterval(async () => {
            try {
                const res = await apiFetch(withSessionId(`/api/v1/deployments?project_id=${encodeURIComponent(projectId)}`));
                const data = await res.json();
                const list = Array.isArray(data) ? data : (data?.deployments || []);
                const row = list.find((d) => d.kind === 'deploy' && d.id === recoveredId);
                if (!row) return;
                if (row.status === 'building' || row.status === 'pending') {
                    advanceTo(row.stage === 'B' ? 'build' : row.stage === 'preview' ? 'preview' : 'analyze');
                } else if (row.status === 'running') {
                    // runStateRef 守卫：SSE result 已接管（success）时不重复触发
                    if (runStateRef.current === 'running') {
                        setRunState('success');
                        setResult({ ok: true, deploymentId: row.id, elapsedMs: (row.updated_at - row.created_at) || 0 });
                        jumpTimerRef.current = setTimeout(() => onSuccess?.({ ok: true, deploymentId: row.id }), 800);
                    }
                    setRecoveredId(null);
                } else if (row.status === 'failed') {
                    setRunState('failed'); setResult({ ok: false, error: row.stage_message || '部署失败', stage: row.stage }); setRecoveredId(null);
                } else if (row.status === 'stopped') {
                    setRunState('aborted');
                    setResult({ ok: false, aborted: true, code: row.last_error_code || undefined, error: row.last_error_message || undefined });
                    setRecoveredId(null);
                }
            } catch { /* ignore */ }
        }, 3000);
        return () => clearInterval(id);
    }, [recoveredId, projectId, sessionId, onSuccess]);

    // 确认轮询：SSE started 事件是主确认通道；这里轮询兜底——只认"本次点击之后
    // 创建"的 building/pending 记录（created_at >= startedAt）。确认前绝不把任何
    // 旧记录的状态当成本次部署的终态（旧实现取"最新一条"判断终态，点击后到
    // 服务端创建记录之间的窗口里会误读上一条 stopped 记录，显示"已中止"）。
    // 确认后交给 recoveredId 轮询（按精确 id 跟踪）+ SSE result 接管终态。
    useEffect(() => {
        if (runState !== 'running') return undefined;
        const id = setInterval(async () => {
            if (confirmedIdRef.current) return;
            try {
                const res = await apiFetch(withSessionId(`/api/v1/deployments?project_id=${encodeURIComponent(projectId)}`));
                const data = await res.json();
                const list = Array.isArray(data) ? data : (data?.deployments || []);
                const mine = list.find((d) => d.kind === 'deploy'
                    && (!sessionId || d.session_id === sessionId)
                    && Number(d.created_at) >= startedAtRef.current
                    && (d.status === 'building' || d.status === 'pending'));
                if (mine) {
                    confirmedIdRef.current = mine.id;
                    if (confirmTimerRef.current) { clearTimeout(confirmTimerRef.current); confirmTimerRef.current = null; }
                    setRecoveredId(mine.id);
                }
            } catch { /* ignore */ }
        }, 2000);
        return () => clearInterval(id);
    }, [runState, projectId, sessionId]);

    useEffect(() => () => {
        if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
        if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    }, []);

    return (
        <div className="flex h-full min-h-0 flex-col">
            {runState === 'success' ? (
                <div className="flex-1 min-h-0 overflow-hidden">
                    <WorkspacePreviewPane projectId={projectId} sessionId={sessionId} deployInfo={result} />
                </div>
            ) : (
                <div className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center">
                {runState === 'idle' && (
                    <div className="flex flex-col items-center justify-center text-center gap-3 px-6 py-8">
                        <Rocket className="w-9 h-9 text-zinc-300" />
                        <div className="text-sm text-zinc-500">{t('deploy:idle.empty')}</div>
                        <div className="text-xs text-zinc-400">{t('deploy:idle.hint')}</div>
                    </div>
                )}
                {runState === 'running' && (
                    <div className="flex flex-col items-center justify-center gap-3 px-6 py-8">
                        <CreationProgress
                            steps={deploySteps}
                            currentStep={furthestStep || 'analyze'}
                        />
                    </div>
                )}
                {runState === 'aborted' && (
                    <div className="flex flex-col items-center justify-center text-center gap-3 px-6 py-8">
                        <AlertCircle className="w-9 h-9 text-zinc-400" />
                        <div className="text-sm font-semibold text-zinc-700">
                            {result?.code === 'deploy_timeout' ? t('deploy:timeout') : t('deploy:aborted')}
                        </div>
                    </div>
                )}
                {runState === 'failed' && result && (
                    <FailureView result={result} />
                )}
                </div>
            )}
        </div>
    );
});

function FailureView({ result }) {
    const { t } = useTranslation();
    const [showDetails, setShowDetails] = useState(false);
    const trail = result?.verify?.trail || [];
    const fallback = result?.verify?.fallback;
    const showTrail = Array.isArray(trail) && trail.length > 0;
    const showFallback = fallback && !fallback.ok;
    const hasDetails = showTrail || showFallback;

    return (
        <div className="flex flex-col items-center justify-center text-center gap-3 px-6 py-8 w-full max-w-lg">
            <AlertCircle className="w-9 h-9 text-red-600" />
            <div className="text-sm font-semibold text-red-700">{t(result?.code === 'quota_exceeded' ? 'deploy:failed.quota_title' : 'deploy:failed.title')}</div>
            {(() => {
                const line = result?.code === 'quota_exceeded'
                    ? t('deploy:error.quota_exceeded', { current: result?.current, limit: result?.limit })
                    : result?.code === 'deploy_stopping'
                        ? t('deploy:error.deploy_stopping')
                        : (result?.error || result?.verify?.warning || '');
                return line ? (
                    <div className="text-xs text-zinc-600 max-w-md break-words px-4">{line}</div>
                ) : null;
            })()}
            {result?.code === 'quota_exceeded' && Array.isArray(result?.occupants) && result.occupants.length > 0 && (
                <div className="w-full max-w-md text-left bg-amber-50 border border-amber-200 rounded p-3">
                    <div className="text-xs font-semibold text-amber-800 mb-1">{t('deploy:failed.occupants_title')}</div>
                    <ul className="text-xs text-amber-900 space-y-0.5">
                        {result.occupants.map((o, i) => (
                            <li key={i}>
                                · {t('deploy:occupant.workspace')}「{o.projectName || o.projectId}」- {t('deploy:occupant.session_label')}「{o.sessionName || t('deploy:occupant.unnamed')}」{o.kind === 'preview' ? t('deploy:occupant.preview_running') : t('deploy:occupant.deploying')}
                            </li>
                        ))}
                    </ul>
                    <div className="text-[11px] text-amber-700 mt-1">{t('deploy:failed.occupants_hint')}</div>
                </div>
            )}
            {result?.code === 'deploy_in_progress' && Array.isArray(result?.occupants) && result.occupants.length > 0 && (
                <div className="w-full max-w-md text-left bg-amber-50 border border-amber-200 rounded p-3">
                    <div className="text-xs font-semibold text-amber-800 mb-1">{t('deploy:failed.in_progress_title')}</div>
                    <ul className="text-xs text-amber-900 space-y-0.5">
                        {result.occupants.map((o, i) => (
                            <li key={i}>
                                · {t('deploy:occupant.workspace')}「{o.projectName || o.projectId}」- {t('deploy:occupant.session_label')}「{o.sessionName || t('deploy:occupant.unnamed')}」{o.kind === 'preview' ? t('deploy:occupant.preview_running') : t('deploy:occupant.deploying')}
                            </li>
                        ))}
                    </ul>
                    <div className="text-[11px] text-amber-700 mt-1">{t('deploy:failed.occupants_hint')}</div>
                </div>
            )}
            {hasDetails && (
                <>
                    <button
                        type="button"
                        onClick={() => setShowDetails((v) => !v)}
                        className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-900"
                    >
                        {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        {showDetails ? t('deploy:failed.hide_details') : t('deploy:failed.show_details')}
                    </button>
                    {showDetails && (
                        <div className="w-full text-left">
                            {showFallback && (
                                <div className="mb-3 text-xs text-red-800 bg-red-50 border border-red-200 rounded p-2">
                                    <div className="font-semibold mb-1">{t('deploy:failed.fallback_title')}</div>
                                    <div className="font-mono text-[10px] whitespace-pre-wrap break-words max-h-32 overflow-y-auto">{fallback.finalStderr || fallback.warning}</div>
                                    <div className="mt-1 text-[10px] text-zinc-500">{fallback.tested?.join(' · ')}</div>
                                </div>
                            )}
                            {showTrail && (
                                <div className="text-[10px] font-mono text-zinc-500 space-y-0.5 max-h-48 overflow-y-auto bg-surface/60 border border-zinc-200 rounded p-2">
                                    {trail.slice(-20).map((t, i) => (
                                        <div key={`${t.round}-${i}`} className="whitespace-pre-wrap break-words">
                                            {t.action === 'tool' ? (
                                                <>
                                                    <span className="text-blue-700">[轮 {t.round}] {t.tool}</span>{' '}
                                                    <span className="text-zinc-400">{JSON.stringify(t.args || '')}</span>
                                                    <div className="text-zinc-400 pl-2">{t.out}</div>
                                                </>
                                            ) : t.action === 'invalid_json' ? (
                                                <span className="text-red-700">[轮 {t.round}] 输出超长被截断（{t.len} 字符），JSON 解析失败</span>
                                            ) : t.action === 'repeat' ? (
                                                <span className="text-amber-700">[轮 {t.round}] 重复调用 {t.tool}，已阻止</span>
                                            ) : t.action === 'final' ? (
                                                <span className="text-green-700">[轮 {t.round}] final ok={String(t.ok)}</span>
                                            ) : (
                                                <span>[轮 {t.round}] {t.action}{t.name ? ` ${t.name}` : ''}</span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

export default DeployPanel;
