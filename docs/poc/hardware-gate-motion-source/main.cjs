const { join } = require('node:path');

const { app, BrowserWindow } = require('electron');

const sourceTitle =
  process.env.WO_MOTION_SOURCE_TITLE ?? 'WO 1080p60 Motion Source';
let sourceWindow = null;

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1_920,
    height: 1_080,
    useContentSize: true,
    frame: false,
    resizable: false,
    minimizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#101418',
    title: sourceTitle,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  sourceWindow = window;
  window.once('closed', () => {
    if (sourceWindow === window) sourceWindow = null;
  });

  window.webContents.on('did-finish-load', () => {
    window.setTitle(sourceTitle);
    window.setContentSize(1_920, 1_080);
  });
  await window.loadFile(join(__dirname, 'index.html'), {
    query: { title: sourceTitle },
  });
});

app.on('window-all-closed', () => app.quit());
