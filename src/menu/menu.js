// Menu chrome: installs the pixel textures + web font, hangs the LowRange sign, rates rigs for the cards,
// and gives the menu / garage full keyboard navigation (arrow keys move focus spatially, radio groups
// keep their selection when entered). The menu's game logic stays in main.js.
import './menu.css';
import { installMenuArt, drawSign, pixelScale } from './art.js';
import '../ui/pixelwebfont.js';   // registers the pixel web font

export function mountMenuChrome() {
  installMenuArt();
  const host = document.getElementById('mSign');
  if (host && !host.querySelector('canvas')) {
    const cv = drawSign();
    cv.setAttribute('aria-hidden', 'true');
    host.appendChild(cv);
    const size = () => { const { p } = pixelScale(); cv.style.width = `${cv.width * p}px`; cv.style.height = `${cv.height * p}px`; };
    size();
    addEventListener('resize', size);
  }
}

// Hardest trail grade a rig is set up for, from its (built) spec: low range, lockers, crawl ratio.
export function rigRating(spec, st) {
  const lockers = (spec.lockers.front ? 1 : 0) + (spec.lockers.rear ? 1 : 0);
  if (!spec.ranges.low) return 'green';
  if (lockers === 2 && st.crawl >= 40) return 'dblack';
  if (lockers >= 1) return 'black';
  return 'blue';
}

// ------------------------------------------------------------ keyboard navigation
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-2"])';
const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };

// Move focus to the nearest control in direction (dx, dy) inside `layer`.
export function moveFocus(layer, dx, dy) {
  const items = [...layer.querySelectorAll(FOCUSABLE)].filter(visible);
  if (!items.length) return false;
  const cur = document.activeElement;
  if (!layer.contains(cur) || cur === layer) { (layer.querySelector('[data-autofocus]') || items[0]).focus(); return true; }
  const a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of items) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    // gap along the direction (edge to edge) and offset across it (centre to centre)
    const along = dx ? (dx > 0 ? b.left - a.right : a.left - b.right) : (dy > 0 ? b.top - a.bottom : a.top - b.bottom);
    const centreAlong = dx ? (b.left + b.width / 2 - ax) * dx : (b.top + b.height / 2 - ay) * dy;
    if (centreAlong <= 1 || along < -Math.min(a.width, a.height) * 0.5) continue;
    const across = dx ? Math.abs(b.top + b.height / 2 - ay) : Math.abs(b.left + b.width / 2 - ax);
    const overlap = dx ? (b.bottom > a.top && b.top < a.bottom) : (b.right > a.left && b.left < a.right);
    const score = Math.max(0, along) + across * (overlap ? 0.5 : 2.5);
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (!best) return false;
  // entering a radio group from outside lands on its checked item, so passing through never changes it
  const group = best.closest('[role=radiogroup]');
  if (group && !group.contains(cur)) best = group.querySelector('[aria-checked=true]') || best;
  best.focus();
  return true;
}

// Arrow keys for whichever layer getLayer() returns (null = no menu up).
export function enableArrowNav(getLayer) {
  addEventListener('keydown', (e) => {
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.code];
    if (!dir || e.defaultPrevented) return;
    const layer = getLayer();
    if (!layer) return;
    if (e.target && e.target.matches && e.target.matches('input[type=range]')) return;
    if (moveFocus(layer, dir[0], dir[1])) e.preventDefault();
  });
}
