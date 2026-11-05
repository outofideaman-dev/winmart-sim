// c:/Users/lshie/Documents/project/stupidfuck/Bao_cao_WinMart_V6_1_5000m2/Mo_phong/core.mjs
// WinMart V6.2 simulation core — 5,000 m² indoor dry warehouse, Excel 6-sheet outbound planner,
// multi-wave cell assembly + QC, Yard-to-Dock multi-trip lifecycle, swept OBB safety, balanced charging & conditional rescue.

import {
  LAYOUT,
  PALLET_TYPES,
  VEHICLE_SPECS,
  dockStagePoint,
  generateStorageSlots,
  generateFloorLocations,
  obbOverlap,
  vehicleHalfExtents
} from './layout_spec.mjs';
import {findCorridorPath, sha256Hex} from './routing_and_hash.mjs';
import {
  daysBetweenIso,
  parseAndValidateExcelWorkbook,
  buildPreRunPlanPreview,
  generateSampleWorkbookBuffer,
  exportRunResultsToXlsx
} from './excel_io.mjs';
import {
  createChargers,
  estimateEnergyPctForDistance,
  buildActiveObstacles,
  computeResourceKeys,
  canRunTrajectory,
  dispatchBalancedChargers,
  reconcileActiveTrajectories,
  faultRobotOp,
  authorizeRescueOp,
  advanceIncidentsOp,
  recoverRobotOp
} from './incident_and_energy.mjs';

export {
  LAYOUT,
  PALLET_TYPES,
  VEHICLE_SPECS,
  generateStorageSlots,
  obbOverlap,
  parseAndValidateExcelWorkbook,
  buildPreRunPlanPreview,
  generateSampleWorkbookBuffer,
  exportRunResultsToXlsx
};

