import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import SelectMenu from '../SelectMenu';
import Button from '../Button';
import ReadOnlyField from '../ReadOnlyField';
import { useToast } from '../Toast';
import { useTheme } from '../../hooks/useTheme';
import { useEditMode } from '../../hooks/useEditMode';
import { loadViewPref, saveViewPref } from '../../lib/viewPrefs';
import { TIMEZONES } from '../../lib/timezones';
import { loadTimezonePref, saveTimezonePref } from '../../lib/timezonePref';
import { consoleSectionLabelClass, consoleCardClass } from '../../lib/consoleTokens';

const THEME_LABEL_KEYS = {
  light: 'settings:preferences.theme_light',
  dark: 'settings:preferences.theme_dark',
  system: 'settings:preferences.theme_system',
};

const VIEW_LABEL_KEYS = {
  agent: 'settings:preferences.view_agent',
  chat: 'settings:preferences.view_chat',
};

/**
 * User preferences: language + appearance + agent interface style.
 * Mirrors the General panel's display/edit card layout:
 *   - one consoleCardClass box framing all options
 *   - Language: full row
 *   - divider (border-t) between language and the styles
 *   - Appearance + Agent style: 2-col grid (half row each)
 */
export default function PreferencesPanel() {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const { pref, setPref } = useTheme();

  const [settings, setSettings] = useState(() => ({
    theme: pref,
    viewMode: loadViewPref(),
    language: i18n.language,
    timezone: loadTimezonePref(),
  }));

  const editMode = useEditMode({
    onSave: (draft) => {
      setPref(draft.theme);
      saveViewPref(draft.viewMode);
      saveTimezonePref(draft.timezone);
      if (draft.language && draft.language !== i18n.language) {
        i18n.changeLanguage(draft.language);
        try { localStorage.setItem('xe_locale', draft.language); } catch { /* ignore */ }
        document.documentElement.lang = draft.language;
      }
      setSettings(draft);
      showToast('success', t('settings:toast.saved'));
    },
  });

  const isEdit = editMode.isEditing;
  const source = isEdit ? editMode.draft : settings;

  const themeOptions = [
    { value: 'light', label: t('settings:preferences.theme_light') },
    { value: 'dark', label: t('settings:preferences.theme_dark') },
    { value: 'system', label: t('settings:preferences.theme_system') },
  ];

  const viewOptions = [
    { value: 'agent', label: t('settings:preferences.view_agent') },
    { value: 'chat', label: t('settings:preferences.view_chat') },
  ];

  const langOptions = [
    { value: 'en', label: t('settings:language.en') },
    { value: 'zh', label: t('settings:language.zh') },
  ];

  const timezoneOptions = TIMEZONES.map((tz) => ({ value: tz, label: tz }));

  const setField = (key, value) => {
    editMode.setDraft({ ...source, [key]: value });
  };

  const langLabel = source?.language
    ? langOptions.find((o) => o.value === source.language)?.label
    : null;
  const themeLabel = source?.theme
    ? t(THEME_LABEL_KEYS[source.theme] || 'settings:preferences.theme_system')
    : null;
  const viewLabel = source?.viewMode
    ? t(VIEW_LABEL_KEYS[source.viewMode] || 'settings:preferences.view_agent')
    : null;

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto console-scroll-hidden">
        <div className={`${consoleCardClass} p-6`}>
          {/* Language & region — full-width rows */}
          <div className="mb-3">
            <h3 className={consoleSectionLabelClass}>{t('settings:preferences.locale')}</h3>
          </div>

          <div className="mb-3">
            {isEdit ? (
              <div className="flex items-center justify-between gap-4 min-h-[38px]">
                <span className="text-xs text-zinc-500 shrink-0">{t('settings:language.label')}</span>
                <div className="w-48">
                  <SelectMenu
                    value={source.language}
                    onChange={(v) => setField('language', v)}
                    options={langOptions}
                  />
                </div>
              </div>
            ) : (
              <ReadOnlyField label={t('settings:language.label')} value={langLabel} />
            )}
          </div>

          <div className="mb-6">
            {isEdit ? (
              <div className="flex items-center justify-between gap-4 min-h-[38px]">
                <span className="text-xs text-zinc-500 shrink-0">{t('settings:preferences.timezone')}</span>
                <div className="w-48">
                  <SelectMenu
                    value={source.timezone}
                    onChange={(v) => setField('timezone', v)}
                    options={timezoneOptions}
                  />
                </div>
              </div>
            ) : (
              <ReadOnlyField label={t('settings:preferences.timezone')} value={source.timezone} />
            )}
          </div>

          {/* Horizontal divider between language and styles — same as General */}
          <div className="border-t border-zinc-100 my-4" />

          {/* Single section title for the styles group; no per-column big title */}
          <div className="mb-3">
            <h3 className={consoleSectionLabelClass}>{t('settings:preferences.display')}</h3>
          </div>

          {/* Theme mode + Agent style — 2-col, half row each */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 mb-6">
            <div>
              {isEdit ? (
                <div className="flex items-center justify-between gap-4 min-h-[38px]">
                  <span className="text-xs text-zinc-500 shrink-0">{t('settings:preferences.theme_mode')}</span>
                  <div className="w-40">
                    <SelectMenu
                      value={source.theme}
                      onChange={(v) => setField('theme', v)}
                      options={themeOptions}
                    />
                  </div>
                </div>
              ) : (
                <ReadOnlyField label={t('settings:preferences.theme_mode')} value={themeLabel} />
              )}
            </div>
            <div>
              {isEdit ? (
                <div className="flex items-center justify-between gap-4 min-h-[38px]">
                  <span className="text-xs text-zinc-500 shrink-0">{t('settings:preferences.session_view')}</span>
                  <div className="w-40">
                    <SelectMenu
                      value={source.viewMode}
                      onChange={(v) => setField('viewMode', v)}
                      options={viewOptions}
                    />
                  </div>
                </div>
              ) : (
                <ReadOnlyField label={t('settings:preferences.session_view')} value={viewLabel} />
              )}
            </div>
          </div>

          {/* Action buttons */}
          <div className="pt-2 flex justify-end gap-2">
            {isEdit ? (
              <>
                <Button variant="secondary" size="md" onClick={editMode.cancelEdit} disabled={editMode.saving}>
                  {t('common:action.cancel')}
                </Button>
                <Button variant="primary" size="md" onClick={editMode.save} disabled={editMode.saving}>
                  {editMode.saving ? t('settings:general.saving') : t('settings:general.save')}
                </Button>
              </>
            ) : (
              <Button variant="secondary" size="md" onClick={() => editMode.enterEdit(settings)}>
                {t('common:action.edit')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
