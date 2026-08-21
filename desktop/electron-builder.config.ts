import { defineConfig } from 'electron-builder';

export default defineConfig({
  appId: 'dev.xensemble.desktop',
  productName: 'AgentHarness',
  directories: {
    output: 'dist'
  },
  files: [
    'out/**/*',
    'resources/**/*'
  ],
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.developer-tools',
    icon: 'resources/icon.icns'
  },
  win: {
    target: 'nsis',
    icon: 'resources/icon.ico'
  },
  linux: {
    target: 'AppImage',
    category: 'Development',
    icon: 'resources/icon.png'
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true
  }
});
