import { useState, useEffect, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthContext } from '../../App';
import Button from '../Button';
import Input from '../Input';
import {
  ConsoleDialogShell,
  ConsoleStructuredDialogHeader,
  ConsoleStructuredDialogBody,
  ConsoleStructuredDialogFooter,
} from '../ConsoleDialog';
import { useToast } from '../Toast';
import { useEditMode } from '../../hooks/useEditMode';
import { consoleSectionLabelClass, consoleCardClass, consoleStructuredDialogPanelClass } from '../../lib/consoleTokens';
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

const FIELD_META = {
  CLIENT_ID: { label: 'git:providers.client_id', placeholder: 'git:providers.client_id_placeholder' },
  CLIENT_SECRET: { label: 'git:providers.client_secret', placeholder: 'git:providers.client_secret_placeholder' },
  CALLBACK_URL: { label: 'git:providers.callback_url', placeholder: 'git:providers.callback_url_placeholder' },
  API_BASE: { label: 'git:providers.api_base_url', placeholder: 'git:providers.api_base_url_placeholder' },
};

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
  const [configProviderId, setConfigProviderId] = useState(null);
  const isAdmin = user?.role === 'admin';

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
      if (field === 'CLIENT_SECRET' && !draft[key]) continue;
      payload[key] = draft[key] || '';
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
    showToast('success', t('git:providers.saved', { provider: provider.label }));
  };

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

  useEffect(() => {
    editGithub.setSource(settings);
    editGitlab.setSource(settings);
    editGitea.setSource(settings);
  }, [settings, editGithub, editGitlab, editGitea]);

  const openConfig = (p) => {
    editMap[p.id].enterEdit(settings);
    setConfigProviderId(p.id);
  };

  const closeConfig = () => {
    if (configProviderId) editMap[configProviderId].cancelEdit();
    setConfigProviderId(null);
  };

  const saveConfig = async () => {
    if (!configProviderId) return;
    await editMap[configProviderId].save();
    setConfigProviderId(null);
  };

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

  const configProvider = configProviderId ? PROVIDERS.find((p) => p.id === configProviderId) : null;
  const configEdit = configProviderId ? editMap[configProviderId] : null;

  return (
    <>
      <div className="grid grid-cols-3 gap-4">
        {PROVIDERS.map((p) => {
          const git = gitMap[p.id];
          const isConfigured = isAdmin && settings ? Boolean(settings[providerKey(p.id, 'CLIENT_ID')]) : false;
          const oauthReady = providerOAuthConfigured[p.id] !== false;
          const showConfigured = isAdmin ? isConfigured : oauthReady;

          return (
            <section key={p.id} className={`${consoleCardClass} p-6 flex flex-col gap-4`}>
              <div className="flex items-center gap-2 shrink-0">
                <h3 className={consoleSectionLabelClass}>{p.label}</h3>
                {showConfigured && (
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-600" />
                )}
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="text-xs">
                  {showConfigured ? (
                    <span className="text-emerald-600">● {t('git:providers.configured')}</span>
                  ) : (
                    <span className="text-amber-600">⚠️ {t('git:providers.not_configured')}</span>
                  )}
                </span>
                {isAdmin && (
                  <Button variant="secondary" size="sm" onClick={() => openConfig(p)}>
                    {t('git:providers.configure_oauth')}
                  </Button>
                )}
              </div>

              <div className="border-t border-zinc-100" />

              <div className="mt-auto flex flex-col gap-2">
                <GitConnectButton
                  provider={p.id}
                  connection={git.connection}
                  loading={git.loading}
                  onConnect={git.connect}
                  onDisconnect={git.disconnect}
                  disabled={!showConfigured}
                  disabledReason={t('git:providers.oauth_not_configured_hint')}
                />
                {!showConfigured && !isAdmin && (
                  <GitOAuthAlert
                    message={t('git:providers.not_configured', { defaultValue: `${p.label} OAuth is not configured. An admin must configure it before you can connect.` })}
                    provider={p.id}
                  />
                )}
                {git.error && showConfigured && (
                  <GitOAuthAlert
                    message={git.error}
                    provider={p.id}
                  />
                )}
              </div>
            </section>
          );
        })}
      </div>

      {configProvider && configEdit && (
        <ConsoleDialogShell fitContent onClose={closeConfig} panelClassName={consoleStructuredDialogPanelClass}>
          <ConsoleStructuredDialogHeader
            title={t('git:providers.configure_dialog_title', { label: configProvider.label })}
          />
          <ConsoleStructuredDialogBody>
            <div className="space-y-4">
              {configProvider.fields.map((field) => {
                const key = providerKey(configProvider.id, field);
                const meta = FIELD_META[field];
                const isSecret = field === 'CLIENT_SECRET';
                const isMono = field === 'CALLBACK_URL' || field === 'API_BASE';
                return (
                  <div key={key}>
                    <label htmlFor={`dialog-${key}`} className="text-xs text-zinc-500 block mb-1">
                      {t(meta.label)}
                    </label>
                    <Input
                      id={`dialog-${key}`}
                      type={isSecret ? 'password' : 'text'}
                      value={configEdit.draft[key] || ''}
                      onChange={(e) => configEdit.setDraft({ ...configEdit.draft, [key]: e.target.value })}
                      placeholder={t(meta.placeholder)}
                      className={`w-full ${isMono ? 'font-mono' : ''}`}
                      autoFocus={field === 'CLIENT_ID'}
                    />
                  </div>
                );
              })}
            </div>
          </ConsoleStructuredDialogBody>
          <ConsoleStructuredDialogFooter>
            <Button variant="secondary" size="sm" onClick={closeConfig} disabled={configEdit.saving}>
              {t('common:action.cancel')}
            </Button>
            <Button size="sm" onClick={saveConfig} disabled={configEdit.saving}>
              {configEdit.saving ? t('settings:general.saving') : t('settings:general.save')}
            </Button>
          </ConsoleStructuredDialogFooter>
        </ConsoleDialogShell>
      )}
    </>
  );
}
