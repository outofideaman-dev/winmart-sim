// c:/Users/lshie/Documents/project/stupidfuck/Bao_cao_WinMart_V6_1_5000m2/Mo_phong/layout_spec.mjs
// Single source of truth for WinMart V6.2 5,000 m² indoor geometry, vehicle safety envelopes, and corridor graph.

export const PALLET_TYPES = {
  STD_WOOD: {
    code: 'STD_WOOD',
    name: 'Pallet gỗ chuẩn GMA/ISO',
    lengthM: 1.20,
    widthM: 1.00,
    baseHeightM: 0.15,
    tareKg: 25,
    maxStackHeightM: 1.65,
    maxGrossWeightKg: 800
  },
  PLASTIC_HD: {
    code: 'PLASTIC_HD',
    name: 'Pallet nhựa tải nặng vệ sinh kho khô',
    lengthM: 1.20,
    widthM: 1.00,
    baseHeightM: 0.15,
    tareKg: 20,
    maxStackHeightM: 1.65,
    maxGrossWeightKg: 800
  }
};

// Vehicle physical & dynamic safety envelopes (meters).
// Reach Truck (XN): body + forks ~2.10 x 1.22 m; dynamic longitudinal & lateral clearance margins included.
// Pallet Robot (CP): referenced to SEER SFL-CBD20 class (~1.72 x 0.96 m unloaded; ~1.85 x 1.08 m carrying 1.2x1.0 pallet).
export const VEHICLE_SPECS = {
  RT: {
    code: 'RT',
    prefix: 'XN',
    displayName: 'Xe nâng tầm cao tự hành (XN)',
    unloadedLengthM: 2.15,
    unloadedWidthM: 1.24,
    loadedLengthM: 2.30,
    loadedWidthM: 1.30,
    longitudinalMarginM: 0.22,
    lateralMarginM: 0.12,
    speedUnloadedMps: 0.90,
    speedLoadedMps: 0.65,
    chargerKw: 3.0,
    idleDrainPctPerHour: 0.35
  },
  CP: {
    code: 'CP',
    prefix: 'CP',
    displayName: 'Robot vận chuyển pallet thấp (CP)',
    unloadedLengthM: 1.72,
    unloadedWidthM: 0.96,
    loadedLengthM: 1.86,
    loadedWidthM: 1.08,
    longitudinalMarginM: 0.20,
    lateralMarginM: 0.10,
    speedUnloadedMps: 1.00,
    speedLoadedMps: 0.80,
    speedInTruckMps: 0.25,
    chargerKw: 1.5,
    idleDrainPctPerHour: 0.25
  }
};

export const LAYOUT = {
  version: '6.2',
  width: 100,
  height: 50,
  levels: 3,
  areas: [
    ['Kệ và đường tiếp cận', 0, 18, 100, 32, 3200],
    ['Nhập và kiểm nhận', 0, 0, 250 / 9, 18, 500],
    ['Nguồn và ghép', 250 / 9, 0, 100 / 3, 18, 600],
    ['Chờ xuất và dock', 550 / 9, 0, 25, 18, 450],
    ['Sạc và phụ trợ', 775 / 9, 0, 125 / 9, 18, 250]
  ],
  aisleXs: Array.from({length: 14}, (_, i) => (i < 7 ? 0 : 50) + 5.2 + 6.6 * (i % 7)),
  inboundDockXs: Array.from({length: 6}, (_, i) => 3.14 + i * 4.3),
  outboundDockXs: [
    ...Array.from({length: 7}, (_, i) => 30.94 + i * 4.5),
    ...Array.from({length: 5}, (_, i) => 64.61 + i * 4.5)
  ],
  rackY: 22.45,
  rackLength: 23.1,
  rackFaceOffsetX: 2.60,
  frontY: 20.2,
  // Continuous 2-way rear detour corridor south of racks (y = 46.8 m), separated from XN home pockets (y = 49.0 m).
  rearY: 46.8,
  rtHomeY: 49.0,
  cpFrontY: 3.4,
  cpMidY: 11.6,
  cpCrossXs: [28.6, 62.1, 85.0],
  // Auxiliary zone geometry (x = 86.11..100, y = 0..18) — chargers recessed >= 2.4 m from active corridors.
  cpHomes: Array.from({length: 4}, (_, i) => ({id: `CP_HOME${i + 1}`, x: 88.0 + i * 2.8, y: 5.6})),
  cpChargers: Array.from({length: 4}, (_, i) => ({id: `CHG_CP${i + 1}`, robotType: 'CP', x: 88.0 + i * 2.8, y: 9.2, kw: 1.5})),
  rtHomes: Array.from({length: 6}, (_, i) => ({
    id: `RT_HOME${i + 1}`,
    x: (i < 3 ? 0 : 50) + 8.5 + 6.6 * (i % 3),
    y: 49.0,
    zone: i < 3 ? 'A' : 'B'
  })),
  rtChargers: Array.from({length: 6}, (_, i) => ({id: `CHG_RT${i + 1}`, robotType: 'RT', x: 87.3 + i * 2.1, y: 16.2, kw: 3.0})),
  // Off-corridor emergency repair / maintenance bays (never obstruct frontY, rearY, cpFrontY, cpMidY, or rack aisles).
  maintBays: {
    CP: [
      {id: 'MAINT_CP1', type: 'CP', x: 92.8, y: 1.35},
      {id: 'MAINT_CP2', type: 'CP', x: 96.8, y: 1.35}
    ],
    RT: [
      {id: 'MAINT_RT1', type: 'RT', x: 84.9, y: 49.0},
      {id: 'MAINT_RT2', type: 'RT', x: 91.5, y: 49.0}
    ]
  },
  // Yard queue outside the 5,000 m² building envelope (visualized above dock apron).
  yardSlots: Array.from({length: 8}, (_, i) => ({
    id: `YARD${i + 1}`,
    x: 88.5 + (i % 2) * 5.2,
    y: -8.5 + Math.floor(i / 2) * 1.9
  })),
  maxChargerPowerKw: 9.0
};

