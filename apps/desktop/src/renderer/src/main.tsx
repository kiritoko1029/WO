import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';

const root = document.getElementById('root');
if (root === null) throw new Error('Renderer root is missing');

// Surface uncaught errors and unhandled promise rejections in the console.
// Without this, failures inside async screen-share / signaling paths can be
// silently swallowed, making white-screen crashes impossible to diagnose.
window.addEventListener('error', (event) => {
  console.error('[uncaught] Renderer error:', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[uncaught] Unhandled rejection:', event.reason);
});

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
