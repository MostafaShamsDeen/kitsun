// Bridge for a terminal tab's page (renderer/terminal.html). Main answers each call only for the tab whose page sent it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kitsunTerm', {
  ready: () => ipcRenderer.invoke('term:ready'),
  write: (data) => ipcRenderer.send('term:input', data),
  resize: (cols, rows) => ipcRenderer.send('term:resize', cols, rows),
  copy: (text) => ipcRenderer.send('term:copy', text),
  paste: () => ipcRenderer.invoke('term:paste'),
  openLink: (url) => ipcRenderer.send('term:open-link', url),
  onData: (fn) => ipcRenderer.on('term:data', (_e, data) => fn(data)),
});