export function dockStagePoint(bay) {
  const dockX = LAYOUT.outboundDockXs[bay];
  const sideOffset = (bay === 0 || bay === 7) ? 1.65 : -1.65;
  return {x: Number((dockX + sideOffset).toFixed(3)), y: 1.55};
}

export function generateStorageSlots() {
  const slots = [];
  for (let aisle = 0; aisle < 14; aisle++) {
    const aisleX = LAYOUT.aisleXs[aisle];
    const friendlyAisle = `L${String(aisle + 1).padStart(2, '0')}`;
    for (let bay = 0; bay < 7; bay++) {
      const centerY = 24.1 + bay * 3.3;
      for (let face = 0; face < 2; face++) {
        const rackX = Number((aisleX + (face === 0 ? -LAYOUT.rackFaceOffsetX : LAYOUT.rackFaceOffsetX)).toFixed(3));
        for (let pos = 0; pos < 3; pos++) {
          const slotY = Number((centerY + (pos - 1) * 1.05).toFixed(3));
          for (let level = 0; level < LAYOUT.levels; level++) {
            const id = `S${aisle}_${bay}_${face}_${pos}_${level}`;
            const friendlyCode = `${friendlyAisle}-B${bay + 1}-${face === 0 ? 'T' : 'P'}${pos + 1}-T${level + 1}`;
            slots.push({
              id,
              friendlyCode,
              kind: 'rack',
              // x, y represent the reach-truck stopping point on the aisle centerline;
              // rackX, rackY represent the physical pallet resting coordinate inside the rack bay.
              x: Number(aisleX.toFixed(3)),
              y: slotY,
              pickupX: Number(aisleX.toFixed(3)),
              pickupY: slotY,
              rackX,
              rackY: slotY,
              aisle,
              bay,
              face,
              pos,
              level,
              zone: aisle < 7 ? 'A' : 'B',
              height: Number((0.15 + level * 1.8).toFixed(2))
            });
          }
        }
      }
    }
  }
  return slots;
}

export function generateFloorLocations() {
  const locs = [];
  for (let i = 0; i < 4; i++) {
    locs.push({id: `IN${i}`, alias: `IN${i}`, kind: 'inbound', x: 8 + i * 4, y: 6.5});
  }
  for (let i = 0; i < 20; i++) {
    const x = Number((29.4 + i * 1.6).toFixed(3));
    locs.push({
      id: `SRC${i}`,
      alias: `N${i}`,
      kind: 'source',
      x,
      y: 14.8,
      rtStopY: 15.55,
      cpStopY: 14.15,
      cell: Math.floor(i / 2)
    });
  }
  for (let i = 0; i < 10; i++) {
    const x = Number((30.2 + i * 3.2).toFixed(3));
    locs.push({id: `OUT${i}`, alias: `G${i}`, kind: 'output', x, y: 6.5, cell: i});
  }
  for (let i = 0; i < 12; i++) {
    const x = Number((63.5 + i * 1.8).toFixed(3));
    locs.push({
      id: `ST${i}`,
      alias: `ST${i}`,
      kind: 'stage',
      x,
      y: 14.8,
      rtStopY: 15.55,
      cpStopY: 14.15,
      stageIndex: i
    });
  }
  for (const m of [...LAYOUT.maintBays.CP, ...LAYOUT.maintBays.RT]) {
    locs.push({id: m.id, alias: m.id, kind: 'maint', robotType: m.type, x: m.x, y: m.y});
  }
  return locs;
}

