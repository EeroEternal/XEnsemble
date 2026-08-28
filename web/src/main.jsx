import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { ToastProvider } from './components/Toast.jsx'
import './i18n'
import './index.css'
import { applyTheme, loadThemePref } from './lib/themePrefs'

// Apply persisted theme before first paint to avoid a light-mode flash (FOUC).
applyTheme(loadThemePref())

ReactDOM.createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <ToastProvider>
      <App />
    </ToastProvider>
  </BrowserRouter>
)
