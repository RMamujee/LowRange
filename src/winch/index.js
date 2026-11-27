// The winch feature wired for main.js in one place: the map's recovery points, the anchor list, the
// controller (keys, buttons, rules), the 3D view and the HUD board. main.js keeps a handful of
// `// [winch]` hook lines: setup, one call per frame, the action hook, the assisted-run marking and the
// controls rows.
import { buildRecoveryPoints } from './recovery_points.js';
import { buildAnchors } from './anchors.js';
import { WinchController } from './controller.js';
import { WinchView } from './view.js';
import { WinchBoard } from './board.js';
import { WINCH_AUDIO } from './winch.js';

export { WINCH_AUDIO };

export const WINCH_CONTROLS = [
  ['K', 'winch: tap picks the anchor, hold hooks up'],
  ['U / O', 'winch in / pay out (hold)'],
  ['L', 'unhook and stow the winch line'],
];

// opts: { RAPIER, world, terrain, scene, rocks, trees, props (PropPhysics items), heightAt, noOutline,
// toast, action, hudRoot }
export function setupWinch(o) {
  const rp = buildRecoveryPoints({ rocks: o.rocks, trees: o.trees, extra: o.props, warn: (m) => console.warn(m) });
  const anchors = buildAnchors({ rocks: o.rocks, trees: o.trees, props: o.props, posts: rp.posts, heightAt: o.heightAt });
  const ctl = new WinchController({ R: o.RAPIER, world: o.world, terrain: o.terrain, anchors, toast: (m, s) => o.toast(m, s) });
  const view = new WinchView(o.scene, { posts: rp.posts, noOutline: o.noOutline });
  const board = o.hudRoot ? new WinchBoard(o.hudRoot, (n) => o.action(n)) : null;
  let clock = 0;
  return {
    ctl, view, board, posts: rp.posts, cruxes: rp.cruxes, anchors, audio: WINCH_AUDIO,
    action: (name) => ctl.action(name),
    // per frame: driving = playing and not paused; assisted = the current run has had help from the line
    frame(car, carView, dt, keys, driving, assisted) {
      clock += dt;
      if (driving) ctl.update(car, dt, keys); else ctl.attach(car);
      view.update(ctl, carView, clock);
      board?.update(dt, ctl.info(assisted), driving);
    },
    assist: (game, courses, race) => ctl.assist(game, courses, race),
  };
}
