import { useState, useEffect } from 'react';
import { Loader2, Rocket, FileText, CheckCircle2, AlertCircle, Terminal, X, RotateCcw } from 'lucide-react';
import { buttonClass } from '../lib/buttonStyles';
import Input, { Textarea } from './Input';
import { apiFetch } from '../lib/api';
import { useToast } from './Toast';

/**
 * 一键部署面板（WorkspacePanel 的 'deploy' tab）。
 *
 * 职责：调 analyze-deploy API 分析项目 -> 展示配置文件编辑区 + 部署步骤 -> 用户确认。
 * 确认后调 onConfirm({ steps, configFiles })，由 Sessions.jsx 接管：
 *   - 先写 configFiles 到 VM（用户填写的配置）
 *   - 关闭 deploy tab + 创建 terminal tab
 *   - prepare 步骤通过 WorkspaceShell.sendInput 注入 Terminal 执行
 *   - serve 步骤在 Terminal 启动 + 建立 tunnel-preview 隧道
 */
export default function DeployPanel({ projectId, onConfirm, onCancel, onEnd }) {
    const { showToast } = useToast();
    const [phase, setPhase] = useState('analyzing');
    const [steps, setSteps] = useState([]);
    const [configFiles, setConfigFiles] = useState([]);
    const [source, setSource] = useState('');
    const [warning, setWarning] = useState(null);
    const [deploying, setDeploying] = useState(false);
    const [deployResult, setDeployResult] = useState(null);
    // 每步执行状态: 'pending' | 'running' | 'success' | 'failed' | 'skipped'
    const [stepStatuses, setStepStatuses] = useState([]);
    // 最近一次失败的步骤索引（用于"重试该步"/"从该步继续"）
    const [failedIndex, setFailedIndex] = useState(-1);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await apiFetch(
                    `/api/v1/projects/${encodeURIComponent(projectId)}/analyze-deploy`,
                    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
                );
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Analysis failed');
                if (cancelled) return;
                setSteps(data.steps || []);
                setConfigFiles((data.configFiles || []).map((c) => ({ ...c, _originalTemplate: c.template })));
                setSource(data.source || 'fallback');
                setWarning(data.warning || null);
                setPhase('reviewing');
            } catch (e) {
                if (cancelled) return;
                showToast('error', e.message);
                onCancel();
            }
        })();
        return () => { cancelled = true; };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const updateStep = (idx, field, value) => {
        setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, [field]: value } : s)));
    };

    const updateConfigFile = (idx, value) => {
        setConfigFiles((prev) => prev.map((c, i) => (i === idx ? { ...c, template: value } : c)));
    };

    const runDeploy = async (startIndex = 0) => {
        setDeploying(true);
        setDeployResult(null);
        if (startIndex === 0) {
            setStepStatuses(steps.map(() => 'pending'));
            setFailedIndex(-1);
        }
        try {
            const result = await onConfirm({ steps, configFiles, startIndex });
            // result: { failedIndex, stepResults, success?, error? }
            if (result?.stepResults) {
                setStepStatuses((prev) => {
                    const next = [...prev];
                    result.stepResults.forEach((r, i) => {
                        if (i >= startIndex && r.status) next[i] = r.status;
                    });
                    return next;
                });
            }
            if (result?.failedIndex >= 0) {
                setFailedIndex(result.failedIndex);
                setDeployResult({ ok: false, message: result.error || `Step ${result.failedIndex} failed` });
            } else {
                setFailedIndex(-1);
                setDeployResult({ ok: true });
            }
        } catch (e) {
            setDeployResult({ ok: false, message: e.message || String(e) });
            showToast('error', e.message);
        } finally {
            setDeploying(false);
        }
    };

    const handleConfirm = () => runDeploy(0);
    const handleRetryFailed = () => failedIndex >= 0 && runDeploy(failedIndex);

    return (
        <div className="flex h-full flex-col bg-white">
            <div className="px-5 py-3 border-b border-zinc-200 shrink-0">
                <div className="flex items-center justify-between">
                    <h3 className="font-bold text-sm text-zinc-900">Deploy Preview</h3>
                    {phase === 'reviewing' && !deploying && !deployResult && (
                        <span className="text-xs text-zinc-500">AI-analyzed steps ({source})</span>
                    )}
                    {deploying && (
                        <span className="flex items-center gap-1.5 text-xs text-blue-700 font-medium">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            Deploying in progress — watch the Terminal tab on the right
                        </span>
                    )}
                    {deployResult?.ok && (
                        <span className="flex items-center gap-1.5 text-xs text-green-700 font-medium">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Deployment complete
                        </span>
                    )}
                    {deployResult && !deployResult.ok && (
                        <span className="flex items-center gap-1.5 text-xs text-red-700 font-medium">
                            <AlertCircle className="w-3.5 h-3.5" />
                            Deployment failed
                        </span>
                    )}
                </div>
                {phase === 'reviewing' && !deploying && (
                    <p className="text-xs text-zinc-500 mt-1 flex items-center gap-1">
                        <Terminal className="w-3 h-3" />
                        Tip: this panel stays open during deployment so you can copy / adjust commands in the Terminal.
                    </p>
                )}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
                {phase === 'analyzing' && (
                    <div className="flex items-center gap-2 text-sm text-zinc-500 py-8 justify-center">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Analyzing project...
                    </div>
                )}
                {phase === 'reviewing' && (
                    <>
                        {warning && (
                            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                                {warning}
                            </div>
                        )}
                        {configFiles.length > 0 && (
                            <div className="space-y-3">
                                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-700 uppercase tracking-wide">
                                    <FileText className="w-3.5 h-3.5" />
                                    Configuration Files
                                    <span className="text-[10px] font-normal text-zinc-500 normal-case">({configFiles.length} 需要填写)</span>
                                </div>
                                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                                    ⚠ 部署前必须填写这些配置（特别是 API key、密钥等），否则服务可能启动失败。
                                </p>
                                {configFiles.map((cf, idx) => {
                                    const descLines = (cf.description || '').split(/\n+/).map((s) => s.replace(/^[\s\-\*•]+/, '').trim()).filter(Boolean);
                                    const keyList = Array.isArray(cf.keys) && cf.keys.length > 0 ? cf.keys : null;
                                    const isDirty = cf._originalTemplate != null && cf._originalTemplate !== cf.template;
                                    return (
                                        <div key={cf.path} className="space-y-1.5 border border-amber-200 rounded-md p-3 bg-amber-50/30">
                                            <div className="flex items-center justify-between">
                                                <span className="text-xs font-mono font-semibold text-amber-900 bg-amber-100 px-1.5 py-0.5 rounded">{cf.path}</span>
                                                <button
                                                    type="button"
                                                    className="text-[10px] text-zinc-500 hover:text-zinc-900 disabled:opacity-50"
                                                    onClick={() => updateConfigFile(idx, cf._originalTemplate ?? cf.template)}
                                                    disabled={!isDirty || deploying}
                                                    title="恢复 AI 生成的原始模板"
                                                >
                                                    <RotateCcw className="w-3 h-3 inline mr-0.5" />重置
                                                </button>
                                            </div>
                                            {descLines.length > 0 && (
                                                <ul className="text-xs text-zinc-700 list-disc list-inside space-y-0.5 pl-1">
                                                    {descLines.map((line, i) => (
                                                        <li key={i}>{line}</li>
                                                    ))}
                                                </ul>
                                            )}
                                            {keyList && (
                                                <div className="flex flex-wrap gap-1.5 pt-0.5">
                                                    <span className="text-[10px] text-zinc-500">需要填写:</span>
                                                    {keyList.map((k) => (
                                                        <span key={k} className="text-[10px] font-mono bg-red-100 text-red-700 px-1.5 py-0.5 rounded border border-red-200">{k}</span>
                                                    ))}
                                                </div>
                                            )}
                                            <Textarea
                                                value={cf.template}
                                                onChange={(e) => updateConfigFile(idx, e.target.value)}
                                                className="font-mono text-xs bg-white"
                                                rows={8}
                                                autoFocus={idx === 0}
                                            />
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        {steps.length > 0 && (
                            <div className="space-y-3">
                                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-700 uppercase tracking-wide">
                                    <Rocket className="w-3.5 h-3.5" />
                                    Deployment Steps
                                </div>
                                {steps.map((step, idx) => {
                                    const status = stepStatuses[idx] || 'pending';
                                    return (
                                        <div key={step.id} className={`space-y-1.5 ${status === 'failed' ? 'rounded-md ring-1 ring-red-300 p-1 -m-1' : ''}`}>
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-mono text-zinc-400 shrink-0 w-4">{idx + 1}.</span>
                                                {status === 'success' && <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />}
                                                {status === 'failed' && <AlertCircle className="w-3.5 h-3.5 text-red-600 shrink-0" />}
                                                {status === 'running' && <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600 shrink-0" />}
                                                <Input
                                                    value={step.name}
                                                    onChange={(e) => updateStep(idx, 'name', e.target.value)}
                                                    className="text-sm font-medium"
                                                    autoFocus={idx === 0 && configFiles.length === 0}
                                                    disabled={deploying}
                                                />
                                                <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded shrink-0 ${step.kind === 'serve' ? 'bg-green-100 text-green-700' : 'bg-zinc-100 text-zinc-500'}`}>
                                                    {step.kind}
                                                </span>
                                            </div>
                                            <Textarea
                                                value={step.command}
                                                onChange={(e) => updateStep(idx, 'command', e.target.value)}
                                                className="font-mono text-xs bg-white"
                                                rows={Math.min(6, Math.max(2, step.command.split('\n').length + 1))}
                                                disabled={deploying}
                                            />
                                            {status === 'failed' && stepStatuses.length > idx && (
                                                <div className="flex items-center gap-2 pl-6 mt-1">
                                                    <span className="text-xs text-red-700">failed</span>
                                                    <button
                                                        type="button"
                                                        className={buttonClass('secondary', 'sm')}
                                                        onClick={handleRetryFailed}
                                                        title={`重跑第 ${failedIndex + 1} 步: ${step.name || ''}`}
                                                    >
                                                        <RotateCcw className="w-3.5 h-3.5" />
                                                        重试该步
                                                    </button>
                                                </div>
                                            )}
                                            {step.description && status !== 'failed' && (
                                                <p className="text-xs text-zinc-500 pl-6">{step.description}</p>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </>
                )}
            </div>
            <div className="border-t border-zinc-200 px-5 py-3 bg-zinc-50/80 flex justify-between items-center gap-2 shrink-0">
                <div className="text-xs text-zinc-500">
                    {deploying && 'Commands are running in the Terminal tab. You can copy / adjust them there if needed.'}
                    {deployResult?.ok && 'Done. Open the Preview tab to see the app, or re-edit steps and Redeploy.'}
                    {deployResult && !deployResult.ok && 'Failed. Check the Terminal tab for the error and re-deploy after fixing.'}
                </div>
                <div className="flex gap-2">
                    <button
                        type="button"
                        className={buttonClass('danger', 'sm')}
                        onClick={onEnd}
                        disabled={deploying}
                        title="关闭本次部署，清空当前内容"
                    >
                        <X className="w-3.5 h-3.5" />
                        结束本次部署
                    </button>
                    <button
                        type="button"
                        className={buttonClass('secondary', 'sm')}
                        onClick={onCancel}
                        disabled={deploying}
                    >
                        {deployResult ? 'Close' : 'Cancel'}
                    </button>
                    {phase === 'reviewing' && (
                        <button
                            type="button"
                            className={buttonClass('primary', 'sm')}
                            onClick={handleConfirm}
                            disabled={deploying || steps.length === 0}
                        >
                            {deploying ? (
                                <>
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    Deploying...
                                </>
                            ) : deployResult ? (
                                <>
                                    <Rocket className="w-3.5 h-3.5" />
                                    Redeploy
                                </>
                            ) : (
                                <>
                                    <Rocket className="w-3.5 h-3.5" />
                                    Deploy
                                </>
                            )}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
