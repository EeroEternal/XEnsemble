import { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2, CheckCircle2, AlertCircle, RotateCcw, Copy, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { buttonClass } from '../lib/buttonStyles';
import { apiFetch } from '../lib/api';
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
export default function DeployPanel({ projectId, sessionId, onSuccess }) {
    const [runState, setRunState] = useState('idle');
    const [result, setResult] = useState(null);
    const [latestMessage, setLatestMessage] = useState(null);
    const autoStartedRef = useRef(false);
    const jumpTimerRef = useRef(null);

    const startRun = useCallback(async (opts = {}) => {
        setRunState('running');
        setResult(null);
        setLatestMessage(null);
        try {
            const res = await apiFetch(
                withSessionId(`/api/v1/projects/${encodeURIComponent(projectId)}/auto-deploy`),
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resume: !!opts.resume }) },
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Auto-deploy failed (${res.status})`);
            if (data.ok) {
                setResult(data);
                setRunState('success');
                jumpTimerRef.current = setTimeout(() => onSuccess?.(data), 800);
            } else {
                setResult(data);
                setRunState('failed');
            }
        } catch (e) {
            setResult({ ok: false, error: e.message || String(e) });
            setRunState('failed');
        }
    }, [projectId, sessionId, onSuccess]);

    useEffect(() => {
        if (autoStartedRef.current) return;
        autoStartedRef.current = true;
        startRun();
    }, [startRun]);

    useEffect(() => () => {
        if (jumpTimerRef.current) clearTimeout(jumpTimerRef.current);
    }, []);

    const friendlyStage = (stage) => {
        switch (stage) {
            case 'A': return '正在分析你的项目…';
            case 'B': return '正在准备运行环境并测试…';
            case 'preview': return '正在开启预览…';
            default: return '';
        }
    };

    useEffect(() => {
        if (runState !== 'running' || !result) return;
        const text = friendlyStage(result?.stage) || (result?.error || '');
        if (text) setLatestMessage(text);
    }, [result, runState]);

    const retry = () => {
        autoStartedRef.current = false;
        setRunState('idle');
        setResult(null);
        setLatestMessage(null);
        setTimeout(() => { autoStartedRef.current = true; startRun(); }, 0);
    };

    const resumeRun = () => {
        autoStartedRef.current = false;
        setRunState('idle');
        setResult(null);
        setLatestMessage(null);
        setTimeout(() => { autoStartedRef.current = true; startRun({ resume: true }); }, 0);
    };

    const resumeReady = !!result?.verify?.resumeReady;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center">
                {runState === 'running' && (
                    <div className="flex flex-col items-center justify-center text-center gap-3 px-6 py-8">
                        <Loader2 className="w-9 h-9 animate-spin text-blue-600" />
                        <div className="text-sm font-medium text-zinc-900">分析部署中…</div>
                        {latestMessage ? (
                            <div className="text-xs text-zinc-500 max-w-md truncate" title={latestMessage}>{latestMessage}</div>
                        ) : null}
                    </div>
                )}
                {runState === 'success' && result && (
                    <div className="flex flex-col items-center justify-center text-center gap-3 px-6 py-8">
                        <CheckCircle2 className="w-10 h-10 text-green-600" />
                        <div className="text-base font-semibold text-zinc-900">部署完成 ✓</div>
                        <div className="text-xs text-zinc-500">正在打开预览…</div>
                    </div>
                )}
                {runState === 'failed' && result && (
                    <FailureView result={result} />
                )}
            </div>
            {runState === 'failed' && (
                <div className="border-t border-zinc-200 px-5 py-3 bg-zinc-50/80 flex justify-center items-center gap-2 shrink-0">
                    <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => copyDiagnostics(result)}>
                        <Copy className="w-3.5 h-3.5" />
                        复制诊断信息
                    </button>
                    {resumeReady && (
                        <button type="button" className={buttonClass('primary', 'sm')} onClick={resumeRun}>
                            <RefreshCw className="w-3.5 h-3.5" />
                            从上次继续修复
                        </button>
                    )}
                    <button type="button" className={buttonClass(resumeReady ? 'secondary' : 'primary', 'sm')} onClick={retry}>
                        <RotateCcw className="w-3.5 h-3.5" />
                        重新部署
                    </button>
                </div>
            )}
        </div>
    );
}

function copyDiagnostics(result) {
    const lines = [
        '== SkyHarness 部署诊断 ==',
        `错误: ${result?.error || ''}`,
        `警告: ${result?.verify?.warning || ''}`,
        '',
        '== 最终输出 ==',
        result?.finalStderr || result?.verify?.finalStderr || '(无)',
        '',
        '== 已尝试的步骤 ==',
        ...((result?.verify?.tested || []).map((t, i) => `${i + 1}. ${t}`)),
        '',
        '== AI 修复过程（最近）==',
        ...((result?.verify?.trail || []).slice(-20).map((t) => {
            if (t.action === 'tool') return `[${t.round}] ${t.tool} ${JSON.stringify(t.args || '')} → ${t.out || ''}`;
            if (t.action === 'invalid_json') return `[${t.round}] 输出超长/截断(truncated=${t.truncated}, ${t.len} chars)，JSON 解析失败`;
            if (t.action === 'repeat') return `[${t.round}] 重复调用 ${t.tool}，被阻止`;
            if (t.action === 'final') return `[${t.round}] final ok=${t.ok}`;
            return `[${t.round}] ${t.action} ${t.name || ''}`;
        })),
    ];
    navigator.clipboard?.writeText(lines.join('\n')).catch(() => {});
}

function FailureView({ result }) {
    const [showDetails, setShowDetails] = useState(false);
    const trail = result?.verify?.trail || [];
    const fallback = result?.verify?.fallback;
    const showTrail = Array.isArray(trail) && trail.length > 0;
    const showFallback = fallback && !fallback.ok;
    const hasDetails = showTrail || showFallback;

    return (
        <div className="flex flex-col items-center justify-center text-center gap-3 px-6 py-8 w-full max-w-lg">
            <AlertCircle className="w-9 h-9 text-red-600" />
            <div className="text-sm font-semibold text-red-700">部署失败</div>
            {result?.verify?.warning ? (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-1.5">{result.verify.warning}</div>
            ) : null}
            <div className="text-xs text-zinc-600 max-w-md break-words px-4 text-left">
                {result.error ? <div className="mb-2">{result.error}</div> : null}
                {result.finalStderr || result?.verify?.finalStderr ? (
                    <pre className="mt-1 bg-white/60 border border-red-200 rounded p-2 font-mono text-[10px] text-red-800 max-h-40 overflow-y-auto whitespace-pre-wrap break-words">{result.finalStderr || result.verify.finalStderr}</pre>
                ) : null}
            </div>
            {hasDetails && (
                <>
                    <button
                        type="button"
                        onClick={() => setShowDetails((v) => !v)}
                        className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-900"
                    >
                        {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        {showDetails ? '收起修复过程' : '查看 AI 修复过程'}
                    </button>
                    {showDetails && (
                        <div className="w-full text-left">
                            {showFallback && (
                                <div className="mb-3 text-xs text-red-800 bg-red-50 border border-red-200 rounded p-2">
                                    <div className="font-semibold mb-1">按计划直接执行时发现：</div>
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
