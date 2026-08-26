import { useState, useEffect, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthContext } from '../../App';
import Button from '../Button';
import Input from '../Input';
import SelectMenu from '../SelectMenu';
import ReadOnlyField from '../ReadOnlyField';
import { useToast } from '../Toast';
import { useEditMode } from '../../hooks/useEditMode';
import { consoleSectionLabelClass, consoleCardClass } from '../../lib/consoleTokens';

import { apiFetch } from '../../lib/api';

const REGISTRATION_MODE_LABELS = {
  open: 'settings:general.mode_open',
  approval: 'settings:general.mode_approval',
  admin_only: 'settings:general.mode_admin',
  invite_only: 'settings:general.mode_invite',
};

const TIER_LABELS = {
  basic: 'users:tier.basic',
  pro: 'users:tier.pro',
  enterprise: 'users:tier.enterprise',
};

export default function GeneralSettingsPanel() {
  const { t } = useTranslation();
  const { user } = useContext(AuthContext);
  const { showToast } = useToast();
  const [settings, setSettings] = useState(null);
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    if (!isAdmin) return;
    apiFetch('/api/v1/admin/platform-settings')
      .then((res) => res.json())
      .then((data) => setSettings(data));
  }, [isAdmin]);

  const handleSave = async (draft) => {
    const quota = draft.default_user_quota || {};
    const res = await apiFetch('/api/v1/admin/platform-settings', {
      method: 'PUT',
      body: JSON.stringify({
        registration_mode: draft.registration_mode,
        default_user_quota: {
          max_projects: Number(quota.max_projects),
          max_sessions: Number(quota.max_sessions),
          max_previews: Number(quota.max_previews),
          max_runtimes: Number(quota.max_runtimes ?? 1),
          resource_tier: quota.resource_tier,
        },
        session_ttl_hours: Number(draft.session_ttl_hours),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setSettings(data);
    showToast('success', t('settings:toast.saved'));
  };

  const editMode = useEditMode({ onSave: handleSave });

  useEffect(() => {
    editMode.setSource(settings);
  }, [settings, editMode]);

  if (!isAdmin) {
    return <div className="space-y-3" />;
  }

  if (!settings) {
    return <p className="text-sm text-zinc-500">{t('common:state.loading')}</p>;
  }

  const quota = settings.default_user_quota || {};
  const draft = editMode.isEditing ? editMode.draft : settings;
  const draftQuota = draft?.default_user_quota || {};
  const isEdit = editMode.isEditing;

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto console-scroll-hidden">
        <div className={`${consoleCardClass} p-6`}>
          {/* Registration — horizontal label:value in both modes */}
          <div className="mb-3">
            <h3 className={consoleSectionLabelClass}>{t('settings:general.registration')}</h3>
          </div>

          <div className="mb-6">
            {isEdit ? (
              <div className="flex items-center justify-between gap-4 min-h-[38px]">
                <span className="text-xs text-zinc-500 shrink-0">{t('settings:general.registration_mode')}</span>
                <div className="w-48">
                  <SelectMenu
                    value={draft.registration_mode}
                    onChange={(v) => editMode.setDraft({ ...draft, registration_mode: v })}
                    options={[
                      { value: 'open', label: t('settings:general.mode_open') },
                      { value: 'approval', label: t('settings:general.mode_approval') },
                      { value: 'admin_only', label: t('settings:general.mode_admin') },
                      { value: 'invite_only', label: t('settings:general.mode_invite') },
                    ]}
                  />
                </div>
              </div>
            ) : (
              <ReadOnlyField
                label={t('settings:general.registration_mode')}
                value={t(REGISTRATION_MODE_LABELS[settings.registration_mode] || 'settings:general.mode_open')}
              />
            )}
          </div>

          <div className="border-t border-zinc-100 my-4" />

          {/* Default Quota — same 2-col grid structure in both modes */}
          <div className="mb-3">
            <h3 className={consoleSectionLabelClass}>{t('settings:general.default_quota')}</h3>
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-1 mb-6">
            {isEdit ? (
              <div className="flex items-center justify-between gap-4 min-h-[38px] py-1">
                <span className="text-xs text-zinc-500 shrink-0">{t('settings:quota.projects')}</span>
                <Input
                  type="number"
                  min={0}
                  value={draftQuota.max_projects ?? 5}
                  onChange={(e) => editMode.setDraft({
                    ...draft,
                    default_user_quota: { ...draftQuota, max_projects: e.target.value },
                  })}
                  className="h-8 py-1 w-24"
                />
              </div>
            ) : (
              <ReadOnlyField
                label={t('settings:quota.projects')}
                value={String(quota.max_projects ?? '')}
              />
            )}
            {isEdit ? (
              <div className="flex items-center justify-between gap-4 min-h-[38px] py-1">
                <span className="text-xs text-zinc-500 shrink-0">{t('settings:quota.sessions')}</span>
                <Input
                  type="number"
                  min={0}
                  value={draftQuota.max_sessions ?? 20}
                  onChange={(e) => editMode.setDraft({
                    ...draft,
                    default_user_quota: { ...draftQuota, max_sessions: e.target.value },
                  })}
                  className="h-8 py-1 w-24"
                />
              </div>
            ) : (
              <ReadOnlyField
                label={t('settings:quota.sessions')}
                value={String(quota.max_sessions ?? '')}
              />
            )}
            {isEdit ? (
              <div className="flex items-center justify-between gap-4 min-h-[38px] py-1">
                <span className="text-xs text-zinc-500 shrink-0">{t('settings:quota.previews')}</span>
                <Input
                  type="number"
                  min={0}
                  value={draftQuota.max_previews ?? 1}
                  onChange={(e) => editMode.setDraft({
                    ...draft,
                    default_user_quota: { ...draftQuota, max_previews: e.target.value },
                  })}
                  className="h-8 py-1 w-24"
                />
              </div>
            ) : (
              <ReadOnlyField
                label={t('settings:quota.previews')}
                value={String(quota.max_previews ?? '')}
              />
            )}
            {isEdit ? (
              <div className="flex items-center justify-between gap-4 min-h-[38px] py-1">
                <span className="text-xs text-zinc-500 shrink-0">{t('settings:general.tier')}</span>
                <div className="w-32">
                  <SelectMenu
                    value={draftQuota.resource_tier ?? 'basic'}
                    onChange={(v) => editMode.setDraft({
                      ...draft,
                      default_user_quota: { ...draftQuota, resource_tier: v },
                    })}
                    options={[
                      { value: 'basic', label: t('users:tier.basic') },
                      { value: 'pro', label: t('users:tier.pro') },
                      { value: 'enterprise', label: t('users:tier.enterprise') },
                    ]}
                  />
                </div>
              </div>
            ) : (
              <ReadOnlyField
                label={t('settings:general.tier')}
                value={t(TIER_LABELS[quota.resource_tier] || 'users:tier.basic')}
              />
            )}
          </div>

          <div className="border-t border-zinc-100 my-4" />

          {/* Session TTL — horizontal label:value in both modes */}
          <div className="mb-3">
            <h3 className={consoleSectionLabelClass}>{t('sessions:title')}</h3>
          </div>

          <div className="mb-6">
            {isEdit ? (
              <div className="flex items-center justify-between gap-4 min-h-[38px]">
                <span className="text-xs text-zinc-500 shrink-0">{t('settings:general.session_ttl')}</span>
                <Input
                  type="number"
                  min={1}
                  value={draft.session_ttl_hours ?? 24}
                  onChange={(e) => editMode.setDraft({ ...draft, session_ttl_hours: e.target.value })}
                  className="h-8 py-1 w-32"
                />
              </div>
            ) : (
              <ReadOnlyField
                label={t('settings:general.session_ttl')}
                value={settings.session_ttl_hours ? `${settings.session_ttl_hours} ${t('settings:general.hours_unit')}` : null}
              />
            )}
          </div>

          {/* Action buttons */}
          <div className="pt-2 flex justify-end gap-2">
            {isEdit ? (
              <>
                <Button variant="secondary" size="md" onClick={editMode.cancelEdit} disabled={editMode.saving}>
                  {t('common:action.cancel')}
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  onClick={editMode.save}
                  disabled={editMode.saving}
                >
                  {editMode.saving ? t('settings:general.saving') : t('settings:general.save')}
                </Button>
              </>
            ) : (
              <Button variant="secondary" size="md" onClick={() => editMode.enterEdit()}>
                {t('common:action.edit')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
