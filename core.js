// c:/Users/lshie/Documents/project/stupidfuck/Bao_cao_WinMart_V6_1_5000m2/Mo_phong/core.mjs
// WinMart V6.1 simulation core — 5.000 m², 3-tier racks (1.764 slots), soft cross-zone RT A<->B, 12 outbound docks.
export const DEFAULT_CONFIG = {
  inboundSeconds: 28800,
  outboundSeconds: 28800,
  startPhase: 'OUTBOUND',
  initialPerSKU: 72,
  initialWaveOrders: 24,
  orderInterval: 135,
  orderLimit: 210,
  assemblySeconds: 600,
  receiptSeconds: 180,
  inboundLanes: 2,
  inboundTruckSize: 16,
  inboundPallets: 128,
  truckArrival: 0,
  truckTurnSeconds: 180,
  truckDeadline: 1800,
  truckPayload: 4500,
  outboundRoutes: 6,
  crossZone: true,
  initialBattery: 100,
  batteryWorkSeconds: 28800,
  chargeSeconds: 7200,
  maxCharging: 3,
  operationMultiplier: 1,
  direct: true,
  autoCycle: false,
  seed: 42
};

export const LAYOUT = {
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
  frontY: 20.2,
  rearY: 47.8,
  cpFrontY: 3.4,
  cpMidY: 11.6,
  cpCrossXs: [28.6, 62.1, 85.0]
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clone = o => JSON.parse(JSON.stringify(o));
const sum = a => a.reduce((x, y) => x + y, 0);
const dedup = pts => pts.filter((p, i) => !i || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 1e-6);

export function generateStorageSlots() {
  const a = [];
  for (let aisle = 0; aisle < 14; aisle++)
    for (let bay = 0; bay < 7; bay++)
      for (let face = 0; face < 2; face++)
        for (let pos = 0; pos < 3; pos++)
          for (let level = 0; level < LAYOUT.levels; level++)
            a.push({
              id: `S${aisle}_${bay}_${face}_${pos}_${level}`,
              kind: 'rack',
              x: LAYOUT.aisleXs[aisle],
              y: 24.1 + bay * 3.3,
              aisle,
              bay,
              face,
              level,
              zone: aisle < 7 ? 'A' : 'B',
              height: 0.15 + level * 1.8
            });
  return a;
}

// Minimum continuous separation during a 1-second tick.
function separation(a, b, c, d) {
  const x = a.x - c.x, y = a.y - c.y;
  const vx = (b.x - a.x) - (d.x - c.x), vy = (b.y - a.y) - (d.y - c.y);
  const v = vx * vx + vy * vy;
  const t = v ? Math.max(0, Math.min(1, -(x * vx + y * vy) / v)) : 0;
  return Math.hypot(x + t * vx, y + t * vy);
}

export class WinMartEngine {
  constructor(config = {}) {
    this.config = {...DEFAULT_CONFIG, ...config};
    const c = this.config;
    for (const k of ['inboundSeconds', 'outboundSeconds', 'assemblySeconds', 'receiptSeconds', 'orderInterval', 'batteryWorkSeconds', 'chargeSeconds'])
      if (!Number.isFinite(c[k]) || c[k] <= 0) throw Error(`Tham số không hợp lệ ${k}`);
    this.time = 0;
    this.motionTime = 0;
    this.phase = c.startPhase;
    this.phaseStart = 0;
    this.phaseIndex = 0;
    this.serial = 0;
    this.locations = new Map();
    this.pallets = new Map();
    this.robots = new Map();
    this.jobs = [];
    this.orders = [];
    this.trucks = [];
    this.inboundTrucks = [];
    this.logs = [];
    this.transitions = [];
    this.shiftResults = [];
    this.initialBySKU = Array(12).fill(0);
    this.receivedBySKU = Array(12).fill(0);
    this.shippedBySKU = Array(12).fill(0);
    this.slots = generateStorageSlots();
    this.slotMap = new Map(this.slots.map(s => [s.id, s]));
    this.metrics = {
      received: 0, stored: 0, assembled: 0, loaded: 0, departed: 0, returned: 0,
      emptyCollected: 0, direct: 0, viaStage: 0, crossZoneTrips: 0,
      maxAssembly: 0, maxRT: 0, maxInbound: 0, maxSource: 0, maxStage: 0, maxActiveDocks: 0,
      blockedReceipt: 0, globalSafetyHold: 0, checks: 0
    };

    const loc = (id, x, y, kind, extra = {}) =>
      this.locations.set(id, {id, x, y, kind, pallet: null, reservation: null, ...extra});
    for (const s of this.slots) loc(s.id, s.x, s.y, 'rack', s);
    for (let i = 0; i < 4; i++) loc(`IN${i}`, 8 + i * 4, 6.5, 'inbound');
    for (let i = 0; i < 20; i++) loc(`SRC${i}`, 29.4 + i * 1.6, 14.8, 'source', {cell: Math.floor(i / 2)});
    for (let i = 0; i < 10; i++) loc(`OUT${i}`, 30.2 + i * 3.2, 6.5, 'output', {cell: i});
    for (let i = 0; i < 12; i++) loc(`ST${i}`, 63.5 + i * 1.8, 14.8, 'stage');

    this.cells = Array.from({length: 10}, (_, i) => ({id: i, state: 'EMPTY', order: null, remaining: 0, team: null}));
    for (let i = 0; i < 6; i++) {
      const home = {x: (i < 3 ? 0 : 50) + 5.2 + 6.6 * (i % 3), y: 47.8};
      this.robots.set(`XN${i + 1}`, this.robot(`XN${i + 1}`, 'RT', home, i < 3 ? 'A' : 'B'));
    }
    for (let i = 0; i < 4; i++) {
      const home = {x: 88 + i * 3, y: 7.0};
      this.robots.set(`CP${i + 1}`, this.robot(`CP${i + 1}`, 'CP', home));
    }

    for (let sku = 0; sku < 12; sku++) {
      const zone = sku % 2 ? 'B' : 'A';
      for (let j = 0; j < c.initialPerSKU; j++) {
        const aisle = (zone === 'A' ? 0 : 7) + (j % 7);
        const slot =
          this.slots.find(s => s.aisle === aisle && s.level === j % LAYOUT.levels && this.free(s.id)) ||
          this.slots.find(s => s.zone === zone && this.free(s.id));
        if (!slot) throw Error(`Vượt sức chứa kệ khi khởi tạo SKU ${sku}`);
        this.createPallet({sku, cartons: 60, kind: 'source', lot: `LOT-${sku}`, expiry: '2027-06-30'}, slot.id);
        this.initialBySKU[sku] += 60;
      }
    }

    this.nextOrder = 0;
    this.routeNextTruck = Array(c.outboundRoutes).fill(c.truckArrival);
    this.routeTrips = Array(c.outboundRoutes).fill(0);
    this.nextTruck = c.truckArrival;
    this.upcomingTruck = {id: 'TR1', state: 'NOT_ARRIVED', plannedArrival: c.truckArrival};
    this.receipts = [];
    this.inboundRemaining = c.inboundPallets;
    this.shiftBaseline = clone(this.metrics);
    this.log(`Khởi tạo V6.1: kệ 3 tầng (1.764 vị trí), 6 xe nâng (hỗ trợ chéo A⇄B), 4 robot, 12 dock xuất; ca ${this.phase}`);
  }

  robot(id, type, home, zone = null) {
    return {
      id, type, home, zone, x: home.x, y: home.y,
      battery: this.config.initialBattery, status: 'IDLE',
      task: null, trajectory: null, index: 0, returning: false, carried: null,
      work: 0, charging: 0, waiting: 0, faultSeconds: 0, distance: 0, crossZoneCount: 0
    };
  }

  log(message) { this.logs.push({time: this.time, message}); }

  free(id) {
    const l = this.locations.get(id);
    return !!l && !l.pallet && !l.reservation && !l.blocked;
  }

  createPallet(data, to) {
    if (!this.free(to)) throw Error('Không có ô ' + to);
    const p = {
      id: `PL${++this.serial}`,
      composition: data.sku == null ? [] : [{sku: data.sku, cartons: data.cartons}],
      ...data,
      location: to,
      job: null,
      lastUsed: this.time
    };
    p.weight = p.weight ?? 25 + p.cartons * 10;
    this.pallets.set(p.id, p);
    this.locations.get(to).pallet = p.id;
    return p;
  }

  at(id) { return this.pallets.get(this.locations.get(id)?.pallet); }

  move(p, to) {
    const old = this.locations.get(p.location);
    if (old) {
      if (old.pallet !== p.id) throw Error('Sai chủ sở hữu');
      old.pallet = null;
    }
    p.location = to;
    const l = this.locations.get(to);
    if (l) {
      if (l.pallet) throw Error('Chồng pallet');
      l.pallet = p.id;
    }
  }

  queue(p, to, type, label, extra = {}) {
    if (p.job || !this.free(to)) return null;
    const j = {
      id: `J${++this.serial}`, pallet: p.id, from: p.location, to,
      type, label, state: 'QUEUED', created: this.time, cleared: false, ...extra
    };
    p.job = j.id;
    this.locations.get(to).reservation = j.id;
    this.jobs.push(j);
    return j;
  }

  cpLane(p) {
    if (Math.abs(p.y - LAYOUT.cpFrontY) < 0.08) return LAYOUT.cpFrontY;
    if (Math.abs(p.y - LAYOUT.cpMidY) < 0.08) return LAYOUT.cpMidY;
    if (p.kind === 'inbound' || p.x < 26) return LAYOUT.cpMidY;
    if (p.kind === 'source' || p.kind === 'stage' || p.y > 9.5) return LAYOUT.cpMidY;
    if (p.kind === 'output' || p.y <= 4.2 || (p.x >= 87.5 && p.y <= 8.2)) return LAYOUT.cpFrontY;
    return Math.abs(p.y - LAYOUT.cpFrontY) <= Math.abs(p.y - LAYOUT.cpMidY) ? LAYOUT.cpFrontY : LAYOUT.cpMidY;
  }

  path(a, b, type) {
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) return [a];
    if (type === 'RT') {
      if (Math.abs(a.x - b.x) < 1e-6) return dedup([a, b]);
      // All cross-aisle and cross-zone A<->B movements traverse the 2-way front main axis y = 20.2 m.
      return dedup([a, {x: a.x, y: LAYOUT.frontY}, {x: b.x, y: LAYOUT.frontY}, b]);
    }
    const onCross = LAYOUT.cpCrossXs.find(cx => Math.abs(a.x - cx) < 0.08 && a.y > LAYOUT.cpFrontY && a.y < LAYOUT.cpMidY);
    const lb = this.cpLane(b);
    if (onCross != null) {
      return dedup([a, {x: onCross, y: lb}, {x: b.x, y: lb}, b]);
    }
    const la = this.cpLane(a);
    if (la === lb) return dedup([a, {x: a.x, y: la}, {x: b.x, y: lb}, b]);
    const cross = [...LAYOUT.cpCrossXs].sort((u, v) => (Math.abs(a.x - u) + Math.abs(b.x - u)) - (Math.abs(a.x - v) + Math.abs(b.x - v)))[0];
    return dedup([a, {x: a.x, y: la}, {x: cross, y: la}, {x: cross, y: lb}, {x: b.x, y: lb}, b]);
  }

  buildTrajectory(r, j, startPos = r.home) {
    const frames = [{x: startPos.x, y: startPos.y, action: 'wait'}];
    let cur = {x: startPos.x, y: startPos.y};
    const m = this.config.operationMultiplier;
    const stay = (sec, action, event) => {
      const steps = Math.ceil(sec * m);
      for (let i = 0; i < steps; i++) frames.push({...cur, action, event: i === steps - 1 ? event : null});
    };
    const walk = (points, loaded = false, reverse = false) => {
      for (const p of points.slice(1)) {
        const d = dist(cur, p);
        if (d < 1e-6) continue;
        const speed = j.truck?.id && (p.y < 0 || cur.y < 0)
          ? 0.25
          : r.type === 'RT'
            ? (loaded ? 0.65 : 0.9)
            : (loaded ? 0.8 : 1.0);
        const n = Math.max(1, Math.ceil(d / speed));
        const a = {...cur};
        for (let k = 1; k <= n; k++)
          frames.push({x: a.x + (p.x - a.x) * k / n, y: a.y + (p.y - a.y) * k / n, action: reverse ? 'reverse' : 'move'});
        cur = {x: p.x, y: p.y};
      }
    };

    if (j.charge) {
      const idx = Number(r.id.slice(2)) - 1;
      const port = {x: 87.5 + idx * 2, y: r.type === 'RT' ? 16.4 : 10.6};
      walk(this.path(cur, port, r.type));
      const cStart = frames.length;
      stay(this.config.chargeSeconds, 'charge', 'charged');
      const cEnd = frames.length;
      walk(this.path(cur, r.home, r.type));
      frames.at(-1).done = true;
      frames.chargeStart = cStart;
      frames.chargeEnd = cEnd;
      return frames;
    }

    const a = this.locations.get(j.from), b = this.locations.get(j.to);
    walk(this.path(cur, a, r.type), false);
    stay(30 + (a.height || 0) * 8, 'pick', 'pick');

    if (j.truck) {
      const dockX = j.truck.dockX;
      const entry = {x: dockX, y: 1.5};
      walk(this.path(cur, entry, 'CP'), true);
      walk([cur, {x: dockX, y: -1.0}, {x: dockX, y: b.y}], true);
      stay(25, 'drop', 'drop');
      walk([cur, {x: dockX, y: -1.0}, {x: dockX, y: 1.5}, {x: dockX, y: LAYOUT.cpFrontY}], false, true);
      frames.at(-1).clear = true;
      walk(this.path(cur, r.home, 'CP'), false);
    } else {
      walk(this.path(cur, b, r.type), true);
      stay(30 + (b.height || 0) * 8, 'drop', 'drop');
      const exitY = r.type === 'RT' ? LAYOUT.frontY : (b.kind === 'output' ? LAYOUT.cpFrontY : LAYOUT.cpMidY);
      walk([cur, {x: b.x, y: exitY}], false);
      frames.at(-1).clear = true;
      walk(this.path(cur, r.home, r.type), false);
    }
    frames.at(-1).done = true;
    return frames;
  }

  resourceKeys(j) {
    const keys = [];
    for (const id of [j.from, j.to]) {
      const l = this.locations.get(id);
      if (l?.kind === 'rack') keys.push(`aisle${l.aisle}`);
    }
    if (j.truck) keys.push(`dock_${j.truck.id}`);
    return [...new Set(keys)];
  }

  jobCells(j) {
    const cells = [];
    for (const id of [j.from, j.to]) {
      const l = this.locations.get(id);
      if (l?.cell != null) cells.push(l.cell);
    }
    return [...new Set(cells)];
  }

  canStart(r, j, traj, delay) {
    const keys = this.resourceKeys(j);
    const cells = this.jobCells(j);
    if (cells.some(c => this.cells[c].state === 'ASSEMBLING')) return false;
    const trajLen = traj.length, totalLen = trajLen + delay;
    const cStart = traj.chargeStart ?? -1, cEnd = traj.chargeEnd ?? -1;
    for (const q of this.robots.values()) {
      if (q === r) continue;
      const qt = q.trajectory, qi = q.index;
      if (q.task && keys.some(k => q.task.resources?.includes(k))) return false;
      const qIdlePos = {x: q.x, y: q.y};
      const qtLen = qt ? qt.length : 0;
      const qcStart = qt?.chargeStart ?? -1, qcEnd = qt?.chargeEnd ?? -1;
      for (let t = 0; t < totalLen; t++) {
        const ti0 = t < delay ? 0 : (t - delay < trajLen ? t - delay : trajLen - 1);
        const ti1 = t + 1 < delay ? 0 : (t + 1 - delay < trajLen ? t + 1 - delay : trajLen - 1);
        const a = traj[ti0], b = traj[ti1];
        const qi0 = qt ? (qi + t < qtLen ? qi + t : qtLen - 1) : -1;
        const qi1 = qt ? (qi + t + 1 < qtLen ? qi + t + 1 : qtLen - 1) : -1;
        const c = qt ? qt[qi0] : qIdlePos;
        const d = qt ? qt[qi1] : qIdlePos;
        const minAX = a.x < b.x ? a.x : b.x, maxAX = a.x > b.x ? a.x : b.x;
        const minCX = c.x < d.x ? c.x : d.x, maxCX = c.x > d.x ? c.x : d.x;
        if (maxAX + 1.45 > minCX && maxCX + 1.45 > minAX) {
          const minAY = a.y < b.y ? a.y : b.y, maxAY = a.y > b.y ? a.y : b.y;
          const minCY = c.y < d.y ? c.y : d.y, maxCY = c.y > d.y ? c.y : d.y;
          if (maxAY + 1.45 > minCY && maxCY + 1.45 > minAY) {
            if (separation(a, b, c, d) < 1.45) return false;
          }
        }
        if (cEnd > 0 && ti0 >= cStart && ti1 < cEnd) {
          if (!qt || qi0 >= qtLen - 1) {
            t = delay + cEnd - 2;
          } else if (qcEnd > 0 && qi0 >= qcStart && qi1 < qcEnd) {
            const jump = Math.min(delay + cEnd - 2, qcEnd - 2 - qi);
            if (jump > t) t = jump;
          }
        }
      }
    }
    return true;
  }

  start(r, j) {
    if (!j.charge && r.battery < 25) return false;
    if (r.task && !r.returning) return false;
    const fromCurrent = r.returning;
    let traj, delay = 0;
    if (fromCurrent) {
      traj = this.buildTrajectory(r, j, {x: r.x, y: r.y});
      if (!this.canStart(r, j, traj, 0)) return false;
      const prevJob = r.task;
      prevJob.state = 'DONE';
      prevJob.ended = this.time;
      r.returning = false;
    } else if (j.charge) {
      r.homeChargeTraj ??= this.buildTrajectory(r, j, r.home);
      traj = r.homeChargeTraj;
      for (; delay <= 300; delay += 20) if (this.canStart(r, j, traj, delay)) break;
      if (delay > 300) return false;
    } else {
      j.trajectoryCache ??= new Map();
      traj = j.trajectoryCache.get(r.id) || this.buildTrajectory(r, j, r.home);
      j.trajectoryCache.set(r.id, traj);
      for (; delay <= 300; delay += 20) if (this.canStart(r, j, traj, delay)) break;
      if (delay > 300) return false;
    }

    const jobZone = r.type === 'RT' ? (this.slotMap.get(j.from) || this.slotMap.get(j.to))?.zone : null;
    if (r.type === 'RT' && jobZone && r.zone !== jobZone) {
      j.crossZone = true;
      r.crossZoneCount++;
      this.metrics.crossZoneTrips++;
    }
    j.resources = this.resourceKeys(j);
    j.activeCells = this.jobCells(j);
    j.state = 'RUNNING';
    j.robot = r.id;
    j.started = this.time;
    r.task = j;
    r.trajectory = delay ? [...Array.from({length: delay}, () => ({x: r.home.x, y: r.home.y, action: 'wait'})), ...traj] : traj;
    r.index = 0;
    r.status = 'RUNNING';
    this.log(`${r.id}${j.crossZone ? ' [hỗ trợ chéo]' : ''}: ${j.label} ${j.pallet || ''}`);
    return true;
  }

  estimatedArrival(r, j) {
    const a = this.locations.get(j.from);
    if (!r.task || r.returning) {
      const pts = this.path({x: r.x, y: r.y}, a, r.type);
      return sum(pts.slice(1).map((p, i) => dist(pts[i], p))) / (r.type === 'RT' ? 0.9 : 1.0);
    }
    const clearIdx = r.trajectory ? r.trajectory.findIndex((f, idx) => idx >= r.index && f.clear) : -1;
    const rem = clearIdx >= 0 ? clearIdx - r.index : (r.trajectory ? r.trajectory.length - r.index : 0);
    const startPt = clearIdx >= 0 ? r.trajectory[clearIdx] : r.home;
    const pts = this.path(startPt, a, r.type);
    return rem + sum(pts.slice(1).map((p, i) => dist(pts[i], p))) / (r.type === 'RT' ? 0.9 : 1.0);
  }

  dispatch() {
    const queuedJobs = this.jobs
      .filter(j => j.state === 'QUEUED')
      .sort((a, b) =>
        ((b.urgency || 0) + Math.floor((this.time - b.created) / 600)) -
        ((a.urgency || 0) + Math.floor((this.time - a.created) / 600)) ||
        a.created - b.created
      );

    const rtQueuedByZone = {A: 0, B: 0};
    for (const j of queuedJobs) {
      if (j.type === 'RT') {
        const z = (this.slotMap.get(j.from) || this.slotMap.get(j.to))?.zone;
        if (z) rtQueuedByZone[z]++;
      }
    }

    for (const j of queuedJobs) {
      const jobZone = j.type === 'RT' ? (this.slotMap.get(j.from) || this.slotMap.get(j.to))?.zone : null;
      let pool = [...this.robots.values()].filter(r => r.type === j.type && r.status !== 'FAULT' && r.zone === jobZone);

      // Soft cross-zone A<->B support: allow helper RT from opposite zone when native RTs are all actively busy
      // or target zone has a backlog while helper zone queue is empty.
      if (j.type === 'RT' && this.config.crossZone) {
        const nativeFree = pool.some(r => (!r.task || r.returning) && r.battery >= 25);
        const otherZone = jobZone === 'A' ? 'B' : 'A';
        if (!nativeFree || (rtQueuedByZone[jobZone] >= 2 && rtQueuedByZone[otherZone] === 0)) {
          const helpers = [...this.robots.values()].filter(
            r => r.type === 'RT' && r.status !== 'FAULT' && r.zone === otherZone && (!r.task || r.returning) && r.battery >= 25
          );
          pool = [...pool, ...helpers];
        }
      }

      pool.sort((a, b) => {
        if (j.type === 'RT' && a.zone !== b.zone) return (a.zone === jobZone ? -1 : 1);
        return a.work - b.work;
      });

      if (j.label === 'Trả nguồn') {
        const choices = pool
          .filter(r => !r.task || r.returning || r.task.label === 'Cấp nguồn')
          .map(r => ({id: r.id, eta: this.estimatedArrival(r, j) + (r.zone === jobZone ? 0 : 35)}))
          .sort((a, b) => a.eta - b.eta);
        j.lastCandidates = choices;
        j.etaChoice = choices[0]?.id;
        const best = choices[0] ? this.robots.get(choices[0].id) : null;
        if (best && best.task && !best.returning && this.time - j.created < 300) continue;
        pool.sort((a, b) =>
          (this.estimatedArrival(a, j) + (a.zone === jobZone ? 0 : 35)) -
          (this.estimatedArrival(b, j) + (b.zone === jobZone ? 0 : 35))
        );
      }

      // Soft 2-2 CP priority: CP1-CP2 prioritize internal cell clearing; CP3-CP4 prioritize truck loading; idle CPs assist across streams.
      if (j.type === 'CP') {
        pool.sort((a, b) => {
          const pref = r => (j.truck ? Number(r.id.slice(2)) > 2 : Number(r.id.slice(2)) <= 2);
          return Number(pref(b)) - Number(pref(a)) || this.estimatedArrival(a, j) - this.estimatedArrival(b, j);
        });
      }

      for (const r of pool) {
        if ((r.task && !r.returning) || r.battery < 25) continue;
        if (this.start(r, j)) {
          if (j.type === 'RT' && jobZone) rtQueuedByZone[jobZone] = Math.max(0, rtQueuedByZone[jobZone] - 1);
          break;
        }
      }
    }

    for (const r of this.robots.values()) {
      if ((!r.task || r.returning) && r.status !== 'FAULT' && r.battery < 25) {
        if ([...this.robots.values()].filter(x => x.task?.charge).length >= this.config.maxCharging) break;
        this.start(r, {id: `CH${++this.serial}`, charge: true, label: 'Sạc', type: r.type});
      }
    }
  }

  advanceMotion() {
    if ([...this.robots.values()].some(r => r.status === 'FAULT')) {
      this.metrics.globalSafetyHold++;
      for (const r of this.robots.values()) r.status === 'FAULT' ? r.faultSeconds++ : r.waiting++;
      return;
    }
    this.motionTime++;
    for (const r of this.robots.values()) {
      if (!r.task) { r.waiting++; continue; }
      const prev = {x: r.x, y: r.y}, f = r.trajectory[++r.index];
      if (!f) throw Error('Trajectory overrun');
      r.x = f.x;
      r.y = f.y;
      r.distance += dist(prev, f);
      if (f.action === 'wait') r.waiting++;
      else if (f.action === 'charge') { r.charging++; r.status = 'CHARGING'; }
      else {
        r.work++;
        r.battery = Math.max(0, r.battery - 100 / this.config.batteryWorkSeconds);
        r.status = 'RUNNING';
      }
      const j = r.task;
      if (f.event === 'charged') r.battery = 100;
      if (f.event === 'pick') {
        const p = this.pallets.get(j.pallet);
        if (p.location !== j.from || r.carried) throw Error('Pick ownership');
        this.move(p, r.id);
        r.carried = p.id;
        if (j.from.startsWith('OUT')) {
          const cell = this.cells[Number(j.from.slice(3))];
          cell.state = 'EMPTY';
          cell.order = null;
        }
      }
      if (f.event === 'drop') {
        const p = this.pallets.get(j.pallet), l = this.locations.get(j.to);
        if (l.reservation !== j.id || r.carried !== p.id) throw Error('Drop reservation');
        this.move(p, j.to);
        l.reservation = null;
        r.carried = null;
        p.job = null;
        j.delivered = this.time;
        if (j.label === 'Cất kệ') this.metrics.stored++;
        if (j.label === 'Trả nguồn') this.metrics.returned++;
        if (j.label === 'Cấp nguồn') p.lastUsed = this.time;
        if (j.truck) {
          this.metrics.loaded++;
          j.truck.pallets.push(p.id);
          j.truck.weight += p.weight;
          j.truck.state = 'LOADING';
          const ord = this.orders.find(o => o.id === p.order);
          if (ord) ord.state = 'LOADED';
        }
      }
      if (f.clear) {
        j.cleared = true;
        j.resources = [];
        j.activeCells = [];
        r.returning = true;
      }
      if (r.index === r.trajectory.length - 1) {
        j.state = 'DONE';
        j.ended = this.time;
        r.task = null;
        r.trajectory = null;
        r.index = 0;
        r.returning = false;
        r.status = 'IDLE';
      }
    }
  }

  faultRobot(id) {
    const r = this.robots.get(id);
    if (!r || r.status === 'FAULT') return false;
    r.status = 'FAULT';
    this.log(`${id} lỗi; dừng điều phối chuyển động chung, giữ mọi vị trí và lịch đặt chỗ`);
    return true;
  }

  recoverRobot(id) {
    const r = this.robots.get(id);
    if (r?.status !== 'FAULT') return false;
    r.status = r.task ? 'RUNNING' : 'IDLE';
    this.log(`${id} phục hồi đúng bước`);
    return true;
  }

  // Sequential single-truck unloading at active inbound dock; up to inboundLanes (2) worker teams standardize pallets into IN0-IN3.
  receive() {
    if (this.phase !== 'INBOUND') return;
    while (this.receipts.length < this.config.inboundLanes && this.inboundRemaining - this.receipts.length > 0) {
      let truck = this.inboundTrucks.at(-1);
      if (!truck || (truck.remaining === 0 && !this.receipts.some(rc => rc.truck === truck.id))) {
        if (truck && truck.remaining === 0 && truck.state !== 'DONE') {
          truck.state = 'DONE';
          truck.ended = this.time;
        }
        const pending = this.inboundRemaining - this.receipts.length;
        if (pending <= 0) break;
        const bay = this.inboundTrucks.length % LAYOUT.inboundDockXs.length;
        truck = {
          id: `INTR${this.inboundTrucks.length + 1}`,
          bay,
          dockX: LAYOUT.inboundDockXs[bay],
          remaining: Math.min(this.config.inboundTruckSize, pending),
          dispatched: 0,
          state: 'UNLOADING',
          arrived: this.time
        };
        this.inboundTrucks.push(truck);
      }
      if (truck.dispatched >= truck.remaining) break;
      const id = [0, 1, 2, 3].map(i => `IN${i}`).find(x => this.free(x));
      if (!id) {
        this.metrics.blockedReceipt++;
        break;
      }
      this.locations.get(id).reservation = 'MANUAL';
      const seqIndex = this.config.inboundPallets - this.inboundRemaining + this.receipts.length;
      truck.dispatched++;
      this.receipts.push({
        to: id,
        remaining: Math.ceil(this.config.receiptSeconds * this.config.operationMultiplier),
        truck: truck.id,
        sku: seqIndex % 12
      });
    }
  }

  processReceipt() {
    for (let i = this.receipts.length - 1; i >= 0; i--) {
      const q = this.receipts[i];
      if (--q.remaining > 0) continue;
      this.locations.get(q.to).reservation = null;
      this.createPallet(
        {sku: q.sku, cartons: 60, kind: 'source', accepted: true, lot: `IN-${q.truck}`, expiry: '2027-08-31'},
        q.to
      );
      this.receivedBySKU[q.sku] += 60;
      this.metrics.received++;
      this.inboundRemaining--;
      const t = this.inboundTrucks.find(t => t.id === q.truck);
      t.remaining--;
      t.dispatched--;
      if (t.remaining === 0) {
        t.state = 'DONE';
        t.ended = this.time;
      }
      this.receipts.splice(i, 1);
    }
  }

  routeInbound() {
    for (const id of ['IN0', 'IN1', 'IN2', 'IN3']) {
      const p = this.at(id);
      if (p && !p.job && p.accepted) {
        const to = Array.from({length: 20}, (_, i) => `SRC${i}`).find(s => this.free(s));
        if (to) this.queue(p, to, 'CP', 'Nhập trung gian', {urgency: 1});
      }
    }
    if (this.phase === 'INBOUND' || (this.phase === 'TRANSITION' && this.previousPhase === 'INBOUND')) {
      for (let i = 0; i < 20; i++) {
        const p = this.at(`SRC${i}`);
        if (!p || p.job) continue;
        const prefZone = p.sku % 2 ? 'B' : 'A';
        const to = this.slots.find(s => s.zone === prefZone && this.free(s.id)) || this.slots.find(s => this.free(s.id));
        if (to) this.queue(p, to.id, 'RT', 'Cất kệ', {urgency: 1});
      }
    }
  }

  addOrders() {
    if (this.phase !== 'OUTBOUND') return;
    const elapsed = this.time - this.phaseStart;
    while (elapsed < this.config.outboundSeconds && elapsed >= this.nextOrder && this.orders.length < this.config.orderLimit) {
      const k = this.orders.length;
      const pair = k < this.config.initialWaveOrders ? (k % 6) : (Math.floor((k - this.config.initialWaveOrders) / 3) % 6);
      const route = pair % this.config.outboundRoutes;
      this.orders.push({
        id: `O${k + 1}`,
        pair: [pair * 2, pair * 2 + 1],
        route,
        kind: k % 10 === 9 ? 'whole' : 'mixed',
        state: 'QUEUED',
        priority: 1,
        created: this.time,
        due: this.time + 3600
      });
      if (this.orders.length >= this.config.initialWaveOrders) {
        this.nextOrder += this.config.orderInterval;
      }
    }
  }

  rankOrders() {
    const srcPallets = [];
    for (let i = 0; i < 20; i++) {
      const p = this.at(`SRC${i}`);
      if (p && p.cartons >= 15) srcPallets.push(p);
    }
    return this.orders
      .filter(o => o.state === 'QUEUED')
      .sort((a, b) => {
        const age = o => Math.max(0, Math.floor((this.time - o.created) / 1800));
        const prio = o => o.priority + age(o);
        const reuse = o => srcPallets.filter(p => o.pair.includes(p.sku)).reduce((n, p) => n + (p.cartons === 15 ? 2 : 1), 0);
        return prio(b) - prio(a) || Math.floor(a.due / 900) - Math.floor(b.due / 900) || reuse(b) - reuse(a) || a.created - b.created;
      });
  }

  sourceFor(sku) {
    return [...this.pallets.values()]
      .filter(p => p.sku === sku && p.cartons >= 15 && this.slotMap.has(p.location) && !p.job)
      .sort((a, b) => a.expiry.localeCompare(b.expiry) || a.cartons - b.cartons)[0];
  }

  planOutbound(acceptNew = true) {
    let emptyCells = this.cells.filter(c => c.state === 'EMPTY').length;
    let freeStages = Array.from({length: 12}, (_, i) => `ST${i}`).filter(x => this.free(x)).length;
    for (const o of acceptNew && (emptyCells > 0 || freeStages > 0) ? this.rankOrders() : []) {
      if (emptyCells === 0 && freeStages === 0) break;
      if (o.kind === 'whole') {
        if (freeStages === 0) continue;
        const p = [...this.pallets.values()].find(p => p.sku === o.pair[0] && p.cartons === 60 && this.slotMap.has(p.location) && !p.job);
        const dest = Array.from({length: 12}, (_, i) => `ST${i}`).find(x => this.free(x));
        if (p && dest) {
          p.order = o.id;
          o.state = 'ACTIVE';
          if (this.queue(p, dest, 'RT', 'Xuất nguyên pallet', {urgency: 2})) freeStages--;
        }
        continue;
      }
      if (emptyCells === 0) continue;
      let cell = this.cells.find(
        c => c.state === 'EMPTY' && [0, 1].every(i => this.at(`SRC${c.id * 2 + i}`)?.sku === o.pair[i] && this.at(`SRC${c.id * 2 + i}`).cartons >= 15)
      );
      cell ??= this.cells.find(
        c => c.state === 'EMPTY' && [0, 1].every(i => this.free(`SRC${c.id * 2 + i}`)) && o.pair.every(s => !!this.sourceFor(s))
      );
      if (!cell) continue;
      cell.state = 'PREPARING';
      cell.order = o.id;
      o.state = 'ACTIVE';
      emptyCells--;
    }
    for (const c of this.cells) {
      if (c.state !== 'PREPARING') continue;
      const o = this.orders.find(x => x.id === c.order);
      for (let i = 0; i < 2; i++) {
        const to = `SRC${2 * c.id + i}`;
        if (this.free(to)) {
          const p = this.sourceFor(o.pair[i]);
          if (p) this.queue(p, to, 'RT', 'Cấp nguồn', {urgency: 1});
        }
      }
    }
  }

  processAssembly() {
    let active = this.cells.filter(c => c.state === 'ASSEMBLING').length;
    for (const c of this.cells) {
      const ids = [`SRC${2 * c.id}`, `SRC${2 * c.id + 1}`], ps = ids.map(id => this.at(id));
      if (
        c.state === 'PREPARING' &&
        active < 4 &&
        ps.every(p => p && p.cartons >= 15 && !p.job) &&
        this.free(`OUT${c.id}`) &&
        ![...this.robots.values()].some(r => r.task?.activeCells?.includes(c.id))
      ) {
        c.state = 'ASSEMBLING';
        c.remaining = Math.ceil(this.config.assemblySeconds * this.config.operationMultiplier);
        c.team = [0, 1, 2, 3].find(i => !this.cells.some(x => x.team === i));
        this.locations.get(`OUT${c.id}`).reservation = `ASSEMBLY${c.id}`;
        active++;
      }
      if (c.state === 'ASSEMBLING' && --c.remaining <= 0) {
        const o = this.orders.find(x => x.id === c.order);
        if (ps.some((p, i) => p.sku !== o.pair[i] || p.cartons < 15)) throw Error('Nguồn ghép sai mã hoặc thiếu kiện');
        for (const p of ps) {
          p.cartons -= 15;
          p.composition[0].cartons -= 15;
          p.weight = 25 + 10 * p.cartons;
          p.lastUsed = this.time;
        }
        this.locations.get(`OUT${c.id}`).reservation = null;
        this.createPallet(
          {kind: 'finished', sku: null, cartons: 30, composition: o.pair.map(sku => ({sku, cartons: 15})), order: o.id, route: o.route, checked: true},
          `OUT${c.id}`
        );
        this.metrics.assembled++;
        c.state = 'COMPLETE';
        c.team = null;
        o.state = 'PREPARED';
        active--;
      }
    }
    this.metrics.maxAssembly = Math.max(this.metrics.maxAssembly, this.cells.filter(c => c.state === 'ASSEMBLING').length);
  }

  returnSources(force = false) {
    for (let i = 0; i < 20; i++) {
      const p = this.at(`SRC${i}`);
      if (!p || p.job) continue;
      const c = this.cells[Math.floor(i / 2)];
      if (['ASSEMBLING', 'PREPARING'].includes(c.state)) continue;
      if (!p.cartons) {
        if (!p.emptySince) p.emptySince = this.time;
        if (this.time - p.emptySince >= 120) {
          this.move(p, 'EMPTY_RETURNED');
          this.metrics.emptyCollected++;
        }
        continue;
      }
      const demand = this.orders.some(o => o.state === 'QUEUED' && o.pair.includes(p.sku));
      const pressure = this.cells.every(cell => cell.state !== 'EMPTY' || [0, 1].some(k => !this.free(`SRC${cell.id * 2 + k}`)));
      if (force || (!demand && (pressure || this.time - (p.lastUsed ?? 0) > 1800))) {
        const prefZone = p.sku % 2 ? 'B' : 'A';
        const slot = this.slots.find(s => s.zone === prefZone && this.free(s.id)) || this.slots.find(s => this.free(s.id));
        if (slot) this.queue(p, slot.id, 'RT', 'Trả nguồn', {urgency: force ? 3 : 0});
      }
    }
  }

  activeTrucks() {
    return this.trucks.filter(t => t.state !== 'DEPARTED' && t.state !== 'NOT_ARRIVED');
  }

  currentTruck() {
    const active = this.activeTrucks();
    return active.find(t => t.state === 'LOADING') || active.find(t => t.state === 'READY') || active[0] || null;
  }

  processTrucks() {
    const canDockPhase = this.phase === 'OUTBOUND' || (this.phase === 'TRANSITION' && this.previousPhase === 'OUTBOUND');
    if (canDockPhase) {
      const occupiedBays = new Set(this.activeTrucks().map(t => t.bay));
      for (let route = 0; route < this.config.outboundRoutes; route++) {
        const hasActiveForRoute = this.activeTrucks().some(t => t.route === route);
        if (!hasActiveForRoute && this.time >= this.routeNextTruck[route] && occupiedBays.size < LAYOUT.outboundDockXs.length) {
          const prefBay = (route + (this.routeTrips[route] % 2) * 6) % LAYOUT.outboundDockXs.length;
          let bay = !occupiedBays.has(prefBay)
            ? prefBay
            : Array.from({length: LAYOUT.outboundDockXs.length}, (_, b) => b).find(b => !occupiedBays.has(b));
          if (bay == null) break;
          occupiedBays.add(bay);
          this.routeTrips[route]++;
          const id = `TR${this.trucks.length + 1}`;
          const dockX = LAYOUT.outboundDockXs[bay];
          const t = {
            id,
            route,
            bay,
            dockX,
            dockCode: `DX${bay + 1}`,
            state: 'DOCKING',
            arrived: this.time,
            readyAt: this.time + 60,
            deadline: this.time + this.config.truckDeadline,
            pallets: [],
            weight: 0,
            payload: this.config.truckPayload,
            history: [['NOT_ARRIVED', this.routeNextTruck[route]], ['DOCKING', this.time]]
          };
          this.trucks.push(t);
          for (let i = 0; i < 4; i++) {
            this.locations.set(`${t.id}_${i}`, {
              id: `${t.id}_${i}`,
              x: dockX,
              y: -5.6 + i * 1.3,
              kind: 'truck',
              truck: t.id,
              index: i,
              pallet: null,
              reservation: null
            });
          }
        }
      }
    }

    for (const t of this.activeTrucks()) {
      if (t.state === 'DOCKING' && this.time >= t.readyAt) {
        t.state = 'READY';
        t.history.push(['READY', this.time]);
      }
      const busy = this.jobs.some(j => j.truck === t && j.state !== 'DONE' && !j.cleared);
      const n = t.pallets.length;
      if (!busy && n && (n === 4 || this.time >= t.deadline || this.phase === 'TRANSITION')) {
        t.state = 'COMPLETE';
        t.history.push(['COMPLETE', this.time]);
        t.state = 'DEPARTED';
        t.departed = this.time;
        t.history.push(['DEPARTED', this.time]);
        for (const id of t.pallets) {
          const p = this.pallets.get(id);
          this.move(p, 'SHIPPED');
          for (const x of p.composition) this.shippedBySKU[x.sku] += x.cartons;
          this.metrics.departed++;
          const o = this.orders.find(o => o.id === p.order);
          if (o) o.state = 'SHIPPED';
        }
        t.cartons = sum(t.pallets.map(id => this.pallets.get(id).cartons));
        this.routeNextTruck[t.route] = this.time + this.config.truckTurnSeconds;
        this.log(`${t.id} (${t.dockCode}) rời kho: ${n} pallet, ${t.cartons} kiện`);
      }
    }

    this.nextTruck = Math.min(...this.routeNextTruck);
    this.upcomingTruck = this.activeTrucks().length < this.config.outboundRoutes
      ? {id: `TR${this.trucks.length + 1}`, state: 'NOT_ARRIVED', plannedArrival: this.nextTruck}
      : null;
    this.metrics.maxActiveDocks = Math.max(this.metrics.maxActiveDocks, this.activeTrucks().length);
  }

  reserveTruck(p) {
    const ord = p.order ? this.orders.find(o => o.id === p.order) : null;
    const targetRoute = ord?.route ?? p.route ?? null;
    const candidates = this.activeTrucks()
      .filter(t =>
        ['READY', 'LOADING'].includes(t.state) &&
        (targetRoute == null || t.route === targetRoute) &&
        t.pallets.length < 4 &&
        t.weight + p.weight <= t.payload &&
        !this.jobs.some(j => j.truck === t && j.state !== 'DONE' && !j.cleared)
      )
      .sort((a, b) => b.pallets.length - a.pallets.length || a.arrived - b.arrived);

    for (const t of candidates) {
      const to = `${t.id}_${t.pallets.length}`;
      if (this.free(to)) return {t, to};
    }
    return null;
  }

  routeOutbound() {
    const outStagingIds = [...Array.from({length: 10}, (_, i) => `OUT${i}`), ...Array.from({length: 12}, (_, i) => `ST${i}`)];
    const ps = outStagingIds
      .map(id => this.at(id))
      .filter(p => p && !p.job && p.order && (p.kind !== 'finished' || p.checked))
      .sort((a, b) => {
        const oa = this.orders.find(o => o.id === a.order), ob = this.orders.find(o => o.id === b.order);
        return oa.due - ob.due || oa.created - ob.created;
      });

    for (const p of ps) {
      const fromOutput = p.location.startsWith('OUT');
      const dest = (!fromOutput || this.config.direct) && this.reserveTruck(p);
      if (dest) {
        const j = this.queue(p, dest.to, 'CP', fromOutput ? 'Ghép lên xe' : 'Chờ xuất lên xe', {
          truck: dest.t,
          urgency: this.time >= dest.t.deadline - 300 ? 5 : 2
        });
        if (j) {
          if (dest.t.pallets.length === 0 && dest.t.state === 'READY') dest.t.deadline = Math.max(dest.t.deadline, this.time + this.config.truckDeadline);
          dest.t.state = 'LOADING';
          dest.t.history.push(['LOADING', this.time]);
          fromOutput ? this.metrics.direct++ : this.metrics.viaStage++;
        }
      } else if (fromOutput) {
        const to = Array.from({length: 12}, (_, i) => `ST${i}`).find(x => this.free(x));
        if (to) this.queue(p, to, 'CP', 'Giải phóng ô ghép', {urgency: 3});
      }
    }
  }

  requestTransition() {
    if (this.phase === 'TRANSITION' || this.phase === 'STOPPED') return;
    this.previousPhase = this.phase;
    this.phase = 'TRANSITION';
    this.transitionStart = this.time;
    this.shiftResults.push({
      phase: this.previousPhase,
      start: this.phaseStart,
      end: this.time,
      metrics: Object.fromEntries(Object.keys(this.metrics).map(k => [k, this.metrics[k] - this.shiftBaseline[k]])),
      inventory: this.inventory()
    });
    this.log('Bắt đầu chuyển ca; giữ hàng và công việc dở');
  }

  processTransition() {
    if (this.phase !== 'TRANSITION') return;
    for (const c of this.cells) {
      if (c.state !== 'PREPARING') continue;
      const o = this.orders.find(o => o.id === c.order);
      if (
        o &&
        o.pair.some((sku, i) => !this.at(`SRC${c.id * 2 + i}`) && !this.locations.get(`SRC${c.id * 2 + i}`).reservation && !this.sourceFor(sku)) &&
        !this.jobs.some(j => j.state !== 'DONE' && [j.from, j.to].some(id => this.locations.get(id)?.cell === c.id))
      ) {
        o.state = 'QUEUED';
        c.state = 'EMPTY';
        c.order = null;
        this.log('Hoãn đơn thiếu tồn sang ca sau: ' + o.id);
      }
    }
    const busy =
      this.jobs.some(j => j.state !== 'DONE') ||
      this.receipts.length > 0 ||
      this.cells.some(c => c.state !== 'EMPTY') ||
      [...this.locations.values()].some(l => ['source', 'inbound', 'stage'].includes(l.kind) && (l.pallet || l.reservation)) ||
      this.activeTrucks().some(t => t.pallets.length > 0);
    if (busy) return;

    // Close empty docked trucks cleanly at shift boundary before switching phase.
    for (const t of this.activeTrucks()) {
      t.state = 'DEPARTED';
      t.departed = this.time;
      t.closedEmpty = true;
    }

    this.transitions.push({
      from: this.previousPhase,
      start: this.transitionStart,
      end: this.time,
      seconds: this.time - this.transitionStart,
      metrics: clone(this.metrics)
    });
    if (!this.config.autoCycle) {
      this.phase = 'STOPPED';
      return;
    }
    this.phase = this.previousPhase === 'INBOUND' ? 'OUTBOUND' : 'INBOUND';
    this.phaseStart = this.time;
    this.phaseIndex++;
    this.shiftBaseline = clone(this.metrics);
    this.nextOrder = 0;
    if (this.phase === 'OUTBOUND') {
      this.routeNextTruck = Array(this.config.outboundRoutes).fill(this.time + this.config.truckArrival);
    }
    if (this.phase === 'INBOUND') this.inboundRemaining = this.config.inboundPallets;
    this.log('Mở ca ' + this.phase);
  }

  step(seconds = 1) {
    for (let s = 0; s < seconds; s++) {
      this.time++;
      this.advanceMotion();
      this.processReceipt();
      this.receive();
      if (this.phase === 'INBOUND' || (this.phase === 'TRANSITION' && this.previousPhase === 'INBOUND')) this.routeInbound();
      if (this.phase === 'OUTBOUND') {
        this.addOrders();
        this.planOutbound();
      } else if (this.phase === 'TRANSITION' && this.previousPhase === 'OUTBOUND') {
        this.planOutbound(false);
      }
      if (this.phase === 'OUTBOUND' || (this.phase === 'TRANSITION' && this.previousPhase === 'OUTBOUND')) {
        this.processAssembly();
        this.returnSources(this.phase === 'TRANSITION');
        this.processTrucks();
        this.routeOutbound();
      }
      if (this.time % 10 === 0 && ![...this.robots.values()].some(r => r.status === 'FAULT')) this.dispatch();
      this.processTransition();
      for (const [kind, key] of [['inbound', 'maxInbound'], ['source', 'maxSource'], ['stage', 'maxStage']])
        this.metrics[key] = Math.max(this.metrics[key], [...this.locations.values()].filter(l => l.kind === kind && (l.pallet || l.reservation)).length);
      this.metrics.maxRT = Math.max(
        this.metrics.maxRT,
        [...this.robots.values()].filter(r => r.type === 'RT' && r.task && r.status !== 'FAULT' && r.trajectory?.[r.index]?.action !== 'wait').length
      );
      if (['INBOUND', 'OUTBOUND'].includes(this.phase) && this.time - this.phaseStart >= (this.phase === 'INBOUND' ? this.config.inboundSeconds : this.config.outboundSeconds))
        this.requestTransition();
      if (this.time % 30 === 0) this.assertInvariants();
    }
    return this.snapshot();
  }

  inventory() {
    const out = Array(12).fill(0);
    for (const p of this.pallets.values())
      if (p.location !== 'SHIPPED')
        for (const x of p.composition) out[x.sku] += x.cartons;
    return out;
  }

  assertInvariants() {
    const inv = this.inventory();
    for (let i = 0; i < 12; i++)
      if (inv[i] + this.shippedBySKU[i] !== this.initialBySKU[i] + this.receivedBySKU[i])
        throw Error(`Bảo toàn SKU ${i}`);
    const seen = new Set();
    for (const l of this.locations.values()) {
      if (l.pallet) {
        if (seen.has(l.pallet) || this.pallets.get(l.pallet)?.location !== l.id) throw Error('Sở hữu ô');
        seen.add(l.pallet);
      }
      if (l.pallet && l.reservation) throw Error('Vượt sức chứa ' + l.id);
    }
    for (const r of this.robots.values()) {
      if (r.carried) {
        if (seen.has(r.carried) || this.pallets.get(r.carried)?.location !== r.id) throw Error('Sở hữu xe');
        seen.add(r.carried);
      }
    }
    for (const p of this.pallets.values()) {
      if (!['SHIPPED', 'EMPTY_RETURNED'].includes(p.location) && !seen.has(p.id)) throw Error('Pallet không chủ');
      if (p.cartons < 0 || sum(p.composition.map(x => x.cartons)) !== p.cartons) throw Error('Số kiện');
    }
    if ([...this.robots.values()].filter(r => r.task?.charge).length > this.config.maxCharging) throw Error('Vượt giới hạn sạc');
    for (const j of this.jobs) {
      if (j.type === 'RT' && j.robot) {
        const z = (this.slotMap.get(j.from) || this.slotMap.get(j.to))?.zone;
        if (this.robots.get(j.robot).zone !== z && (!this.config.crossZone || !j.crossZone))
          throw Error('Xe nâng sai vùng khi chưa bật hỗ trợ chéo');
      }
    }
    const rs = [...this.robots.values()];
    for (let i = 0; i < rs.length; i++)
      for (let j = i + 1; j < rs.length; j++)
        if (dist(rs[i], rs[j]) < 1.45 - 1e-7) throw Error('Xung đột xe ' + rs[i].id + ' ' + rs[j].id);
    if (this.cells.filter(c => c.state === 'ASSEMBLING').length > 4) throw Error('Quá đội ghép');
    const activeInbound = this.inboundTrucks.filter(t => t.state === 'UNLOADING');
    if (activeInbound.length > 1) throw Error('Quá một xe nhập dỡ đồng thời');
    for (const t of this.trucks) {
      if (t.pallets.length > 4 || t.weight > t.payload) throw Error('Quá tải xe');
      if (t.state === 'DEPARTED' && !t.closedEmpty && this.jobs.some(j => j.truck === t && j.state !== 'DONE' && !j.cleared))
        throw Error('Xe rời khi robot chưa ra khỏi thùng');
    }
    this.metrics.checks++;
    return true;
  }

  snapshot() {
    const shippedTrips = this.trucks.filter(t => t.state === 'DEPARTED' && !t.closedEmpty);
    const activeDocks = this.activeTrucks();
    return {
      time: this.time,
      phase: this.phase,
      upcomingTruck: this.upcomingTruck ? {...this.upcomingTruck} : null,
      metrics: clone(this.metrics),
      inventory: this.inventory(),
      initial: [...this.initialBySKU],
      received: [...this.receivedBySKU],
      shipped: [...this.shippedBySKU],
      queuedOrders: this.orders.filter(o => o.state === 'QUEUED').length,
      unfinishedJobs: this.jobs.filter(j => j.state !== 'DONE').length,
      occupancy: Object.fromEntries(
        ['inbound', 'source', 'output', 'stage', 'rack'].map(k => [
          k,
          [...this.locations.values()].filter(l => l.kind === k && l.pallet).length
        ])
      ),
      activeDocks: activeDocks.map(t => ({
        id: t.id, dockCode: t.dockCode, bay: t.bay, route: t.route,
        state: t.state, pallets: t.pallets.length, weight: t.weight, payload: t.payload, deadline: t.deadline
      })),
      trucks: this.trucks.filter(t => !t.closedEmpty).map(t => ({
        id: t.id, dockCode: t.dockCode, bay: t.bay, route: t.route,
        state: t.state, pallets: t.pallets.length, weight: t.weight, cartons: t.cartons || 0, departed: t.departed
      })),
      departedCount: shippedTrips.length,
      robots: [...this.robots.values()].map(r => ({
        id: r.id, type: r.type, zone: r.zone, work: r.work, charging: r.charging,
        waiting: r.waiting, faultSeconds: r.faultSeconds, battery: r.battery,
        distance: r.distance, crossZoneCount: r.crossZoneCount
      })),
      transitions: clone(this.transitions),
      shiftResults: clone(this.shiftResults)
    };
  }
}
