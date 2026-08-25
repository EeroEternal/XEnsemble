const i18next = require('i18next');
const path = require('path');
const fs = require('fs');

const SHARED_I18N_DIR = path.join(__dirname, '..', '..', '..', '..', 'shared', 'i18n');

function loadLocaleResources(locale) {
  const localeDir = path.join(SHARED_I18N_DIR, locale);
  const resources = {};
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

i18next.init({
  resources: {
    en: loadLocaleResources('en'),
    zh: loadLocaleResources('zh'),
  },
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'errors',
  interpolation: {
    escapeValue: false,
  },
});

/**
 * Translate a key for a given locale.
 * @param {string} key - i18n key (e.g. 'errors:project_not_found')
 * @param {object} [params] - interpolation params
 * @param {string} [locale] - 'en' or 'zh'; defaults to 'en'
 * @returns {string}
 */
function t(key, params, locale) {
  if (locale && locale !== i18next.language) {
    return i18next.getFixedT(locale).t(key, params);
  }
  return i18next.t(key, params);
}

module.exports = { i18next, t };
