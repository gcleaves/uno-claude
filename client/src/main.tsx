import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { I18nProvider } from './i18n';
import { initAnalytics, track } from './analytics';
import './styles.css';

initAnalytics();
// Which layout people actually play on. Viewport bucket only — no user agent,
// no screen fingerprint.
track('app opened', { viewport: window.innerWidth < 768 ? 'mobile' : 'desktop' });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
