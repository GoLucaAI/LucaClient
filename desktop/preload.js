'use strict'
/**
 * Preload — runs in the renderer with Node access disabled.
 * Exposes a safe typed API to the dashboard page via contextBridge.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('lucaDesktop', {
  // Status
  getStatus: () => ipcRenderer.invoke('get-status'),

  // Native capabilities the dashboard can request
  requestScreenshot: () => ipcRenderer.invoke('screenshot'),
  openExternal:      (url) => ipcRenderer.invoke('open-external', url),

  // Notifications
  showNotification: (title, body) => ipcRenderer.invoke('show-notification', { title, body }),

  // Confirmation dialog (for HIGH-risk actions)
  confirm: (message) => ipcRenderer.invoke('confirm-dialog', message),

  // Server settings (used by setup.html)
  getConfig:      () => ipcRenderer.sendSync('get-config'),
  saveServerUrl:  (url) => ipcRenderer.invoke('save-server-url', url),
  resetServerUrl: () => ipcRenderer.invoke('reset-server-url'),

  // Auto-update
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
  installUpdate:  () => ipcRenderer.invoke('install-update'),

  // Listen for events from main process
  on: (event, cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on(event, handler)
    return () => ipcRenderer.removeListener(event, handler)
  },
})
