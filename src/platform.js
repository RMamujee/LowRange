// Platform glue: desktop (Electron, via the preload's window.lowrange) vs browser.
// Adds a small SETTINGS button to the garage menu everywhere, and QUIT only in the desktop app.
import { openSettings } from './settings.js';

export const desktop = window.lowrange && window.lowrange.isDesktop ? window.lowrange : null;
export const isDesktop = !!desktop;

function addMenuButtons() {
  const menu = document.getElementById('menu');
  if (!menu || document.getElementById('lrMenuBar')) return;
  const bar = document.createElement('div');
  bar.id = 'lrMenuBar';
  bar.style.cssText = 'position:absolute;top:14px;right:14px;display:flex;gap:8px;z-index:1';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.style.cssText = 'font-size:12px;padding:6px 14px;letter-spacing:.1em';
    b.textContent = label;
    b.addEventListener('click', fn);
    bar.appendChild(b);
    return b;
  };
  mk('SETTINGS', openSettings);
  if (desktop) mk('QUIT', () => desktop.quit());
  menu.appendChild(bar);
}

if (isDesktop) document.documentElement.classList.add('desktop');
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addMenuButtons);
else addMenuButtons();
