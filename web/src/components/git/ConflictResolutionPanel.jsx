import { useCallback, useState } from 'react';
import { ChevronRight, GitMerge } from 'lucide-react';
import { useToast } from '../Toast';
import * as gitApi from '../../lib/gitApi';
import MergeEditorDialog from './MergeEditorDialog';
import {
  borderHairline,
  bgCanvas,
} from '../../lib/consoleTokens';

export function ConflictFileItem({ file, projectId, onResolved }) {
  const { showToast } = useToast();
  const [mergeOpen, setMergeOpen] = useState(false);
  const [oursContent, setOursContent] = useState(null);
  const [theirsContent, setTheirsContent] = useState(null);
  const [loading, setLoading] = useState(false);

  const openMerge = useCallback(async () => {
    setMergeOpen(true);
    setLoading(true);
    try {
      const [oursRes, theirsRes] = await Promise.all([
        gitApi.getFileAtRef(projectId, file.path, 'HEAD').catch(() => ({ content: '(unable to load)' })),
        gitApi.getFileAtRef(projectId, file.path, 'MERGE_HEAD').catch(() => ({ content: '(unable to load)' })),
      ]);
      setOursContent(oursRes.content || '');
      setTheirsContent(theirsRes.content || '');
    } catch {
      showToast('error', `Failed to load file content for ${file.path}`);
    } finally {
      setLoading(false);
    }
  }, [projectId, file, showToast]);

  return (
    <>
      <div className={`border ${borderHairline} rounded-lg overflow-hidden`}>
        <button
          type="button"
          onClick={openMerge}
          className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm ${bgCanvas} hover:bg-zinc-100 transition-colors`}
        >
          <GitMerge className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span className="font-mono text-xs truncate flex-1">{file.path}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        </button>
      </div>
      <MergeEditorDialog
        open={mergeOpen}
        file={file}
        projectId={projectId}
        oursContent={oursContent}
        theirsContent={theirsContent}
        loading={loading}
        onClose={() => setMergeOpen(false)}
        onResolved={onResolved}
      />
    </>
  );
}
