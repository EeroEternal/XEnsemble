import { ipcMain, dialog, shell, app, Menu, BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { IPC_CHANNELS } from '@shared/ipc';
import * as config from '@main/services/config';
import * as secureStore from '@main/services/secureStore';
import { i18next, setLocale } from '@main/i18n';
import { createMenu } from '@main/app/menu';

export function registerIPCHandlers(): void {
  ipcMain.on(IPC_CHANNELS.GET_BACKEND_URL, (event) => {
    event.returnValue = config.getBackendURL();
  });

  ipcMain.on(IPC_CHANNELS.SET_BACKEND_URL, (_event, url: string) => {
    config.setBackendURL(url);
  });

  ipcMain.handle(IPC_CHANNELS.GET_ACCESS_TOKEN, () => secureStore.getAccessToken());
  ipcMain.handle(IPC_CHANNELS.SET_ACCESS_TOKEN, (_event, token: string) => {
    secureStore.setAccessToken(token);
  });
  ipcMain.handle(IPC_CHANNELS.GET_REFRESH_TOKEN, () => secureStore.getRefreshToken());
  ipcMain.handle(IPC_CHANNELS.SET_REFRESH_TOKEN, (_event, token: string) => {
    secureStore.setRefreshToken(token);
  });
  ipcMain.handle(IPC_CHANNELS.CLEAR_TOKENS, () => secureStore.clearTokens());

  ipcMain.handle(IPC_CHANNELS.SELECT_FILE, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile']
    });
    if (canceled || filePaths.length === 0) return null;
    const filePath = filePaths[0];
    const content = await readFile(filePath, 'utf-8');
    return { path: filePath, content };
  });

  ipcMain.handle(IPC_CHANNELS.SAVE_FILE, async (_event, file: { name: string; content: string }) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: file.name
    });
    if (canceled || !filePath) return false;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, file.content, 'utf-8');
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL, (_event, url: string) => {
    shell.openExternal(url);
  });

  ipcMain.on(IPC_CHANNELS.GET_APP_VERSION, (event) => {
    event.returnValue = app.getVersion();
  });

  ipcMain.handle(IPC_CHANNELS.SET_LOCALE, async (_event, locale: string) => {
    setLocale(locale);
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      Menu.setApplicationMenu(createMenu(windows[0]));
    }
  });
}
