import { useTranslation } from 'react-i18next';
import SelectMenu from '../SelectMenu';
import { consoleSectionLabelClass } from '../../lib/consoleTokens';

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
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <label className={consoleSectionLabelClass}>{t('settings:language.label')}</label>
        <SelectMenu
          value={i18n.language}
          onChange={handleChange}
          options={options}
        />
      </div>
    </div>
  );
}