// Compute vehicle half-extents (halfLength along heading, halfWidth perpendicular to heading) including dynamic safety margin.
export function vehicleHalfExtents(type, loaded = false, stationary = false) {
  const spec = VEHICLE_SPECS[type];
  const baseL = loaded ? spec.loadedLengthM : spec.unloadedLengthM;
  const baseW = loaded ? spec.loadedWidthM : spec.unloadedWidthM;
  const longMargin = stationary ? 0.06 : spec.longitudinalMarginM;
  const latMargin = stationary ? 0.05 : spec.lateralMarginM;
  return {
    hl: 0.5 * baseL + longMargin,
    hw: 0.5 * baseW + latMargin,
    rawHalfL: 0.5 * baseL,
    rawHalfW: 0.5 * baseW
  };
}

// Separating Axis Theorem (SAT) overlap check for two 2D Oriented Bounding Boxes (OBBs).
export function obbOverlap(x1, y1, cos1, sin1, hl1, hw1, x2, y2, cos2, sin2, hl2, hw2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  // Axes of box 1: u1 = (cos1, sin1), v1 = (-sin1, cos1)
  // Axes of box 2: u2 = (cos2, sin2), v2 = (-sin2, cos2)
  const u1x = cos1, u1y = sin1;
  const v1x = -sin1, v1y = cos1;
  const u2x = cos2, u2y = sin2;
  const v2x = -sin2, v2y = cos2;

  const r1u2 = Math.abs(u1x * u2x + u1y * u2y);
  const r1v2 = Math.abs(u1x * v2x + u1y * v2y);
  if (Math.abs(dx * u1x + dy * u1y) >= hl1 + hl2 * r1u2 + hw2 * r1v2 - 1e-7) return false;

  const r2u2 = Math.abs(v1x * u2x + v1y * u2y);
  const r2v2 = Math.abs(v1x * v2x + v1y * v2y);
  if (Math.abs(dx * v1x + dy * v1y) >= hw1 + hl2 * r2u2 + hw2 * r2v2 - 1e-7) return false;

  const r3u1 = r1u2;
  const r3v1 = r2u2;
  if (Math.abs(dx * u2x + dy * u2y) >= hl2 + hl1 * r3u1 + hw1 * r3v1 - 1e-7) return false;

  const r4u1 = r1v2;
  const r4v1 = r2v2;
  if (Math.abs(dx * v2x + dy * v2y) >= hw2 + hl1 * r4u1 + hw1 * r4v1 - 1e-7) return false;

  return true;
}

// Swept segment-to-segment OBB collision check over a 1-second step [0, 1].
// Samples endpoints and midpoint (and quarter-points when relative speed is high) after fast bounding-circle prune.
export function sweptEnvelopeConflict(segA, segB) {
  const {a0, a1, typeA, loadedA, statA} = segA;
  const {b0, b1, typeB, loadedB, statB} = segB;
  const extA = vehicleHalfExtents(typeA, loadedA, statA);
  const extB = vehicleHalfExtents(typeB, loadedB, statB);
  const radSum = Math.hypot(extA.hl, extA.hw) + Math.hypot(extB.hl, extB.hw);

  const minAX = Math.min(a0.x, a1.x), maxAX = Math.max(a0.x, a1.x);
  const minBX = Math.min(b0.x, b1.x), maxBX = Math.max(b0.x, b1.x);
  if (maxAX + radSum <= minBX || maxBX + radSum <= minAX) return false;

  const minAY = Math.min(a0.y, a1.y), maxAY = Math.max(a0.y, a1.y);
  const minBY = Math.min(b0.y, b1.y), maxBY = Math.max(b0.y, b1.y);
  if (maxAY + radSum <= minBY || maxBY + radSum <= minAY) return false;

  const dAx = a1.x - a0.x, dAy = a1.y - a0.y;
  const dBx = b1.x - b0.x, dBy = b1.y - b0.y;
  const moveA = Math.hypot(dAx, dAy);
  const moveB = Math.hypot(dBx, dBy);

  let cosA = a0.cos ?? 0, sinA = a0.sin ?? 1;
  if (moveA > 1e-5) { cosA = dAx / moveA; sinA = dAy / moveA; }
  else if (a1.cos != null) { cosA = a1.cos; sinA = a1.sin; }

  let cosB = b0.cos ?? 0, sinB = b0.sin ?? 1;
  if (moveB > 1e-5) { cosB = dBx / moveB; sinB = dBy / moveB; }
  else if (b1.cos != null) { cosB = b1.cos; sinB = b1.sin; }

  const samples = (moveA + moveB > 0.8) ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1];
  for (const s of samples) {
    const x1 = a0.x + dAx * s, y1 = a0.y + dAy * s;
    const x2 = b0.x + dBx * s, y2 = b0.y + dBy * s;
    if (obbOverlap(x1, y1, cosA, sinA, extA.hl, extA.hw, x2, y2, cosB, sinB, extB.hl, extB.hw)) {
      return true;
    }
  }
  return false;
}
