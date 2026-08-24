import {
  ConsoleDialogShell,
  ConsoleStructuredDialogBody,
  ConsoleStructuredDialogFooter,
  ConsoleStructuredDialogHeader,
} from '../ConsoleDialog';
import Button from '../Button';
import {
  consoleCardClass,
  consoleSectionLabelClass,
  consoleStructuredDialogPanelClass,
} from '../../lib/consoleTokens';

function getAuthSummary(agent) {
  return {
    mode: 'Gateway',
    hint: agent.keys_ready ? 'Ready' : 'Needs model',
    hintClass: agent.keys_ready ? 'text-emerald-600' : 'text-amber-600',
  };
}

function DetailField({ label, children, className, mono = false }) {
  return (
    <div className={className ?? 'min-w-0'}>
      <p className={consoleSectionLabelClass}>{label}</p>
      <p className={`mt-0.5 text-sm ${mono ? 'break-all font-mono text-zinc-600' : 'text-zinc-700'}`}>
        {children}
      </p>
    </div>
  );
}

export default function AgentDetailsDialog({ agent, onClose }) {
  if (!agent) return null;

  const auth = getAuthSummary(agent);
  const rawModel = agent.gateway_config?.model;
  const modelList = Array.isArray(rawModel)
    ? rawModel.map((m) => String(m || '').trim()).filter(Boolean)
    : (rawModel ? [String(rawModel).trim()] : []);
  const model = modelList.length > 0 ? modelList.join(', ') : '-';
  const executable = [agent.cmd, ...(agent.args || [])].filter(Boolean).join(' ') || '-';

  return (
    <ConsoleDialogShell
      onClose={onClose}
      panelClassName={consoleStructuredDialogPanelClass}
    >
      <ConsoleStructuredDialogHeader>
        <div className="min-w-0">
          <h3 className="font-bold text-lg text-zinc-900">{agent.name}</h3>
          <p className="mt-0.5 truncate font-mono text-xs text-zinc-500">{agent.id}</p>
        </div>
      </ConsoleStructuredDialogHeader>
      <ConsoleStructuredDialogBody>
        <div className={`${consoleCardClass} space-y-3 bg-zinc-50/70 p-4`}>
          <div>
            <p className={consoleSectionLabelClass}>Auth</p>
            <p className="mt-1 text-sm font-medium text-zinc-900">
              {auth.mode}
              <span className={`ml-1 text-sm ${auth.hintClass}`}>({auth.hint})</span>
            </p>
          </div>
          <div>
            <p className={consoleSectionLabelClass}>Session readiness</p>
            <p className={`mt-1 text-base font-semibold ${auth.hintClass}`}>{auth.hint}</p>
          </div>
        </div>

        <div className={`${consoleCardClass} space-y-3 bg-zinc-50/70 p-4`}>
          <p className={consoleSectionLabelClass}>Runtime</p>
          <div className="grid grid-cols-1 gap-4">
            <DetailField label="Model" mono>
              {model}
            </DetailField>
            <DetailField label="Executable" className="min-w-0" mono>
              {executable}
            </DetailField>
          </div>
        </div>
      </ConsoleStructuredDialogBody>
      <ConsoleStructuredDialogFooter>
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      </ConsoleStructuredDialogFooter>
    </ConsoleDialogShell>
  );
}
