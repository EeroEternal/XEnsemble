import { useState, useEffect } from 'react';
import { Loader2, Rocket } from 'lucide-react';
import {
    ConsoleDialogShell,
    ConsoleStructuredDialogHeader,
    ConsoleStructuredDialogBody,
    ConsoleStructuredDialogFooter,
} from './ConsoleDialog';
import { consoleStructuredDialogPanelClass } from '../lib/consoleTokens';
import { buttonClass } from '../lib/buttonStyles';
import Input from './Input';
import { apiFetch } from '../lib/api';
import { useToast } from './Toast';

/**
 * 一键部署确认弹窗（小火箭按钮触发，覆盖在 Terminal tab 上）。
 *
 * 职责：调后端 analyze-deploy API 分析项目 -> 展示可编辑的部署步骤 -> 用户确认。
 * 确认后调 onConfirm(steps)，由父组件（Sessions.jsx）接管执行：
 *   - prepare 步骤通过 WorkspaceShell 的 sendInput 注入 Terminal 执行
 *   - serve 步骤写 .agents/preview.json + 调 preview API
 *   - 完成后创建 Preview tab
 */
export default function DeployDialog({ projectId, onClose, onConfirm }) {
    const { showToast } = useToast();
    // 阶段：analyzing(分析中) -> reviewing(确认步骤)
    const [phase, setPhase] = useState('analyzing');
    const [steps, setSteps] = useState([]);
    const [source, setSource] = useState('');
    const [warning, setWarning] = useState(null);
    const [confirming, setConfirming] = useState(false);

    // 打开弹窗时立即调 analyze-deploy API 分析项目
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
                setSource(data.source || 'fallback');
                setWarning(data.warning || null);
                setPhase('reviewing');
            } catch (e) {
                if (cancelled) return;
                showToast('error', e.message);
                onClose();
            }
        })();
        return () => { cancelled = true; };
    }, [projectId]);

    // 用户编辑某步的名称或命令
    const updateStep = (idx, field, value) => {
        setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, [field]: value } : s)));
    };

    // 确认部署：调 onConfirm 交由父组件执行，完成后关闭弹窗
    const handleConfirm = async () => {
        setConfirming(true);
        try {
            await onConfirm(steps);
            onClose();
        } catch (e) {
            showToast('error', e.message);
        } finally {
            setConfirming(false);
        }
    };

    return (
        <ConsoleDialogShell onClose={onClose} panelClassName={consoleStructuredDialogPanelClass}>
            <ConsoleStructuredDialogHeader
                title="Deploy Preview"
                subtitle={phase === 'reviewing' ? `AI-analyzed steps (${source})` : undefined}
            />
            <ConsoleStructuredDialogBody>
                {phase === 'analyzing' && (
                    <div className="flex items-center gap-2 text-sm text-zinc-500 py-8 justify-center">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Analyzing project...
                    </div>
                )}

                {phase === 'reviewing' && (
                    <div className="space-y-3">
                        {warning && (
                            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                                {warning}
                            </div>
                        )}
                        {steps.map((step, idx) => (
                            <div key={step.id} className="space-y-1.5">
                                <div className="flex items-center gap-2">
                                    <span className="text-xs font-mono text-zinc-400 shrink-0 w-4">{idx + 1}.</span>
                                    <Input
                                        value={step.name}
                                        onChange={(e) => updateStep(idx, 'name', e.target.value)}
                                        className="text-sm font-medium"
                                        autoFocus={idx === 0}
                                    />
                                    <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded shrink-0 ${step.kind === 'serve' ? 'bg-green-100 text-green-700' : 'bg-zinc-100 text-zinc-500'}`}>
                                        {step.kind}
                                    </span>
                                </div>
                                <Input
                                    value={step.command}
                                    onChange={(e) => updateStep(idx, 'command', e.target.value)}
                                    className="font-mono text-xs"
                                />
                                {step.description && (
                                    <p className="text-xs text-zinc-500 pl-6">{step.description}</p>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </ConsoleStructuredDialogBody>
            <ConsoleStructuredDialogFooter>
                <button
                    type="button"
                    className={buttonClass('secondary', 'sm')}
                    onClick={onClose}
                    disabled={confirming}
                >
                    Cancel
                </button>
                {phase === 'reviewing' && (
                    <button
                        type="button"
                        className={buttonClass('primary', 'sm')}
                        onClick={handleConfirm}
                        disabled={confirming || steps.length === 0}
                    >
                        {confirming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />}
                        Deploy
                    </button>
                )}
            </ConsoleStructuredDialogFooter>
        </ConsoleDialogShell>
    );
}
