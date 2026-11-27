// Vehicle definitions. Units: metres, kg, N·m, rpm.
// `independent: [front, rear]` selects independent (double-wishbone style) suspension
// per axle; otherwise the axle is a solid beam on links.
// The road-going rigs are styled after well-known 4x4s and a rally car, without badges.
// `enabled: false` parks a rig: its data and view code stay, but it is left out of
// VEHICLES (the menu, garage and saves). Flip the flag to bring it back.
// tire.psi [tyre pressure]: live pressure range (min / max), the stops (crawl / trail / road),
// bead (below this a hard corner or side hit at speed can unseat a bead) and defl (loaded-radius
// drop at crawl pressure and static load, x tyre radius). See src/tyres/pressure.js.
export const ALL_VEHICLES = [
  {
    id: 'taco',
    name: 'Trail Pickup',
    blurb: 'Lifted mid-size double-cab pickup. Independent front, solid rear with an e-locker, 6-speed manual.',
    body: 'taco',
    color: 0x7d7a4a, // olive, as in the reference art
    chassis: { mass: 1750, size: [1.85, 0.6, 5.35], comY: -0.08 },
    wheelbase: 3.24, track: 1.62,
    axleY: -0.36,
    tire: { radius: 0.465, width: 0.32, mass: 36, psi: { min: 8, crawl: 10, trail: 18, road: 32, max: 36, bead: 14, defl: 0.06 } }, // 37" [tyre pressure]
    axleMass: 120,
    independent: [true, false],
    susp: { freq: 1.45, zeta: 0.32, bump: 0.12, droop: 0.16, springSpacing: 1.15, articulation: 0.28, arb: 9000 },
    steer: { max: 0.6, rate: 1.5 },
    engine: { idle: 700, redline: 6000, peakT: 490, peakRpm: 4600, inertia: 0.2, friction: 24, sound: 'v6' },
    gears: [3.8, 2.35, 1.69, 1.31, 1.0, 0.82], reverse: 3.6,
    ranges: { high: 1.0, low: 3.0 }, final: 4.3, // aftermarket crawl gearing (49:1)
    brakeT: 3200,
    lockers: { front: false, rear: true },
    lsd: { front: 900 }, // brake-based traction control (A-TRAC style) on the open front diff
    rearSteer: false,
  },
  {
    id: 'lc70',
    name: 'Cruiser 76',
    blurb: 'Boxy old-school 4x4 wagon. Solid axles both ends, diff locks front and rear, torquey V8 diesel. Built to outlast you.',
    body: 'lc70',
    color: 0xe9e4d4,
    chassis: { mass: 2050, size: [1.8, 0.65, 4.9], comY: -0.02 },
    wheelbase: 2.73, track: 1.56,
    axleY: -0.4,
    tire: { radius: 0.455, width: 0.3, mass: 36, psi: { min: 8, crawl: 10, trail: 18, road: 32, max: 36, bead: 14, defl: 0.06 } }, // 36" [tyre pressure]
    axleMass: 150,
    susp: { freq: 1.4, zeta: 0.30, bump: 0.13, droop: 0.18, springSpacing: 1.15, articulation: 0.33 },
    steer: { max: 0.56, rate: 1.3 },
    engine: { idle: 700, redline: 3800, peakT: 880, peakRpm: 2000, inertia: 0.35, friction: 34, sound: 'diesel' },
    gears: [4.31, 2.33, 1.44, 1.0, 0.84], reverse: 4.3,
    ranges: { high: 1.0, low: 2.49 }, final: 4.3,
    brakeT: 3800,
    lockers: { front: true, rear: true },
    rearSteer: false,
  },
  {
    id: 'wrx',
    name: 'Rally Sedan',
    blurb: 'Gravel-spec turbo AWD rally sedan. Independent all round, permanent AWD, no low range. Flies on roads, suffers on rock.',
    body: 'wrx',
    color: 0x1f4fa8,
    // floor: chassis-local height of the floor pan, below the frame box (0.25 m off the ground)
    chassis: { mass: 1180, size: [1.7, 0.4, 4.4], comY: -0.12, floor: -0.34 },
    wheelbase: 2.62, track: 1.52,
    axleY: -0.26,
    tire: { radius: 0.33, width: 0.21, mass: 20, psi: { min: 10, crawl: 10, trail: 20, road: 32, max: 36, bead: 16, defl: 0.045 } }, // low-profile gravel tyres: no lower than 10 psi, the bead lets go sooner [tyre pressure]
    axleMass: 70,
    independent: [true, true],
    awd: true,
    susp: { freq: 1.7, zeta: 0.36, bump: 0.11, droop: 0.12, springSpacing: 1.2, articulation: 0.2, arb: 7000 },
    steer: { max: 0.55, rate: 2.6 },
    engine: { idle: 950, redline: 7500, peakT: 570, peakRpm: 4200, inertia: 0.13, friction: 20, sound: 'boxer' },
    gears: [3.0, 2.1, 1.65, 1.35, 1.12, 0.95], reverse: 3.2,
    ranges: { high: 1.0 }, final: 4.44,
    brakeT: 2600,
    lockers: { front: false, rear: false },
    lsd: { front: 450, rear: 700 }, // rally-spec limited-slip diffs
    rearSteer: false,
  },
  {
    id: 'goat',
    enabled: false, // parked until it has a Blender model
    name: 'Billy Goat',
    blurb: 'Purpose-built rock buggy. 40" tyres, huge flex, rear steer, both lockers. Light and twitchy.',
    body: 'buggy',
    color: 0xe8a020,
    chassis: { mass: 1450, size: [1.5, 0.5, 3.4], comY: -0.12 },
    wheelbase: 2.75, track: 1.78,
    axleY: -0.38,
    tire: { radius: 0.51, width: 0.38, mass: 42 },
    axleMass: 110,
    susp: { freq: 1.3, zeta: 0.32, bump: 0.16, droop: 0.26, springSpacing: 1.05, articulation: 0.42 },
    steer: { max: 0.62, rate: 1.6 },
    engine: { idle: 800, redline: 6000, peakT: 760, peakRpm: 3800, inertia: 0.22, friction: 28, sound: 'v8' },
    gears: [3.1, 1.95, 1.36, 1.0], reverse: 3.2,
    ranges: { high: 1.0, low: 3.8 }, final: 5.13,
    brakeT: 3400,
    lockers: { front: true, rear: true },
    rearSteer: true,
  },
  {
    id: 'mule',
    enabled: false, // parked until it has a Blender model
    name: 'Mule',
    blurb: 'Heavy expedition truck. Big diesel, 46" tyres, six gears. Slow, heavy, nearly unstoppable in mud.',
    body: 'truck',
    color: 0x6b7a3a,
    chassis: { mass: 6200, size: [2.1, 0.9, 6.4], comY: 0.05 },
    wheelbase: 3.9, track: 2.0,
    axleY: -0.50,
    tire: { radius: 0.60, width: 0.45, mass: 95 },
    axleMass: 320,
    susp: { freq: 1.4, zeta: 0.29, bump: 0.15, droop: 0.20, springSpacing: 1.45, articulation: 0.26 },
    steer: { max: 0.52, rate: 1.0 },
    engine: { idle: 650, redline: 2800, peakT: 2840, peakRpm: 1400, inertia: 1.4, friction: 90, sound: 'diesel' },
    gears: [6.2, 3.8, 2.4, 1.5, 1.0, 0.8], reverse: 6.0,
    ranges: { high: 1.0, low: 2.4 }, final: 5.6,
    brakeT: 14000,
    lockers: { front: true, rear: true },
    rearSteer: false,
  },
];

// The playable roster.
export const VEHICLES = ALL_VEHICLES.filter((v) => v.enabled !== false);
