import { useState, useEffect, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthContext } from '../../App';
import Button from '../Button';
import Input, { FormLabel } from '../Input';
import { useToast } from '../Toast';
import { consoleSectionLabelClass } from '../../lib/consoleTokens';
import { apiFetch } from '../../lib/api';
import GitConnectButton from '../git/GitConnectButton';
import GitOAuthAlert from '../git/GitOAuthAlert';
import { useGitProvider } from '../../hooks/useGitProvider';
import { getProviderLabel } from '../../lib/gitLabels';
import * as gitApi from '../../lib/gitApi';

const MASK = '••••••••';

const USER_PROVIDERS = ['github', 'gitlab', 'gitea'];

export default function GitHubSettingsPanel() {
  const { t } = useTranslation();
  const { user } = useContext(AuthContext);
  const { showToast } = useToast();
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [activeProvider, setActiveProvider] = useState('github');
  const [providerOAuthConfigured, setProviderOAuthConfigured] = useState({});
  const isAdmin = user?.role === 'admin';
  const git = useGitProvider(activeProvider);

  useEffect(() => {
    if (isAdmin) return;
    gitApi.listProviders()
      .then((data) => {
        const map = {};
        for (const p of data.providers || []) {
          map[p.name] = p.oauth_configured ?? p.oauthConfigured ?? false;
        }
        setProviderOAuthConfigured(map);
      })
      .catch(() => setProviderOAuthConfigured({}));
  }, [isAdmin]);

  const loadSettings = () => {
    setError(null);
    setSettings(null);
    apiFetch('/api/v1/admin/platform-settings')
      .then(async (res) => {
        if (!res.ok) throw new Error('failed');
        const data = await res.json();
        setSettings({
          ...data,
          GITHUB_CLIENT_SECRET: data.GITHUB_CLIENT_SECRET ? MASK : '',
        });
      })
      .catch((err) => {
        setSettings(null);
        setError(err.message || t('settings:error.load_settings_failed', { defaultValue: 'Failed to load settings' }));
      });
  };

  useEffect(() => {
    if (!isAdmin) return;
    loadSettings();
  }, [isAdmin]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await apiFetch('/api/v1/admin/platform-settings', {
        method: 'PUT',
        body: JSON.stringify({
          GITHUB_CLIENT_ID: settings.GITHUB_CLIENT_ID || '',
          GITHUB_CLIENT_SECRET: settings.GITHUB_CLIENT_SECRET || '',
          GITHUB_CALLBACK_URL: settings.GITHUB_CALLBACK_URL || '',
          GITHUB_API_BASE: settings.GITHUB_API_BASE || '',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSettings({
        ...data,
        GITHUB_CLIENT_SECRET: data.GITHUB_CLIENT_SECRET ? MASK : '',
      });
      showToast('success', t('settings:toast.github_saved'));
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setSaving(false);
    }
  };

  if (isAdmin) {
    if (error) {
      return (
        <div className="space-y-4">
          <h3 className={consoleSectionLabelClass}>GitHub OAuth App</h3>
          <p className="text-sm text-red-600">{error}</p>
          <Button type="button" size="md" onClick={loadSettings}>Retry</Button>
        </div>
      );
    }

    if (!settings) {
      return <p className="text-sm text-zinc-500">{t('common:state.loading')}</p>;
    }

    return (
      <form onSubmit={handleSave} className="h-full flex flex-col">
        <div className="flex-1 min-h-0 space-y-4">
          <div>
            <h3 className={consoleSectionLabelClass}>GitHub OAuth App</h3>
            <p className="text-xs text-zinc-500 mt-1">
              Configure the GitHub OAuth App used for repository import and pull requests.
            </p>
          </div>

          <div className="space-y-2">
            <FormLabel htmlFor="github-client-id">Client ID</FormLabel>
            <Input
              id="github-client-id"
              value={settings.GITHUB_CLIENT_ID || ''}
              onChange={(e) => setSettings({ ...settings, GITHUB_CLIENT_ID: e.target.value })}
              placeholder="Ov23li…"
              className="h-8 py-1"
            />
          </div>

          <div className="space-y-2">
            <FormLabel htmlFor="github-client-secret">Client Secret</FormLabel>
            <Input
              id="github-client-secret"
              type="password"
              value={settings.GITHUB_CLIENT_SECRET || ''}
              onChange={(e) => setSettings({ ...settings, GITHUB_CLIENT_SECRET: e.target.value })}
              placeholder="••••••••"
              className="h-8 py-1"
            />
          </div>

          <div className="space-y-2">
            <FormLabel htmlFor="github-callback-url">Callback URL</FormLabel>
            <Input
              id="github-callback-url"
              value={settings.GITHUB_CALLBACK_URL || ''}
              onChange={(e) => setSettings({ ...settings, GITHUB_CALLBACK_URL: e.target.value })}
              placeholder="https://app.example.com/api/v1/git/callback"
              className="h-8 py-1 font-mono"
            />
          </div>

          <div className="space-y-2">
            <FormLabel htmlFor="github-api-base">API Base</FormLabel>
            <Input
              id="github-api-base"
              value={settings.GITHUB_API_BASE || ''}
              onChange={(e) => setSettings({ ...settings, GITHUB_API_BASE: e.target.value })}
              placeholder="https://api.github.com"
              className="h-8 py-1 font-mono"
            />
          </div>
        </div>

        <div className="pt-4 flex justify-end shrink-0">
          <Button type="submit" size="md" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-1 border-b border-zinc-200 pb-0">
        {USER_PROVIDERS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveProvider(id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors border-b-2 -mb-px ${
              activeProvider === id
                ? 'border-zinc-900 text-zinc-900 bg-surface'
                : 'border-transparent text-zinc-500 hover:text-zinc-900'
            }`}
          >
            {getProviderLabel(id)}
          </button>
        ))}
      </div>

      {(git.error || providerOAuthConfigured[activeProvider] === false) && (
        <GitOAuthAlert
          message={git.error || `${activeProvider} OAuth is not configured`}
          provider={activeProvider}
        />
      )}

      <GitConnectButton
        provider={activeProvider}
        connection={git.connection}
        loading={git.loading}
        onConnect={git.connect}
        onDisconnect={git.disconnect}
        disabled={providerOAuthConfigured[activeProvider] === false}
      />
    </div>
  );
}
