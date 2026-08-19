import { X } from 'lucide-react';
import { ConsoleDialogShell } from './ConsoleDialog';
import { consoleDialogPanelClass } from '../lib/consoleTokens';
import { ImagesAdminContent } from '../pages/ImagesAdmin';

export default function AgentImagesModal({ initialAgentId, onClose }) {
  return (
    <ConsoleDialogShell
      onClose={onClose}
      panelClassName={`${consoleDialogPanelClass} w-[800px] max-w-[calc(100vw-2rem)] h-[600px] max-h-[calc(100vh-2rem)]`}
      panelProps={{ 'aria-labelledby': 'agent-images-modal-title' }}
    >
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-5 pt-3 pb-1 shrink-0">
          <h2 id="agent-images-modal-title" className="font-bold text-lg text-zinc-900">
            Agent Images
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close agent images"
            className="flex items-center justify-center w-8 h-8 rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0 px-5 py-3">
          <ImagesAdminContent initialAgentId={initialAgentId} />
        </div>
      </div>
    </ConsoleDialogShell>
  );
}
