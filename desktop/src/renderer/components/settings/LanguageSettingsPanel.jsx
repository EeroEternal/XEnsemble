import { useTranslation } from 'react-i18next';
import SelectMenu from '../SelectMenu';

export default function LanguageSettingsPanel() {
  const { t, i18n } = useTranslation();

  const options = [
    { value: 'en', label: t('settings:language.en') },
    { value: 'zh', label: t('settings:language.zh') },
  ];

  const handleChange = (value) => {
    i18n.changeLanguage(value);
    localStorage.setItem('xe_locale', value);
    document.documentElement.lang = value;
    // Notify Electron main process to rebuild native menu
    if (typeof window !== 'undefined' && window.xensembleDesktopAPI?.setLocale) {
      window.xensembleDesktopAPI.setLocale(value);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <label className="text-xs font-medium text-zinc-500">{t('settings:language.label')}</label>
        <SelectMenu
          value={i18n.language}
          onChange={handleChange}
          options={options}
        />
      </div>
    </div>
  );
}
