// c:/Users/lshie/Documents/project/stupidfuck/Bao_cao_WinMart_V6_1_5000m2/Mo_phong/incident_and_energy.mjs
// Swept OBB trajectory verification, balanced fleet charging, local fault isolation, transitive replanning & conditional rescue for WinMart V6.2.

import {LAYOUT, VEHICLE_SPECS, sweptEnvelopeConflict} from './layout_spec.mjs';
import {findCorridorPath} from './routing_and_hash.mjs';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function createChargers() {
  const map = new Map();
  for (const c of [...LAYOUT.rtChargers, ...LAYOUT.cpChargers]) {
    map.set(c.id, {...c, state: 'FREE', robotId: null, reservedAt: null});
  }
  return map;
}

export function estimateEnergyPctForDistance(type, meters, pickDropSec = 60, batteryWorkSeconds = 28800) {
  const speed = type === 'RT' ? 0.78 : 0.90;
  const activeSec = meters / speed + pickDropSec;
  return (activeSec * 100) / batteryWorkSeconds;
}

export function buildActiveObstacles(engine, excludeRobotId = null) {
  const obstacles = [];
  const blockedAisles = new Set();

  for (const r of engine.robots.values()) {
    if (!r.active || r.id === excludeRobotId) continue;
    const isStaticBlock =
      r.status === 'FAULT' ||
      r.status === 'RESCUE_SETUP' ||
      r.status === 'WAITING_EXTERNAL_ASSISTANCE' ||
      r.status === 'WAITING_PATH';

    if (!isStaticBlock) continue;

    // Ignore robots safely parked inside off-corridor home or MAINT bays
    const atHome = Math.hypot(r.x - r.home.x, r.y - r.home.y) < 0.25;
    const atMaint = [...LAYOUT.maintBays.RT, ...LAYOUT.maintBays.CP].some(m => Math.hypot(r.x - m.x, r.y - m.y) < 0.35);
    if (atHome || atMaint) continue;

    const rx = r.type === 'RT' ? 1.45 : 1.20;
    const ry = r.type === 'RT' ? 1.15 : 0.95;
    obstacles.push({x: r.x, y: r.y, rx, ry, robotId: r.id, status: r.status});

    // Check if robot sits inside a rack aisle
    if (r.type === 'RT' && r.y > LAYOUT.frontY + 0.4 && r.y < LAYOUT.rearY - 0.4) {
      const aisle = LAYOUT.aisleXs.findIndex(ax => Math.abs(ax - r.x) < 0.4);
      if (aisle >= 0) blockedAisles.add(aisle);
    }
  }

  // Also mark aisles actively locked by healthy running RTs as unavailable for through-detouring by other RTs
  for (const r of engine.robots.values()) {
    if (!r.active || r.id === excludeRobotId || r.type !== 'RT' || !r.task) continue;
    for (const res of (r.task.resources || [])) {
      if (res.startsWith('aisle')) blockedAisles.add(Number(res.slice(5)));
    }
  }

  return {obstacles, blockedAisles};
}

export function computeResourceKeys(engine, j) {
  const keys = [];
  for (const id of [j.from, j.to]) {
    if (!id) continue;
    const l = engine.locations.get(id);
    if (l?.kind === 'rack') keys.push(`aisle${l.aisle}`);
    if (l?.kind === 'stage' && l.stageIndex != null) {
      // ST_HANDOFF_LOCK: locks target ST slot and immediate neighbors against concurrent XN/CP access
      keys.push(`st_slot_${l.stageIndex}`);
      if (l.stageIndex > 0) keys.push(`st_adj_${l.stageIndex - 1}_${l.stageIndex}`);
      if (l.stageIndex < 11) keys.push(`st_adj_${l.stageIndex}_${l.stageIndex + 1}`);
    }
  }
  return [...new Set(keys)];
}

