import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ChevronDown, ChevronUp, Rocket, Search } from 'lucide-react';
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
const DeployPanel = forwardRef(function DeployPanel({ projectId, sessionId, onSuccess, onDeployStatus, abortRequested }, ref) {
    const { t } = useTranslation();
    const deploySteps = [
        { id: 'analyze', label: t('deploy:steps.analyze'), icon: Search },
        { id: 'build', label: t('deploy:steps.build'), icon: Rocket },
    ];
    const [runState, setRunState] = useState('idle');
    const [result, setResult] = useState(null);
    // 当前部署阶段：null（初始）| 'A'（分析）| 'B'（部署/验证）| 'preview'（开预览）
    const [phase, setPhase] = useState(null);
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
        setRunState('running');
        setResult(null);
        setPhase(null);
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
            // SSE 流式：progress 事件驱动分阶段展示，result 事件收尾
            const handleEvent = (evt) => {
                if (!evt || typeof evt !== 'object') return;
                if (evt.type === 'progress') {
                    if (evt.stage === 'A') {
                        setPhase('A');
                    } else if (evt.stage === 'B') {
                        setPhase('B'); // 阶段 1 结束 → 阶段 2，界面显示完成提示
                    } else if (evt.stage === 'preview') {
                        setPhase('preview');
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

    // 主动部署请求（父组件"Deploy"按钮触发）：跳过"查状态恢复"，强制重新部署
    const requestedRef = useRef(false);
    const requestDeploy = useCallback(() => {
        requestedRef.current = true;
        startRun();
    }, [startRun]);
    useImperativeHandle(ref, () => ({ requestDeploy }), [requestDeploy]);

    // 挂载先查该 session 的部署状态：有进行中/已完成的 kind='deploy' 则恢复展示，不重复触发。
    // 主动部署（requestedRef=true，由 requestDeploy 触发）时跳过本逻辑。
    // 无该 session 的部署记录 → 保持 idle 空态，等用户点"Deploy"再部署，绝不自动重新部署。
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
                    setPhase(active.stage === 'B' ? 'B' : active.stage === 'preview' ? 'preview' : 'A');
                    setRecoveredId(active.id);
                } else if (deployRows.length > 0) {
                    const last = deployRows[0];
                    if (last.status === 'running') setRunState('success');
                    else if (last.status === 'failed') { setRunState('failed'); setResult({ ok: false, error: last.stage_message || '上次部署失败', stage: last.stage }); }
                    else if (last.status === 'stopped') setRunState('aborted');
                }
                // 无该 session 记录 → 保持 idle（空态）
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
                    setPhase(row.stage === 'B' ? 'B' : row.stage === 'preview' ? 'preview' : 'A');
                } else if (row.status === 'running') {
                    setRunState('success'); setRecoveredId(null);
                } else if (row.status === 'failed') {
                    setRunState('failed'); setResult({ ok: false, error: row.stage_message || '部署失败', stage: row.stage }); setRecoveredId(null);
                } else if (row.status === 'stopped') {
                    setRunState('aborted'); setRecoveredId(null);
                }
            } catch { /* ignore */ }
        }, 3000);
        return () => clearInterval(id);
    }, [recoveredId, projectId, sessionId]);

    // 部署中轮询兜底：SSE 断开/verify 卡死时也能感知部署终态（running/failed/stopped），
    // 避免前端一直卡在 running（右上角 Stop deploy 停不下来）。SSE 正常时由 result 事件接管。
    const runStateRef = useRef(runState);
    runStateRef.current = runState;
    useEffect(() => {
        if (runState !== 'running') return undefined;
        const id = setInterval(async () => {
            try {
                const res = await apiFetch(withSessionId(`/api/v1/deployments?project_id=${encodeURIComponent(projectId)}`));
                const data = await res.json();
                const list = Array.isArray(data) ? data : (data?.deployments || []);
                const rows = list.filter((d) => d.kind === 'deploy' && (!sessionId || d.session_id === sessionId)).sort((a, b) => b.created_at - a.created_at);
                if (!rows.length) return;
                const latest = rows[0];
                if (latest.status !== 'running' && latest.status !== 'failed' && latest.status !== 'stopped') return;
                if (runStateRef.current !== 'running') return; // 已被 SSE 结果接管
                if (latest.status === 'running') {
                    setRunState('success');
                    jumpTimerRef.current = setTimeout(() => onSuccess?.(latest), 800);
                } else if (latest.status === 'failed') {
                    setRunState('failed');
                    setResult({ ok: false, error: latest.stage_message || '部署失败', stage: latest.stage });
                } else if (latest.status === 'stopped') {
                    setRunState('aborted');
                }
            } catch { /* ignore */ }
        }, 5000);
        return () => clearInterval(id);
    }, [runState, projectId, sessionId, onSuccess]);

    useEffect(() => () => {
        if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
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
                            currentStep={phase === 'B' || phase === 'preview' ? 'build' : 'analyze'}
                        />
                        {phase === 'preview' && <div className="text-sm text-zinc-500">{t('deploy:running.opening_preview')}</div>}
                    </div>
                )}
                {runState === 'aborted' && (
                    <div className="flex flex-col items-center justify-center text-center gap-3 px-6 py-8">
                        <AlertCircle className="w-9 h-9 text-zinc-400" />
                        <div className="text-sm font-semibold text-zinc-700">{t('deploy:aborted')}</div>
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
                                · 「{o.projectName || o.projectId}」{o.kind === 'preview' ? t('deploy:occupant.preview_running') : t('deploy:occupant.deploying')}
                                {o.sessionId ? t('deploy:occupant.session', { id: o.sessionId.slice(-8) }) : ''}
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
                                <div className="text-[10px] font-mono text-zinc-500 space-y-0.5 max-h-48 overflow-y-auto bg-white/60 border border-zinc-200 rounded p-2">
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