export const DEFAULT_CONFIG = {
  version: '6.2',
  inboundSeconds: 28800,
  outboundSeconds: 28800,
  startPhase: 'OUTBOUND',
  shiftDate: '2026-11-05',
  shiftStartTime: '06:00:00',
  // Synthetic scenario parameters (overridden when config.excelPlan is supplied)
  skuCount: 12,
  initialPerSKU: 72,
  multiLotExpiries: true,
  demandSkewA: 0.5, // 0.5 = balanced A/B; 0.8 = 80% Zone A SKU demand skew
  initialWaveOrders: 24,
  orderInterval: 135,
  orderLimit: 180,
  outboundRoutes: 6,
  truckArrival: 0,
  truckIntervalSec: 2100,
  truckDeadline: 2700,
  truckMaxWaitSec: 2100,
  truckPayload: 3600,
  // Separated human vs equipment vs handover timing norms (no lumped operationMultiplier!)
  humanMultiplier: 1.0,
  assemblyBaseSeconds: 120,
  pickSecondsPerCarton: 14,
  workerWalkSpeedMps: 1.1,
  assemblyTeams: 4,
  qcWrapSeconds: 60,
  qcInspectors: 2,
  receiptSeconds: 180,
  emptyCollectSeconds: 120,
  inboundLanes: 2,
  inboundTruckSize: 16,
  inboundPallets: 128,
  rtPickDropBaseSec: 30,
  rtLiftSecPerMeter: 8,
  cpPickSec: 28,
  cpDropSec: 25,
  cpTruckDropSec: 25,
  shiftHandoverCheckSeconds: 300,
  // Fleet, Dock, Policy & Energy configuration
  activeXnCount: 6,
  activeCpCount: 4,
  activeOutboundDocks: 12,
  crossZone: true,
  direct: true,
  dispatchPolicy: 'V6_2_PROPOSED', // 'V6_2_PROPOSED' (Milestone C) | 'V6_2_BASELINE' (Milestone B)
  fefoMode: 'WINDOW_FEFO', // 'WINDOW_FEFO' | 'STRICT_FEFO'
  fefoWindowDays: 14,
  initialBattery: 100,
  batteryWorkSeconds: 28800,
  chargeSeconds: 7200,
  lowBatteryThreshold: 25,
  minReserveSOC: 12,
  opportunityChargeTarget: 85,
  maxCharging: 3,
  maxChargerPowerKw: 9.0,
  // Incident & Conditional Rescue parameters
  autoAuthorizeRescue: false,
  rescueLoadedSetupSec: 240,
  rescueUnloadedSetupSec: 120,
  towSpeedMps: 0.20,
  maintRepairSec: 900,
  faultSchedule: [],
  autoCycle: false,
  seed: 42
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clone = o => JSON.parse(JSON.stringify(o));
const sum = a => a.reduce((x, y) => x + y, 0);

export class WinMartEngine {
  constructor(config = {}) {
    // Backwards-compatible mapping if legacy operationMultiplier is passed without humanMultiplier
    const merged = {...DEFAULT_CONFIG, ...config};
    if (config.operationMultiplier != null && config.humanMultiplier == null) {
      merged.humanMultiplier = config.operationMultiplier;
    }
    if (merged.excelPlan?.shiftConfig) {
      const sc = merged.excelPlan.shiftConfig;
      merged.outboundSeconds = sc.shiftDurationSec;
      merged.shiftDate = sc.shiftDate;
      merged.shiftStartTime = sc.shiftStartTime;
      merged.activeXnCount = config.activeXnCount ?? sc.activeXnCount;
      merged.activeCpCount = config.activeCpCount ?? sc.activeCpCount;
      merged.assemblyTeams = config.assemblyTeams ?? sc.assemblyTeams;
      merged.qcInspectors = config.qcInspectors ?? sc.qcInspectors;
      merged.crossZone = config.crossZone ?? sc.crossZoneEnabled;
      merged.direct = config.direct ?? sc.directLoadEnabled;
      merged.fefoMode = config.fefoMode ?? sc.fefoMode;
      merged.fefoWindowDays = config.fefoWindowDays ?? sc.fefoWindowDays;
      merged.dispatchPolicy = config.dispatchPolicy ?? sc.dispatchPolicy;
      merged.startPhase = 'OUTBOUND';
    }
    this.config = merged;
    const c = this.config;

    this.time = 0;
    this.motionTime = 0;
    this.topologyVersion = 0;
    this.phase = c.startPhase;
    this.phaseStart = 0;
    this.phaseIndex = 0;
    this.handoverRemaining = 0;
    this.serial = 0;
    this.emergencyStop = {active: false, zone: 'ALL'};
    this.faultScheduleQueue = (c.faultSchedule || []).map(f => ({...f, triggered: false}));

    this.locations = new Map();
    this.pallets = new Map();
    this.robots = new Map();
    this.chargers = createChargers();
    this.jobs = [];
    this.orders = [];
    this.plannedPallets = new Map();
    this.trucks = [];
    this.inboundTrucks = [];
    this.logs = [];
    this.decisionTraces = [];
    this.transitions = [];
    this.shiftResults = [];

    this.slots = generateStorageSlots();
    this.slotMap = new Map(this.slots.map(s => [s.id, s]));
    for (const s of this.slots) {
      this.locations.set(s.id, {...s, pallet: null, reservation: null, blocked: false});
    }
    for (const f of generateFloorLocations()) {
      this.locations.set(f.id, {...f, pallet: null, reservation: null, blocked: false, occupiedByRobot: null});
    }

    this.cells = Array.from({length: 10}, (_, i) => ({
      id: i,
      x: Number((30.2 + i * 3.2).toFixed(3)),
      state: 'EMPTY',
      orderId: null,
      outPalletId: null,
      waveItems: [],
      remaining: 0,
      team: null,
      qcInspector: null
    }));
    this.workerTeams = Array.from({length: c.assemblyTeams}, (_, i) => ({
      id: i,
      x: 30.2 + i * 6.4,
      busyCell: null
    }));
    this.qcPool = Array.from({length: c.qcInspectors}, (_, i) => ({
      id: i,
      busyCell: null
    }));

    // Initialize Fleet: XN1..XN6 and CP1..CP4 (respecting activeXnCount & activeCpCount)
    for (let i = 0; i < 6; i++) {
      const home = {...LAYOUT.rtHomes[i]};
      const active = i < c.activeXnCount;
      this.robots.set(`XN${i + 1}`, this.createRobot(`XN${i + 1}`, 'RT', home, home.zone, active));
    }
    for (let i = 0; i < 4; i++) {
      const home = {...LAYOUT.cpHomes[i]};
      const active = i < c.activeCpCount;
      this.robots.set(`CP${i + 1}`, this.createRobot(`CP${i + 1}`, 'CP', home, null, active));
    }

    this.metrics = {
      received: 0, stored: 0, assembled: 0, qcPassed: 0, loaded: 0, departed: 0, returned: 0,
      emptyCollected: 0, direct: 0, viaStage: 0, crossZoneTrips: 0, multiWavePallets: 0,
      maxAssembly: 0, maxRT: 0, maxInbound: 0, maxSource: 0, maxStage: 0, maxActiveDocks: 0, maxYardQueue: 0,
      blockedReceipt: 0, globalSafetyHold: 0, eStopSeconds: 0,
      faultEvents: 0, reassignedTasks: 0, detourCount: 0, rescuesCompleted: 0, waitingPathEvents: 0,
      strictFefoPicks: 0, windowFefoOptimizations: 0, checks: 0
    };

    this.skus = new Map();
    this.skuCodes = [];
    this.initialBySKU = [];
    this.receivedBySKU = [];
    this.shippedBySKU = [];
    this.skuIndexMap = new Map();

    if (c.excelPlan) {
      this.initFromExcelPlan(c.excelPlan);
    } else {
      this.initSyntheticScenario();
    }

    this.receipts = [];
    this.inboundRemaining = c.inboundPallets;
    this.shiftBaseline = clone(this.metrics);
    this.log(`Khởi tạo WinMart V6.2 (${c.dispatchPolicy}, ${c.fefoMode}): ${c.activeXnCount} XN, ${c.activeCpCount} CP, ${c.activeOutboundDocks} dock xuất; ca ${this.phase}`);
  }

  createRobot(id, type, home, zone = null, active = true) {
    return {
      id,
      type,
      zone,
      active,
      home: {x: home.x, y: home.y},
      x: home.x,
      y: home.y,
      cos: 0,
      sin: -1,
      currentLiftM: 0,
      battery: this.config.initialBattery,
      status: active ? 'IDLE' : 'INACTIVE',
      task: null,
      trajectory: null,
      index: 0,
      returning: false,
      carried: null,
      work: 0,
      charging: 0,
      waiting: 0,
      faultSeconds: 0,
      distance: 0,
      crossZoneCount: 0,
      detourCount: 0,
      reassignedCount: 0,
      awaitingOperatorConfirm: false,
      faultContext: null,
      faultReason: null,
      maintBayId: null
    };
  }

  registerSku(skuObj) {
    const idx = this.skuCodes.length;
    this.skuCodes.push(skuObj.skuCode);
    this.skuIndexMap.set(skuObj.skuCode, idx);
    this.skus.set(skuObj.skuCode, {...skuObj, index: idx});
    this.initialBySKU.push(0);
    this.receivedBySKU.push(0);
    this.shippedBySKU.push(0);
    return idx;
  }

  initFromExcelPlan(plan) {
    this.planId = plan.shiftConfig.planId;
    for (const s of plan.skus) this.registerSku(s);

    for (const sp of plan.sourcePallets) {
      const idx = this.skuIndexMap.get(sp.skuCode);
      const sku = this.skus.get(sp.skuCode);
      this.createPallet({
        explicitId: sp.palletId,
        sku: idx,
        skuCode: sp.skuCode,
        cartons: sp.availableCartons,
        allocatedCartons: 0,
        kind: 'source',
        palletType: sp.palletType,
        tareWeightKg: sp.palletTareKg,
        cartonWeightKg: sku.cartonWeightKg,
        weight: Number((sp.palletTareKg + sp.availableCartons * sku.cartonWeightKg).toFixed(3)),
        lot: sp.lotCode,
        expiry: sp.expiryDate,
        qcStatus: sp.qcStatus
      }, sp.locationCode);
      this.initialBySKU[idx] += sp.availableCartons;
    }

    for (const tr of plan.trips) {
      this.trucks.push({
        id: tr.tripId,
        vehicleType: tr.vehicleType,
        vehiclePlate: tr.vehiclePlate,
        route: tr.routeId,
        bay: null,
        dockX: null,
        dockCode: null,
        pinnedBay: tr.pinnedBay,
        state: 'NOT_ARRIVED',
        arrivalTimeSec: tr.arrivalTimeSec,
        arrived: null,
        dockedAt: null,
        readyAt: null,
        committedDepartureSec: tr.committedDepartureSec,
        deadline: tr.committedDepartureSec,
        maxWaitLoadingSec: tr.maxWaitLoadingSec,
        latePolicy: tr.latePolicy,
        maxPalletSlots: tr.maxPalletSlots,
        payload: tr.maxLoadWeightKg,
        pallets: [],
        reservedPallets: [],
        weight: 0,
        reservedWeight: 0,
        closing: false,
        safetyHeld: false,
        departureLatenessSec: 0,
        decisionReason: null,
        history: [['PLANNED', tr.arrivalTimeSec]]
      });
    }

    for (const ord of plan.orders) {
      const orderEntity = {
        id: ord.orderId,
        storeCode: ord.storeCode,
        route: ord.routeId,
        releaseTimeSec: ord.releaseTimeSec,
        created: ord.releaseTimeSec,
        due: ord.dueTimeSec,
        priority: ord.priority,
        allowSplitTrips: ord.allowSplitTrips,
        stopSequence: ord.stopSequence,
        state: ord.releaseTimeSec <= 0 ? 'QUEUED' : 'UNRELEASED',
        assignedTripId: null,
        plannedPalletIds: [],
        shippedPalletIds: [],
        plannedCartons: ord.totalCartons,
        shippedCartons: 0,
        completedAt: null,
        latenessSec: 0,
        tripIds: []
      };
      for (const op of ord.plannedPallets) {
        const pp = {
          id: op.outPalletId,
          orderId: ord.orderId,
          route: ord.routeId,
          dispatchMode: op.dispatchMode,
          palletType: op.palletType,
          tareWeightKg: op.tareWeightKg,
          grossWeightKg: op.grossWeightKg,
          totalCartons: op.totalCartons,
          pinnedTripId: op.pinnedTripId || null,
          lines: op.lines.map(ln => ({...ln})),
          allocations: [],
          waveCursor: 0,
          state: 'PLANNED',
          cellId: null,
          physicalPalletId: null,
          reservedTripId: null,
          shippedTripId: null,
          shortageReason: null
        };
        if (pp.pinnedTripId && !orderEntity.allowSplitTrips) {
          orderEntity.assignedTripId = pp.pinnedTripId;
        }
        this.plannedPallets.set(pp.id, pp);
        orderEntity.plannedPalletIds.push(pp.id);
      }
      this.orders.push(orderEntity);
    }
    this.syntheticMode = false;
  }

  initSyntheticScenario() {
    const c = this.config;
    this.syntheticMode = true;
    this.planId = 'SYNTHETIC-V6.2';

    for (let i = 0; i < c.skuCount; i++) {
      const code = `SKU${String(i + 1).padStart(2, '0')}`;
      this.registerSku({
        skuCode: code,
        skuName: `Mặt hàng chuẩn ${code}`,
        unitName: 'CARTON',
        cartonWeightKg: 10,
        cartonVolumeM3: 0.020,
        maxCartonsPerPallet: 60,
        preferredZone: i % 2 === 0 ? 'A' : 'B'
      });
    }

    const expPool = c.multiLotExpiries
      ? ['2027-01-20', '2027-01-28', '2027-05-15', '2027-08-30']
      : ['2027-06-30'];

    for (let sku = 0; sku < c.skuCount; sku++) {
      const skuCode = this.skuCodes[sku];
      const zone = sku % 2 ? 'B' : 'A';
      for (let j = 0; j < c.initialPerSKU; j++) {
        const aisle = (zone === 'A' ? 0 : 7) + (j % 7);
        const slot =
          this.slots.find(s => s.aisle === aisle && s.level === j % LAYOUT.levels && this.free(s.id)) ||
          this.slots.find(s => s.zone === zone && this.free(s.id));
        if (!slot) throw Error(`Vượt sức chứa kệ khi khởi tạo ${skuCode}`);
        const exp = expPool[j % expPool.length];
        const cartons = (c.multiLotExpiries && j % 9 === 1) ? 30 : 60;
        this.createPallet({
          sku,
          skuCode,
          cartons,
          allocatedCartons: 0,
          kind: 'source',
          palletType: 'STD_WOOD',
          tareWeightKg: 25,
          cartonWeightKg: 10,
          weight: 25 + cartons * 10,
          lot: `LOT-${skuCode}-${exp.slice(5, 7)}`,
          expiry: exp,
          qcStatus: 'AVAILABLE'
        }, slot.id);
        this.initialBySKU[sku] += cartons;
      }
    }

    this.nextSyntheticOrderTime = 0;
    this.syntheticOrderSeq = 0;
    this.buildSyntheticTripsForOutboundShift(0);
  }

  buildSyntheticTripsForOutboundShift(shiftOffsetSec = 0) {
    const c = this.config;
    const routes = Array.from({length: c.outboundRoutes}, (_, i) => `R${String(i + 1).padStart(2, '0')}`);
    const waves = Math.max(4, Math.ceil(c.outboundSeconds / c.truckIntervalSec));
    for (let w = 0; w < waves; w++) {
      for (let rIdx = 0; rIdx < routes.length; rIdx++) {
        const arr = shiftOffsetSec + c.truckArrival + w * c.truckIntervalSec + rIdx * 45;
        if (arr >= shiftOffsetSec + c.outboundSeconds - 180) continue;
        const dep = Math.min(shiftOffsetSec + c.outboundSeconds + 300, arr + c.truckDeadline);
        const id = `TR${this.trucks.length + 1}`;
        this.trucks.push({
          id,
          vehicleType: 'BOX_TRUCK_4PL',
          vehiclePlate: `29H-${800 + rIdx}.${String(w + 1).padStart(2, '0')}`,
          route: routes[rIdx],
          bay: null,
          dockX: null,
          dockCode: null,
          pinnedBay: null,
          state: 'NOT_ARRIVED',
          arrivalTimeSec: arr,
          arrived: null,
          dockedAt: null,
          readyAt: null,
          committedDepartureSec: dep,
          deadline: dep,
          maxWaitLoadingSec: c.truckMaxWaitSec,
          latePolicy: 'DEPART_WHEN_FULL_OR_CUTOFF',
          maxPalletSlots: 4,
          payload: c.truckPayload,
          pallets: [],
          reservedPallets: [],
          weight: 0,
          reservedWeight: 0,
          closing: false,
          safetyHeld: false,
          departureLatenessSec: 0,
          decisionReason: null,
          history: [['PLANNED', arr]]
        });
      }
    }
  }

  log(message) {
    this.logs.push({time: this.time, message});
  }

  recordDecision(category, targetId, reason) {
    if (!reason) return;
    this.decisionTraces.push({time: this.time, category, targetId, reason});
    if (this.decisionTraces.length > 400) this.decisionTraces.shift();
  }

  free(id) {
    const l = this.locations.get(id);
    return !!l && !l.pallet && !l.reservation && !l.blocked && !this.isLocationIsolated(id);
  }

  isLocationIsolated(locId, excludeRobotId = null) {
    const l = this.locations.get(locId);
    if (!l) return true;
    for (const r of this.robots.values()) {
      if (!r.active || r.id === excludeRobotId) continue;
      if (!['FAULT', 'RESCUE_SETUP', 'WAITING_EXTERNAL_ASSISTANCE'].includes(r.status)) continue;
      if (Math.hypot(r.x - l.x, r.y - l.y) < 1.35) return true;
      if (l.kind === 'rack' && r.type === 'RT' && r.y > LAYOUT.frontY + 0.4 && r.y < LAYOUT.rearY - 0.4) {
        if (Math.abs(r.x - l.x) < 0.4) return true;
      }
    }
    return false;
  }

  isCellIsolated(cellId, excludeRobotId = null) {
    const src0 = this.locations.get(`SRC${2 * cellId}`);
    const src1 = this.locations.get(`SRC${2 * cellId + 1}`);
    const out = this.locations.get(`OUT${cellId}`);
    for (const r of this.robots.values()) {
      if (!r.active || r.id === excludeRobotId) continue;
      if (!['FAULT', 'RESCUE_SETUP', 'WAITING_EXTERNAL_ASSISTANCE'].includes(r.status)) continue;
      for (const l of [src0, src1, out]) {
        if (l && Math.hypot(r.x - l.x, r.y - l.y) < 1.55) return true;
      }
    }
    return false;
  }

  createPallet(data, to) {
    const l = this.locations.get(to);
    if (!l || l.pallet) throw Error('Không thể đặt pallet mới tại ô ' + to);
    const id = data.explicitId || `PL${++this.serial}`;
    const skuCode = data.skuCode ?? (data.sku != null ? this.skuCodes[data.sku] : null);
    const composition = data.composition || (data.sku == null ? [] : [{
      sku: data.sku,
      skuCode,
      cartons: data.cartons,
      lot: data.lot || null,
      expiry: data.expiry || null
    }]);
    const tare = data.tareWeightKg ?? 25;
    const cWeight = data.cartonWeightKg ?? 10;
    const p = {
      id,
      composition,
      ...data,
      skuCode,
      tareWeightKg: tare,
      cartonWeightKg: cWeight,
      allocatedCartons: data.allocatedCartons ?? 0,
      weight: data.weight ?? Number((tare + (data.cartons || 0) * cWeight).toFixed(3)),
      location: to,
      job: null,
      lastUsed: this.time
    };
    this.pallets.set(p.id, p);
    l.pallet = p.id;
    return p;
  }

  at(id) {
    const pid = this.locations.get(id)?.pallet;
    return pid ? this.pallets.get(pid) : null;
  }

  move(p, to) {
    const old = this.locations.get(p.location);
    if (old) {
      if (old.pallet !== p.id) throw Error(`Sai chủ sở hữu pallet ${p.id} tại ${p.location}`);
      old.pallet = null;
    }
    p.location = to;
    const l = this.locations.get(to);
    if (l) {
      if (l.pallet) throw Error(`Chồng pallet tại ${to}`);
      l.pallet = p.id;
    }
  }

  queue(p, to, type, label, extra = {}) {
    if (p.job || !this.free(to)) return null;
    const j = {
      id: `J${++this.serial}`,
      pallet: p.id,
      from: p.location,
      to,
      type,
      label,
      state: 'QUEUED',
      created: this.time,
      cleared: false,
      decisionReason: extra.decisionReason || null,
      ...extra
    };
    p.job = j.id;
    this.locations.get(to).reservation = j.id;
    this.jobs.push(j);
    if (j.decisionReason) this.recordDecision('JOB_QUEUE', j.id, j.decisionReason);
    return j;
  }

  jobCells(j) {
    const cells = [];
    for (const id of [j.from, j.to]) {
      if (!id) continue;
      const l = this.locations.get(id);
      if (l?.cell != null) cells.push(l.cell);
    }
    return [...new Set(cells)];
  }

  stopPointForLocation(loc, robotType) {
    if (!loc) return {x: 0, y: 0};
    if (loc.kind === 'source' || loc.kind === 'stage') {
      return {
        x: loc.x,
        y: robotType === 'RT' ? (loc.rtStopY ?? 15.55) : (loc.cpStopY ?? 14.15)
      };
    }
    return {x: loc.x, y: loc.y};
  }

  path(a, b, type, excludeRobotId = null) {
    const {obstacles, blockedAisles} = buildActiveObstacles(this, excludeRobotId);
    const allowRearDetour = this.config.dispatchPolicy !== 'V6_2_BASELINE' || obstacles.length > 0;
    return findCorridorPath(a, b, type, {obstacles, blockedAisles, allowRearDetour});
  }

  appendWalkFrames(frames, cur, points, r, loaded = false, reverse = false, inTruck = false) {
    let pos = {x: cur.x, y: cur.y, cos: cur.cos ?? 0, sin: cur.sin ?? 1};
    for (const p of points.slice(1)) {
      const d = dist(pos, p);
      if (d < 1e-5) continue;
      const spec = VEHICLE_SPECS[r.type];
      const speed = inTruck
        ? spec.speedInTruckMps
        : (loaded ? spec.speedLoadedMps : spec.speedUnloadedMps);
      const n = Math.max(1, Math.ceil(d / speed));
      const cos = (p.x - pos.x) / d;
      const sin = (p.y - pos.y) / d;
      const a = {x: pos.x, y: pos.y};
      for (let k = 1; k <= n; k++) {
        frames.push({
          x: a.x + (p.x - a.x) * (k / n),
          y: a.y + (p.y - a.y) * (k / n),
          cos: reverse ? -cos : cos,
          sin: reverse ? -sin : sin,
          loaded,
          action: reverse ? 'reverse' : 'move'
        });
      }
      pos = {x: p.x, y: p.y, cos: reverse ? -cos : cos, sin: reverse ? -sin : sin};
    }
    return pos;
  }

  appendStayFrames(frames, pos, seconds, action, event, loaded = false, liftM = 0) {
    const steps = Math.max(1, Math.ceil(seconds));
    for (let i = 0; i < steps; i++) {
      frames.push({
        x: pos.x,
        y: pos.y,
        cos: pos.cos ?? 0,
        sin: pos.sin ?? 1,
        loaded,
        liftM,
        action,
        event: i === steps - 1 ? event : null
      });
    }
  }

  buildReturnHomeTrajectory(r, startPos) {
    const route = this.path(startPos, r.home, r.type, r.id);
    if (!route) return null;
    const frames = [{x: startPos.x, y: startPos.y, cos: r.cos ?? 0, sin: r.sin ?? 1, loaded: false, action: 'wait'}];
    this.appendWalkFrames(frames, frames[0], route.points, r, false, false, false);
    frames.at(-1).done = true;
    frames.usedDetour = route.usedDetour;
    frames.totalMeters = route.distance;
    return frames;
  }

  buildLoadedContinuationTrajectory(r, j, startPos) {
    const bLoc = this.locations.get(j.to);
    if (!bLoc) return null;
    const bStop = this.stopPointForLocation(bLoc, r.type);
    const rToB = this.path(startPos, bStop, r.type, r.id);
    if (!rToB) return null;
    const frames = [{x: startPos.x, y: startPos.y, cos: r.cos ?? 0, sin: r.sin ?? 1, loaded: true, action: 'wait'}];
    let cur = this.appendWalkFrames(frames, frames[0], rToB.points, r, true, false, false);
    const dropSec = r.type === 'RT'
      ? this.config.rtPickDropBaseSec + (bLoc.height || 0) * this.config.rtLiftSecPerMeter
      : this.config.cpDropSec;
    this.appendStayFrames(frames, cur, dropSec, 'drop', 'drop', true, bLoc.height || 0);
    const exitY = r.type === 'RT'
      ? (Math.abs(bStop.y - LAYOUT.rearY) < Math.abs(bStop.y - LAYOUT.frontY) ? LAYOUT.rearY : LAYOUT.frontY)
      : (bLoc.kind === 'output' ? LAYOUT.cpFrontY : LAYOUT.cpMidY);
    cur = this.appendWalkFrames(frames, cur, [cur, {x: bStop.x, y: exitY}], r, false, true, false);
    frames.at(-1).clear = true;
    const rHome = this.path(cur, r.home, r.type, r.id);
    if (!rHome) return null;
    this.appendWalkFrames(frames, cur, rHome.points, r, false, false, false);
    frames.at(-1).done = true;
    frames.usedDetour = rToB.usedDetour || rHome.usedDetour;
    frames.totalMeters = rToB.distance + rHome.distance;
    return frames;
  }

  buildTrajectory(r, j, startPos = r.home) {
    const frames = [{x: startPos.x, y: startPos.y, cos: r.cos ?? 0, sin: r.sin ?? 1, loaded: false, action: 'wait'}];
    let cur = frames[0];
    let usedDetour = false;
    let totalMeters = 0;

    if (j.charge) {
      const port = this.chargers.get(j.chargerId);
      if (!port) return null;
      const toPort = this.path(cur, port, r.type, r.id);
      if (!toPort) return null;
      usedDetour = usedDetour || toPort.usedDetour;
      totalMeters += toPort.distance;
      cur = this.appendWalkFrames(frames, cur, toPort.points, r, false, false, false);
      frames.at(-1).event = 'enter_charger';
      const cStart = frames.length;
      const neededPct = Math.max(5, (j.targetSOC ?? 100) - r.battery);
      const chargeSec = Math.max(60, Math.ceil((neededPct / 100) * this.config.chargeSeconds));
      this.appendStayFrames(frames, cur, chargeSec, 'charge', 'charged', false, 0);
      const cEnd = frames.length;
      // Exit charger pocket onto corridor and immediately set clear=true so robot can chain directly to work!
      const exitY = r.type === 'RT' ? LAYOUT.frontY : LAYOUT.cpMidY;
      cur = this.appendWalkFrames(frames, cur, [cur, {x: port.x, y: exitY}], r, false, true, false);
      frames.at(-1).clear = true;
      frames.at(-1).leaveCharger = true;
      const toHome = this.path(cur, r.home, r.type, r.id);
      if (!toHome) return null;
      usedDetour = usedDetour || toHome.usedDetour;
      totalMeters += toHome.distance;
      this.appendWalkFrames(frames, cur, toHome.points, r, false, false, false);
      frames.at(-1).done = true;
      frames.chargeStart = cStart;
      frames.chargeEnd = cEnd;
      frames.usedDetour = usedDetour;
      frames.totalMeters = totalMeters;
      return frames;
    }

    const aLoc = this.locations.get(j.from);
    const bLoc = this.locations.get(j.to);
    if (!aLoc || !bLoc) return null;

    const aStop = this.stopPointForLocation(aLoc, r.type);
    const toA = this.path(cur, aStop, r.type, r.id);
    if (!toA) return null;
    usedDetour = usedDetour || toA.usedDetour;
    totalMeters += toA.distance;
    cur = this.appendWalkFrames(frames, cur, toA.points, r, false, false, false);

    const pickSec = r.type === 'RT'
      ? this.config.rtPickDropBaseSec + (aLoc.height || 0) * this.config.rtLiftSecPerMeter
      : this.config.cpPickSec;
    this.appendStayFrames(frames, cur, pickSec, 'pick', 'pick', false, aLoc.height || 0);

    if (j.truck) {
      const dockX = j.truck.dockX;
      const stagePt = dockStagePoint(j.truck.bay);
      const someoneInBed = [...this.robots.values()].some(q =>
        q !== r && q.active && q.task?.truck?.id === j.truck.id && !q.returning
      );
      const approachTarget = someoneInBed ? stagePt : {x: dockX, y: LAYOUT.cpFrontY};
      const toDockFront = this.path(cur, approachTarget, 'CP', r.id);
      if (!toDockFront) return null;
      usedDetour = usedDetour || toDockFront.usedDetour;
      totalMeters += toDockFront.distance;
      cur = this.appendWalkFrames(frames, cur, toDockFront.points, r, true, false, false);

      if (someoneInBed) {
        // Brief staging buffer wait outside corridor before aligning with dock ramp
        this.appendStayFrames(frames, cur, 12, 'wait', null, true, 0);
        cur = this.appendWalkFrames(frames, cur, [cur, {x: cur.x, y: LAYOUT.cpFrontY}, {x: dockX, y: LAYOUT.cpFrontY}], r, true, false, false);
      }

      const bedStart = frames.length;
      cur = this.appendWalkFrames(frames, cur, [cur, {x: dockX, y: 1.5}], r, true, false, false);
      cur = this.appendWalkFrames(frames, cur, [cur, {x: dockX, y: -1.0}, {x: dockX, y: bLoc.y}], r, true, false, true);
      this.appendStayFrames(frames, cur, this.config.cpTruckDropSec, 'drop', 'drop', true, 0);
      cur = this.appendWalkFrames(frames, cur, [cur, {x: dockX, y: -1.0}, {x: dockX, y: 1.5}], r, false, true, true);
      cur = this.appendWalkFrames(frames, cur, [cur, {x: dockX, y: LAYOUT.cpFrontY}], r, false, true, false);
      const bedEnd = frames.length - 1;
      frames.at(-1).clear = true;
      frames.bedStart = bedStart;
      frames.bedEnd = bedEnd;
      totalMeters += 18.0;

      const toHome = this.path(cur, r.home, 'CP', r.id);
      if (!toHome) return null;
      usedDetour = usedDetour || toHome.usedDetour;
      totalMeters += toHome.distance;
      this.appendWalkFrames(frames, cur, toHome.points, r, false, false, false);
    } else {
      const bStop = this.stopPointForLocation(bLoc, r.type);
      const toB = this.path(cur, bStop, r.type, r.id);
      if (!toB) return null;
      usedDetour = usedDetour || toB.usedDetour;
      totalMeters += toB.distance;
      cur = this.appendWalkFrames(frames, cur, toB.points, r, true, false, false);

      const dropSec = r.type === 'RT'
        ? this.config.rtPickDropBaseSec + (bLoc.height || 0) * this.config.rtLiftSecPerMeter
        : this.config.cpDropSec;
      this.appendStayFrames(frames, cur, dropSec, 'drop', 'drop', true, bLoc.height || 0);

      // Pull out from buffer/aisle onto nearest main corridor so slot unlocks cleanly
      if (r.type === 'RT' && bLoc.kind !== 'rack') {
        cur = this.appendWalkFrames(frames, cur, [cur, {x: bStop.x, y: LAYOUT.frontY}], r, false, true, false);
      } else if (r.type === 'RT' && bLoc.kind === 'rack') {
        const nearY = Math.abs(bStop.y - LAYOUT.rearY) < Math.abs(bStop.y - LAYOUT.frontY) ? LAYOUT.rearY : LAYOUT.frontY;
        cur = this.appendWalkFrames(frames, cur, [cur, {x: bStop.x, y: nearY}], r, false, false, false);
      } else if (r.type === 'CP') {
        const exitY = bLoc.kind === 'output' ? LAYOUT.cpFrontY : LAYOUT.cpMidY;
        cur = this.appendWalkFrames(frames, cur, [cur, {x: bStop.x, y: exitY}], r, false, true, false);
      }
      frames.at(-1).clear = true;

      const toHome = this.path(cur, r.home, r.type, r.id);
      if (!toHome) return null;
      usedDetour = usedDetour || toHome.usedDetour;
      totalMeters += toHome.distance;
      this.appendWalkFrames(frames, cur, toHome.points, r, false, false, false);
    }

    frames.at(-1).done = true;
    frames.usedDetour = usedDetour;
    frames.totalMeters = totalMeters;
    return frames;
  }

  start(r, j) {
    if (!r.active) return false;
    if (['FAULT', 'RESCUE_SETUP', 'TOWING', 'IN_MAINT', 'WAITING_EXTERNAL_ASSISTANCE'].includes(r.status)) return false;
    if (r.task && !r.returning) return false;

    const startPt = r.returning ? {x: r.x, y: r.y} : {x: r.home.x, y: r.home.y};
    const actualIdleOffHome = !r.task && dist(r, r.home) > 0.25;
    const origin = (r.returning || actualIdleOffHome) ? {x: r.x, y: r.y} : r.home;

    let traj = null;
    if (origin === r.home && !j.charge) {
      const someoneInBed = j.truck
        ? [...this.robots.values()].some(q => q !== r && q.active && q.task?.truck?.id === j.truck.id && !q.returning)
        : false;
      const aisleMask = r.type === 'RT'
        ? [...buildActiveObstacles(this, r.id).blockedAisles].sort((a, b) => a - b).join(',')
        : '';
      const cacheKey = `${r.id}:${this.topologyVersion}:${someoneInBed ? 1 : 0}:${aisleMask}`;
      if (!j._trajCache) j._trajCache = new Map();
      if (j._trajCache.has(cacheKey)) {
        traj = j._trajCache.get(cacheKey);
      } else {
        traj = this.buildTrajectory(r, j, origin);
        if (traj) j._trajCache.set(cacheKey, traj);
      }
    } else {
      traj = this.buildTrajectory(r, j, origin);
    }
    if (!traj) {
      j.waitingPath = true;
      return false;
    }

    // Energy-to-charger safety check before accepting any non-charge job
    if (!j.charge) {
      if (r.battery < (this.config.lowBatteryThreshold ?? 25)) return false;
      const jobPct = estimateEnergyPctForDistance(r.type, traj.totalMeters || 60, 60, this.config.batteryWorkSeconds);
      const chgPorts = r.type === 'RT' ? LAYOUT.rtChargers : LAYOUT.cpChargers;
      const minToChg = Math.min(...chgPorts.map(c => dist(r.home, c)));
      const reserveToChg = estimateEnergyPctForDistance(r.type, minToChg, 5, this.config.batteryWorkSeconds);
      if (r.battery - jobPct < (this.config.minReserveSOC ?? 12) + reserveToChg) {
        r.battery = Math.min(r.battery, (this.config.lowBatteryThreshold ?? 25) - 0.1);
        return false;
      }
    }

    j.waitingPath = false;
    let delay = 0;
    const maxDelay = r.returning ? 60 : 240;
    const stepDelay = r.returning ? 10 : 20;
    const waitStand = {x: origin.x, y: origin.y, cos: r.cos ?? 0, sin: r.sin ?? 1};
    for (; delay <= maxDelay; delay += stepDelay) {
      if (canRunTrajectory(this, r, j, traj, delay, waitStand)) break;
    }
    if (delay > maxDelay) return false;

    if (r.returning && r.task) {
      const prevJob = r.task;
      prevJob.state = 'DONE';
      prevJob.ended = this.time;
      r.returning = false;
    }

    const jobZone = r.type === 'RT' ? (this.slotMap.get(j.from) || this.slotMap.get(j.to))?.zone : null;
    if (r.type === 'RT' && jobZone && r.zone !== jobZone) {
      j.crossZone = true;
      r.crossZoneCount++;
      this.metrics.crossZoneTrips++;
    }

    j._trajCache = null;
    j.resources = computeResourceKeys(this, j);
    j.activeCells = this.jobCells(j);
    j.state = 'RUNNING';
    j.robot = r.id;
    j.started = this.time;
    r.task = j;
    const waitFrames = delay
      ? Array.from({length: delay}, () => ({x: origin.x, y: origin.y, cos: r.cos ?? 0, sin: r.sin ?? 1, loaded: false, action: 'wait'}))
      : [];
    const fullTraj = delay ? [...waitFrames, ...traj] : traj;
    if (traj.bedStart != null) { fullTraj.bedStart = traj.bedStart + delay; fullTraj.bedEnd = traj.bedEnd + delay; }
    if (traj.chargeStart != null) { fullTraj.chargeStart = traj.chargeStart + delay; fullTraj.chargeEnd = traj.chargeEnd + delay; }
    fullTraj.usedDetour = traj.usedDetour;
    if (traj.usedDetour) {
      r.detourCount++;
      this.metrics.detourCount++;
    }
    r.trajectory = fullTraj;
    r.index = 0;
    r.status = 'RUNNING';
    if (j.decisionReason) this.recordDecision('DISPATCH', `${r.id}->${j.id}`, j.decisionReason);
    this.log(`${r.id}${j.crossZone ? ' [hỗ trợ chéo]' : ''}${traj.usedDetour ? ' [đi vòng]' : ''}: ${j.label} ${j.pallet || j.chargerId || ''}`);
    return true;
  }

  estimatedArrival(r, j) {
    const a = this.locations.get(j.from);
    if (!a) return 9999;
    const speed = r.type === 'RT' ? 0.9 : 1.0;
    if (!r.task || r.returning) {
      return dist(r, a) / speed;
    }
    const clearIdx = r.trajectory ? r.trajectory.findIndex((f, idx) => idx >= r.index && f.clear) : -1;
    const rem = clearIdx >= 0 ? clearIdx - r.index : (r.trajectory ? r.trajectory.length - r.index : 0);
    const startPt = clearIdx >= 0 ? r.trajectory[clearIdx] : r.home;
    return rem + dist(startPt, a) / speed;
  }

  dispatch() {
    const baseline = this.config.dispatchPolicy === 'V6_2_BASELINE';
    const queuedJobs = this.jobs
      .filter(j => j.state === 'QUEUED')
      .sort((a, b) => {
        if (baseline) return a.created - b.created;
        const ua = (a.urgency || 0) + Math.floor((this.time - a.created) / 480);
        const ub = (b.urgency || 0) + Math.floor((this.time - b.created) / 480);
        return ub - ua || a.created - b.created;
      });

    const rtQueuedByZone = {A: 0, B: 0};
    for (const j of queuedJobs) {
      if (j.type === 'RT') {
        const z = (this.slotMap.get(j.from) || this.slotMap.get(j.to))?.zone;
        if (z) rtQueuedByZone[z]++;
      }
    }

    for (const j of queuedJobs) {
      // Skip retrying NO_PATH jobs until topology changes or 30s passes
      if (j.waitingPath && j.lastTopo === this.topologyVersion && (this.time - (j.lastTry || 0)) < 30) {
        continue;
      }
      j.lastTopo = this.topologyVersion;
      j.lastTry = this.time;

      const jobZone = j.type === 'RT' ? (this.slotMap.get(j.from) || this.slotMap.get(j.to))?.zone : null;
      const healthyType = [...this.robots.values()].filter(r =>
        r.active &&
        r.type === j.type &&
        !['FAULT', 'RESCUE_SETUP', 'TOWING', 'IN_MAINT', 'WAITING_EXTERNAL_ASSISTANCE', 'WAITING_PATH'].includes(r.status)
      );

      let pool = jobZone ? healthyType.filter(r => r.zone === jobZone) : healthyType;

      if (j.type === 'RT' && jobZone && this.config.crossZone) {
        const nativeFree = pool.some(r => (!r.task || r.returning) && r.battery >= (this.config.lowBatteryThreshold ?? 25));
        const otherZone = jobZone === 'A' ? 'B' : 'A';
        if (!nativeFree || (!baseline && rtQueuedByZone[jobZone] >= 2 && rtQueuedByZone[otherZone] === 0)) {
          const helpers = healthyType.filter(r =>
            r.zone === otherZone && (!r.task || r.returning) && r.battery >= (this.config.lowBatteryThreshold ?? 25)
          );
          pool = [...pool, ...helpers];
        }
      }

      if (baseline) {
        pool.sort((a, b) => a.id.localeCompare(b.id));
      } else {
        pool.sort((a, b) => {
          if (j.type === 'RT' && jobZone && a.zone !== b.zone) return a.zone === jobZone ? -1 : 1;
          if (j.type === 'CP') {
            const pref = r => (j.truck ? Number(r.id.slice(2)) > 2 : Number(r.id.slice(2)) <= 2);
            if (pref(b) !== pref(a)) return Number(pref(b)) - Number(pref(a));
          }
          return this.estimatedArrival(a, j) - this.estimatedArrival(b, j) || a.work - b.work;
        });
      }

      for (const r of pool) {
        if ((r.task && !r.returning) || r.battery < (this.config.lowBatteryThreshold ?? 25)) continue;
        if (this.start(r, j)) {
          if (j.type === 'RT' && jobZone) rtQueuedByZone[jobZone] = Math.max(0, rtQueuedByZone[jobZone] - 1);
          break;
        }
      }
    }

    dispatchBalancedChargers(this);
  }

  isRobotStoppedByEStop(r) {
    if (!this.emergencyStop.active) return false;
    const z = this.emergencyStop.zone;
    if (z === 'ALL') return true;
    if (z === 'DOCK' && r.y < 12.5) return true;
    if (z === 'A' && r.x < 50 && r.y >= 18) return true;
    if (z === 'B' && r.x >= 50 && r.y >= 18) return true;
    return false;
  }

  triggerEmergencyStop(active = true, zone = 'ALL') {
    this.emergencyStop = {active: Boolean(active), zone};
    this.log(active ? `Kích hoạt dừng khẩn E-STOP (${zone}); đồng hồ ca và hạn chuyến xe vẫn trôi trung thực` : `Giải tỏa dừng khẩn E-STOP (${zone})`);
    return true;
  }

  faultRobot(id, options = {}) {
    return faultRobotOp(this, id, options);
  }

  authorizeRescue(id) {
    return authorizeRescueOp(this, id);
  }

  recoverRobot(id, options = {}) {
    return recoverRobotOp(this, id, options);
  }

  trySubstituteBlockedSourceJob(prevTask, blockedAisle, faultedRobotId) {
    const oldPallet = this.pallets.get(prevTask.pallet);
    if (!oldPallet || !['Cấp nguồn', 'Xuất nguyên pallet'].includes(prevTask.label)) return false;

    const alt = [...this.pallets.values()]
      .filter(p =>
        p.id !== oldPallet.id &&
        p.kind === 'source' &&
        p.qcStatus === 'AVAILABLE' &&
        p.skuCode === oldPallet.skuCode &&
        !p.job &&
        (p.cartons - p.allocatedCartons) >= oldPallet.allocatedCartons &&
        (prevTask.label !== 'Xuất nguyên pallet' || p.cartons === oldPallet.cartons) &&
        this.slotMap.get(p.location)?.aisle !== blockedAisle &&
        !this.isLocationIsolated(p.location, faultedRobotId)
      )
      .sort((a, b) => a.expiry.localeCompare(b.expiry))[0];

    if (!alt) return false;

    const movedAlloc = oldPallet.allocatedCartons;
    oldPallet.allocatedCartons = 0;
    oldPallet.job = null;
    alt.allocatedCartons += movedAlloc;
    alt.job = prevTask.id;

    // Update PlannedOutboundPallet allocations referencing oldPallet
    for (const pp of this.plannedPallets.values()) {
      if (pp.physicalPalletId === oldPallet.id && pp.dispatchMode === 'WHOLE_PALLET') {
        pp.physicalPalletId = alt.id;
        alt.order = pp.orderId;
        alt.outPalletId = pp.id;
        oldPallet.order = null;
        oldPallet.outPalletId = null;
      }
      for (const al of pp.allocations) {
        if (al.sourcePalletId === oldPallet.id && al.status === 'ALLOCATED') {
          al.sourcePalletId = alt.id;
          al.lotCode = alt.lot;
          al.expiryDate = alt.expiry;
          al.decisionReason = `Đổi sang ${alt.id} do lối L${blockedAisle + 1} bị cô lập bởi ${faultedRobotId}`;
        }
      }
    }

    prevTask.pallet = alt.id;
    prevTask.from = alt.location;
    prevTask.state = 'QUEUED';
    prevTask.robot = null;
    prevTask.resources = [];
    prevTask.activeCells = [];
    prevTask.decisionReason = `Đổi nguồn sang ${alt.id} tránh lối L${blockedAisle + 1}`;
    this.log(`Tự động chuyển nguồn từ ${oldPallet.id} (lối L${blockedAisle + 1} bị chặn) sang ${alt.id} cho lệnh ${prevTask.id}`);
    return true;
  }

  completeRescuePalletTransfer(r) {
    const j = r.task;
    const p = this.pallets.get(r.carried);
    if (!p || !j) return;

    const oldDest = this.locations.get(j.to);
    if (oldDest && oldDest.reservation === j.id) oldDest.reservation = null;

    if (j.truck) {
      r.heldTruckId = j.truck.id;
      const rIdx = j.truck.reservedPallets.indexOf(p.id);
      if (rIdx >= 0) {
        j.truck.reservedPallets.splice(rIdx, 1);
        j.truck.reservedWeight = Math.max(0, j.truck.reservedWeight - p.weight);
      }
    }

    // Place rescued pallet onto nearest free safe floor buffer (ST for outbound finished/whole, SRC for source/putaway)
    const bufferCandidates = (p.kind === 'finished' || p.outPalletId)
      ? Array.from({length: 12}, (_, i) => `ST${i}`).filter(id => this.free(id))
      : [
          ...Array.from({length: 20}, (_, i) => `SRC${i}`).filter(id => this.free(id)),
          ...this.slots.filter(s => s.level === 0 && this.free(s.id)).map(s => s.id)
        ];

    const safeSlotId = bufferCandidates.sort((a, b) => dist(r, this.locations.get(a)) - dist(r, this.locations.get(b)))[0];
    if (!safeSlotId) {
      // Keep pallet on robot until maint if every single buffer slot is full
      return;
    }

    this.move(p, safeSlotId);
    r.carried = null;
    p.job = null;
    j.state = 'DONE';
    j.abortedByRescue = true;
    j.ended = this.time;
    r.task = null;
    r.trajectory = null;
    r.index = 0;

    if (p.outPalletId) {
      const pp = this.plannedPallets.get(p.outPalletId);
      if (pp) {
        pp.reservedTripId = null;
        pp.state = 'STAGED';
      }
    } else if (j.label === 'Cấp nguồn' && oldDest?.kind === 'source') {
      // Re-queue source feed from safeSlotId to target SRC slot if needed
      this.queue(p, j.to, p.location.startsWith('S') ? 'RT' : 'CP', 'Cấp nguồn (sau cứu hộ)', {urgency: 3});
    }
    this.log(`Tổ cứu hộ bàn giao an toàn pallet ${p.id} từ ${r.id} sang ô đệm ${safeSlotId}`);
  }

  advanceMotion() {
    if (this.emergencyStop.active) {
      this.metrics.eStopSeconds++;
    }
    advanceIncidentsOp(this);

    let anyMoved = false;
    for (const r of this.robots.values()) {
      if (!r.active) continue;
      if (['FAULT', 'RESCUE_SETUP', 'TOWING', 'IN_MAINT', 'WAITING_EXTERNAL_ASSISTANCE', 'WAITING_PATH'].includes(r.status)) {
        continue;
      }
      if (this.isRobotStoppedByEStop(r)) {
        r.waiting++;
        continue;
      }

      if (!r.task) {
        r.waiting++;
        // Realistic tiny idle self-drain; transition to BATTERY_DEPLETED fault if ever hits 0%
        const idleDrain = (VEHICLE_SPECS[r.type].idleDrainPctPerHour || 0.25) / 3600;
        r.battery = Math.max(0, r.battery - idleDrain);
        if (r.battery <= 0) {
          this.faultRobot(r.id, {reason: 'BATTERY_DEPLETED (cạn kiệt pin về 0%)', repairMode: 'TOW_TO_MAINT'});
        }
        continue;
      }

      anyMoved = true;
      const prev = {x: r.x, y: r.y};
      const f = r.trajectory[++r.index];
      if (!f) throw Error(`Trajectory overrun on ${r.id}`);
      r.x = f.x;
      r.y = f.y;
      if (f.cos != null) { r.cos = f.cos; r.sin = f.sin; }
      r.currentLiftM = f.liftM || 0;
      r.distance += dist(prev, f);

      const j = r.task;
      if (f.event === 'enter_charger' && j.chargerId) {
        const chg = this.chargers.get(j.chargerId);
        if (chg) chg.state = 'CHARGING';
      }

      if (f.action === 'wait') {
        r.waiting++;
      } else if (f.action === 'charge') {
        r.charging++;
        r.status = 'CHARGING';
        r.battery = Math.min(100, r.battery + 100 / this.config.chargeSeconds);
      } else {
        r.work++;
        r.battery = Math.max(0, r.battery - 100 / this.config.batteryWorkSeconds);
        r.status = 'RUNNING';
      }

      if (f.event === 'charged') {
        r.battery = Math.max(r.battery, j.targetSOC ?? 100);
      }
      if (f.leaveCharger && j.chargerId) {
        const chg = this.chargers.get(j.chargerId);
        if (chg && chg.robotId === r.id) {
          chg.state = 'FREE';
          chg.robotId = null;
        }
      }

      if (f.event === 'pick') {
        const p = this.pallets.get(j.pallet);
        if (!p || p.location !== j.from || r.carried) throw Error(`Pick ownership violation on ${r.id} / ${j.pallet}`);
        this.move(p, r.id);
        r.carried = p.id;
        if (j.from.startsWith('OUT')) {
          const cell = this.cells[Number(j.from.slice(3))];
          cell.state = 'EMPTY';
          cell.orderId = null;
          cell.outPalletId = null;
        }
      }

      if (f.event === 'drop') {
        const p = this.pallets.get(j.pallet);
        const l = this.locations.get(j.to);
        if (!p || !l || l.reservation !== j.id || r.carried !== p.id) {
          throw Error(`Drop reservation violation on ${r.id} -> ${j.to}`);
        }
        this.move(p, j.to);
        l.reservation = null;
        r.carried = null;
        p.job = null;
        j.delivered = this.time;

        if (j.label === 'Cất kệ') this.metrics.stored++;
        if (j.label === 'Trả nguồn') this.metrics.returned++;
        if (j.label.startsWith('Cấp nguồn')) p.lastUsed = this.time;

        if (p.outPalletId) {
          const pp = this.plannedPallets.get(p.outPalletId);
          if (pp && j.to.startsWith('ST')) pp.state = 'STAGED';
        }

        if (j.truck) {
          this.metrics.loaded++;
          if (j.fromOutput) this.metrics.direct++;
          else this.metrics.viaStage++;
          j.truck.pallets.push(p.id);
          j.truck.weight = Number((j.truck.weight + p.weight).toFixed(3));
          j.truck.state = 'LOADING';
          if (p.outPalletId) {
            const pp = this.plannedPallets.get(p.outPalletId);
            if (pp) pp.state = 'LOADED';
          }
          const ord = this.orders.find(o => o.id === p.order);
          if (ord) {
            const allLoaded = ord.plannedPalletIds.every(pid => {
              const planP = this.plannedPallets.get(pid);
              return planP && ['LOADED', 'SHIPPED'].includes(planP.state);
            });
            if (allLoaded) ord.state = 'LOADED';
          }
        }
      }

      if (f.clear) {
        j.cleared = true;
        j.resources = [];
        j.activeCells = [];
        r.returning = true;
      }

      if (r.index === r.trajectory.length - 1) {
        if (j.chargerId) {
          const chg = this.chargers.get(j.chargerId);
          if (chg && chg.robotId === r.id) { chg.state = 'FREE'; chg.robotId = null; }
        }
        j.state = 'DONE';
        j.ended = this.time;
        r.task = null;
        r.trajectory = null;
        r.index = 0;
        r.returning = false;
        r.status = 'IDLE';
      } else if (r.battery <= 0 && !j.charge) {
        this.faultRobot(r.id, {reason: 'BATTERY_DEPLETED (hết pin giữa hành trình)', repairMode: 'TOW_TO_MAINT'});
      }
    }
    if (anyMoved) this.motionTime++;
  }

  // ==================== INBOUND FLOW ====================
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
        remaining: Math.ceil(this.config.receiptSeconds * this.config.humanMultiplier),
        truck: truck.id,
        sku: seqIndex % this.skuCodes.length
      });
    }
  }

  processReceipt() {
    for (let i = this.receipts.length - 1; i >= 0; i--) {
      const q = this.receipts[i];
      if (--q.remaining > 0) continue;
      this.locations.get(q.to).reservation = null;
      const skuCode = this.skuCodes[q.sku];
      const skuMeta = this.skus.get(skuCode);
      const cartons = skuMeta?.maxCartonsPerPallet ?? 60;
      const cWeight = skuMeta?.cartonWeightKg ?? 10;
      this.createPallet({
        sku: q.sku,
        skuCode,
        cartons,
        allocatedCartons: 0,
        kind: 'source',
        accepted: true,
        palletType: 'STD_WOOD',
        tareWeightKg: 25,
        cartonWeightKg: cWeight,
        weight: 25 + cartons * cWeight,
        lot: `IN-${q.truck}`,
        expiry: '2027-09-30',
        qcStatus: 'AVAILABLE'
      }, q.to);
      this.receivedBySKU[q.sku] += cartons;
      this.metrics.received++;
      this.inboundRemaining--;
      const t = this.inboundTrucks.find(x => x.id === q.truck);
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
        const skuMeta = this.skus.get(p.skuCode);
        const prefZone = skuMeta?.preferredZone === 'A' || skuMeta?.preferredZone === 'B'
          ? skuMeta.preferredZone
          : (p.sku % 2 ? 'B' : 'A');
        const to = this.slots.find(s => s.zone === prefZone && this.free(s.id)) || this.slots.find(s => this.free(s.id));
        if (to) this.queue(p, to.id, 'RT', 'Cất kệ', {urgency: 1});
      }
    }
  }

  // ==================== OUTBOUND ORDER RELEASE & SOURCE ALLOCATION ====================
  releaseOrders() {
    if (this.phase !== 'OUTBOUND') return;
    if (!this.syntheticMode) {
      for (const o of this.orders) {
        if (o.state === 'UNRELEASED' && this.time >= o.releaseTimeSec) {
          o.state = 'QUEUED';
        }
      }
      return;
    }

    const c = this.config;
    const elapsed = this.time - this.phaseStart;
    while (
      elapsed < c.outboundSeconds &&
      elapsed >= this.nextSyntheticOrderTime &&
      this.syntheticOrderSeq < c.orderLimit
    ) {
      const k = this.syntheticOrderSeq++;
      const routes = Array.from({length: c.outboundRoutes}, (_, i) => `R${String(i + 1).padStart(2, '0')}`);
      const route = routes[k % routes.length];
      // Support demandSkewA (e.g. 0.8 => 80% Zone A even-indexed SKUs)
      const zoneASkus = this.skuCodes.filter((_, idx) => idx % 2 === 0);
      const zoneBSkus = this.skuCodes.filter((_, idx) => idx % 2 === 1);
      const pickSkewSku = offset => {
        const roll = ((k * 37 + offset * 17) % 100) / 100;
        const pool = roll < c.demandSkewA ? zoneASkus : zoneBSkus;
        return pool[(k + offset) % pool.length];
      };

      const isWhole = k % 10 === 9;
      const isMultiPallet = k % 12 === 4;
      const priority = (k % 6 === 0) ? 4 : 2;
      const ordId = `O${this.orders.length + 1}`;
      const ord = {
        id: ordId,
        storeCode: `WM-${route}-S${(k % 8) + 1}`,
        route,
        releaseTimeSec: this.time,
        created: this.time,
        due: this.time + (priority >= 4 ? 4200 : 7200),
        priority,
        allowSplitTrips: false,
        stopSequence: (k % 4) + 1,
        state: 'QUEUED',
        assignedTripId: null,
        plannedPalletIds: [],
        shippedPalletIds: [],
        plannedCartons: 0,
        shippedCartons: 0,
        completedAt: null,
        latenessSec: 0,
        tripIds: []
      };

      const palletCount = isMultiPallet ? 2 : 1;
      for (let sub = 0; sub < palletCount; sub++) {
        const ppId = `${ordId}_P${sub + 1}`;
        let lines;
        if (isWhole && sub === 0) {
          const sc = pickSkewSku(0);
          lines = [{lineNo: 1, skuCode: sc, qtyCartons: 60, pinnedSourcePalletId: null, minShelfLifeDays: 0}];
        } else if (k % 15 === 7 && sub === 0) {
          // 3-SKU multi-wave mixed pallet
          const s1 = pickSkewSku(0), s2 = pickSkewSku(1);
          const s3 = this.skuCodes[(this.skuIndexMap.get(s2) + 2) % this.skuCodes.length];
          lines = [
            {lineNo: 1, skuCode: s1, qtyCartons: 10, pinnedSourcePalletId: null, minShelfLifeDays: 0},
            {lineNo: 2, skuCode: s2, qtyCartons: 10, pinnedSourcePalletId: null, minShelfLifeDays: 0},
            {lineNo: 3, skuCode: s3, qtyCartons: 10, pinnedSourcePalletId: null, minShelfLifeDays: 0}
          ];
        } else {
          const s1 = pickSkewSku(sub);
          let s2 = pickSkewSku(sub + 1);
          if (s2 === s1) s2 = this.skuCodes[(this.skuIndexMap.get(s1) + 1) % this.skuCodes.length];
          lines = [
            {lineNo: 1, skuCode: s1, qtyCartons: 15, pinnedSourcePalletId: null, minShelfLifeDays: 0},
            {lineNo: 2, skuCode: s2, qtyCartons: 15, pinnedSourcePalletId: null, minShelfLifeDays: 0}
          ];
        }
        const totalC = sum(lines.map(l => l.qtyCartons));
        const pp = {
          id: ppId,
          orderId: ordId,
          route,
          dispatchMode: (isWhole && sub === 0) ? 'WHOLE_PALLET' : 'MIXED_PALLET',
          palletType: 'STD_WOOD',
          tareWeightKg: 25,
          grossWeightKg: 25 + totalC * 10,
          totalCartons: totalC,
          pinnedTripId: null,
          lines,
          allocations: [],
          waveCursor: 0,
          state: 'PLANNED',
          cellId: null,
          physicalPalletId: null,
          reservedTripId: null,
          shippedTripId: null,
          shortageReason: null
        };
        this.plannedPallets.set(ppId, pp);
        ord.plannedPalletIds.push(ppId);
        ord.plannedCartons += totalC;
      }

      this.orders.push(ord);
      if (k + 1 >= c.initialWaveOrders) {
        this.nextSyntheticOrderTime += c.orderInterval;
      }
    }
  }

  rankActiveOutboundPallets(allowWhole = true, allowMixed = true) {
    if (!allowWhole && !allowMixed) return [];
    const baseline = this.config.dispatchPolicy === 'V6_2_BASELINE';
    const candidates = [];
    for (const o of this.orders) {
      if (!['QUEUED', 'IN_PROGRESS'].includes(o.state)) continue;
      for (const pid of o.plannedPalletIds) {
        const pp = this.plannedPallets.get(pid);
        if (!pp || pp.state !== 'PLANNED') continue;
        if (pp.dispatchMode === 'WHOLE_PALLET' && !allowWhole) continue;
        if (pp.dispatchMode !== 'WHOLE_PALLET' && !allowMixed) continue;
        candidates.push({o, pp});
      }
    }
    if (!candidates.length) return candidates;
    return candidates.sort((a, b) => {
      if (baseline) {
        return a.o.created - b.o.created || a.pp.id.localeCompare(b.pp.id);
      }
      // Proposed Least-Slack + Priority + Trip Cutoff Awareness
      const slackA = (a.o.due - this.time) - a.o.priority * 360;
      const slackB = (b.o.due - this.time) - b.o.priority * 360;
      return slackA - slackB || a.o.stopSequence - b.o.stopSequence || a.o.created - b.o.created;
    });
  }

  eligibleSourcePallets(skuCode, minShelfLifeDays = 0, wholeExactQty = null, targetCellId = null) {
    return [...this.pallets.values()].filter(p => {
      if (p.kind !== 'source' || p.qcStatus !== 'AVAILABLE' || p.skuCode !== skuCode) return false;
      if (p.location === 'SHIPPED' || p.location === 'EMPTY_RETURNED') return false;
      if (!this.slotMap.has(p.location) && !String(p.location).startsWith('SRC')) return false;
      if (this.isLocationIsolated(p.location)) return false;
      // Exclusive active reservation: never share a physical pallet across two concurrent cells simultaneously
      if (p.allocatedCartons > 0 || p.job) return false;
      if (String(p.location).startsWith('SRC')) {
        const cId = Math.floor(Number(p.location.slice(3)) / 2);
        if (cId !== targetCellId && ['ASSEMBLING', 'QC_WRAPPING'].includes(this.cells[cId].state)) return false;
      }
      if (daysBetweenIso(this.config.shiftDate, p.expiry) < (minShelfLifeDays || 0)) return false;
      if (wholeExactQty != null) {
        return p.cartons === wholeExactQty;
      }
      return p.cartons > 0;
    });
  }

  allocateSourcesForPlannedPallet(pp, targetCellX = 45.0, targetCellId = null) {
    const baseline = this.config.dispatchPolicy === 'V6_2_BASELINE';
    const useWindowFefo = !baseline && this.config.fefoMode === 'WINDOW_FEFO';
    const tempTakes = new Map(); // palletId -> cartons
    // Count committed allocation decisions only, against stock still available at that decision.
    let windowChoices = 0, earliestChoices = 0;

    if (pp.dispatchMode === 'WHOLE_PALLET') {
      const ln = pp.lines[0];
      let chosen = null;
      let reason = '';
      if (ln.pinnedSourcePalletId) {
        const pinned = this.pallets.get(ln.pinnedSourcePalletId);
        if (pinned && !pinned.job && pinned.allocatedCartons === 0 && pinned.cartons === ln.qtyCartons && !this.isLocationIsolated(pinned.location)) {
          chosen = pinned;
          reason = `Ghim cứng nguồn ${pinned.id} (${pinned.lot})`;
        }
      } else {
        const pool = this.eligibleSourcePallets(ln.skuCode, ln.minShelfLifeDays, ln.qtyCartons);
        if (pool.length) {
          const minExp = pool.reduce((m, p) => (p.expiry < m ? p.expiry : m), pool[0].expiry);
          pool.sort((a, b) => {
            if (useWindowFefo) {
              const inWinA = daysBetweenIso(minExp, a.expiry) <= this.config.fefoWindowDays;
              const inWinB = daysBetweenIso(minExp, b.expiry) <= this.config.fefoWindowDays;
              if (inWinA !== inWinB) return inWinA ? -1 : 1;
              const locA = this.locations.get(a.location), locB = this.locations.get(b.location);
              return Math.abs(locA.x - 72) - Math.abs(locB.x - 72) || a.expiry.localeCompare(b.expiry);
            }
            return a.expiry.localeCompare(b.expiry);
          });
          chosen = pool[0];
          if (useWindowFefo && chosen.expiry !== minExp) this.metrics.windowFefoOptimizations++;
          else this.metrics.strictFefoPicks++;
          reason = useWindowFefo
            ? `WINDOW_FEFO(${this.config.fefoWindowDays}d): nguyên pallet ${chosen.id} hạn ${chosen.expiry} gần khu ST`
            : `STRICT_FEFO: nguyên pallet ${chosen.id} hạn sớm nhất ${chosen.expiry}`;
        }
      }
      if (!chosen) return {ok: false, shortage: !this.anyStockRemainingForSku(ln.skuCode, ln.qtyCartons, true)};
      chosen.allocatedCartons += ln.qtyCartons;
      pp.allocations = [{
        outPalletId: pp.id,
        orderId: pp.orderId,
        dispatchMode: 'WHOLE_PALLET',
        lineNo: ln.lineNo,
        skuCode: ln.skuCode,
        qtyCartons: ln.qtyCartons,
        sourcePalletId: chosen.id,
        lotCode: chosen.lot,
        expiryDate: chosen.expiry,
        status: 'ALLOCATED',
        decisionReason: reason
      }];
      pp.physicalPalletId = chosen.id;
      return {ok: true};
    }

    // MIXED_PALLET: may allocate 1 or multiple source pallets per line (SourceAllocation[])
    const plannedAllocs = [];
    for (const ln of pp.lines) {
      let rem = ln.qtyCartons;
      if (ln.pinnedSourcePalletId) {
        const pinned = this.pallets.get(ln.pinnedSourcePalletId);
        const already = tempTakes.get(pinned?.id) || 0;
        const avail = pinned ? (pinned.cartons - pinned.allocatedCartons - already) : 0;
        if (!pinned || avail < rem || this.isLocationIsolated(pinned.location)) {
          return {ok: false, shortage: !pinned || (pinned.cartons - pinned.allocatedCartons) < rem};
        }
        tempTakes.set(pinned.id, already + rem);
        plannedAllocs.push({
          outPalletId: pp.id,
          orderId: pp.orderId,
          dispatchMode: 'MIXED_PALLET',
          lineNo: ln.lineNo,
          skuCode: ln.skuCode,
          qtyCartons: rem,
          sourcePalletId: pinned.id,
          lotCode: pinned.lot,
          expiryDate: pinned.expiry,
          status: 'ALLOCATED',
          decisionReason: `Ghim cứng nguồn ${pinned.id}`
        });
        continue;
      }

      const pool = this.eligibleSourcePallets(ln.skuCode, ln.minShelfLifeDays, null, targetCellId)
        .filter(p => (p.cartons - p.allocatedCartons - (tempTakes.get(p.id) || 0)) > 0);
      if (!pool.length) {
        return {ok: false, shortage: !this.anyStockRemainingForSku(ln.skuCode, rem, false)};
      }
      while (rem > 0) {
        const remaining = pool.filter(p => p.cartons - p.allocatedCartons - (tempTakes.get(p.id) || 0) > 0);
        if (!remaining.length) break;
        // Re-anchor the expiry window after each source is exhausted.
        const minExp = remaining.reduce((m, p) => p.expiry < m ? p.expiry : m, remaining[0].expiry);
        remaining.sort((a, b) => {
        const remA = a.cartons - a.allocatedCartons - (tempTakes.get(a.id) || 0);
        const remB = b.cartons - b.allocatedCartons - (tempTakes.get(b.id) || 0);
        if (useWindowFefo) {
          const inWinA = daysBetweenIso(minExp, a.expiry) <= this.config.fefoWindowDays;
          const inWinB = daysBetweenIso(minExp, b.expiry) <= this.config.fefoWindowDays;
          if (inWinA !== inWinB) return inWinA ? -1 : 1;
          // Strongly prefer pallet already sitting in targetCellId's own SRC slots, then any SRC, then single-pallet fit & proximity
          const sameCellA = (targetCellId != null && (a.location === `SRC${2 * targetCellId}` || a.location === `SRC${2 * targetCellId + 1}`)) ? 1 : 0;
          const sameCellB = (targetCellId != null && (b.location === `SRC${2 * targetCellId}` || b.location === `SRC${2 * targetCellId + 1}`)) ? 1 : 0;
          if (sameCellA !== sameCellB) return sameCellB - sameCellA;
          const atSrcA = String(a.location).startsWith('SRC') ? 1 : 0;
          const atSrcB = String(b.location).startsWith('SRC') ? 1 : 0;
          if (atSrcA !== atSrcB) return atSrcB - atSrcA;
          const fitA = remA >= rem ? 1 : 0, fitB = remB >= rem ? 1 : 0;
          if (fitA !== fitB) return fitB - fitA;
          if (fitA && fitB && (remA <= 30) !== (remB <= 30)) return remA - remB;
          const da = Math.abs(this.locations.get(a.location).x - targetCellX);
          const db = Math.abs(this.locations.get(b.location).x - targetCellX);
          return da - db || a.expiry.localeCompare(b.expiry);
        }
        return a.expiry.localeCompare(b.expiry) || remA - remB;
      });

        const cand = remaining[0];
        const already = tempTakes.get(cand.id) || 0;
        const avail = cand.cartons - cand.allocatedCartons - already;
        if (avail <= 0) continue;
        const take = Math.min(rem, avail);
        const remainingPool = pool.filter(p => p.cartons - p.allocatedCartons - (tempTakes.get(p.id) || 0) > 0);
        const earliestAvailableExpiry = remainingPool.reduce((m, p) => p.expiry < m ? p.expiry : m, cand.expiry);
        const windowChoice = useWindowFefo && cand.expiry > earliestAvailableExpiry &&
          daysBetweenIso(earliestAvailableExpiry, cand.expiry) <= this.config.fefoWindowDays;
        if (windowChoice) windowChoices++;
        else if (cand.expiry === earliestAvailableExpiry) earliestChoices++;
        tempTakes.set(cand.id, already + take);
        rem -= take;
        plannedAllocs.push({
          outPalletId: pp.id,
          orderId: pp.orderId,
          dispatchMode: 'MIXED_PALLET',
          lineNo: ln.lineNo,
          skuCode: ln.skuCode,
          qtyCartons: take,
          sourcePalletId: cand.id,
          lotCode: cand.lot,
          expiryDate: cand.expiry,
          earliestAvailableExpiry,
          windowChoice,
          status: 'ALLOCATED',
          decisionReason: useWindowFefo
            ? `WINDOW_FEFO(${this.config.fefoWindowDays}d): rút ${take} kiện từ ${cand.id} (${cand.lot}, hạn ${cand.expiry})`
            : `STRICT_FEFO: rút ${take} kiện từ ${cand.id} hạn sớm nhất ${cand.expiry}`
        });
      }

      if (rem > 0) {
        return {ok: false, shortage: !this.anyStockRemainingForSku(ln.skuCode, ln.qtyCartons, false)};
      }
    }

    // Commit reservations atomically
    for (const [pid, qty] of tempTakes.entries()) {
      this.pallets.get(pid).allocatedCartons += qty;
    }
    pp.allocations = plannedAllocs;
    this.metrics.windowFefoOptimizations += windowChoices;
    this.metrics.strictFefoPicks += earliestChoices;
    if (plannedAllocs.length > 2) this.metrics.multiWavePallets++;
    return {ok: true};
  }

  anyStockRemainingForSku(skuCode, neededQty, wholeOnly) {
    const anyIsolatedOrBusy = [...this.pallets.values()].filter(p =>
      p.kind === 'source' &&
      p.qcStatus === 'AVAILABLE' &&
      p.skuCode === skuCode &&
      !['SHIPPED', 'EMPTY_RETURNED'].includes(p.location) &&
      (p.cartons - p.allocatedCartons) > 0
    );
    if (wholeOnly) return anyIsolatedOrBusy.some(p => p.allocatedCartons === 0 && p.cartons === neededQty);
    return sum(anyIsolatedOrBusy.map(p => p.cartons - p.allocatedCartons)) >= neededQty;
  }

  planOutbound(acceptNew = true) {
    if (acceptNew) {
      let freeStages = Array.from({length: 12}, (_, i) => `ST${i}`).filter(id => this.free(id));
      let emptyCells = this.cells.filter(c => c.state === 'EMPTY' && !this.isCellIsolated(c.id));

      for (const {o, pp} of this.rankActiveOutboundPallets(freeStages.length > 0, emptyCells.length > 0)) {
        if (!freeStages.length && !emptyCells.length) break;

        if (pp.dispatchMode === 'WHOLE_PALLET') {
          if (!freeStages.length) continue;
          const res = this.allocateSourcesForPlannedPallet(pp, 72.0);
          if (!res.ok) {
            if (res.shortage) this.markPalletShortage(o, pp, 'Thiếu pallet nguyên khớp quy cách');
            continue;
          }
          const srcPallet = this.pallets.get(pp.physicalPalletId);
          const destSt = freeStages.shift();
          srcPallet.order = o.id;
          srcPallet.outPalletId = pp.id;
          srcPallet.route = o.route;
          const urgency = this.config.dispatchPolicy === 'V6_2_BASELINE' ? 1 : Math.max(1, Math.min(5, o.priority));
          if (this.queue(srcPallet, destSt, srcPallet.location.startsWith('SRC') ? 'CP' : 'RT', 'Xuất nguyên pallet', {
            urgency,
            decisionReason: pp.allocations[0]?.decisionReason
          })) {
            pp.state = 'MOVING_WHOLE';
            pp.allocations[0].status = 'PICKED';
            srcPallet.allocatedCartons = 0; // Ownership transferred whole to order
            if (o.state === 'QUEUED') o.state = 'IN_PROGRESS';
          } else {
            // Rollback if queue failed
            srcPallet.order = null;
            srcPallet.outPalletId = null;
            srcPallet.allocatedCartons = 0;
            pp.allocations = [];
            pp.physicalPalletId = null;
          }
          continue;
        }

        if (!emptyCells.length) continue;
        const cell = emptyCells[0];
        const res = this.allocateSourcesForPlannedPallet(pp, cell.x, cell.id);
        if (!res.ok) {
          if (res.shortage) this.markPalletShortage(o, pp, 'Không đủ kiện tồn khả dụng theo hạn dùng');
          continue;
        }
        emptyCells.shift();
        cell.state = 'PREPARING';
        cell.orderId = o.id;
        cell.outPalletId = pp.id;
        pp.cellId = cell.id;
        pp.waveCursor = 0;
        pp.state = 'IN_CELL';
        if (o.state === 'QUEUED') o.state = 'IN_PROGRESS';
        this.assignNextCellWave(cell, pp);
      }
    }

    // Feed active PREPARING cells (and evict leftover pallets from prior orders occupying SRC_{2c}, SRC_{2c+1})
    for (const c of this.cells) {
      if (c.state !== 'PREPARING' || this.isCellIsolated(c.id)) continue;
      const wantedIds = new Set(c.waveItems.map(w => w.sourcePalletId));

      for (const sId of [`SRC${2 * c.id}`, `SRC${2 * c.id + 1}`]) {
        const occ = this.at(sId);
        if (!occ || occ.job || occ.allocatedCartons > 0 || wantedIds.has(occ.id)) continue;
        if (occ.cartons === 0) {
          if (!occ.emptySince) occ.emptySince = this.time;
          if (this.time - occ.emptySince >= Math.ceil(this.config.emptyCollectSeconds * this.config.humanMultiplier)) {
            this.move(occ, 'EMPTY_RETURNED');
            this.metrics.emptyCollected++;
          }
        } else {
          const skuMeta = this.skus.get(occ.skuCode);
          const prefZ = skuMeta?.preferredZone === 'A' || skuMeta?.preferredZone === 'B' ? skuMeta.preferredZone : 'A';
          const rackSlot = this.pickFreeReturnSlot(prefZ, this.locations.get(sId)?.x ?? 45);
          if (rackSlot) {
            this.queue(occ, rackSlot.id, 'RT', 'Trả nguồn', {
              urgency: 3,
              decisionReason: `Giải phóng ${sId} cho đợt ghép mới tại cụm G${c.id}`
            });
          }
        }
      }

      for (const item of c.waveItems) {
        if (item.targetSrcSlot && this.at(item.targetSrcSlot)?.id === item.sourcePalletId) continue;
        const srcP = this.pallets.get(item.sourcePalletId);
        if (!srcP || srcP.job) continue;
        if (String(srcP.location).startsWith('SRC') && Math.floor(Number(srcP.location.slice(3)) / 2) === c.id) {
          item.targetSrcSlot = srcP.location;
          continue;
        }
        const freeSlot = [`SRC${2 * c.id}`, `SRC${2 * c.id + 1}`].find(s => this.free(s));
        if (freeSlot) {
          const mover = String(srcP.location).startsWith('SRC') ? 'CP' : 'RT';
          if (this.queue(srcP, freeSlot, mover, 'Cấp nguồn', {urgency: 2, decisionReason: item.decisionReason})) {
            item.targetSrcSlot = freeSlot;
          }
        }
      }
    }
  }

  markPalletShortage(order, pp, reason) {
    pp.state = 'UNFULFILLED_SHORTAGE';
    pp.shortageReason = reason;
    const allResolved = order.plannedPalletIds.every(id => {
      const p = this.plannedPallets.get(id);
      return p && ['SHIPPED', 'UNFULFILLED_SHORTAGE'].includes(p.state);
    });
    if (allResolved) {
      order.state = order.shippedPalletIds.length > 0 ? 'PARTIALLY_SHIPPED' : 'UNFULFILLED_SHORTAGE';
    }
    this.log(`Cảnh báo thiếu hụt đơn ${order.id} (${pp.id}): ${reason}`);
  }

  assignNextCellWave(cell, pp) {
    // Reorder unpicked tail so any allocated source pallet already sitting in THIS cell's SRC slots is picked in the immediate wave!
    const head = pp.allocations.slice(0, pp.waveCursor);
    const remaining = pp.allocations.slice(pp.waveCursor).sort((a, b) => {
      const inCellA = [`SRC${2 * cell.id}`, `SRC${2 * cell.id + 1}`].includes(this.pallets.get(a.sourcePalletId)?.location) ? 1 : 0;
      const inCellB = [`SRC${2 * cell.id}`, `SRC${2 * cell.id + 1}`].includes(this.pallets.get(b.sourcePalletId)?.location) ? 1 : 0;
      return inCellB - inCellA || a.lineNo - b.lineNo;
    });
    pp.allocations = [...head, ...remaining];

    // Group remaining unpicked allocations by distinct sourcePalletId (up to 2 distinct source pallets per wave)
    const distinctIds = [];
    const waveItems = [];
    for (const al of remaining) {
      if (!distinctIds.includes(al.sourcePalletId)) {
        if (distinctIds.length >= 2) break;
        distinctIds.push(al.sourcePalletId);
      }
      waveItems.push(al);
    }
    cell.waveItems = waveItems;
    cell.state = 'PREPARING';
  }

  processAssembly() {
    for (const c of this.cells) {
      if (this.isCellIsolated(c.id)) continue;
      const pp = c.outPalletId ? this.plannedPallets.get(c.outPalletId) : null;

      // 1. Handle WAVE_CHANGEOVER: clear unneeded pallets from SRC_{2c}, SRC_{2c+1} before starting next wave
      if (c.state === 'WAVE_CHANGEOVER' && pp) {
        const nextRemaining = pp.allocations.slice(pp.waveCursor);
        const nextSourceIds = new Set(nextRemaining.slice(0, 2).map(a => a.sourcePalletId));
        let neededFreeSlots = [...nextSourceIds].filter(sid => {
          const loc = this.pallets.get(sid)?.location;
          return loc !== `SRC${2 * c.id}` && loc !== `SRC${2 * c.id + 1}`;
        }).length;

        let freeCount = 0;
        for (const sId of [`SRC${2 * c.id}`, `SRC${2 * c.id + 1}`]) {
          const p = this.at(sId);
          if (!p && !this.locations.get(sId).reservation) {
            freeCount++;
            continue;
          }
          if (p && !p.job && !nextSourceIds.has(p.id)) {
            if (p.cartons === 0) {
              if (!p.emptySince) p.emptySince = this.time;
              if (this.time - p.emptySince >= Math.ceil(this.config.emptyCollectSeconds * this.config.humanMultiplier)) {
                this.move(p, 'EMPTY_RETURNED');
                this.metrics.emptyCollected++;
                freeCount++;
              }
            } else {
              const skuMeta = this.skus.get(p.skuCode);
              const prefZ = skuMeta?.preferredZone === 'A' || skuMeta?.preferredZone === 'B' ? skuMeta.preferredZone : 'A';
              const slot = this.slots.find(s => s.zone === prefZ && this.free(s.id)) || this.slots.find(s => this.free(s.id));
              if (slot) this.queue(p, slot.id, 'RT', 'Trả nguồn', {urgency: 3});
            }
          }
        }
        if (freeCount >= neededFreeSlots) {
          this.assignNextCellWave(c, pp);
        }
        continue;
      }

      // 2. Transition PREPARING -> ASSEMBLING when wave sources are physically at cell & no robot active in cell
      if (c.state === 'PREPARING' && pp) {
        const distinctWaveSources = [...new Set(c.waveItems.map(w => w.sourcePalletId))];
        const allPresent = distinctWaveSources.every(sid => {
          const p = this.pallets.get(sid);
          return p && !p.job && (p.location === `SRC${2 * c.id}` || p.location === `SRC${2 * c.id + 1}`);
        });
        const outPallet = this.at(`OUT${c.id}`);
        const outReady = (pp.waveCursor === 0 && this.free(`OUT${c.id}`)) ||
          (pp.waveCursor > 0 && outPallet && outPallet.id === pp.physicalPalletId);
        const robotClear = ![...this.robots.values()].some(r => r.active && r.task?.activeCells?.includes(c.id));
        const freeTeams = this.workerTeams.filter(t => t.busyCell === null).sort((a, b) => Math.abs(a.x - c.x) - Math.abs(b.x - c.x));

        if (allPresent && outReady && robotClear && freeTeams.length > 0) {
          const team = freeTeams[0];
          const walkSec = Math.ceil((Math.abs(team.x - c.x) / this.config.workerWalkSpeedMps) * this.config.humanMultiplier);
          const waveCartons = sum(c.waveItems.map(w => w.qtyCartons));
          const setupSec = pp.waveCursor === 0 ? this.config.assemblyBaseSeconds : 40;
          c.remaining = walkSec + Math.ceil((setupSec + waveCartons * this.config.pickSecondsPerCarton) * this.config.humanMultiplier);
          c.state = 'ASSEMBLING';
          c.team = team.id;
          team.busyCell = c.id;
          team.x = c.x;
          if (pp.waveCursor === 0) {
            this.locations.get(`OUT${c.id}`).reservation = `ASSEMBLY${c.id}`;
          }
        }
      }

      // 3. Execute ASSEMBLING countdown
      if (c.state === 'ASSEMBLING' && pp && --c.remaining <= 0) {
        const team = this.workerTeams[c.team];
        if (team) team.busyCell = null;
        c.team = null;

        let outP = pp.physicalPalletId ? this.pallets.get(pp.physicalPalletId) : null;
        if (!outP) {
          this.locations.get(`OUT${c.id}`).reservation = null;
          outP = this.createPallet({
            kind: 'finished',
            sku: null,
            skuCode: null,
            cartons: 0,
            composition: [],
            palletType: pp.palletType,
            tareWeightKg: pp.tareWeightKg,
            weight: pp.tareWeightKg,
            order: pp.orderId,
            outPalletId: pp.id,
            route: pp.route,
            checked: false
          }, `OUT${c.id}`);
          pp.physicalPalletId = outP.id;
        }

        for (const item of c.waveItems) {
          const sp = this.pallets.get(item.sourcePalletId);
          if (!sp || sp.cartons < item.qtyCartons) throw Error(`Nguồn ghép thiếu kiện tại cụm G${c.id}`);
          const skuIdx = this.skuIndexMap.get(item.skuCode);
          const cWeight = this.skus.get(item.skuCode)?.cartonWeightKg ?? 10;
          sp.cartons -= item.qtyCartons;
          sp.allocatedCartons = Math.max(0, sp.allocatedCartons - item.qtyCartons);
          sp.composition[0].cartons -= item.qtyCartons;
          sp.weight = Number((sp.tareWeightKg + sp.cartons * cWeight).toFixed(3));
          sp.lastUsed = this.time;

          outP.cartons += item.qtyCartons;
          outP.weight = Number((outP.weight + item.qtyCartons * cWeight).toFixed(3));
          const existingComp = outP.composition.find(x => x.skuCode === item.skuCode && x.lot === item.lotCode);
          if (existingComp) existingComp.cartons += item.qtyCartons;
          else outP.composition.push({sku: skuIdx, skuCode: item.skuCode, cartons: item.qtyCartons, lot: item.lotCode, expiry: item.expiryDate});
          item.status = 'PICKED';
          pp.waveCursor++;
        }
        c.waveItems = [];

        if (pp.waveCursor < pp.allocations.length) {
          c.state = 'WAVE_CHANGEOVER';
        } else {
          this.metrics.assembled++;
          pp.assembledAt = this.time;
          c.state = 'QC_PENDING';
        }
      }

      // 4. QC & Stretch-Wrap Stage (QC_PENDING -> QC_WRAPPING -> COMPLETE)
      if (c.state === 'QC_PENDING' && pp) {
        const freeQc = this.qcPool.find(q => q.busyCell === null);
        if (freeQc) {
          freeQc.busyCell = c.id;
          c.qcInspector = freeQc.id;
          c.remaining = Math.max(1, Math.ceil(this.config.qcWrapSeconds * this.config.humanMultiplier));
          c.state = 'QC_WRAPPING';
        }
      } else if (c.state === 'QC_WRAPPING' && pp && --c.remaining <= 0) {
        const qc = this.qcPool[c.qcInspector];
        if (qc) qc.busyCell = null;
        c.qcInspector = null;
        const outP = this.pallets.get(pp.physicalPalletId);
        if (outP) outP.checked = true;
        pp.state = 'QC_PASSED';
        pp.qcPassedAt = this.time;
        c.state = 'COMPLETE';
        this.metrics.qcPassed++;
        const ord = this.orders.find(o => o.id === pp.orderId);
        if (ord && ord.plannedPalletIds.every(pid => {
          const p = this.plannedPallets.get(pid);
          return p && ['QC_PASSED', 'STAGED', 'MOVING_WHOLE', 'LOADED', 'SHIPPED'].includes(p.state);
        })) {
          ord.state = 'QC_PASSED';
        }
      }
    }

    this.metrics.maxAssembly = Math.max(
      this.metrics.maxAssembly,
      this.cells.filter(c => c.state === 'ASSEMBLING').length
    );
  }

  pickFreeReturnSlot(prefZone, refX = 45) {
    const busyAisles = new Set();
    for (const j of this.jobs) {
      if (j.state === 'DONE' || j.type !== 'RT') continue;
      const a1 = this.slotMap.get(j.from)?.aisle;
      const a2 = this.slotMap.get(j.to)?.aisle;
      if (a1 != null) busyAisles.add(a1);
      if (a2 != null) busyAisles.add(a2);
    }
    let best = null;
    let bestScore = Infinity;
    for (const s of this.slots) {
      if (!this.free(s.id)) continue;
      const zonePen = s.zone === prefZone ? 0 : 80;
      const busyPen = busyAisles.has(s.aisle) ? 45 : 0;
      const score = zonePen + busyPen + Math.abs(s.x - refX) + s.level * 6 + (s.y - LAYOUT.frontY) * 0.25;
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  returnSources(force = false) {
    for (let i = 0; i < 20; i++) {
      const p = this.at(`SRC${i}`);
      if (!p || p.job) continue;
      const c = this.cells[Math.floor(i / 2)];
      if (['PREPARING', 'ASSEMBLING', 'WAVE_CHANGEOVER'].includes(c.state)) continue;
      if (p.cartons === 0) {
        if (!p.emptySince) p.emptySince = this.time;
        if (this.time - p.emptySince >= Math.ceil(this.config.emptyCollectSeconds * this.config.humanMultiplier)) {
          this.move(p, 'EMPTY_RETURNED');
          this.metrics.emptyCollected++;
        }
        continue;
      }
      if (p.allocatedCartons > 0) continue;
      const stillDemanded = [...this.plannedPallets.values()].some(pp =>
        pp.state === 'PLANNED' && pp.lines.some(ln => ln.skuCode === p.skuCode)
      );
      const cellPressure = this.cells.filter(x => x.state === 'EMPTY').length <= 2;
      if (force || (!stillDemanded && (cellPressure || this.time - (p.lastUsed ?? 0) > 1500))) {
        const skuMeta = this.skus.get(p.skuCode);
        const prefZone = skuMeta?.preferredZone === 'A' || skuMeta?.preferredZone === 'B' ? skuMeta.preferredZone : 'A';
        const slot = this.pickFreeReturnSlot(prefZone, this.locations.get(`SRC${i}`)?.x ?? 45);
        if (slot) this.queue(p, slot.id, 'RT', 'Trả nguồn', {urgency: force ? 3 : 0});
      }
    }
  }

  // ==================== YARD & MULTI-TRIP TRUCK LIFECYCLE ====================
  activeTrucks() {
    return this.trucks.filter(t => ['DOCKING', 'READY', 'LOADING', 'DOCK_HOLD_FAULT'].includes(t.state));
  }

  yardTrucks() {
    return this.trucks.filter(t => t.state === 'AT_YARD');
  }

  currentTruck() {
    const active = this.activeTrucks();
    return active.find(t => t.state === 'LOADING') || active.find(t => t.state === 'READY') || active[0] || null;
  }

  processTrucks() {
    // 1. Move newly arrived trucks into AT_YARD queue
    for (const t of this.trucks) {
      if (t.state === 'NOT_ARRIVED' && this.time >= t.arrivalTimeSec) {
        t.state = 'AT_YARD';
        t.arrived = this.time;
        t.history.push(['AT_YARD', this.time]);
      }
    }
    this.metrics.maxYardQueue = Math.max(this.metrics.maxYardQueue, this.yardTrucks().length);

    // 2. Call AT_YARD trucks into free outbound docks (up to activeOutboundDocks; multiple active trips per route allowed!)
    const canCallDocks = this.phase === 'OUTBOUND' || (this.phase === 'TRANSITION' && this.previousPhase === 'OUTBOUND');
    if (canCallDocks) {
      const maxDocks = Math.min(LAYOUT.outboundDockXs.length, this.config.activeOutboundDocks);
      const occupiedBays = new Set(this.activeTrucks().map(t => t.bay));
      const baseline = this.config.dispatchPolicy === 'V6_2_BASELINE';

      const yardQueue = [...this.yardTrucks()].sort((a, b) => {
        if (baseline) return a.arrivalTimeSec - b.arrivalTimeSec || a.id.localeCompare(b.id);
        const readyForRoute = r => [...this.plannedPallets.values()].filter(pp =>
          pp.route === r && ['QC_PASSED', 'STAGED', 'IN_CELL', 'MOVING_WHOLE'].includes(pp.state)
        ).length;
        const scoreA = (a.committedDepartureSec - this.time) - readyForRoute(a.route) * 180;
        const scoreB = (b.committedDepartureSec - this.time) - readyForRoute(b.route) * 180;
        return scoreA - scoreB || a.arrivalTimeSec - b.arrivalTimeSec;
      });

      for (const t of yardQueue) {
        if (occupiedBays.size >= maxDocks) break;
        // In V6_2_PROPOSED, consolidate trips: hold second truck of same route in yard while active docked trip still has >=2 open slots
        if (!baseline && t.pinnedBay == null && (t.committedDepartureSec - this.time) > 900) {
          const openSameRoute = this.activeTrucks().some(d =>
            d.route === t.route && !d.closing && (d.maxPalletSlots - d.reservedPallets.length) >= 2
          );
          if (openSameRoute) continue;
        }
        const availableBays = Array.from({length: maxDocks}, (_, b) => b).filter(b => !occupiedBays.has(b));
        if (!availableBays.length) break;

        let chosenBay = null;
        let reason = '';
        if (t.pinnedBay != null) {
          if (t.pinnedBay < maxDocks && !occupiedBays.has(t.pinnedBay)) {
            chosenBay = t.pinnedBay;
            reason = `Ghim cứng bến DX${chosenBay + 1} theo kế hoạch`;
          } else {
            continue; // Wait in yard until pinned dock frees up
          }
        } else if (baseline) {
          chosenBay = availableBays[0];
          reason = `FIFO bãi chờ -> bến trống đầu tiên DX${chosenBay + 1}`;
        } else {
          // Choose dock closest to centroid of staged/ready pallets for t.route
          const routePallets = [...this.pallets.values()].filter(p =>
            p.route === t.route && (String(p.location).startsWith('OUT') || String(p.location).startsWith('ST'))
          );
          const targetX = routePallets.length
            ? sum(routePallets.map(p => this.locations.get(p.location).x)) / routePallets.length
            : (t.id.charCodeAt(t.id.length - 1) % 2 === 0 ? 45.0 : 72.0);
          availableBays.sort((a, b) => Math.abs(LAYOUT.outboundDockXs[a] - targetX) - Math.abs(LAYOUT.outboundDockXs[b] - targetX));
          chosenBay = availableBays[0];
          reason = `Ưu tiên hạn rời ${t.committedDepartureSec}s & chọn DX${chosenBay + 1} gần cụm hàng (x≈${targetX.toFixed(1)}m)`;
        }

        occupiedBays.add(chosenBay);
        t.bay = chosenBay;
        t.dockX = LAYOUT.outboundDockXs[chosenBay];
        t.dockCode = `DX${chosenBay + 1}`;
        t.state = 'DOCKING';
        t.dockedAt = this.time;
        t.readyAt = this.time + 60;
        t.decisionReason = reason;
        t.history.push(['DOCKING', this.time]);
        this.recordDecision('DOCK_ASSIGN', `${t.id}->${t.dockCode}`, reason);

        for (let i = 0; i < t.maxPalletSlots; i++) {
          this.locations.set(`${t.id}_${i}`, {
            id: `${t.id}_${i}`,
            x: t.dockX,
            y: Number((-5.6 + i * 1.3).toFixed(2)),
            kind: 'truck',
            truck: t.id,
            index: i,
            pallet: null,
            reservation: null
          });
        }
      }
    }

    // 3. Advance docked trucks & enforce strict committed_departure_sec cutoff (NEVER auto-extend!)
    for (const t of this.activeTrucks()) {
      if (t.state === 'DOCKING' && this.time >= t.readyAt) {
        t.state = 'READY';
        t.history.push(['READY', this.time]);
      }

      const effectiveCutoff = t.dockedAt != null
        ? Math.min(t.committedDepartureSec, t.dockedAt + t.maxWaitLoadingSec)
        : t.committedDepartureSec;

      const cutoffReached =
        this.time >= effectiveCutoff ||
        (t.latePolicy === 'DEPART_WHEN_FULL_OR_CUTOFF' && t.pallets.length >= t.maxPalletSlots) ||
        this.phase === 'TRANSITION';

      if (cutoffReached && !t.closing) {
        t.closing = true;
        // Cancel any QUEUED (not yet started) CP jobs targeting this closing truck so pallets stay safely at OUT/ST
        for (const j of this.jobs) {
          if (j.truck?.id === t.id && j.state === 'QUEUED') {
            const p = this.pallets.get(j.pallet);
            const dest = this.locations.get(j.to);
            if (dest && dest.reservation === j.id) dest.reservation = null;
            if (p && p.job === j.id) p.job = null;
            j.state = 'DONE';
            j.cancelledAtCutoff = true;
            const rIdx = t.reservedPallets.indexOf(j.pallet);
            if (rIdx >= 0) {
              t.reservedPallets.splice(rIdx, 1);
              t.reservedWeight = Math.max(0, t.reservedWeight - (p?.weight || 0));
            }
            if (p?.outPalletId) {
              const pp = this.plannedPallets.get(p.outPalletId);
              if (pp) pp.reservedTripId = null;
            }
          }
        }
      }

      if (!t.closing) continue;

      // Truck CANNOT depart while a robot is faulted in bed (DOCK_HOLD_FAULT) or actively inside/entering truck bed!
      if (t.state === 'DOCK_HOLD_FAULT') continue;
      const robotStillOnDock = this.jobs.some(j => j.truck?.id === t.id && j.state === 'RUNNING' && !j.cleared);
      if (robotStillOnDock) continue;

      const n = t.pallets.length;

      t.state = 'DEPARTED';
      t.departed = this.time;
      t.closedEmpty = n === 0;
      t.departureLatenessSec = Math.max(0, this.time - t.committedDepartureSec);
      t.history.push(['DEPARTED', this.time]);

      if (!t.closedEmpty) {
        for (const pid of t.pallets) {
          const p = this.pallets.get(pid);
          this.move(p, 'SHIPPED');
          for (const x of p.composition) {
            const sIdx = x.sku ?? this.skuIndexMap.get(x.skuCode);
            if (sIdx != null) this.shippedBySKU[sIdx] += x.cartons;
          }
          this.metrics.departed++;
          const pp = p.outPalletId ? this.plannedPallets.get(p.outPalletId) : null;
          if (pp) {
            pp.state = 'SHIPPED';
            pp.shippedAt = this.time;
            pp.shippedTripId = t.id;
            for (const al of pp.allocations) al.tripId = t.id;
          }
          const o = this.orders.find(ord => ord.id === p.order);
          if (o) {
            if (!o.shippedPalletIds.includes(pp?.id || p.id)) o.shippedPalletIds.push(pp?.id || p.id);
            o.shippedCartons += p.cartons;
            if (!o.tripIds.includes(t.id)) o.tripIds.push(t.id);
            if (o.shippedPalletIds.length >= o.plannedPalletIds.length) {
              o.state = 'SHIPPED';
              o.completedAt = this.time;
              o.latenessSec = Math.max(0, this.time - o.due);
            } else {
              o.state = 'PARTIALLY_SHIPPED';
            }
          }
        }
        t.cartons = sum(t.pallets.map(id => this.pallets.get(id).cartons));
        this.log(`${t.id} (${t.dockCode}, tuyến ${t.route}) rời kho lúc ${this.time}s: ${n} pallet, ${t.cartons} kiện${t.departureLatenessSec > 0 ? ` [trễ ${t.departureLatenessSec}s do an toàn]` : ''}`);
      }
    }

    this.metrics.maxActiveDocks = Math.max(this.metrics.maxActiveDocks, this.activeTrucks().length);
  }

  findEligibleTripForPallet(p) {
    const ord = p.order ? this.orders.find(o => o.id === p.order) : null;
    const pp = p.outPalletId ? this.plannedPallets.get(p.outPalletId) : null;
    if (!ord) return null;

    const candidates = this.activeTrucks().filter(t => {
      if (!['READY', 'LOADING'].includes(t.state) || t.closing) return false;
      if (t.route !== ord.route) return false;
      if (pp?.pinnedTripId && t.id !== pp.pinnedTripId) return false;
      if (!ord.allowSplitTrips && ord.assignedTripId && ord.assignedTripId !== t.id) return false;

      // Ensure enough time before effective cutoff (and shift end) to physically load sequential pallets
      const shiftCutoff = this.phaseStart + this.config.outboundSeconds;
      const effectiveCutoff = Math.min(
        shiftCutoff,
        t.dockedAt != null ? Math.min(t.committedDepartureSec, t.dockedAt + t.maxWaitLoadingSec) : t.committedDepartureSec
      );
      const neededWindowSec = (!ord.allowSplitTrips && ord.plannedPalletIds.length > 1)
        ? 220 * Math.max(1, ord.plannedPalletIds.length - ord.shippedPalletIds.length)
        : 105;
      if (effectiveCutoff - this.time < neededWindowSec) return false;

      if (!ord.allowSplitTrips && !ord.assignedTripId) {
        // Unsplit multi-pallet order: verify ALL sibling pallets are physically ready on floor buffers (OUT/ST)
        // and this trip has enough remaining slots & weight for the ENTIRE order so cutoff can never split them!
        const siblingPps = ord.plannedPalletIds.map(id => this.plannedPallets.get(id));
        const allSiblingsReadyOnFloor = siblingPps.every(s => {
          if (!s?.physicalPalletId) return false;
          const sp = this.pallets.get(s.physicalPalletId);
          if (!sp || sp.job) return false;
          const onOut = String(sp.location).startsWith('OUT') && this.config.direct;
          const onSt = String(sp.location).startsWith('ST');
          return (onOut || onSt) && (sp.kind !== 'finished' || sp.checked) && !this.isLocationIsolated(sp.location);
        });
        if (!allSiblingsReadyOnFloor && ord.plannedPalletIds.length > 1) return false;
        const remSlots = t.maxPalletSlots - t.reservedPallets.length;
        const remWeight = t.payload - t.reservedWeight;
        const totalOrdWeight = sum(siblingPps.map(s => s?.grossWeightKg || p.weight));
        if (remSlots < ord.plannedPalletIds.length || remWeight + 1e-6 < totalOrdWeight) return false;
      } else {
        if (t.reservedPallets.length >= t.maxPalletSlots) return false;
        if (t.reservedWeight + p.weight > t.payload + 1e-6) return false;
      }
      return true;
    });

    const baseline = this.config.dispatchPolicy === 'V6_2_BASELINE';
    candidates.sort((a, b) => {
      // Prefer trip already carrying sibling pallets of the same order
      if (ord.assignedTripId === a.id) return -1;
      if (ord.assignedTripId === b.id) return 1;
      if (baseline) return (a.arrived ?? 0) - (b.arrived ?? 0);
      // Consolidate partially loaded trip departing soonest & nearest dock
      return b.reservedPallets.length - a.reservedPallets.length ||
        a.committedDepartureSec - b.committedDepartureSec ||
        Math.abs(a.dockX - this.locations.get(p.location).x) - Math.abs(b.dockX - this.locations.get(p.location).x);
    });

    for (const t of candidates) {
      for (let slotIdx = 0; slotIdx < t.maxPalletSlots; slotIdx++) {
        const slotId = `${t.id}_${slotIdx}`;
        if (this.free(slotId)) return {t, to: slotId};
      }
    }
    return null;
  }

  routeOutbound() {
    const outStageIds = [
      ...Array.from({length: 10}, (_, i) => `OUT${i}`),
      ...Array.from({length: 12}, (_, i) => `ST${i}`)
    ];
    const readyPallets = outStageIds
      .map(id => this.at(id))
      .filter(p => p && !p.job && p.order && (p.kind !== 'finished' || p.checked) && !this.isLocationIsolated(p.location));

    // Sort by stopSequence DESC (higher stop loads deeper into truck bed P0..P1 so stop 1 loads last near door!), then due ASC
    readyPallets.sort((a, b) => {
      const oa = this.orders.find(o => o.id === a.order);
      const ob = this.orders.find(o => o.id === b.order);
      if (oa.route === ob.route && oa.stopSequence !== ob.stopSequence) {
        return ob.stopSequence - oa.stopSequence;
      }
      return oa.due - ob.due || oa.created - ob.created;
    });

    for (const p of readyPallets) {
      if (p.job) continue;
      const fromOutput = p.location.startsWith('OUT');
      const ord = this.orders.find(o => o.id === p.order);
      const dest = (!fromOutput || this.config.direct) ? this.findEligibleTripForPallet(p) : null;
      if (dest) {
        const isUnsplitBatch = ord && !ord.allowSplitTrips && ord.plannedPalletIds.length > 1 && !ord.assignedTripId;
        const batchPallets = isUnsplitBatch
          ? ord.plannedPalletIds.map(id => this.pallets.get(this.plannedPallets.get(id)?.physicalPalletId)).filter(Boolean)
          : [p];
        const urgency = (this.time >= dest.t.committedDepartureSec - 420 || isUnsplitBatch) ? 5 : 3;

        for (const bp of batchPallets) {
          if (bp.job) continue;
          let slotTo = null;
          for (let slotIdx = 0; slotIdx < dest.t.maxPalletSlots; slotIdx++) {
            const sid = `${dest.t.id}_${slotIdx}`;
            if (this.free(sid)) { slotTo = sid; break; }
          }
          if (!slotTo) break;
          const bpFromOut = bp.location.startsWith('OUT');
          const j = this.queue(bp, slotTo, 'CP', bpFromOut ? 'Ghép lên xe' : 'Chờ xuất lên xe', {
            truck: dest.t,
            fromOutput: bpFromOut,
            urgency,
            decisionReason: `Xếp lên ${dest.t.id} (${dest.t.dockCode}), điểm giao #${ord?.stopSequence ?? 1}`
          });
          if (j) {
            dest.t.reservedPallets.push(bp.id);
            dest.t.reservedWeight = Number((dest.t.reservedWeight + bp.weight).toFixed(3));
            if (dest.t.state === 'READY') {
              dest.t.state = 'LOADING';
              dest.t.history.push(['LOADING', this.time]);
            }
            if (ord && !ord.allowSplitTrips && !ord.assignedTripId) {
              ord.assignedTripId = dest.t.id;
            }
            if (bp.outPalletId) {
              const pp = this.plannedPallets.get(bp.outPalletId);
              if (pp) pp.reservedTripId = dest.t.id;
            }
          }
        }
      } else if (fromOutput) {
        // Free assembly output cell G_c by moving finished pallet to nearest free ST slot
        const freeSt = Array.from({length: 12}, (_, i) => `ST${i}`).find(id => this.free(id));
        if (freeSt) {
          this.queue(p, freeSt, 'CP', 'Giải phóng ô ghép', {
            urgency: 3,
            decisionReason: `Giải phóng ${p.location} sang ${freeSt} chờ xe tuyến ${p.route}`
          });
        }
      }
    }
  }

  // ==================== SHIFT TRANSITION & INVARIANTS ====================
  requestTransition() {
    if (this.phase === 'TRANSITION' || this.phase === 'STOPPED') return;
    this.previousPhase = this.phase;
    this.phase = 'TRANSITION';
    this.transitionStart = this.time;
    this.handoverRemaining = this.config.shiftHandoverCheckSeconds ?? 0;
    this.shiftResults.push({
      phase: this.previousPhase,
      start: this.phaseStart,
      end: this.time,
      metrics: Object.fromEntries(Object.keys(this.metrics).map(k => [k, this.metrics[k] - (this.shiftBaseline[k] || 0)])),
      inventory: this.inventory()
    });
    this.log('Bắt đầu chuyển giao ca: hoàn tất công việc dở dang và kiểm tra an toàn bàn giao');
  }

  processTransition() {
    if (this.phase !== 'TRANSITION') return;

    const hasFreeStage = Array.from({length: 12}, (_, i) => `ST${i}`).some(id => this.free(id));
    const activeCellWork = this.cells.some(c =>
      c.state !== 'EMPTY' && !(c.state === 'COMPLETE' && !hasFreeStage && this.activeTrucks().length === 0)
    );
    const physicalBusy =
      this.jobs.some(j => j.state !== 'DONE') ||
      this.receipts.length > 0 ||
      activeCellWork ||
      [...this.locations.values()].some(l => ['source', 'inbound'].includes(l.kind) && (l.pallet || l.reservation)) ||
      this.activeTrucks().some(t => t.pallets.length > 0 || t.state === 'DOCK_HOLD_FAULT');

    if (physicalBusy) return;

    if (this.handoverRemaining > 0) {
      this.handoverRemaining--;
      return;
    }

    for (const t of [...this.activeTrucks(), ...this.yardTrucks()]) {
      t.state = 'DEPARTED';
      t.departed = this.time;
      t.closedEmpty = true;
    }

    // Finalize any unshipped orders honestly at end of single outbound shift
    if (!this.config.autoCycle && this.previousPhase === 'OUTBOUND') {
      for (const o of this.orders) {
        if (!['SHIPPED', 'UNFULFILLED_SHORTAGE'].includes(o.state)) {
          o.state = o.shippedPalletIds.length > 0 ? 'PARTIALLY_SHIPPED' : 'UNSHIPPED_AT_CUTOFF';
        }
      }
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
    if (this.phase === 'OUTBOUND') {
      this.nextSyntheticOrderTime = 0;
      this.syntheticOrderSeq = 0;
      this.buildSyntheticTripsForOutboundShift(this.time);
    } else {
      this.inboundRemaining = this.config.inboundPallets;
    }
    this.log('Mở ca tiếp theo: ' + this.phase);
  }

  step(seconds = 1) {
    for (let s = 0; s < seconds; s++) {
      this.time++;

      for (const f of this.faultScheduleQueue) {
        if (!f.triggered && this.time >= f.time) {
          f.triggered = true;
          this.faultRobot(f.robotId, f);
        }
      }

      this.advanceMotion();
      this.processReceipt();
      this.receive();

      if (this.phase === 'INBOUND' || (this.phase === 'TRANSITION' && this.previousPhase === 'INBOUND')) {
        this.routeInbound();
      }

      if (this.phase === 'OUTBOUND') {
        this.releaseOrders();
        this.planOutbound(true);
      } else if (this.phase === 'TRANSITION' && this.previousPhase === 'OUTBOUND') {
        this.planOutbound(false);
      }

      if (this.phase === 'OUTBOUND' || (this.phase === 'TRANSITION' && this.previousPhase === 'OUTBOUND')) {
        this.processAssembly();
        this.returnSources(this.phase === 'TRANSITION');
        this.processTrucks();
        this.routeOutbound();
      }

      if (this.time % 5 === 0) {
        this.dispatch();
      }

      this.processTransition();

      for (const [kind, key] of [['inbound', 'maxInbound'], ['source', 'maxSource'], ['stage', 'maxStage']]) {
        this.metrics[key] = Math.max(
          this.metrics[key],
          [...this.locations.values()].filter(l => l.kind === kind && (l.pallet || l.reservation)).length
        );
      }
      this.metrics.maxRT = Math.max(
        this.metrics.maxRT,
        [...this.robots.values()].filter(r => r.active && r.type === 'RT' && r.task && r.status === 'RUNNING').length
      );

      const shiftLimit = this.phase === 'INBOUND' ? this.config.inboundSeconds : this.config.outboundSeconds;
      if (['INBOUND', 'OUTBOUND'].includes(this.phase) && (this.time - this.phaseStart) >= shiftLimit) {
        this.requestTransition();
      }

      if (this.time % 30 === 0) {
        this.assertInvariants();
      }
    }
    return this.snapshot();
  }

  inventory() {
    const out = Array(this.skuCodes.length).fill(0);
    for (const p of this.pallets.values()) {
      if (p.location !== 'SHIPPED') {
        for (const x of p.composition) {
          const idx = x.sku ?? this.skuIndexMap.get(x.skuCode);
          if (idx != null) out[idx] += x.cartons;
        }
      }
    }
    return out;
  }

  assertInvariants() {
    const inv = this.inventory();
    for (let i = 0; i < this.skuCodes.length; i++) {
      if (inv[i] + this.shippedBySKU[i] !== this.initialBySKU[i] + this.receivedBySKU[i]) {
        throw Error(`Vi phạm bảo toàn tồn kho ${this.skuCodes[i]}: còn=${inv[i]}, xuất=${this.shippedBySKU[i]}, đầu+nhập=${this.initialBySKU[i] + this.receivedBySKU[i]}`);
      }
    }

    const seen = new Set();
    for (const l of this.locations.values()) {
      if (l.pallet) {
        if (seen.has(l.pallet) || this.pallets.get(l.pallet)?.location !== l.id) {
          throw Error(`Vi phạm sở hữu pallet tại ô ${l.id}`);
        }
        seen.add(l.pallet);
      }
      if (l.pallet && l.reservation && !String(l.reservation).startsWith('ASSEMBLY')) {
        throw Error(`Vượt sức chứa đặt chỗ tại ô ${l.id}`);
      }
    }

    for (const r of this.robots.values()) {
      if (r.carried) {
        if (seen.has(r.carried) || this.pallets.get(r.carried)?.location !== r.id) {
          throw Error(`Vi phạm sở hữu pallet trên thiết bị ${r.id}`);
        }
        seen.add(r.carried);
      }
    }

    for (const p of this.pallets.values()) {
      if (!['SHIPPED', 'EMPTY_RETURNED'].includes(p.location) && !seen.has(p.id)) {
        throw Error(`Pallet vô chủ ${p.id} (${p.location})`);
      }
      if (p.cartons < 0 || sum(p.composition.map(x => x.cartons)) !== p.cartons) {
        throw Error(`Sai lệch số kiện trên pallet ${p.id}`);
      }
      if (p.weight > 800 + 1e-4) {
        throw Error(`Pallet ${p.id} vượt trần khối lượng 800 kg (${p.weight} kg)`);
      }
    }

    const activeChargers = [...this.chargers.values()].filter(c => c.state !== 'FREE');
    if (activeChargers.length > this.config.maxCharging) {
      throw Error(`Vượt giới hạn cổng sạc đồng thời (${activeChargers.length} > ${this.config.maxCharging})`);
    }
    const powerKw = sum(activeChargers.map(c => c.kw));
    if (powerKw > (this.config.maxChargerPowerKw ?? LAYOUT.maxChargerPowerKw) + 1e-5) {
      throw Error(`Vượt trần công suất trạm sạc (${powerKw} kW)`);
    }

    const activeRobots = [...this.robots.values()].filter(r =>
      r.active && !['TOWING', 'IN_MAINT', 'RESCUE_SETUP'].includes(r.status)
    );
    for (let i = 0; i < activeRobots.length; i++) {
      for (let k = i + 1; k < activeRobots.length; k++) {
        const a = activeRobots[i], b = activeRobots[k];
        // Use physical raw body extents for instantaneous non-overlap invariant
        const ea = vehicleHalfExtents(a.type, Boolean(a.carried), true);
        const eb = vehicleHalfExtents(b.type, Boolean(b.carried), true);
        if (obbOverlap(a.x, a.y, a.cos ?? 0, a.sin ?? 1, ea.rawHalfL, ea.rawHalfW, b.x, b.y, b.cos ?? 0, b.sin ?? 1, eb.rawHalfL, eb.rawHalfW)) {
          throw Error(`Xung đột bao hình vật lý giữa ${a.id} (${a.x.toFixed(2)},${a.y.toFixed(2)}) và ${b.id} (${b.x.toFixed(2)},${b.y.toFixed(2)})`);
        }
      }
    }

    if (this.cells.filter(c => c.state === 'ASSEMBLING').length > this.config.assemblyTeams) {
      throw Error('Vượt số đội nhân công ghép đơn');
    }
    if (this.cells.filter(c => c.state === 'QC_WRAPPING').length > this.config.qcInspectors) {
      throw Error('Vượt số nhân viên QC xuất');
    }
    if (this.inboundTrucks.filter(t => t.state === 'UNLOADING').length > 1) {
      throw Error('Quá một xe nhập dỡ hàng đồng thời');
    }

    for (const t of this.trucks) {
      if (t.pallets.length > t.maxPalletSlots || t.weight > t.payload + 1e-4) {
        throw Error(`Quá tải chuyến xe ${t.id}`);
      }
      if (t.state === 'DEPARTED' && !t.closedEmpty) {
        const trapped = [...this.robots.values()].some(r =>
          r.active && r.y < 1.5 && Math.abs(r.x - (t.dockX ?? -999)) < 1.0 && r.task?.truck?.id === t.id && !r.returning
        );
        if (trapped) throw Error(`Xe ${t.id} rời kho khi robot chưa ra khỏi thùng`);
      }
    }

    this.metrics.checks++;
    return true;
  }

  computeNormalizedHash() {
    const canonical = {
      version: '6.2',
      planId: this.planId,
      policy: this.config.dispatchPolicy,
      fefoMode: this.config.fefoMode,
      time: this.time,
      phase: this.phase,
      metrics: this.metrics,
      skuCodes: this.skuCodes,
      initial: this.initialBySKU,
      received: this.receivedBySKU,
      shipped: this.shippedBySKU,
      inventory: this.inventory(),
      orders: this.orders.map(o => ({
        id: o.id,
        state: o.state,
        shippedPallets: o.shippedPalletIds.length,
        shippedCartons: o.shippedCartons,
        latenessSec: o.latenessSec,
        trips: o.tripIds
      })),
      trucks: this.trucks.filter(t => !t.closedEmpty).map(t => ({
        id: t.id,
        dock: t.dockCode,
        state: t.state,
        pallets: t.pallets.length,
        weight: Number(t.weight.toFixed(2)),
        departed: t.departed,
        lateness: t.departureLatenessSec
      })),
      robots: [...this.robots.values()].map(r => ({
        id: r.id,
        active: r.active,
        status: r.status,
        x: Number(r.x.toFixed(2)),
        y: Number(r.y.toFixed(2)),
        work: r.work,
        charging: r.charging,
        waiting: r.waiting,
        faultSeconds: r.faultSeconds,
        battery: Number(r.battery.toFixed(2)),
        distance: Number(r.distance.toFixed(2)),
        crossZone: r.crossZoneCount,
        detours: r.detourCount,
        reassigned: r.reassignedCount
      }))
    };
    return sha256Hex(JSON.stringify(canonical));
  }

  snapshot(includeHash = false, includeVisual = false) {
    const shippedTrips = this.trucks.filter(t => t.state === 'DEPARTED' && !t.closedEmpty);
    const activeDocks = this.activeTrucks();
    const yardList = this.yardTrucks();

    const shippedOnTime = this.orders.filter(o => o.state === 'SHIPPED' && (o.latenessSec || 0) === 0).length;
    const shippedLate = this.orders.filter(o => o.state === 'SHIPPED' && (o.latenessSec || 0) > 0).length;
    const partialOrders = this.orders.filter(o => o.state === 'PARTIALLY_SHIPPED').length;
    const shortageOrders = this.orders.filter(o => o.state === 'UNFULFILLED_SHORTAGE').length;

    const allocationsDetail = [];
    for (const pp of this.plannedPallets.values()) {
      for (const al of pp.allocations) allocationsDetail.push({...al});
    }

    let floorPallets = null;
    let rackPallets = null;
    if (includeVisual) {
      floorPallets = [];
      rackPallets = [];
      for (const l of this.locations.values()) {
        if (!l.pallet) continue;
        const p = this.pallets.get(l.pallet);
        if (!p) continue;
        if (l.kind === 'rack') {
          rackPallets.push({
            id: p.id,
            slotId: l.id,
            x: l.rackX,
            y: l.rackY,
            level: l.level,
            aisle: l.aisle,
            zone: l.zone,
            skuCode: p.skuCode,
            cartons: p.cartons,
            allocated: p.allocatedCartons
          });
        } else {
          floorPallets.push({
            id: p.id,
            locId: l.id,
            locKind: l.kind,
            x: l.x,
            y: l.y,
            palletKind: p.kind,
            skuCode: p.skuCode,
            cartons: p.cartons,
            order: p.order || null,
            route: p.route || null,
            checked: Boolean(p.checked),
            isolated: this.isLocationIsolated(l.id)
          });
        }
      }
    }

    return {
      version: '6.2',
      planId: this.planId,
      policy: this.config.dispatchPolicy,
      fefoMode: this.config.fefoMode,
      shiftStartTime: this.config.shiftStartTime,
      time: this.time,
      phase: this.phase,
      emergencyStop: {...this.emergencyStop},
      normalizedHash: includeHash || this.phase === 'STOPPED' ? this.computeNormalizedHash() : null,
      metrics: clone(this.metrics),
      skuCodes: [...this.skuCodes],
      inventory: this.inventory(),
      initial: [...this.initialBySKU],
      received: [...this.receivedBySKU],
      shipped: [...this.shippedBySKU],
      queuedOrders: this.orders.filter(o => ['QUEUED', 'UNRELEASED'].includes(o.state)).length,
      unfinishedJobs: this.jobs.filter(j => j.state !== 'DONE').length,
      orderSummary: {
        totalOrders: this.orders.length,
        shippedTotal: shippedOnTime + shippedLate,
        shippedOnTime,
        shippedLate,
        partialOrders,
        shortageOrders,
        inProgressOrders: this.orders.filter(o => ['IN_PROGRESS', 'QC_PASSED', 'LOADED'].includes(o.state)).length
      },
      tripSummary: {
        totalTrips: this.trucks.filter(t => !t.closedEmpty).length,
        yardCount: yardList.length,
        dockedCount: activeDocks.length,
        departedCount: shippedTrips.length,
        onTimeTrips: shippedTrips.filter(t => (t.departureLatenessSec || 0) === 0).length,
        safetyDelayedTrips: shippedTrips.filter(t => (t.departureLatenessSec || 0) > 0).length
      },
      occupancy: Object.fromEntries(
        ['inbound', 'source', 'output', 'stage', 'rack'].map(k => [
          k,
          [...this.locations.values()].filter(l => l.kind === k && l.pallet).length
        ])
      ),
      cells: this.cells.map(c => ({
        id: c.id,
        x: c.x,
        state: c.state,
        orderId: c.orderId,
        outPalletId: c.outPalletId,
        remaining: c.remaining,
        team: c.team,
        qcInspector: c.qcInspector,
        isolated: this.isCellIsolated(c.id)
      })),
      chargers: [...this.chargers.values()].map(c => ({
        id: c.id, robotType: c.robotType, state: c.state, robotId: c.robotId, kw: c.kw
      })),
      yardTrucks: yardList.map(t => ({
        id: t.id, route: t.route, plate: t.vehiclePlate, arrivalTimeSec: t.arrivalTimeSec,
        committedDepartureSec: t.committedDepartureSec, maxPalletSlots: t.maxPalletSlots
      })),
      activeDocks: activeDocks.map(t => ({
        id: t.id, dockCode: t.dockCode, bay: t.bay, route: t.route,
        state: t.state, pallets: t.pallets.length, reserved: t.reservedPallets.length,
        maxPalletSlots: t.maxPalletSlots, weight: t.weight, payload: t.payload,
        deadline: t.committedDepartureSec, committedDepartureSec: t.committedDepartureSec,
        decisionReason: t.decisionReason
      })),
      trucks: this.trucks.filter(t => !t.closedEmpty).map(t => ({
        id: t.id, dockCode: t.dockCode, bay: t.bay, route: t.route,
        state: t.state, pallets: t.pallets.length, maxPalletSlots: t.maxPalletSlots,
        weight: t.weight, cartons: t.cartons || 0,
        arrivalTimeSec: t.arrivalTimeSec, committedDepartureSec: t.committedDepartureSec,
        departed: t.departed, departureLatenessSec: t.departureLatenessSec || 0,
        decisionReason: t.decisionReason
      })),
      ordersDetail: this.orders.map(o => ({
        id: o.id, storeCode: o.storeCode, route: o.route, priority: o.priority,
        allowSplitTrips: o.allowSplitTrips, stopSequence: o.stopSequence,
        due: o.due, state: o.state,
        plannedPalletCount: o.plannedPalletIds.length,
        shippedPalletCount: o.shippedPalletIds.length,
        plannedCartons: o.plannedCartons,
        shippedCartons: o.shippedCartons,
        completedAt: o.completedAt,
        latenessSec: o.latenessSec || 0,
        tripIds: [...o.tripIds]
      })),
      allocationsDetail,
      palletSummary: {
        planned: this.plannedPallets.size,
        shippedMixed: [...this.plannedPallets.values()].filter(p => p.state === 'SHIPPED' && p.dispatchMode === 'MIXED_PALLET').length,
        shippedWhole: [...this.plannedPallets.values()].filter(p => p.state === 'SHIPPED' && p.dispatchMode === 'WHOLE_PALLET').length,
        shippedMultiWave: [...this.plannedPallets.values()].filter(p => p.state === 'SHIPPED' && p.dispatchMode === 'MIXED_PALLET' && p.allocations.length > 2).length,
        unshipped: [...this.plannedPallets.values()].filter(p => p.state !== 'SHIPPED').length
      },
      palletsDetail: [...this.plannedPallets.values()].map(p => ({
        id: p.id, orderId: p.orderId, dispatchMode: p.dispatchMode, state: p.state,
        physicalPalletId: p.physicalPalletId, allocatedSources: new Set(p.allocations.map(a => a.sourcePalletId)).size,
        assembledAt: p.assembledAt ?? null, qcPassedAt: p.qcPassedAt ?? null,
        shippedAt: p.shippedAt ?? null, shippedTripId: p.shippedTripId ?? null,
        physicalLocation: this.pallets.get(p.physicalPalletId)?.location ?? null
      })),
      departedCount: shippedTrips.length,
      robots: [...this.robots.values()].map(r => ({
        id: r.id, type: r.type, zone: r.zone, active: r.active, status: r.status,
        x: r.x, y: r.y, cos: r.cos ?? 0, sin: r.sin ?? -1, returning: Boolean(r.returning),
        carried: r.carried, currentLiftM: r.currentLiftM,
        work: r.work, charging: r.charging, waiting: r.waiting, faultSeconds: r.faultSeconds,
        battery: r.battery, distance: r.distance,
        crossZoneCount: r.crossZoneCount, detourCount: r.detourCount, reassignedCount: r.reassignedCount,
        awaitingOperatorConfirm: r.awaitingOperatorConfirm, faultContext: r.faultContext, faultReason: r.faultReason,
        maintBayId: r.maintBayId,
        taskLabel: r.task?.label || null
      })),
      floorPallets,
      rackPallets,
      recentLogs: this.logs.slice(-40),
      decisionTraces: this.decisionTraces.slice(-40),
      transitions: clone(this.transitions),
      shiftResults: clone(this.shiftResults)
    };
  }

  runToCompletion(maxSeconds = 90000) {
    while (this.phase !== 'STOPPED' && this.time < maxSeconds) {
      this.step(1);
    }
    return this.snapshot(true, true);
  }
}
