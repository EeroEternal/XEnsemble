import { useTranslation } from 'react-i18next';
import SelectMenu from '../SelectMenu';
import { useTheme } from '../../hooks/useTheme';
import { consoleSectionLabelClass } from '../../lib/consoleTokens';

/**
 * User preferences: appearance (light/dark/system) + language.
 * All users see this panel regardless of admin role.
 */
export default function PreferencesPanel() {
  const { t, i18n } = useTranslation();
  const { pref, setPref } = useTheme();

  const themeOptions = [
    { value: 'light', label: t('settings:preferences.theme_light') },
    { value: 'dark', label: t('settings:preferences.theme_dark') },
    { value: 'system', label: t('settings:preferences.theme_system') },
  ];

  const langOptions = [
    { value: 'en', label: t('settings:language.en') },
    { value: 'zh', label: t('settings:language.zh') },
  ];

  const handleLang = (value) => {
    i18n.changeLanguage(value);
    localStorage.setItem('xe_locale', value);
    document.documentElement.lang = value;
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-1">
        <label className={consoleSectionLabelClass}>{t('settings:preferences.appearance')}</label>
        <SelectMenu value={pref} onChange={setPref} options={themeOptions} />
      </div>
      <div className="space-y-1">
        <label className={consoleSectionLabelClass}>{t('settings:language.label')}</label>
        <SelectMenu value={i18n.language} onChange={handleLang} options={langOptions} />
      </div>
    </div>
  );
}
