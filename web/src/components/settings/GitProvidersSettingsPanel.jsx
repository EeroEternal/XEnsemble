import { useState, useEffect, useContext } from 'react';
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

const PROVIDERS = [
  { id: 'github', label: 'GitHub', fields: ['CLIENT_ID', 'CLIENT_SECRET', 'CALLBACK_URL', 'API_BASE'] },
  { id: 'gitlab', label: 'GitLab', fields: ['CLIENT_ID', 'CLIENT_SECRET', 'CALLBACK_URL', 'API_BASE'] },
  { id: 'gitea', label: 'Gitea', fields: ['CLIENT_ID', 'CLIENT_SECRET', 'CALLBACK_URL', 'API_BASE'] },
];

const FIELD_META = {
  CLIENT_ID: { label: 'Client ID', placeholder: 'Application ID…', type: 'text' },
  CLIENT_SECRET: { label: 'Client Secret', placeholder: '••••••••', type: 'password' },
  CALLBACK_URL: { label: 'Callback URL', placeholder: 'https://app.example.com/api/v1/git/callback', type: 'text', mono: true },
  API_BASE: { label: 'API Base URL', placeholder: 'Leave empty for default', type: 'text', mono: true },
};

function providerKey(provider, field) {
  return `${provider.toUpperCase()}_${field}`;
}

export default function GitProvidersSettingsPanel() {
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
    gitApi.listProviders()
      .then((data) => {
        const map = {};
        for (const p of data.providers || []) {
          map[p.name] = p.oauth_configured ?? p.oauthConfigured ?? false;
        }
        setProviderOAuthConfigured(map);
      })
      .catch(() => setProviderOAuthConfigured({}));
  }, []);

  const loadSettings = () => {
    setError(null);
    setSettings(null);
    apiFetch('/api/v1/admin/platform-settings')
      .then(async (res) => {
        if (!res.ok) throw new Error('failed');
        const data = await res.json();
        for (const p of PROVIDERS) {
          const secretKey = providerKey(p.id, 'CLIENT_SECRET');
          if (data[secretKey]) data[secretKey] = MASK;
        }
        setSettings(data);
      })
      .catch((err) => {
        setSettings(null);
        setError(err.message || 'Failed to load settings');
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
      const provider = PROVIDERS.find((p) => p.id === activeProvider);
      if (!provider) return;

      const payload = {};
      for (const field of provider.fields) {
        const key = providerKey(provider.id, field);
        payload[key] = settings[key] || '';
      }

      const res = await apiFetch('/api/v1/admin/platform-settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      for (const p of PROVIDERS) {
        const secretKey = providerKey(p.id, 'CLIENT_SECRET');
        if (data[secretKey]) data[secretKey] = MASK;
      }
      setSettings((prev) => ({ ...prev, ...data }));
      showToast('success', `${provider.label} settings saved.`);
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="space-y-4">
        <h3 className={consoleSectionLabelClass}>Git Providers</h3>
        <p className="text-sm text-zinc-500">
          Ask an administrator to configure Git provider OAuth settings.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Git Account Configuration */}
      <section className="space-y-4">
        <h3 className={consoleSectionLabelClass}>Git Account</h3>

        <div className="space-y-4">
          <div className="flex gap-1 border-b border-zinc-200 pb-0">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setActiveProvider(p.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors border-b-2 -mb-px ${
                  activeProvider === p.id
                    ? 'border-zinc-900 text-zinc-900 bg-white'
                    : 'border-transparent text-zinc-500 hover:text-zinc-900'
                }`}
              >
                {getProviderLabel(p.id)}
              </button>
            ))}
          </div>
      <div className="border-t border-zinc-200" />
      {/* OAuth Application Configuration */}
      <section className="space-y-4">
        <h3 className={consoleSectionLabelClass}>OAuth Apps</h3>
        {error ? (
          <div className="space-y-4">
            <p className="text-sm text-red-600">{error}</p>
            <Button type="button" size="md" onClick={loadSettings}>Retry</Button>
          </div>
        ) : !settings ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (
          <form onSubmit={handleSave} className="space-y-4">
            <div className="flex gap-1 border-b border-zinc-200 pb-0">
              {PROVIDERS.map((p) => {
                const isConfigured = Boolean(settings[providerKey(p.id, 'CLIENT_ID')]);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setActiveProvider(p.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors border-b-2 -mb-px ${
                      activeProvider === p.id
                        ? 'border-zinc-900 text-zinc-900 bg-white'
                        : 'border-transparent text-zinc-500 hover:text-zinc-900'
                    }`}
                  >
                    {p.label}
                    {isConfigured && (
                      <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-600" />
                    )}
                  </button>
                );
              })}
            </div>

            {(() => {
              const provider = PROVIDERS.find((p) => p.id === activeProvider);
              if (!provider) return null;
              return (
                <div className="space-y-3">
                  {provider.fields.map((field) => {
                    const key = providerKey(provider.id, field);
                    const meta = FIELD_META[field];
                    return (
                      <div key={key} className="space-y-1.5">
                        <FormLabel htmlFor={key}>{meta.label}</FormLabel>
                        <Input
                          id={key}
                          type={meta.type}
                          value={settings[key] || ''}
                          onChange={(e) => setSettings({ ...settings, [key]: e.target.value })}
                          placeholder={meta.placeholder}
                          className={`h-8 py-1 ${meta.mono ? 'font-mono' : ''}`}
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            <div className="pt-2 flex justify-start">
              <Button type="submit" size="md" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
