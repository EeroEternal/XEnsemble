import i18next from 'i18next';
import path from 'node:path';
import fs from 'node:fs';

const SHARED_I18N_DIR = path.join(__dirname, '..', '..', '..', '..', 'shared', 'i18n');

function loadLocaleResources(locale: string): Record<string, any> {
  const localeDir = path.join(SHARED_I18N_DIR, locale);
  const resources: Record<string, any> = {};
  const namespaces = [
    'common', 'auth', 'sessions', 'agents', 'users',
    'settings', 'gateway', 'workspace', 'git', 'images', 'deploy', 'errors',
  ];
  for (const ns of namespaces) {
    const filePath = path.join(localeDir, `${ns}.json`);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      resources[ns] = JSON.parse(content);
    } catch {
      resources[ns] = {};
    }
  }
  return resources;
}

const savedLocale = 'en';

i18next.init({
  resources: {
    en: loadLocaleResources('en'),
    zh: loadLocaleResources('zh'),
  },
  lng: savedLocale,
  fallbackLng: 'en',
  defaultNS: 'common',
  interpolation: {
    escapeValue: false,
  },
});

export function getCurrentLocale(): string {
  return i18next.language || 'en';
}

export function setLocale(locale: string): void {
  i18next.changeLanguage(locale);
}

export { i18next };
