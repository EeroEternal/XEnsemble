import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, Loader2, RefreshCw, User, FolderOpen, Search } from 'lucide-react';
import * as gitApi from '../../lib/gitApi';
import { useToast } from '../Toast';
import {
  consoleIconButtonClass,
  textPrimary,
  textSecondary,
  textPlaceholder,
  borderHairline,
} from '../../lib/consoleTokens';

function shaToColor(sha) {
  if (!sha) return '#f4f4f5';
  let hash = 0;
  for (let i = 0; i < sha.length; i++) {
    hash = sha.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 40%, 92%)`;
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleDateString();
}

function BlameLine({ entry, prevSha, showGutter }) {
  const isNewBlock = entry.sha !== prevSha;
  const bg = shaToColor(entry.sha);

  return (
    <div className="flex text-xs font-mono leading-5 hover:bg-zinc-100 transition-colors">
      <div
        className="w-40 shrink-0 flex items-center gap-2 px-2 border-r border-zinc-200 overflow-hidden"
        style={{ backgroundColor: isNewBlock ? bg : 'transparent' }}
      >
        {isNewBlock ? (
          <>
            <span className="w-14 truncate text-[10px] text-zinc-500" title={entry.sha}>
              {entry.sha?.slice(0, 7)}
            </span>
            <span className="flex-1 truncate text-[10px] text-zinc-900" title={entry.author}>
              {entry.author}
            </span>
            <span className="text-[10px] text-zinc-400 shrink-0">
              {formatDate(entry.date)}
            </span>
          </>
        ) : (
          <span className="text-[10px] text-transparent select-none">.</span>
        )}
      </div>

      <div className="w-10 shrink-0 text-right pr-2 text-zinc-400 select-none border-r border-zinc-200">
        {entry.lineNumber}
      </div>

      <div className="flex-1 min-w-0 px-3 whitespace-pre overflow-x-auto text-zinc-900">
        {entry.content}
      </div>
    </div>
  );
}

export default function GitBlamePanel({ projectId }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [blameData, setBlameData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [files, setFiles] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [fileSearch, setFileSearch] = useState('');
  const [showFilePicker, setShowFilePicker] = useState(false);

  const fetchFiles = useCallback(async () => {
    if (!projectId) return;
    setLoadingFiles(true);
    try {
      const data = await gitApi.listTrackedFiles(projectId);
      setFiles(data.files || []);
    } catch (err) {
      showToast('error', err.message);
      setFiles([]);
    } finally {
      setLoadingFiles(false);
    }
  }, [projectId, showToast]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const fetchBlame = useCallback(async () => {
    if (!projectId || !selectedFile) return;
    setLoading(true);
    try {
      const data = await gitApi.getBlame(projectId, selectedFile, {});
      setBlameData(data.entries || []);
    } catch (err) {
      showToast('error', err.message);
      setBlameData([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, selectedFile, showToast]);

  useEffect(() => {
    fetchBlame();
  }, [fetchBlame]);

  const filteredFiles = fileSearch
    ? files.filter((f) => f.toLowerCase().includes(fileSearch.toLowerCase()))
    : files;

  const groupedFiles = React.useMemo(() => {
    const groups = {};
    filteredFiles.forEach((f) => {
      const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '(root)';
      if (!groups[dir]) groups[dir] = [];
      groups[dir].push(f);
    });
    return groups;
  }, [filteredFiles]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2.5 shrink-0">
        <div className="flex items-center gap-2">
          <Eye className="h-4 w-4 text-zinc-500" />
          <h3 className={`text-sm font-semibold ${textPrimary}`}>Blame</h3>
          {selectedFile && (
            <span className="font-mono text-[10px] text-zinc-500 bg-zinc-100 rounded px-1.5 py-0.5 max-w-[16rem] truncate">
              {selectedFile}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowFilePicker((v) => !v)}
            title={t('git:select_file', { defaultValue: 'Select file' })}
            className={consoleIconButtonClass}
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={fetchBlame}
            disabled={loading || !selectedFile}
            title={t('common:action.refresh')}
            className={consoleIconButtonClass}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {showFilePicker && (
        <div className="border-b border-zinc-200 shrink-0">
          <div className="px-3 py-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-400" />
              <input
                type="text"
                placeholder={t('git:search_files', { defaultValue: 'Search files...' })}
                value={fileSearch}
                onChange={(e) => setFileSearch(e.target.value)}
                autoFocus={showFilePicker}
                className="w-full pl-7 pr-2 py-1 text-xs rounded border border-zinc-300 bg-white focus:outline-none focus:border-black"
              />
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {loadingFiles ? (
              <div className="flex items-center justify-center gap-2 py-4 text-sm text-zinc-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading file list…
              </div>
            ) : Object.keys(groupedFiles).sort().map((dir) => (
              <div key={dir}>
                {dir !== '(root)' && (
                  <div className="px-3 py-1 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider bg-zinc-50">
                    {dir}
                  </div>
                )}
                {groupedFiles[dir].map((f) => (
                  <button
                    key={f}
                    onClick={() => {
                      setSelectedFile(f);
                      setShowFilePicker(false);
                      setFileSearch('');
                    }}
                    className={`w-full text-left px-6 py-1 text-xs truncate hover:bg-zinc-100 transition-colors ${
                      selectedFile === f ? 'text-zinc-900 bg-zinc-200' : 'text-zinc-900'
                    }`}
                  >
                    <span className="font-mono">{dir === '(root)' ? f : f.slice(dir.length + 1)}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {!selectedFile ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-zinc-400">
            <FolderOpen className="h-10 w-10" />
            <p className={`text-sm ${textSecondary}`}>Select a file to view Blame</p>
            <button
              onClick={() => { fetchFiles(); setShowFilePicker(true); }}
              className={`text-xs ${textPlaceholder} hover:${textPrimary} transition-colors underline underline-offset-2`}
            >
              Click to browse file list
            </button>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading blame…
          </div>
        ) : blameData.length === 0 ? (
          <div className="text-center py-8">
            <Eye className="mx-auto h-8 w-8 text-zinc-400 mb-2" />
            <p className={`text-sm ${textSecondary}`}>No blame data available.</p>
          </div>
        ) : (
          <div className="min-w-max">
            {blameData.map((entry, idx) => (
              <BlameLine
                key={idx}
                entry={entry}
                prevSha={idx > 0 ? blameData[idx - 1].sha : null}
                showGutter
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}