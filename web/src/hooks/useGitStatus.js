import { useCallback, useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast';
import { confirm } from '../components/ConfirmDialog';
import * as githubApi from '../lib/githubApi';

const POLL_INTERVAL_MS = 15000;
const FULL_POLL_INTERVAL_MS = 60000;

export function useGitStatus(projectId, fullPollEnabledRef, sessionId, ready) {
  const { showToast } = useToast();
  const { t } = useTranslation();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState(null);
  const lastFullAtRef = useRef(0);
  const prevFullEnabledRef = useRef(false);

  // Reset status and trigger refetch when sessionId changes (same project, different worktree)
  useEffect(() => {
    setStatus(null);
    setLoading(false);
    setOperation(null);
    lastFullAtRef.current = 0;
  }, [sessionId]);

  // Switching to Changes tab (fullPollEnabledRef goes false→true) triggers
  // an immediate full fetch so the user sees fresh ahead/behind after git
  // operations done in the terminal.
  useEffect(() => {
    const current = !fullPollEnabledRef || fullPollEnabledRef.current;
    if (current && !prevFullEnabledRef.current && projectId) {
      fetchStatusFull({ silent: true });
      lastFullAtRef.current = Date.now();
    }
    prevFullEnabledRef.current = current;
  });

  const fetchStatusFull = useCallback(async ({ silent = false, skipIfFreshMs = 0 } = {}) => {
    if (!projectId) return null;
    if (skipIfFreshMs > 0 && Date.now() - lastFullAtRef.current < skipIfFreshMs) {
      return null;
    }
    if (!silent) setLoading(true);
    try {
      const data = await githubApi.getGitStatus(projectId);
      // During transient detached HEAD (mid-rebase etc.) the server returns
      // ahead/behind null; keep the last known values instead of showing 0.
      setStatus((prev) => {
        if (!prev) return data;
        const ahead = data.ahead ?? prev.ahead;
        const behind = data.behind ?? prev.behind;
        return { ...data, ahead, behind };
      });
      lastFullAtRef.current = Date.now();
      return data;
    } catch (err) {
      if (!silent) showToast('error', err.message);
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }, [projectId, sessionId, showToast]);

  const fetchStatusLight = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await githubApi.getGitStatusLight(projectId);
      // Light polls only refresh file/working-tree state. Keep the last full
      // ahead/behind (they are divergence info that light mode does not
      // compute) so a 15s light poll can never flip "unpushed" between 17 and 0.
      setStatus((prev) => {
        if (!prev) return data;
        const ahead = data.ahead ?? prev.ahead;
        const behind = data.behind ?? prev.behind;
        return { ...prev, ...data, ahead, behind };
      });
    } catch {
      // ignore light poll errors silently
    }
  }, [projectId]);

  useEffect(() => {
    if (!ready) return undefined;
    fetchStatusFull();
    lastFullAtRef.current = Date.now();
    let timer;
    const scheduleNext = () => {
      const now = Date.now();
      const needFull = (now - lastFullAtRef.current) >= FULL_POLL_INTERVAL_MS;
      const fullEnabled = !fullPollEnabledRef || fullPollEnabledRef.current;
      const interval = (needFull && fullEnabled) ? 0 : POLL_INTERVAL_MS;
      timer = setTimeout(() => {
        if (typeof document !== 'undefined' && document.hidden) {
          scheduleNext();
          return;
        }
        const stillNeedFull = (Date.now() - lastFullAtRef.current) >= FULL_POLL_INTERVAL_MS;
        const stillEnabled = !fullPollEnabledRef || fullPollEnabledRef.current;
        if (stillNeedFull && stillEnabled) {
          fetchStatusFull({ silent: true });
          lastFullAtRef.current = Date.now();
        } else {
          fetchStatusLight();
        }
        scheduleNext();
      }, interval);
    };
    scheduleNext();
    return () => clearTimeout(timer);
  }, [fetchStatusFull, fetchStatusLight, fullPollEnabledRef, ready]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      if (!document.hidden && projectId) {
        const now = Date.now();
        const needFull = (now - lastFullAtRef.current) >= FULL_POLL_INTERVAL_MS;
        const fullEnabled = !fullPollEnabledRef || fullPollEnabledRef.current;
        if (needFull && fullEnabled) {
          fetchStatusFull({ silent: true });
          lastFullAtRef.current = now;
        } else {
          fetchStatusLight();
        }
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [projectId, fetchStatusFull, fetchStatusLight, fullPollEnabledRef]);

  const commit = useCallback(async (message, author) => {
    if (!projectId || !message?.trim()) return;
    setOperation('commit');
    try {
      const result = await githubApi.commitStaged(projectId, message.trim(), author);
      showToast('success', t('git:toast.committed'));
      if (result.status && result.status.ahead != null) {
        setStatus((prev) => prev ? { ...prev, ...result.status } : null);
      } else {
        fetchStatusFull({ silent: true });
      }
      return result;
    } catch (err) {
      if (err.code === 'AUTHOR_REQUIRED') {
        throw err;
      }
      showToast('error', err.message);
      throw err;
    } finally {
      setOperation(null);
    }
  }, [projectId, showToast, fetchStatusFull]);

  const push = useCallback(async () => {
    if (!projectId) return;
    setOperation('push');
    try {
      const result = await githubApi.pushBranch(projectId, status?.branch);
      showToast('success', t('git:toast.branch_pushed', { defaultValue: 'Branch pushed.' }));
      if (result.status) {
        setStatus(result.status);
      } else {
        fetchStatusFull({ silent: true });
      }
      return result;
    } catch (err) {
      showToast('error', err.message);
      throw err;
    } finally {
      setOperation(null);
    }
  }, [projectId, status?.branch, showToast, fetchStatusFull]);

  const pull = useCallback(async () => {
    if (!projectId) return;
    setOperation('pull');
    try {
      try {
        const result = await githubApi.pullLatest(projectId);
        showToast('success', t('git:toast.pulled_latest', { defaultValue: 'Pulled latest changes.' }));
        fetchStatusFull({ silent: true });
        return result;
      } catch (err) {
        if (err.code !== 'pull_conflict') {
          showToast('error', err.message);
          throw err;
        }
        // Pull would conflict. Ask the user whether to force pull
        // (stash → pull → stash pop); local changes are preserved and any
        // conflicts surface in the Changes panel afterwards.
        const confirmed = await confirm({
          title: t('git:pull_conflict_title', { defaultValue: 'Pull Conflict' }),
          message: t('git:pull_conflict_prompt', { defaultValue: 'There are conflicts between your local changes and the remote. Force pull will stash your local changes, pull the remote, then reapply them. This will not overwrite your local code — any conflicts will be shown in the Changes panel for you to resolve. Continue?' }),
          confirmLabel: t('git:force_pull', { defaultValue: 'Force Pull' }),
          variant: 'primary',
        });
        if (!confirmed) return null;
        const forceResult = await githubApi.pullLatest(projectId, { force: true });
        if (forceResult?.conflicts?.length) {
          showToast('info', t('git:toast.pull_conflict_surfaced', { count: forceResult.conflicts.length, defaultValue: 'Pulled. {{count}} file(s) have conflicts — resolve them in Changes.' }));
        } else {
          showToast('success', t('git:toast.pulled_latest', { defaultValue: 'Pulled latest changes.' }));
        }
        fetchStatusFull({ silent: true });
        return forceResult;
      }
    } finally {
      setOperation(null);
    }
  }, [projectId, showToast, fetchStatusFull]);

  const fetchRemote = useCallback(async () => {
    if (!projectId) return;
    setOperation('fetch');
    try {
      const result = await githubApi.fetchRemote(projectId);
      showToast('success', t('git:toast.fetched', { defaultValue: 'Fetched from remote.' }));
      if (result.status) {
        setStatus(result.status);
      } else {
        fetchStatusFull({ silent: true });
      }
      return result;
    } catch (err) {
      showToast('error', err.message);
      throw err;
    } finally {
      setOperation(null);
    }
  }, [projectId, showToast, fetchStatusFull]);

  const switchBranch = useCallback(async (name) => {
    if (!projectId || !name) return;
    setOperation('switch');
    try {
      await githubApi.switchBranch(projectId, name);
      showToast('success', t('git:toast.switched_branch', { name, defaultValue: 'Switched to {{name}}.' }));
      fetchStatusFull({ silent: true });
    } catch (err) {
      showToast('error', err.message);
      throw err;
    } finally {
      setOperation(null);
    }
  }, [projectId, showToast, fetchStatusFull]);

  const createBranch = useCallback(async (name) => {
    if (!projectId || !name) return;
    setOperation('switch');
    try {
      await githubApi.createBranch(projectId, name);
      showToast('success', t('git:toast.created_and_switched', { name, defaultValue: 'Created and switched to {{name}}.' }));
      fetchStatusFull({ silent: true });
    } catch (err) {
      showToast('error', err.message);
      throw err;
    } finally {
      setOperation(null);
    }
  }, [projectId, showToast, fetchStatusFull]);

  return {
    status,
    loading,
    operation,
    commit,
    push,
    pull,
    fetchRemote,
    switchBranch,
    createBranch,
    fetchStatus: fetchStatusFull,
  };
}
