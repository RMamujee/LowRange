# Low Range: a 4x4 rock-crawling sim

A browser off-road game with simple low-poly graphics and serious physics. Pick a rig, drop it into 4-Low,
lock the diffs and pick your line up rated rock trails.

Built with [Three.js](https://threejs.org/) for rendering and [Rapier](https://rapier.rs/) for rigid bodies,
plus a custom tyre and drivetrain solver.

## Run it

```bash
npm install
npm run dev      # http://localhost:5199
```

`npm run build` produces a static site in `dist/`.

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
| Backspace | recover (on a trail: back to its start, repaired) |
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
