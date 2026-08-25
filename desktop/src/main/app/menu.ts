import { Menu, BrowserWindow } from 'electron';
import { i18next } from '../i18n';

export function createMenu(_mainWindow: BrowserWindow): Menu {
  const isMac = process.platform === 'darwin';
  const t = i18next.getFixedT(i18next.language, 'common');

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'AgentHarness',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } as Electron.MenuItemConstructorOptions
        ]
      : []),
    {
      label: t('menu.file', { defaultValue: 'File' }),
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }]
    },
    {
      label: t('menu.edit', { defaultValue: 'Edit' }),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: t('menu.view', { defaultValue: 'View' }),
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: t('menu.window', { defaultValue: 'Window' }),
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ];

  return Menu.buildFromTemplate(template);
}
