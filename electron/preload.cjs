// LowRange preload (sandboxed, context-isolated). Exposes a tiny, fixed API as window.lowrange;
// the page never sees ipcRenderer or any Node API.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--lowrange-version='));
const version = arg ? arg.slice('--lowrange-version='.length) : '0.0.0';

contextBridge.exposeInMainWorld('lowrange', Object.freeze({
  isDesktop: true,
  version,
  platform: process.platform,
  toggleFullscreen: () => ipcRenderer.invoke('lowrange:toggle-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('lowrange:is-fullscreen'),
  onFullscreenChange: (fn) => {
    if (typeof fn !== 'function') return () => {};
    const h = (_e, on) => fn(!!on);
    ipcRenderer.on('lowrange:fullscreen-changed', h);
    return () => ipcRenderer.removeListener('lowrange:fullscreen-changed', h);
  },
  quit: () => ipcRenderer.send('lowrange:quit'),
}));
