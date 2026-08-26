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
  const [providerOAuthConfigured, setProviderOAuthConfigured] = useState({});
  const isAdmin = user?.role === 'admin';

  // Per-provider connection state
  const gitGithub = useGitProvider('github');
  const gitGitlab = useGitProvider('gitlab');
  const gitGitea = useGitProvider('gitea');
  const gitMap = { github: gitGithub, gitlab: gitGitlab, gitea: gitGitea };

  const handleSave = async (providerId, draft) => {
    const provider = PROVIDERS.find((p) => p.id === providerId);
    if (!provider) return;

    const payload = {};
    for (const field of provider.fields) {
      const key = providerKey(providerId, field);
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

  // Per-provider edit mode
  const editGithub = useEditMode({ onSave: (d) => handleSave('github', d) });
  const editGitlab = useEditMode({ onSave: (d) => handleSave('gitlab', d) });
  const editGitea = useEditMode({ onSave: (d) => handleSave('gitea', d) });
  const editMap = { github: editGithub, gitlab: editGitlab, gitea: editGitea };

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

  // Keep sourceRef in sync for each provider's edit mode
  useEffect(() => {
    editGithub.setSource(settings);
    editGitlab.setSource(settings);
    editGitea.setSource(settings);
  }, [settings, editGithub, editGitlab, editGitea]);

  if (isAdmin && error) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-red-600">{error}</p>
        <Button type="button" size="md" onClick={loadSettings}>{t('common:action.retry')}</Button>
      </div>
    );
  }

  if (isAdmin && !settings) {
    return <p className="text-sm text-zinc-500">{t('git:providers.loading_settings')}</p>;
  }

  return (
    <div className="space-y-4">
      {PROVIDERS.map((p) => {
        const git = gitMap[p.id];
        const editMode = editMap[p.id];
        const isConfigured = isAdmin && settings ? Boolean(settings[providerKey(p.id, 'CLIENT_ID')]) : false;
        const oauthReady = providerOAuthConfigured[p.id] !== false;

        return (
          <section key={p.id} className={`${consoleCardClass} p-6 space-y-4`}>
            {/* Card header */}
            <div className="flex items-center gap-2">
              <h3 className={consoleSectionLabelClass}>{p.label}</h3>
              {isConfigured && (
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-600" />
              )}
            </div>

            {/* OAuth Configuration (admin only) */}
            {isAdmin && (
            <div>
              <p className="text-xs text-zinc-500">{t('git:providers.oauth_config_desc', { defaultValue: 'OAuth application credentials for this provider.' })}</p>

              <div className="mt-3 space-y-4">
                {editMode.isEditing ? (
                  <>
                    {p.fields.map((field) => {
                      const key = providerKey(p.id, field);
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
                            value={editMode.draft[key] || ''}
                            onChange={(e) => editMode.setDraft({ ...editMode.draft, [key]: e.target.value })}
                            placeholder={placeholder}
                            className={`w-64 ${isMono ? 'font-mono' : ''}`}
                            autoFocus={field === 'CLIENT_ID'}
                          />
                        </div>
                      );
                    })}

                    <div className="pt-2 flex justify-end gap-2">
                      <Button variant="secondary" size="md" onClick={editMode.cancelEdit} disabled={editMode.saving}>
                        {t('common:action.cancel')}
                      </Button>
                      <Button variant="primary" size="md" onClick={editMode.save} disabled={editMode.saving}>
                        {editMode.saving ? t('settings:general.saving') : t('settings:general.save')}
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <ReadOnlyField
                      label={t('git:providers.client_id')}
                      value={maskClientId(settings[providerKey(p.id, 'CLIENT_ID')])}
                      mono
                      emptyText={t('git:providers.not_configured')}
                    />
                    <ReadOnlyField
                      label={t('git:providers.client_secret')}
                      value={settings[providerKey(p.id, 'CLIENT_SECRET')] || null}
                      mono
                      emptyText={t('git:providers.not_configured')}
                    />
                    <ReadOnlyField
                      label={t('git:providers.callback_url')}
                      value={settings[providerKey(p.id, 'CALLBACK_URL')]}
                      mono
                      emptyText={t('git:providers.not_configured')}
                    />
                    <ReadOnlyField
                      label={t('git:providers.api_base_url')}
                      value={settings[providerKey(p.id, 'API_BASE')]}
                      mono
                      emptyText={t('settings:general.default_value')}
                    />

                    <div className="pt-2 flex justify-end">
                      <Button variant="secondary" size="md" onClick={() => editMode.enterEdit()}>
                        {t('common:action.edit')}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </div>
            )}

            {/* Divider */}
            {isAdmin && <div className="border-t border-zinc-100" />}

            {/* Connect account (all users) */}
            <div>
              {!oauthReady && (
                <GitOAuthAlert
                  message={t('git:providers.not_configured', { defaultValue: `${p.label} OAuth is not configured. An admin must configure it before you can connect.` })}
                  provider={p.id}
                />
              )}
              {git.error && oauthReady && (
                <GitOAuthAlert
                  message={git.error}
                  provider={p.id}
                />
              )}
              <GitConnectButton
                provider={p.id}
                connection={git.connection}
                loading={git.loading}
                onConnect={git.connect}
                onDisconnect={git.disconnect}
                disabled={!oauthReady}
                disabledReason={t('git:providers.oauth_not_configured', { defaultValue: 'OAuth not configured' })}
              />
            </div>
          </section>
        );
      })}
    </div>
  );
}
