const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ember', {
  hello: () => ipcRenderer.invoke('ember:hello'),
  onEvent: (handler) => ipcRenderer.on('ember:event', (_event, payload) => handler(payload)),
  resize: (height) => ipcRenderer.send('ember:resize', height),
  utterance: (samples, overSpeech = false) => ipcRenderer.invoke('ember:utterance', samples.buffer, overSpeech),
  // The sentence so far, while you are still talking.
  partial: (samples, overSpeech = false) => ipcRenderer.invoke('ember:partial', samples.buffer, overSpeech),
  say: (text) => ipcRenderer.invoke('ember:say', text),
  interrupt: () => ipcRenderer.invoke('ember:interrupt'),
  reconnect: () => ipcRenderer.invoke('ember:reconnect'),
  permission: (id, allow) => ipcRenderer.invoke('ember:permission', id, allow),
  openSession: () => ipcRenderer.invoke('ember:open-session'),
  menu: () => ipcRenderer.send('ember:menu'),
  log: (line) => ipcRenderer.send('ember:log', String(line)),
  shot: (file, rect) => ipcRenderer.send('ember:shot', file, rect),
  settings: () => ipcRenderer.invoke('ember:settings'),
  setSettings: (patch) => ipcRenderer.invoke('ember:set-settings', patch),
  tts: (text) => ipcRenderer.invoke('ember:tts', text),
  ttsStop: () => ipcRenderer.send('ember:tts-stop'),
  taskbarIcon: (name) => ipcRenderer.send('ember:taskbar-icon', String(name)),
  quit: () => ipcRenderer.send('ember:quit'),
});
