import {
  ConsoleDialogShell,
  ConsoleStructuredDialogBody,
  ConsoleStructuredDialogFooter,
  ConsoleStructuredDialogHeader,
} from '../ConsoleDialog';
import Button from '../Button';
import StatusBadge from '../StatusBadge';
import { CheckCircle, Clock } from 'lucide-react';
import {
  consoleCardClass,
  consoleSectionLabelClass,
  consoleStructuredDialogPanelClass,
} from '../../lib/consoleTokens';

function statusBadge(installed) {
  return installed
    ? { tone: 'success', icon: CheckCircle, label: 'Installed' }
    : { tone: 'warning', icon: Clock, label: 'Not installed' };
}

function getAuthSummary(agent) {
  const isGateway = agent.llm_auth_mode === 'gateway';
  if (isGateway) {
    return {
      mode: 'Gateway',
      hint: agent.keys_ready ? 'Ready' : 'Needs model',
      hintClass: agent.keys_ready ? 'text-emerald-600' : 'text-amber-600',
    };
  }
  return {
    mode: 'BYOK',
    hint: 'User keys',
    hintClass: 'text-zinc-500',
  };
}

function formatLifecycleTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
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
  const model = agent.llm_auth_mode === 'gateway' && agent.gateway_config?.model
    ? agent.gateway_config.model
    : '-';
  const executable = [agent.cmd, ...(agent.args || [])].filter(Boolean).join(' ') || '-';
  const path = agent.executable_path_display || agent.executable_path || '-';

  return (
    <ConsoleDialogShell
      onClose={onClose}
      panelClassName={consoleStructuredDialogPanelClass}
    >
      <ConsoleStructuredDialogHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-bold text-lg text-zinc-900">{agent.name}</h3>
            <p className="mt-0.5 truncate font-mono text-xs text-zinc-500">{agent.id}</p>
          </div>
          <StatusBadge tone={statusBadge(agent.installed).tone} icon={statusBadge(agent.installed).icon} label={statusBadge(agent.installed).label} />
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
            <DetailField label="Version" mono>
              {agent.local_version ? `v${agent.local_version}` : '-'}
            </DetailField>
            <DetailField label="Model" mono>
              {model}
            </DetailField>
            <DetailField label="Path" className="min-w-0" mono>
              {path}
            </DetailField>
            <DetailField label="Executable" className="min-w-0" mono>
              {executable}
            </DetailField>
          </div>
        </div>

        {agent.last_lifecycle ? (
          <div className={`${consoleCardClass} space-y-2 bg-zinc-50/70 p-4`}>
            <p className={consoleSectionLabelClass}>Last operation</p>
            <p className={`text-sm font-medium ${agent.last_lifecycle.ok ? 'text-zinc-700' : 'text-red-600'}`}>
              {agent.last_lifecycle.ok
                ? `${agent.last_lifecycle.action} OK`
                : `${agent.last_lifecycle.action} failed`}
            </p>
            {!agent.last_lifecycle.ok && agent.last_lifecycle.message ? (
              <p className="text-sm text-zinc-500">{agent.last_lifecycle.message}</p>
            ) : null}
            <p className="text-xs text-zinc-400">
              {formatLifecycleTime(agent.last_lifecycle.finished_at)}
            </p>
          </div>
        ) : null}
      </ConsoleStructuredDialogBody>
      <ConsoleStructuredDialogFooter>
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      </ConsoleStructuredDialogFooter>
    </ConsoleDialogShell>
  );
}
