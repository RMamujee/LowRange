// Platform glue: desktop (Electron, via the preload's window.lowrange) vs browser.
// Adds a Settings button to the menu's button board everywhere, and Quit only in the desktop app.
import { openSettings } from './settings.js';

export const desktop = window.lowrange && window.lowrange.isDesktop ? window.lowrange : null;
export const isDesktop = !!desktop;

function addMenuButtons() {
  const menu = document.getElementById('menu');
  if (!menu || document.getElementById('lrMenuBar')) return;
  const bar = document.createElement('div');
  bar.id = 'lrMenuBar';
  const mk = (id, label, fn) => {
    const b = document.createElement('button');
    b.className = 'pbtn'; b.id = id;
    const t = document.createElement('span'); t.textContent = label; b.appendChild(t);
    b.addEventListener('click', fn);
    bar.appendChild(b);
    return b;
  };
  mk('setBtn', 'Settings', openSettings);
  if (desktop) mk('quitBtn', 'Quit', () => desktop.quit());
  (document.getElementById('mActions') || menu).appendChild(bar);
}

if (isDesktop) document.documentElement.classList.add('desktop');
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addMenuButtons);
else addMenuButtons();
