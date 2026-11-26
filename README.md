# LowRange: a 4x4 rock-crawling sim

An off-road game for Windows (offline desktop app) and the browser, with simple low-poly graphics and serious physics. Pick a rig, drop it into 4-Low,
lock the diffs and pick your line up rated rock trails.

Built with [Three.js](https://threejs.org/) for rendering and [Rapier](https://rapier.rs/) for rigid bodies,
plus a custom tyre and drivetrain solver.

## Run it

```bash
npm install
npm run dev      # http://localhost:5199
```

`npm run build` produces a static site in `dist/`.

## Download & play (Windows)

LowRange runs fully offline as a desktop game. There are two builds (see *Build from source* below to make them):

| File | What it is |
|---|---|
| `LowRange-Setup-0.1.0.exe` | Installer. Installs for your user only (no admin needed), lets you choose the folder, adds Desktop and Start Menu shortcuts, and uninstalls from *Settings > Apps*. |
| `LowRange-0.1.0-portable.exe` | Portable. One file, nothing installed: run it from anywhere, a USB stick included. It starts a little slower because it unpacks itself on each launch. |

**Windows SmartScreen:** the builds aren't code-signed yet, so the first launch shows *Windows protected your PC* with an *Unknown publisher*. Click **More info**, then **Run anyway**.

**Desktop keys:** F11 or Alt+Enter toggles fullscreen. F10 opens Settings (graphics preset, master volume, fullscreen, FPS counter). Esc opens the garage menu, the same as in the browser, and never drops you out of fullscreen. The garage menu has Settings and Quit buttons. The window's size, position and fullscreen state are remembered between launches.

**Where saves live:** settings, best times and garage builds are stored in the app's local storage under `%APPDATA%\LowRange\` (the `Local Storage` folder). The window position is in `%APPDATA%\LowRange\window-state.json`. The installer and the portable exe share that folder. Uninstalling keeps it, so delete the folder to reset everything. The browser version keeps its own separate saves in the browser.

The desktop app makes no network requests (everything, including the physics WASM, ships inside it), and it has no telemetry or auto-update.

## Build from source

You need Node.js 20+; the Windows packages must be built on Windows.

```bash
npm install
npm run dev            # browser version with hot reload, http://localhost:5199
npm run build          # static site in dist/
npm run desktop        # build, then run the desktop app from source (Electron)
npm run dist:win       # build the installer and portable exe into release/
npm run smoke:desktop  # launch the desktop app, wait for the game, screenshot to test/shots/
node test/desktop-smoke.mjs --packaged   # same, against release/win-unpacked/LowRange.exe
npm run icon           # regenerate build/icon.ico and build/icon.png (scripts/make-icon.mjs)
```

The first `dist:win` downloads the Electron runtime and the NSIS installer tools into electron-builder's cache.

The desktop shell is in `electron/`. `main.cjs` serves `dist/` over a private `app://lowrange` scheme with a strict Content-Security-Policy, and `preload.cjs` exposes a small `window.lowrange` API (version, platform, fullscreen, quit). The page is sandboxed and context-isolated with no Node access, and it can't navigate away or open windows. Allow-listed links (GitHub, three.js, Rapier) open in your browser.

## What's simulated

- **Suspension:** solid axles on links (articulation, diff hang-ups, axle wrap) or independent double-wishbone style, with springs, dampers, bump stops and anti-roll bars.
- **Drivetrain:** engine torque curve with an idle governor, a clutch you can slip or stall, a manual gearbox, a 2-speed transfer case (high/low), 2WD/4WD, open or locked front and rear diffs. Everything is solved as one exact constraint system each physics step, so 80:1 crawl ratios stay stable.
- **Tyres:** a custom friction model on every contact patch, so a tyre pushing into a rock face can climb it. Grip and side force share one friction budget (spinning tyres lose sideways grip), and grip varies by surface: rock, dirt, gravel, sand, mud. You can air down for more grip.
- **Damage:** hard landings and impacts bend suspension, flatten tyres, dent body panels, hurt the engine and can tear wheels off.
- **Terrain:** a trail park with graded roads and five rated trails: green Pinyon Two-Track, blue Granite Steps and Bog Run, black Boulder Alley, and double-black Widowmaker Falls.

## Rigs

| Rig | Style | Notes |
|---|---|---|
| Trail Pickup | lifted mid-size double cab | independent front, solid rear with locker, 6-speed |
| Cruiser 76 | 70-series style wagon | solid axles, front and rear lockers, V8 diesel |
| Rally Sedan | turbo AWD rally car | independent all round, permanent AWD, no low range |
| Billy Goat | rock buggy | 40" tyres, huge flex, rear steer |
| Mule | expedition truck | heavy, big diesel, 46" tyres |

## Controls

| Input | Action |
|---|---|
| W / S | throttle / brake |
| A / D | steer |
| Space | clutch (hold) |
| Shift | crawl throttle (35%) |
| Mouse wheel | shift up / down |
| R | high / low range |
| Q / E | front / rear locker |
| F | 2WD / 4WD |
| G | rear steer (buggy) |
| T | air down / up |
| B | handbrake |
| I | start engine |
| C | auto-clutch on/off |
| Backspace | repair and right the truck where it is |
| Y | restart the current trail |
| V | camera |
| Z / X | zoom |
| Mouse drag | orbit the camera |
| H | help |
| Esc | garage (repairs your rig) |

A gamepad also works: RT/LT for the pedals, RB/LB to shift, X for the clutch.

## Tests

Headless physics checks run in Node, for example:

- `node test/brake.mjs`: braking distances
- `node test/obstacle.mjs ledge`: ledge climbing
- `node test/trails.mjs goat 200`: an autopilot drives each trail
- `node test/damage.mjs`: drop and wall-impact damage
