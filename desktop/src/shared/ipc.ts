export interface DesktopAPI {
  getBackendURL(): string;
  setBackendURL(url: string): void;
  getAccessToken(): Promise<string | null>;
  setAccessToken(token: string): Promise<void>;
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string): Promise<void>;
  clearTokens(): Promise<void>;
  selectFile(): Promise<{ path: string; content: string } | null>;
  saveFile(file: { name: string; content: string }): Promise<boolean>;
  openExternal(url: string): void;
  getAppVersion(): string;
  setLocale(locale: string): Promise<void>;
}

export const IPC_CHANNELS = {
  GET_BACKEND_URL: 'config:getBackendURL',
  SET_BACKEND_URL: 'config:setBackendURL',
  GET_ACCESS_TOKEN: 'secure:getAccessToken',
  SET_ACCESS_TOKEN: 'secure:setAccessToken',
  GET_REFRESH_TOKEN: 'secure:getRefreshToken',
  SET_REFRESH_TOKEN: 'secure:setRefreshToken',
  CLEAR_TOKENS: 'secure:clearTokens',
  SELECT_FILE: 'dialog:selectFile',
  SAVE_FILE: 'dialog:saveFile',
  OPEN_EXTERNAL: 'shell:openExternal',
  GET_APP_VERSION: 'app:getVersion',
  SET_LOCALE: 'i18n:setLocale'
} as const;

declare global {
  interface Window {
    xensembleDesktopAPI: DesktopAPI;
  }
}

export {};
