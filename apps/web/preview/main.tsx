import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../desktop/src/renderer/src/App.js';
import {
  applyTheme,
  writeThemePreference,
} from '../../desktop/src/renderer/src/theme.js';
import {
  createPreviewCall,
  createPreviewDesktop,
  demoGateway,
  demoRoom,
  demoShell,
} from './fixtures.js';
import '../../desktop/src/renderer/src/styles.css';
import './preview.css';

const params = new URLSearchParams(window.location.search);
const scene = params.get('scene') ?? 'home';
const theme = params.get('theme');
if (theme === 'light' || theme === 'dark') {
  writeThemePreference(theme);
  applyTheme(theme);
}
Object.defineProperty(window, 'woShell', {
  value: demoShell,
  configurable: true,
});
const desktop = createPreviewDesktop(scene === 'auth');
const call = createPreviewCall();
const root = document.getElementById('root');
if (root === null) throw new Error('Missing preview root');
createRoot(root).render(
  <StrictMode>
    <App
      desktop={desktop}
      roomGateway={demoGateway}
      callController={call}
      initialJoinIntent={
        scene === 'room'
          ? {
              version: 1,
              mode: 'server',
              serverOrigin: 'https://wo.example.com',
              roomCode: demoRoom.roomCode,
            }
          : null
      }
    />
    <aside className="preview-note" aria-label="本地界面演示">
      <span>本地演示 · 示例数据</span>
      {!params.has('capture') && (
        <nav aria-label="演示场景">
          <a href="?scene=auth">登录</a>
          <a href="?scene=home">首页</a>
          <a href="?scene=room">房间</a>
        </nav>
      )}
    </aside>
  </StrictMode>,
);
