import { useTranslation } from 'react-i18next';
import { consoleButtonFocusClass } from '@/lib/consoleTokens';

/**
 * Compact language toggle: 中 | EN
 * Shown in the top-right action area.
 */
export default function LanguageToggle() {
  const { i18n } = useTranslation();
  const current = i18n.language || 'en';

  const handleToggle = () => {
    const next = current.startsWith('zh') ? 'en' : 'zh';
    i18n.changeLanguage(next);
    localStorage.setItem('xe_locale', next);
    document.documentElement.lang = next;
  };

  return (
    <button
      type="button"
      onClick={handleToggle}
      className={`flex items-center gap-0.5 px-1.5 h-7 rounded-md text-xs font-medium text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 transition-colors ${consoleButtonFocusClass}`}
      title={current.startsWith('zh') ? '切换到英文' : 'Switch to Chinese'}
    >
      <span className={current.startsWith('zh') ? 'text-zinc-900 font-semibold' : 'text-zinc-400'}>中</span>
      <span className="text-zinc-300">|</span>
      <span className={current.startsWith('zh') ? 'text-zinc-400' : 'text-zinc-900 font-semibold'}>EN</span>
    </button>
  );
}
