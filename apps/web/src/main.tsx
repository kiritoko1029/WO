import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '../../desktop/src/renderer/src/App.js';
import '../../desktop/src/renderer/src/styles.css';
import './web.css';
import {
  browserSupportsDisplayCapture,
  createBrowserDesktopApi,
} from './browser-desktop-api.js';
import { parseWebJoinIntent } from './join-path.js';

const root = document.getElementById('root');
if (root === null) throw new Error('Web root is missing');

const supportsDisplayCapture = browserSupportsDisplayCapture();
const desktop = createBrowserDesktopApi({
  displayCaptureSupported: supportsDisplayCapture,
});
const initialJoinIntent = parseWebJoinIntent(window.location);

createRoot(root).render(
  <StrictMode>
    <div
      className={supportsDisplayCapture ? 'web-app' : 'web-app web-voice-only'}
    >
      {!supportsDisplayCapture && (
        <p className="web-capability-notice" role="status">
          当前浏览器仅支持语音通话
        </p>
      )}
      <App desktop={desktop} initialJoinIntent={initialJoinIntent} />
    </div>
  </StrictMode>,
);
