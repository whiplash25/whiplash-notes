// ─────────────────────────────────────────────────────────────────────────────
//  preload.js  –  Secure IPC bridge
// ─────────────────────────────────────────────────────────────────────────────

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notesAPI', {
  // File operations
  save:             (filename, content) => ipcRenderer.invoke('notes:save', { filename, content }),
  delete:           (filename)          => ipcRenderer.invoke('notes:delete', filename),
  loadAll:          ()                  => ipcRenderer.invoke('notes:loadAll'),

  // Window control
  toggleAlwaysOnTop: ()                 => ipcRenderer.invoke('window:toggleAlwaysOnTop'),
  isAlwaysOnTop:     ()                 => ipcRenderer.invoke('window:isAlwaysOnTop'),
  onAlwaysOnTopChanged: cb              => ipcRenderer.on('window:aotChanged', (_e, isOn) => cb(isOn)),
  closeWindow:       ()                 => ipcRenderer.invoke('window:close'),
  minimizeWindow:    ()                 => ipcRenderer.invoke('window:minimize'),
  maximizeWindow:    ()                 => ipcRenderer.invoke('window:maximize'),
});
