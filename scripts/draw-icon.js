// Draws build/icon.png (256 px) from the fox in renderer/fox.js, so the app icon and the tray icon are the same fox as
// the title bar's mark. Run with Electron (npm run icon), which also wraps it into build/icon.ico (make-icon.js).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 300, height: 300, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<!doctype html><meta charset="utf-8"><body></body>');
  const fox = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'fox.js'), 'utf8');
  const dataUrl = await win.webContents.executeJavaScript(`${fox};
    (async () => {
      const svg = new XMLSerializer().serializeToString(KitsunFox.icon());
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      c.getContext('2d').drawImage(img, 0, 0, 256, 256);
      return c.toDataURL('image/png');
    })()`);
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`wrote ${out}`);
  app.quit();
});