export function computeTrajBounds(traj, startIdx = 0, standPt = null) {
  let minX = standPt ? standPt.x : Infinity;
  let maxX = standPt ? standPt.x : -Infinity;
  let minY = standPt ? standPt.y : Infinity;
  let maxY = standPt ? standPt.y : -Infinity;
  for (let i = startIdx; i < traj.length; i++) {
    const p = traj[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return {minX, maxX, minY, maxY};
}

export function canRunTrajectory(engine, r, j, traj, delay = 0, waitPos = null) {
  const keys = computeResourceKeys(engine, j);
  const cells = engine.jobCells(j);
  for (const cId of cells) {
    const cell = engine.cells[cId];
    if (cell && ['ASSEMBLING', 'QC_WRAPPING'].includes(cell.state)) return false;
    if (engine.isCellIsolated(cId, r.id)) return false;
  }

  const standPt = waitPos || {x: r.x, y: r.y, cos: r.cos ?? 0, sin: r.sin ?? 1};
  if (!traj._bounds) traj._bounds = computeTrajBounds(traj, 0, null);
  const aMinX = Math.min(standPt.x, traj._bounds.minX);
  const aMaxX = Math.max(standPt.x, traj._bounds.maxX);
  const aMinY = Math.min(standPt.y, traj._bounds.minY);
  const aMaxY = Math.max(standPt.y, traj._bounds.maxY);
  const SAFE_CULL = 3.6; // Strictly > max possible 2-vehicle half-diagonals + 1s motion (~2.95 m)

  const trajLen = traj.length;
  const totalLen = trajLen + delay;
  const bedStart = traj.bedStart ?? -1;
  const bedEnd = traj.bedEnd ?? -1;
  const cStart = traj.chargeStart ?? -1;
  const cEnd = traj.chargeEnd ?? -1;

  for (const q of engine.robots.values()) {
    if (!q.active || q === r) continue;
    if (q.task && !q.returning && keys.some(k => q.task.resources?.includes(k))) return false;

    // Physical single-robot-in-truck-bed mutex: check overlap of [delay + bedStart .. delay + bedEnd]
    if (j.truck && bedStart >= 0 && q.task?.truck?.id === j.truck.id) {
      const qt = q.trajectory;
      if (qt && qt.bedStart >= 0) {
        const a0 = delay + bedStart, a1 = delay + bedEnd;
        const b0 = qt.bedStart - q.index, b1 = qt.bedEnd - q.index;
        if (b1 >= 0 && Math.max(a0, b0) <= Math.min(a1, b1)) return false;
      } else if (q.y < 1.6 && Math.abs(q.x - j.truck.dockX) < 1.2) {
        return false;
      }
    }

    const qt = (q.trajectory && !['FAULT', 'RESCUE_SETUP', 'WAITING_EXTERNAL_ASSISTANCE', 'WAITING_PATH'].includes(q.status))
      ? q.trajectory
      : null;

    if (!qt) {
      // Stationary robot fast AABB cull
      if (
        q.x < aMinX - SAFE_CULL || q.x > aMaxX + SAFE_CULL ||
        q.y < aMinY - SAFE_CULL || q.y > aMaxY + SAFE_CULL
      ) {
        continue;
      }
    } else {
      if (!qt._bounds) qt._bounds = computeTrajBounds(qt, 0, null);
      if (
        qt._bounds.maxX < aMinX - SAFE_CULL || qt._bounds.minX > aMaxX + SAFE_CULL ||
        qt._bounds.maxY < aMinY - SAFE_CULL || qt._bounds.minY > aMaxY + SAFE_CULL
      ) {
        continue;
      }
    }

    const qi = q.index || 0;
    const qtLen = qt ? qt.length : 0;
    const qIdle = {x: q.x, y: q.y, cos: q.cos ?? 0, sin: q.sin ?? 1};
    const qcStart = qt?.chargeStart ?? -1, qcEnd = qt?.chargeEnd ?? -1;

    for (let t = 0; t < totalLen; t++) {
      const a0 = t < delay ? standPt : traj[Math.min(t - delay, trajLen - 1)];
      const b0 = qt ? qt[Math.min(qi + t, qtLen - 1)] : qIdle;

      // Fast per-frame Manhattan proximity filter before trig/OBB
      if (Math.abs(a0.x - b0.x) > 4.6 || Math.abs(a0.y - b0.y) > 4.6) {
        if (cEnd > 0 && (t - delay) >= cStart && (t + 1 - delay) < cEnd) {
          if (!qt || (qi + t) >= qtLen - 1) {
            t = delay + cEnd - 2;
          } else if (qcEnd > 0 && (qi + t) >= qcStart && (qi + t + 1) < qcEnd) {
            const jump = Math.min(delay + cEnd - 2, qcEnd - 2 - qi);
            if (jump > t) t = jump;
          }
        }
        continue;
      }

      const a1 = (t + 1) < delay ? standPt : traj[Math.min(t + 1 - delay, trajLen - 1)];
      const b1 = qt ? qt[Math.min(qi + t + 1, qtLen - 1)] : qIdle;
      const loadedA = Boolean(r.carried || a0.loaded || a1.loaded);
      const statA = Math.abs(a1.x - a0.x) < 1e-5 && Math.abs(a1.y - a0.y) < 1e-5;
      const loadedB = Boolean(q.carried || b0.loaded || b1.loaded);
      const statB = !qt || (Math.abs(b1.x - b0.x) < 1e-5 && Math.abs(b1.y - b0.y) < 1e-5);

      if (sweptEnvelopeConflict(
        {a0, a1, typeA: r.type, loadedA, statA},
        {b0, b1, typeB: q.type, loadedB, statB}
      )) {
        return false;
      }

      if (cEnd > 0 && (t - delay) >= cStart && (t + 1 - delay) < cEnd) {
        if (!qt || (qi + t) >= qtLen - 1) {
          t = delay + cEnd - 2;
        } else if (qcEnd > 0 && (qi + t) >= qcStart && (qi + t + 1) < qcEnd) {
          const jump = Math.min(delay + cEnd - 2, qcEnd - 2 - qi);
          if (jump > t) t = jump;
        }
      }
    }
  }
  return true;
}

export function dispatchBalancedChargers(engine) {
  const activeChargers = [...engine.chargers.values()].filter(c => c.state !== 'FREE');
  let usedSlots = activeChargers.length;
  let usedKw = activeChargers.reduce((s, c) => s + c.kw, 0);
  if (usedSlots >= engine.config.maxCharging) return;

  const threshold = engine.config.lowBatteryThreshold ?? 25;
  const candidates = [...engine.robots.values()].filter(r =>
    r.active &&
    (!r.task || r.returning) &&
    !['FAULT', 'RESCUE_SETUP', 'TOWING', 'IN_MAINT', 'WAITING_EXTERNAL_ASSISTANCE'].includes(r.status) &&
    r.battery < threshold
  );
  if (!candidates.length) return;

  for (const c of candidates) {
    if (c.lowBatterySince == null) c.lowBatterySince = engine.time;
  }

  const fleetHealthRatio = type => {
    const all = [...engine.robots.values()].filter(r => r.active && r.type === type);
    if (!all.length) return 1;
    const capable = all.filter(r => r.status !== 'FAULT' && r.battery >= threshold && !r.task?.charge).length;
    return capable / all.length;
  };

  const zoneOnlineOrChargingCount = zone => [...engine.robots.values()].filter(r =>
    r.active && r.type === 'RT' && r.zone === zone &&
    (r.battery >= threshold || r.task?.charge)
  ).length;

  const baselinePolicy = engine.config.dispatchPolicy === 'V6_2_BASELINE';
  candidates.sort((a, b) => {
    if (!baselinePolicy && a.type !== b.type) {
      const ra = fleetHealthRatio(a.type);
      const rb = fleetHealthRatio(b.type);
      if (Math.abs(ra - rb) > 0.05) return ra - rb;
    }
    if (!baselinePolicy && a.type === 'RT' && b.type === 'RT' && a.zone !== b.zone) {
      const za = zoneOnlineOrChargingCount(a.zone);
      const zb = zoneOnlineOrChargingCount(b.zone);
      if (za !== zb) return za - zb;
    }
    return a.battery - b.battery || (a.lowBatterySince - b.lowBatterySince);
  });

  for (const r of candidates) {
    if (usedSlots >= engine.config.maxCharging) break;
    const specKw = VEHICLE_SPECS[r.type].chargerKw;
    if (usedKw + specKw > (engine.config.maxChargerPowerKw ?? LAYOUT.maxChargerPowerKw) + 1e-6) continue;

    // Balanced reserve rule in V6_2_PROPOSED: if both fleets have waiting low-battery units and maxCharging >= 2,
    // do not let one fleet consume 100% of maxCharging slots when the other fleet currently has 0 active chargers.
    if (!baselinePolicy && engine.config.maxCharging >= 2 && usedSlots === engine.config.maxCharging - 1) {
      const otherType = r.type === 'RT' ? 'CP' : 'RT';
      const otherNeeds = candidates.some(x => x.type === otherType);
      const otherHasCharger = [...engine.chargers.values()].some(c => c.state !== 'FREE' && c.robotType === otherType);
      if (otherNeeds && !otherHasCharger) continue;
    }

    const freePorts = [...engine.chargers.values()]
      .filter(c => c.robotType === r.type && c.state === 'FREE')
      .sort((a, b) => dist(r, a) - dist(r, b));

    for (const port of freePorts) {
      const backlog = engine.jobs.filter(j => j.state === 'QUEUED' && j.type === r.type).length;
      const healthRatio = fleetHealthRatio(r.type);
      const targetSOC = baselinePolicy
        ? 100
        : healthRatio < 0.5
          ? 65
          : backlog >= 3
            ? (engine.config.opportunityChargeTarget ?? 85)
            : 100;
      const chJob = {
        id: `CH${++engine.serial}`,
        charge: true,
        chargerId: port.id,
        targetSOC,
        label: 'Sạc pin',
        type: r.type,
        decisionReason: baselinePolicy
          ? `FIFO sạc về 100% tại ${port.id}`
          : `Cân bằng đội (${r.type}${r.zone ? '-' + r.zone : ''} khả dụng ${(healthRatio * 100).toFixed(0)}%) -> ${port.id} tới ${targetSOC}%`
      };
      if (engine.start(r, chJob)) {
        port.state = 'RESERVED';
        port.robotId = r.id;
        port.reservedAt = engine.time;
        usedSlots++;
        usedKw += port.kw;
        r.lowBatterySince = null;
        break;
      }
    }
  }
}

export function reconcileActiveTrajectories(engine) {
  // Fixed-point scan: ensure no active moving robot collides with a newly stopped/faulted robot or rerouted peer.
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 12) {
    changed = false;
    for (const q of engine.robots.values()) {
      if (!q.active || !q.task || !q.trajectory) continue;
      if (['FAULT', 'RESCUE_SETUP', 'TOWING', 'WAITING_EXTERNAL_ASSISTANCE', 'WAITING_PATH'].includes(q.status)) continue;

      const remTraj = q.trajectory.slice(q.index);
      if (remTraj.length <= 1) continue;
      const stillSafe = canRunTrajectory(engine, q, q.task, remTraj, 0, {x: q.x, y: q.y, cos: q.cos, sin: q.sin});
      if (stillSafe) continue;

      // Attempt live detour replanning from current position {x: q.x, y: q.y}
      const j = q.task;
      if (q.returning || (j.delivered && q.y >= 1.5)) {
        const homeTraj = engine.buildReturnHomeTrajectory(q, {x: q.x, y: q.y});
        if (homeTraj && canRunTrajectory(engine, q, j, homeTraj, 0, {x: q.x, y: q.y})) {
          if (!q.returning) {
            j.cleared = true;
            j.resources = [];
            j.activeCells = [];
            q.returning = true;
          }
          q.trajectory = homeTraj;
          q.index = 0;
          if (homeTraj.usedDetour) { q.detourCount++; engine.metrics.detourCount++; }
          changed = true;
          continue;
        }
      } else if (!q.carried && !j.delivered && !j.charge) {
        const reTraj = engine.buildTrajectory(q, j, {x: q.x, y: q.y});
        if (reTraj && canRunTrajectory(engine, q, j, reTraj, 0, {x: q.x, y: q.y})) {
          q.trajectory = reTraj;
          q.index = 0;
          if (reTraj.usedDetour) { q.detourCount++; engine.metrics.detourCount++; }
          changed = true;
          continue;
        }
      } else if (q.carried && !j.truck) {
        const loadedTraj = engine.buildLoadedContinuationTrajectory(q, j, {x: q.x, y: q.y});
        if (loadedTraj && canRunTrajectory(engine, q, j, loadedTraj, 0, {x: q.x, y: q.y})) {
          q.trajectory = loadedTraj;
          q.index = 0;
          if (loadedTraj.usedDetour) { q.detourCount++; engine.metrics.detourCount++; }
          changed = true;
          continue;
        }
      }

      // No immediate collision-free detour available -> pause safely in place (WAITING_PATH)
      q.status = 'WAITING_PATH';
      q.pausedTrajectory = remTraj;
      q.waitingPathSince = engine.time;
      q.lastTopologyChecked = engine.topologyVersion;
      engine.metrics.waitingPathEvents++;
      engine.log(`${q.id} tạm dừng an toàn tại (${q.x.toFixed(1)}, ${q.y.toFixed(1)}) do nhánh phía trước đang cô lập`);
      changed = true;
    }
  }
}

export function faultRobotOp(engine, id, options = {}) {
  const r = engine.robots.get(id);
  if (!r || !r.active || ['FAULT', 'RESCUE_SETUP', 'TOWING', 'IN_MAINT', 'WAITING_EXTERNAL_ASSISTANCE'].includes(r.status)) {
    return false;
  }

  const repairMode = options.repairMode || (options.towToMaint ? 'TOW_TO_MAINT' : 'IN_PLACE');
  const repairDurationSec = options.repairDurationSec ?? null;
  const prevTask = r.task;

  r.status = 'FAULT';
  r.faultStartedAt = engine.time;
  r.repairMode = repairMode;
  r.plannedRepairRemaining = repairDurationSec;
  r.faultReason = options.reason || 'Lỗi thiết bị cục bộ';
  engine.topologyVersion++;
  engine.metrics.faultEvents++;

  // Release charger reservation if robot was only heading to charge
  if (prevTask?.charge && prevTask.chargerId) {
    const chg = engine.chargers.get(prevTask.chargerId);
    if (chg && chg.robotId === r.id) {
      chg.state = 'FREE';
      chg.robotId = null;
    }
    if (r.y > 16.8 || (r.type === 'CP' && r.y > 9.8)) {
      r.task = null;
      r.trajectory = null;
      r.index = 0;
    }
  }

  // Classify 6 physical fault contexts
  if (!prevTask || r.returning) {
    r.faultContext = 'IDLE_OR_RETURNING';
    if (r.returning && prevTask) {
      prevTask.state = 'DONE';
      prevTask.ended = engine.time;
      r.task = null;
      r.returning = false;
      r.trajectory = null;
      r.index = 0;
    }
  } else if (!r.carried) {
    r.faultContext = 'EN_ROUTE_UNLOADED';
    const allowReassign = engine.config.dispatchPolicy !== 'V6_2_BASELINE' && options.allowReassign !== false;
    if (allowReassign && !prevTask.charge) {
      // Check if r faulted inside the exact rack aisle of prevTask.from, blocking access to that source pallet
      const fromLoc = engine.locations.get(prevTask.from);
      const faultedAisle = (r.type === 'RT' && r.y > LAYOUT.frontY + 0.4 && r.y < LAYOUT.rearY - 0.4)
        ? LAYOUT.aisleXs.findIndex(ax => Math.abs(ax - r.x) < 0.4)
        : -1;
      const blocksOwnSource = fromLoc?.kind === 'rack' && fromLoc.aisle === faultedAisle;

      if (!blocksOwnSource) {
        prevTask.state = 'QUEUED';
        prevTask.robot = null;
        prevTask.resources = [];
        prevTask.activeCells = [];
        prevTask.decisionReason = `Giao lại từ ${r.id} bị lỗi khi chưa mang hàng`;
        r.task = null;
        r.trajectory = null;
        r.index = 0;
        r.reassignedCount++;
        engine.metrics.reassignedTasks++;
        engine.log(`${r.id} lỗi khi chưa lấy hàng; cô lập vị trí (${r.x.toFixed(1)}, ${r.y.toFixed(1)}) và giao lại lệnh ${prevTask.id} cho xe khác`);
      } else {
        // Source aisle blocked by r -> try substituting another unblocked source pallet if Cấp nguồn / Xuất nguyên pallet
        const substituted = engine.trySubstituteBlockedSourceJob(prevTask, faultedAisle, r.id);
        if (substituted) {
          r.task = null;
          r.trajectory = null;
          r.index = 0;
          r.reassignedCount++;
          engine.metrics.reassignedTasks++;
        }
      }
    }
  } else {
    // Robot is physically carrying a pallet -> strict ownership preservation!
    const inTruckBed = Boolean(prevTask.truck && r.y < 1.6);
    const highLiftInRack = Boolean(r.type === 'RT' && (r.currentLiftM || 0) > 0.30);
    r.faultContext = inTruckBed
      ? 'CARRYING_IN_TRUCK_BED'
      : highLiftInRack
        ? 'CARRYING_HIGH_LIFT_RACK'
        : 'CARRYING_CORRIDOR_LOW';

    if (inTruckBed && prevTask.truck) {
      prevTask.truck.state = 'DOCK_HOLD_FAULT';
      prevTask.truck.safetyHeld = true;
      engine.log(`${r.id} lỗi trong thùng xe ${prevTask.truck.id} (${prevTask.truck.dockCode}); khóa cứng chèn bánh D2, giữ pallet ${r.carried}`);
    } else if (highLiftInRack) {
      r.status = 'WAITING_EXTERNAL_ASSISTANCE';
      r.awaitingOperatorConfirm = true;
      engine.log(`${r.id} lỗi khi càng nâng ở độ cao ${(r.currentLiftM || 0).toFixed(2)} m; cô lập lối kệ và chờ kỹ thuật chuyên trách hạ tải`);
    } else {
      engine.log(`${r.id} lỗi khi đang mang pallet ${r.carried} tại (${r.x.toFixed(1)}, ${r.y.toFixed(1)}); bảo toàn quyền sở hữu & đặt chỗ ${prevTask.to}`);
    }
  }

  // If TOW_TO_MAINT requested, either wait for operator authorization or auto-authorize in batch mode
  if (repairMode === 'TOW_TO_MAINT' && r.status === 'FAULT') {
    if (engine.config.autoAuthorizeRescue) {
      authorizeRescueOp(engine, id);
    } else {
      r.awaitingOperatorConfirm = true;
      engine.log(`${r.id} chờ xác nhận điều động tổ cứu hộ cơ–điện (F3) đưa về khu sửa chữa`);
    }
  }

  // Transitive source substitution for any QUEUED jobs whose source slot sits inside the newly isolated aisle
  if (engine.config.dispatchPolicy !== 'V6_2_BASELINE' && options.allowReassign !== false) {
    const blockedAisle = (r.type === 'RT' && r.y > LAYOUT.frontY + 0.4 && r.y < LAYOUT.rearY - 0.4)
      ? LAYOUT.aisleXs.findIndex(ax => Math.abs(ax - r.x) < 0.4)
      : -1;
    if (blockedAisle >= 0) {
      for (const qj of engine.jobs) {
        if (qj.state === 'QUEUED' && engine.slotMap.get(qj.from)?.aisle === blockedAisle) {
          engine.trySubstituteBlockedSourceJob(qj, blockedAisle, r.id);
        }
      }
    }
  }

  reconcileActiveTrajectories(engine);
  return true;
}

export function authorizeRescueOp(engine, id) {
  const r = engine.robots.get(id);
  if (!r || !['FAULT', 'WAITING_EXTERNAL_ASSISTANCE'].includes(r.status)) return false;
  if (r.status === 'WAITING_EXTERNAL_ASSISTANCE') {
    // External/specialist crew lowers forks safely first
    r.currentLiftM = 0.15;
  }
  r.awaitingOperatorConfirm = false;
  r.status = 'RESCUE_SETUP';
  r.rescueRemaining = r.carried
    ? (engine.config.rescueLoadedSetupSec ?? 240)
    : (engine.config.rescueUnloadedSetupSec ?? 120);
  engine.log(`Xác nhận cứu hộ ${r.id}: kỹ thuật viên tiếp cận mở phanh từ 48V${r.carried ? ' & rút pallet bằng xe nâng tay cứu hộ' : ''} (${r.rescueRemaining}s)`);
  return true;
}

export function advanceIncidentsOp(engine) {
  // Retry WAITING_PATH robots when topology changes or every 30s
  for (const q of engine.robots.values()) {
    if (!q.active || q.status !== 'WAITING_PATH') continue;
    q.waiting++;
    if (q.lastTopologyChecked === engine.topologyVersion && (engine.time - (q.waitingPathSince || 0)) % 30 !== 0) {
      continue;
    }
    q.lastTopologyChecked = engine.topologyVersion;
    const j = q.task;
    if (!j) { q.status = 'IDLE'; continue; }

    let candidateTraj = null;
    if (q.pausedTrajectory && q.pausedTrajectory.length > 1 && canRunTrajectory(engine, q, j, q.pausedTrajectory, 0, {x: q.x, y: q.y})) {
      candidateTraj = q.pausedTrajectory;
    } else if (q.returning || (j.delivered && q.y >= 1.5)) {
      candidateTraj = engine.buildReturnHomeTrajectory(q, {x: q.x, y: q.y});
    } else if (!q.carried && !j.delivered && !j.charge) {
      candidateTraj = engine.buildTrajectory(q, j, {x: q.x, y: q.y});
    } else if (q.carried && !j.truck) {
      candidateTraj = engine.buildLoadedContinuationTrajectory(q, j, {x: q.x, y: q.y});
    }

    if (candidateTraj && canRunTrajectory(engine, q, j, candidateTraj, 0, {x: q.x, y: q.y})) {
      if (!q.returning && j.delivered && q.y >= 1.5 && candidateTraj !== q.pausedTrajectory) {
        j.cleared = true;
        j.resources = [];
        j.activeCells = [];
        q.returning = true;
      }
      q.trajectory = candidateTraj;
      q.index = 0;
      q.status = 'RUNNING';
      q.pausedTrajectory = null;
      if (candidateTraj.usedDetour) { q.detourCount++; engine.metrics.detourCount++; }
      engine.log(`${q.id} tìm được lộ trình thông thoáng, tiếp tục nhiệm vụ ${j.label}`);
    }
  }

  for (const r of engine.robots.values()) {
    if (!r.active) continue;

    if (r.status === 'FAULT' || r.status === 'WAITING_EXTERNAL_ASSISTANCE') {
      r.faultSeconds++;
      if (r.status === 'FAULT' && r.repairMode === 'IN_PLACE' && r.plannedRepairRemaining != null) {
        if (--r.plannedRepairRemaining <= 0) {
          recoverRobotOp(engine, r.id);
        }
      }
      continue;
    }

    if (r.status === 'RESCUE_SETUP') {
      r.faultSeconds++;
      if (--r.rescueRemaining > 0) continue;

      // Physical pallet handoff / buffer placement before towing robot to MAINT
      if (r.carried && r.task) {
        engine.completeRescuePalletTransfer(r);
      }

      // Build physical 0.20 m/s tow trajectory to nearest free MAINT bay
      const maintPool = LAYOUT.maintBays[r.type];
      const targetMaint = maintPool.find(m => {
        const loc = engine.locations.get(m.id);
        return loc && !loc.occupiedByRobot;
      }) || maintPool[0];

      const loc = engine.locations.get(targetMaint.id);
      if (loc) loc.occupiedByRobot = r.id;
      r.maintBayId = targetMaint.id;

      const towPoints = r.y < 1.5
        ? [{x: r.x, y: r.y}, {x: r.x, y: LAYOUT.cpFrontY}, ...(findCorridorPath({x: r.x, y: LAYOUT.cpFrontY}, targetMaint, r.type, {obstacles: []})?.points.slice(1) || [targetMaint])]
        : (findCorridorPath({x: r.x, y: r.y}, targetMaint, r.type, {obstacles: []})?.points || [{x: r.x, y: r.y}, targetMaint]);

      const towFrames = [{x: r.x, y: r.y, action: 'tow'}];
      let cur = {x: r.x, y: r.y};
      const towSpeed = engine.config.towSpeedMps ?? 0.20;
      for (const p of towPoints.slice(1)) {
        const d = dist(cur, p);
        if (d < 1e-5) continue;
        const steps = Math.max(1, Math.ceil(d / towSpeed));
        for (let k = 1; k <= steps; k++) {
          const nx = cur.x + (p.x - cur.x) * (k / steps);
          const ny = cur.y + (p.y - cur.y) * (k / steps);
          towFrames.push({x: nx, y: ny, action: 'tow', clearDockAtY: ny >= LAYOUT.cpFrontY - 0.05});
        }
        cur = {x: p.x, y: p.y};
      }
      r.status = 'TOWING';
      r.towTrajectory = towFrames;
      r.towIndex = 0;
      engine.topologyVersion++;
      engine.log(`Bắt đầu kéo cứu hộ ${r.id} (0,20 m/s) về ô sửa chữa ${targetMaint.id}`);
      continue;
    }

    if (r.status === 'TOWING') {
      r.faultSeconds++;
      const prev = {x: r.x, y: r.y};
      const f = r.towTrajectory[++r.towIndex];
      if (f) {
        r.x = f.x;
        r.y = f.y;
        r.distance += dist(prev, f);
        // Release truck DOCK_HOLD_FAULT once faulted robot & crew exit truck bed completely onto cpFrontY
        if (f.clearDockAtY && r.heldTruckId) {
          const tr = engine.trucks.find(t => t.id === r.heldTruckId);
          if (tr && tr.state === 'DOCK_HOLD_FAULT') {
            tr.state = tr.pallets.length > 0 ? 'LOADING' : 'READY';
            engine.log(`Tổ cứu hộ và ${r.id} đã rời khỏi thùng ${tr.id}; mở lại khóa bến ${tr.dockCode}`);
          }
          r.heldTruckId = null;
          engine.topologyVersion++;
        }
      }
      if (!f || r.towIndex >= r.towTrajectory.length - 1) {
        r.status = 'IN_MAINT';
        r.towTrajectory = null;
        r.towIndex = 0;
        r.maintRepairRemaining = r.plannedRepairRemaining ?? (engine.config.maintRepairSec ?? 900);
        engine.topologyVersion++;
        engine.metrics.rescuesCompleted++;
        engine.log(`${r.id} đã vào khu sửa chữa ${r.maintBayId}; giải phóng hoàn toàn hành lang lưu thông`);
        reconcileActiveTrajectories(engine);
      }
      continue;
    }

    if (r.status === 'IN_MAINT') {
      r.faultSeconds++;
      if (r.maintRepairRemaining != null && --r.maintRepairRemaining <= 0) {
        recoverRobotOp(engine, r.id);
      }
    }
  }
}

export function recoverRobotOp(engine, id, options = {}) {
  const r = engine.robots.get(id);
  if (!r || !['FAULT', 'IN_MAINT', 'WAITING_EXTERNAL_ASSISTANCE', 'RESCUE_SETUP'].includes(r.status)) return false;

  if (r.maintBayId) {
    const loc = engine.locations.get(r.maintBayId);
    if (loc && loc.occupiedByRobot === r.id) loc.occupiedByRobot = null;
    r.maintBayId = null;
  }
  if (r.battery <= 1) r.battery = 30;
  r.awaitingOperatorConfirm = false;
  r.faultReason = null;
  r.currentLiftM = 0;

  if (r.task?.truck && r.task.truck.state === 'DOCK_HOLD_FAULT') {
    r.task.truck.state = r.task.truck.pallets.length > 0 ? 'LOADING' : 'READY';
  }
  if (r.heldTruckId) {
    const tr = engine.trucks.find(t => t.id === r.heldTruckId);
    if (tr && tr.state === 'DOCK_HOLD_FAULT') tr.state = tr.pallets.length > 0 ? 'LOADING' : 'READY';
    r.heldTruckId = null;
  }

  if (r.task) {
    // Rebuild safe continuation trajectory from current location
    const remTraj = r.trajectory ? r.trajectory.slice(r.index) : null;
    if (remTraj && remTraj.length > 1) {
      if (remTraj.bedStart != null) delete remTraj.bedStart;
      if (r.trajectory?.bedStart != null) {
        remTraj.bedStart = Math.max(0, r.trajectory.bedStart - r.index);
        remTraj.bedEnd = Math.max(0, r.trajectory.bedEnd - r.index);
      }
    }
    if (remTraj && remTraj.length > 1 && canRunTrajectory(engine, r, r.task, remTraj, 0, {x: r.x, y: r.y})) {
      r.trajectory = remTraj;
      r.index = 0;
      r.pausedTrajectory = null;
      r.status = 'RUNNING';
    } else {
      r.pausedTrajectory = remTraj;
      r.status = 'WAITING_PATH';
      r.waitingPathSince = engine.time;
      r.lastTopologyChecked = -1;
    }
  } else if (dist(r, r.home) > 0.3) {
    const retJob = {
      id: `RET_${r.id}_${engine.time}`,
      label: 'Về bến sau phục hồi',
      type: r.type,
      state: 'ACTIVE',
      robot: r.id,
      resources: [],
      activeCells: []
    };
    r.task = retJob;
    r.returning = true;
    const retTraj = engine.buildReturnHomeTrajectory(r, {x: r.x, y: r.y});
    if (retTraj && retTraj.length > 1 && canRunTrajectory(engine, r, retJob, retTraj, 0, {x: r.x, y: r.y})) {
      r.trajectory = retTraj;
      r.index = 0;
      r.status = 'RUNNING';
    } else if (retTraj && retTraj.length > 1) {
      r.trajectory = retTraj;
      r.index = 0;
      r.status = 'WAITING_PATH';
      r.waitingPathSince = engine.time;
      r.lastTopologyChecked = -1;
    } else {
      r.task = null;
      r.returning = false;
      r.status = 'IDLE';
      r.trajectory = null;
      r.index = 0;
    }
  } else {
    r.status = 'IDLE';
    r.trajectory = null;
    r.index = 0;
  }

  engine.topologyVersion++;
  engine.log(`${id} hoàn tất phục hồi kỹ thuật tại (${r.x.toFixed(1)}, ${r.y.toFixed(1)}), mở lại vùng cô lập`);
  reconcileActiveTrajectories(engine);
  return true;
}
