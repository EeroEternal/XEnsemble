import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast';
import { getApiBase } from '../lib/api';
import * as gitApi from '../lib/gitApi';
import { openExternal } from '../lib/githubApi';
import { isOAuthNotConfiguredError } from '../lib/gitLabels';

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 150;
const CLOSED_POPUP_GRACE_ATTEMPTS = 3;

function isNotConnectedError(err) {
  return err?.message?.toLowerCase().includes('not connected');
}

function openOAuthPopup(url) {
  const width = 980;
  const height = 720;
  const left = Math.max(0, Math.round((window.screen.width - width) / 2));
  const top = Math.max(0, Math.round((window.screen.height - height) / 2));
  return window.open(
    url,
    'git-oauth',
    `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
  );
}

export function useGitProvider(providerName, { onChange } = {}) {
  const { showToast } = useToast();
  const { t } = useTranslation();
  const [connection, setConnection] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);
  const messageHandlerRef = useRef(null);

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (messageHandlerRef.current) {
      window.removeEventListener('message', messageHandlerRef.current);
      messageHandlerRef.current = null;
    }
  }, []);

  const fetchConnection = useCallback(async ({ silent = false } = {}) => {
    if (!providerName) return null;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const data = await gitApi.getConnection(providerName);
      setConnection(data);
      onChange?.(data);
      return data;
    } catch (err) {
      if (!isNotConnectedError(err) && !silent) setError(err.message);
      setConnection(null);
      onChange?.(null);
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }, [providerName, onChange]);

  useEffect(() => {
    if (providerName) fetchConnection();
    return clearPoll;
  }, [providerName, fetchConnection, clearPoll]);

  const connect = useCallback(async () => {
    if (!providerName) return false;
    setLoading(true);
    setError(null);
    try {
      const { auth_url: authUrl } = await gitApi.connectProvider(providerName);
      // Callback HTML is served by the control plane, not the OAuth provider.
      let expectedOrigin = window.location.origin;
      try {
        expectedOrigin = new URL(getApiBase() || window.location.origin, window.location.origin).origin;
      } catch (_) { /* keep window origin */ }
      const popup = openOAuthPopup(authUrl);
      if (!popup) openExternal(authUrl);
      showToast('loading', t('git:toast.waiting_authorization', { provider: providerName, defaultValue: 'Waiting for {{provider}} authorization…' }));
      clearPoll();

      const reportSuccess = (conn) => {
        const username = conn.remote_username || conn.remoteUsername
          || conn.github_username || conn.githubUsername || providerName;
        showToast('success', t('git:toast.connected_as', { provider: providerName, username, defaultValue: 'Connected to {{provider}} as {{username}}' }));
      };

      const onMessage = async (event) => {
        if (expectedOrigin && event.origin !== expectedOrigin) return;
        const data = event.data;
        if (!data || data.type !== 'git-oauth-result') return;
        if (data.provider && data.provider !== providerName) return;
        clearPoll();
        if (data.status === 'success') {
          const conn = await fetchConnection({ silent: true });
          if (conn) reportSuccess(conn);
        } else {
          showToast('error', data.message || t('git:toast.authorization_failed', { provider: providerName, defaultValue: '{{provider}} authorization failed. Please try again.' }));
        }
      };
      messageHandlerRef.current = onMessage;
      window.addEventListener('message', onMessage);

      let attempts = 0;
      let attemptsAfterClose = 0;
      pollRef.current = setInterval(async () => {
        attempts += 1;
        if (popup?.closed) attemptsAfterClose += 1;
        const conn = await fetchConnection({ silent: true });
        if (conn) {
          clearPoll();
          reportSuccess(conn);
        } else if (attemptsAfterClose >= CLOSED_POPUP_GRACE_ATTEMPTS) {
          clearPoll();
          showToast('error', t('git:toast.authorization_window_closed', { provider: providerName, defaultValue: '{{provider}} authorization window was closed before completing. Please try again.' }));
        } else if (attempts >= MAX_POLL_ATTEMPTS) {
          clearPoll();
          showToast('error', t('git:toast.authorization_timed_out', { provider: providerName, defaultValue: '{{provider}} authorization timed out. Please try again.' }));
        }
      }, POLL_INTERVAL_MS);
      return true;
    } catch (err) {
      setError(err.message);
      if (!isOAuthNotConfiguredError(err.message)) {
        showToast('error', err.message);
      }
      return false;
    } finally {
      setLoading(false);
    }
  }, [providerName, fetchConnection, showToast, clearPoll]);

  const connectWithPat = useCallback(async (token) => {
    if (!providerName) return false;
    setLoading(true);
    setError(null);
    try {
      const result = await gitApi.connectWithPat(providerName, token);
      const conn = result.connection || result;
      setConnection(conn);
      onChange?.(conn);
      if (result.warning) {
        showToast('warning', result.warning.message);
      }
      const username = conn.remote_username || conn.remoteUsername
        || conn.github_username || conn.githubUsername || providerName;
      showToast('success', t('git:toast.connected_as', { provider: providerName, username, defaultValue: 'Connected to {{provider}} as {{username}}' }));
      return true;
    } catch (err) {
      setError(err.message);
      showToast('error', err.message);
      return false;
    } finally {
      setLoading(false);
    }
  }, [providerName, onChange, showToast]);

  const disconnect = useCallback(async () => {
    if (!providerName) return;
    setLoading(true);
    try {
      await gitApi.disconnectProvider(providerName);
      setConnection(null);
      onChange?.(null);
      showToast('success', t('git:toast.disconnected', { provider: providerName }));
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setLoading(false);
    }
  }, [providerName, onChange, showToast]);

  return {
    connection,
    loading,
    error,
    fetchConnection,
    connect,
    connectWithPat,
    disconnect,
  };
}
