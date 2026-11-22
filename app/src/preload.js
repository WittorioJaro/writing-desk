'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('desk', {
  init: () => ipcRenderer.invoke('desk:init'),
  op: (name, ...args) => ipcRenderer.invoke('desk:op', name, ...args),
  checkInbox: () => ipcRenderer.invoke('desk:inbox'),
  setSync: (cfg) => ipcRenderer.invoke('desk:sync-config', cfg),
  syncNow: () => ipcRenderer.invoke('desk:sync-now'),
  exportCover: (bytes, name) => ipcRenderer.invoke('desk:export-cover', bytes, name),
  reveal: (which) => ipcRenderer.invoke('desk:reveal', which),
  onState: on('desk:state'),
  onSync: on('desk:sync'),
  onInbox: on('desk:inbox'),
  onCommand: on('desk:command'),
  onToast: on('desk:toast'),
});
