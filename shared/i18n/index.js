/**
 * Shared i18n configuration — used by web/, desktop/, and server/.
 */

const SUPPORTED_LOCALES = ['en', 'zh'];
const DEFAULT_LOCALE = 'en';
const FALLBACK_LOCALE = 'en';

const NAMESPACES = [
  'common',
  'auth',
  'sessions',
  'agents',
  'users',
  'settings',
  'gateway',
  'workspace',
  'git',
  'images',
  'deploy',
  'skills',
  'errors',
];

module.exports = {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  NAMESPACES,
};
