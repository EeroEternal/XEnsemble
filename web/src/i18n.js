import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import commonEn from '../../shared/i18n/en/common.json';
import authEn from '../../shared/i18n/en/auth.json';
import sessionsEn from '../../shared/i18n/en/sessions.json';
import agentsEn from '../../shared/i18n/en/agents.json';
import usersEn from '../../shared/i18n/en/users.json';
import settingsEn from '../../shared/i18n/en/settings.json';
import gatewayEn from '../../shared/i18n/en/gateway.json';
import workspaceEn from '../../shared/i18n/en/workspace.json';
import gitEn from '../../shared/i18n/en/git.json';
import imagesEn from '../../shared/i18n/en/images.json';
import deployEn from '../../shared/i18n/en/deploy.json';
import errorsEn from '../../shared/i18n/en/errors.json';
import chatEn from '../../shared/i18n/en/chat.json';

import commonZh from '../../shared/i18n/zh/common.json';
import authZh from '../../shared/i18n/zh/auth.json';
import sessionsZh from '../../shared/i18n/zh/sessions.json';
import agentsZh from '../../shared/i18n/zh/agents.json';
import usersZh from '../../shared/i18n/zh/users.json';
import settingsZh from '../../shared/i18n/zh/settings.json';
import gatewayZh from '../../shared/i18n/zh/gateway.json';
import workspaceZh from '../../shared/i18n/zh/workspace.json';
import gitZh from '../../shared/i18n/zh/git.json';
import imagesZh from '../../shared/i18n/zh/images.json';
import deployZh from '../../shared/i18n/zh/deploy.json';
import errorsZh from '../../shared/i18n/zh/errors.json';
import chatZh from '../../shared/i18n/zh/chat.json';

const savedLocale = (() => {
  try { return localStorage.getItem('xe_locale') || 'en'; } catch { return 'en'; }
})();

i18next
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        common: commonEn,
        auth: authEn,
        sessions: sessionsEn,
        agents: agentsEn,
        users: usersEn,
        settings: settingsEn,
        gateway: gatewayEn,
        workspace: workspaceEn,
        git: gitEn,
        images: imagesEn,
        deploy: deployEn,
        errors: errorsEn,
        chat: chatEn,
      },
      zh: {
        common: commonZh,
        auth: authZh,
        sessions: sessionsZh,
        agents: agentsZh,
        users: usersZh,
        settings: settingsZh,
        gateway: gatewayZh,
        workspace: workspaceZh,
        git: gitZh,
        images: imagesZh,
        deploy: deployZh,
        errors: errorsZh,
        chat: chatZh,
      },
    },
    lng: savedLocale,
    fallbackLng: 'en',
    defaultNS: 'common',
    interpolation: {
      escapeValue: false,
    },
  });

try { document.documentElement.lang = i18next.language; } catch { /* jsdom */ }

export default i18next;
