import { useState, useEffect, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthContext } from '../../App';
import Button from '../Button';
import Input from '../Input';
import ReadOnlyField from '../ReadOnlyField';
import { useToast } from '../Toast';
import { useEditMode } from '../../hooks/useEditMode';
import { consoleSectionLabelClass, consoleCardClass } from '../../lib/consoleTokens';
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

function providerKey(provider, field) {
  return `${provider.toUpperCase()}_${field}`;
}

/** Mask a Client ID for display: show first 4 and last 4 chars. */
function maskClientId(value) {
  if (!value || value.length <= 8) return value ? '••••' : '';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export default function GitProvidersSettingsPanel() {
  const { t } = useTranslation();
  const { user } = useContext(AuthContext);
  const { showToast } = useToast();
  const [settings, setSettings] = useState(null);
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

  const handleSave = async (draft) => {
    const provider = PROVIDERS.find((p) => p.id === activeProvider);
    if (!provider) return;

    const payload = {};
    for (const field of provider.fields) {
      const key = providerKey(provider.id, field);
      // Skip empty CLIENT_SECRET — server keeps the existing value
      if (field === 'CLIENT_SECRET' && !draft[key]) continue;
      payload[key] = draft[key] || '';
    }

    const res = await apiFetch('/api/v1/admin/platform-settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    // Re-mask secrets in the merged result
    for (const p of PROVIDERS) {
      const secretKey = providerKey(p.id, 'CLIENT_SECRET');
      if (data[secretKey]) data[secretKey] = MASK;
    }
    setSettings((prev) => ({ ...prev, ...data }));
    showToast('success', t('git:providers.saved', { provider: provider.label }));
  };

  const editMode = useEditMode({ onSave: handleSave });

  // Keep sourceRef in sync
  useEffect(() => {
    editMode.setSource(settings);
  }, [settings, editMode]);

  if (!isAdmin) {
    return (
      <div className="space-y-4">
        <h3 className={consoleSectionLabelClass}>{t('git:providers.title')}</h3>
        <p className="text-sm text-zinc-500">
          {t('git:providers.ask_admin_to_configure')}
        </p>
      </div>
    );
  }

  const providerTabClass = (isActive) =>
    `px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors border-b-2 -mb-px ${
      isActive
        ? 'border-zinc-900 text-zinc-900 bg-white'
        : 'border-transparent text-zinc-500 hover:text-zinc-900'
    }`;

  return (
    <div className="space-y-8">
      {/* Git Account Configuration */}
      <section className={`${consoleCardClass} p-6 space-y-4`}>
        <h3 className={consoleSectionLabelClass}>{t('git:providers.git_account')}</h3>

        <div className="space-y-4">
          <div className="flex gap-1 border-b border-zinc-200 pb-0">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setActiveProvider(p.id)}
                className={providerTabClass(activeProvider === p.id)}
              >
                {getProviderLabel(p.id)}
              </button>
            ))}
          </div>
        </div>

        {git.error && (
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
      </section>

      {/* OAuth Application Configuration */}
      <section className={`${consoleCardClass} p-6 space-y-4`}>
        <h3 className={consoleSectionLabelClass}>{t('git:providers.oauth_apps')}</h3>

        {error ? (
          <div className="space-y-4">
            <p className="text-sm text-red-600">{error}</p>
            <Button type="button" size="md" onClick={loadSettings}>{t('common:action.retry')}</Button>
          </div>
        ) : !settings ? (
          <p className="text-sm text-zinc-500">{t('git:providers.loading_settings')}</p>
        ) : (
          <>
            {/* Provider tabs with configured indicator */}
            <div className="flex gap-1 border-b border-zinc-200 pb-0">
              {PROVIDERS.map((p) => {
                const isConfigured = Boolean(settings[providerKey(p.id, 'CLIENT_ID')]);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setActiveProvider(p.id);
                      if (editMode.isEditing) editMode.cancelEdit();
                    }}
                    className={providerTabClass(activeProvider === p.id)}
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

              if (editMode.isEditing) {
                const draft = editMode.draft;
                return (
                  <div className="space-y-4">
                    {provider.fields.map((field) => {
                      const key = providerKey(provider.id, field);
                      const isSecret = field === 'CLIENT_SECRET';
                      const label = t(`git:providers.${field.toLowerCase()}`);
                      const placeholder = isSecret
                        ? t('git:providers.client_secret_placeholder')
                        : t(`git:providers.${field.toLowerCase()}_placeholder`);
                      const isMono = field === 'CALLBACK_URL' || field === 'API_BASE';
                      return (
                        <div key={key} className="flex items-center justify-between gap-4 min-h-[38px]">
                          <label htmlFor={key} className="text-xs text-zinc-500 shrink-0">
                            {label}
                            {field !== 'CLIENT_SECRET' && <span className="text-red-500 ml-0.5">*</span>}
                          </label>
                          <Input
                            id={key}
                            type={isSecret ? 'password' : 'text'}
                            value={draft[key] || ''}
                            onChange={(e) => editMode.setDraft({ ...draft, [key]: e.target.value })}
                            placeholder={placeholder}
                            className={`w-64 ${isMono ? 'font-mono' : ''}`}
                            autoFocus={field === 'CLIENT_ID'}
                          />
                        </div>
                      );
                    })}

                    <div className="pt-4 flex justify-end gap-2">
                      <Button variant="secondary" size="md" onClick={editMode.cancelEdit} disabled={editMode.saving}>
                        {t('common:action.cancel')}
                      </Button>
                      <Button variant="primary" size="md" onClick={editMode.save} disabled={editMode.saving}>
                        {editMode.saving ? t('settings:general.saving') : t('settings:general.save')}
                      </Button>
                    </div>
                  </div>
                );
              }

              // View mode
              const clientId = settings[providerKey(provider.id, 'CLIENT_ID')];
              const callbackUrl = settings[providerKey(provider.id, 'CALLBACK_URL')];
              const apiBase = settings[providerKey(provider.id, 'API_BASE')];

              return (
                <div className="space-y-4">
                  <ReadOnlyField
                    label={t('git:providers.client_id')}
                    value={maskClientId(clientId)}
                    mono
                    emptyText={t('git:providers.not_configured')}
                  />
                  <ReadOnlyField
                    label={t('git:providers.client_secret')}
                    value={settings[providerKey(provider.id, 'CLIENT_SECRET')] || null}
                    mono
                    emptyText={t('git:providers.not_configured')}
                  />
                  <ReadOnlyField
                    label={t('git:providers.callback_url')}
                    value={callbackUrl}
                    mono
                    emptyText={t('git:providers.not_configured')}
                  />
                  <ReadOnlyField
                    label={t('git:providers.api_base_url')}
                    value={apiBase}
                    mono
                    emptyText={t('settings:general.default_value')}
                  />

                  <div className="pt-4 flex justify-end">
                    <Button variant="secondary" size="md" onClick={() => editMode.enterEdit()}>
                      {t('common:action.edit')}
                    </Button>
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </section>
    </div>
  );
}
