import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import App from './App';

// A deploy replaces every hashed chunk, so a tab opened before it asks for page
// files that no longer exist the next time it navigates. Vite reports that as
// vite:preloadError, and a reload picks up the new build, which is almost
// always all that is needed — so it happens without asking.
//
// Once only. If the chunk is missing for some other reason (a broken deploy, a
// proxy serving index.html for the .js), reloading would fail the same way and
// loop forever. The time of the last automatic reload is kept in
// sessionStorage, which survives the reload but not the tab; a second failure
// within the window is left to the ErrorBoundary, which shows a Reload button
// instead. sessionStorage can throw (some private modes), so a failure to read
// or write it means "do not reload" rather than "reload regardless".
const RELOAD_KEY = 'chunkReloadAt';
const RELOAD_WINDOW_MS = 60 * 1000;

window.addEventListener('vite:preloadError', () => {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
    if (Date.now() - last < RELOAD_WINDOW_MS) return;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return;
  }
  window.location.reload();
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
