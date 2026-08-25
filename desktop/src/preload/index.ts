import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';

contextBridge.exposeInMainWorld('xensembleDesktopAPI', {
  getBackendURL: () => ipcRenderer.sendSync(IPC_CHANNELS.GET_BACKEND_URL),
  setBackendURL: (url: string) => ipcRenderer.send(IPC_CHANNELS.SET_BACKEND_URL, url),
  getAccessToken: () => ipcRenderer.invoke(IPC_CHANNELS.GET_ACCESS_TOKEN),
  setAccessToken: (token: string) => ipcRenderer.invoke(IPC_CHANNELS.SET_ACCESS_TOKEN, token),
  getRefreshToken: () => ipcRenderer.invoke(IPC_CHANNELS.GET_REFRESH_TOKEN),
  setRefreshToken: (token: string) => ipcRenderer.invoke(IPC_CHANNELS.SET_REFRESH_TOKEN, token),
  clearTokens: () => ipcRenderer.invoke(IPC_CHANNELS.CLEAR_TOKENS),
  selectFile: () => ipcRenderer.invoke(IPC_CHANNELS.SELECT_FILE),
  saveFile: (file: { name: string; content: string }) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_FILE, file),
  openExternal: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL, url),
  getAppVersion: () => ipcRenderer.sendSync(IPC_CHANNELS.GET_APP_VERSION),
  setLocale: (locale: string) => ipcRenderer.invoke(IPC_CHANNELS.SET_LOCALE, locale)
});
