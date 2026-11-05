// c:/Users/lshie/Documents/project/stupidfuck/Bao_cao_WinMart_V6_1_5000m2/Mo_phong/app.mjs
// WinMart V6.2 Interactive Frontend Controller — 5-Step Excel Planning, Live Oriented Floorplan, Local Rescue/E-STOP & Web Worker Comparison.

import {WinMartEngine, LAYOUT, VEHICLE_SPECS} from './core.mjs';
import {
  parseAndValidateExcelWorkbook,
  buildPreRunPlanPreview,
  generateSampleWorkbookBuffer,
  exportRunResultsToXlsx
} from './excel_io.mjs';

const $ = id => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d');
const bg = new Image();
bg.src = 'map.svg';

let engine = null;
let workerSnapshotOverride = null;
let lastWallMs = null;
let playing = false;
let lastFrameTs = 0;
let simAcc = 0;
let pendingExcelResult = null;
let activeExcelPlan = null;
let simWorker = null;
let currentWorkerRunId = 0;

const PHASE_LABELS = {
  INBOUND: 'Ca nhập',
  OUTBOUND: 'Ca xuất',
  TRANSITION: 'Bàn giao chuyển ca',
  STOPPED: 'Đã hoàn tất ca'
};

const CELL_LABELS = {
  EMPTY: 'Trống',
  PREPARING: 'Chuẩn bị đợt',
  ASSEMBLING: 'Đang ghép',
  WAVE_CHANGEOVER: 'Đổi đợt nguồn',
  QC_PENDING: 'Chờ QC',
  QC_WRAPPING: 'QC & quấn màng',
  COMPLETE: 'Hoàn tất'
};

const ROBOT_STATUS_LABELS = {
  IDLE: 'Rảnh tại bến',
  RUNNING: 'Đang vận hành',
  CHARGING: 'Đang sạc',
  WAITING_PATH: 'Tạm dừng chờ đường',
  FAULT: 'Dừng lỗi cục bộ',
  WAITING_EXTERNAL_ASSISTANCE: 'Chờ hạ tải cao',
  RESCUE_SETUP: 'Mở phanh & rút hàng (F3)',
  TOWING: 'Kéo cứu hộ (0,20 m/s)',
  IN_MAINT: 'Đang sửa tại MAINT',
  INACTIVE: 'Ngừng kích hoạt'
};

const TRUCK_STATUS_LABELS = {
  NOT_ARRIVED: 'Chưa đến',
  AT_YARD: 'Chờ tại bãi',
  DOCKING: 'Đang cập dock',
  READY: 'Sẵn sàng xếp',
  LOADING: 'Đang xếp hàng',
  DOCK_HOLD_FAULT: 'KHÓA CỨNG D2 (Sự cố)',
  DEPARTED: 'Đã rời kho'
};

function clock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map(v => String(v).padStart(2, '0'))
    .join(':');
}

function buildScenarioConfig(scenarioKey) {
  const uiPolicy = $('policySelect').value;
  const uiFefo = $('fefoSelect').value;
  const activeXnCount = Number($('xnCountSelect').value);
  const activeCpCount = Number($('cpCountSelect').value);
  const activeOutboundDocks = Number($('dockCountSelect').value);

  const common = {
    dispatchPolicy: uiPolicy,
    fefoMode: uiFefo,
    activeXnCount,
    activeCpCount,
    activeOutboundDocks
  };

  if (scenarioKey === 'excel_std' || scenarioKey === 'excel_full') {
    const variant = scenarioKey === 'excel_full' ? 'full_8h' : 'standard';
    const buf = generateSampleWorkbookBuffer(variant);
    const parsed = parseAndValidateExcelWorkbook(buf);
    pendingExcelResult = {fileName: variant === 'full_8h' ? 'Mau_Tai_Cao_8h_V6_2.xlsx' : 'Mau_Ke_Hoach_Ca_Xuat_WinMart_V6_2.xlsx', ...parsed};
    activeExcelPlan = parsed.plan;
    renderExcelReviewPanel(pendingExcelResult, false);
    return {
      ...common,
      excelPlan: parsed.plan
    };
  }

  if (scenarioKey === 'custom_excel' && activeExcelPlan) {
    return {
      ...common,
      excelPlan: activeExcelPlan
    };
  }

  activeExcelPlan = null;
  const presets = {
    base: {},
    baseline_b: {dispatchPolicy: 'V6_2_BASELINE', fefoMode: 'STRICT_FEFO'},
    nocross: {crossZone: false},
    skew80: {demandSkewA: 0.80},
    slow: {humanMultiplier: 1.25},
    inbound: {startPhase: 'INBOUND', initialPerSKU: 0, inboundPallets: 128},
    cycle: {startPhase: 'INBOUND', initialPerSKU: 48, autoCycle: true, orderLimit: 600, inboundPallets: 112},
    charge: {initialBattery: 15},
    low: {initialPerSKU: 2},
    stage: {direct: false},
    fault_detour: {
      faultSchedule: [
        {time: 900, robotId: 'XN2', repairMode: 'IN_PLACE', repairDurationSec: 2400, reason: 'Lỗi cảm biến dẫn hướng trên hành lang chính'}
      ]
    },
    fault_dock: {
      faultSchedule: [
        {time: 1350, robotId: 'CP3', repairMode: 'TOW_TO_MAINT', repairDurationSec: 1200, reason: 'Mất áp thủy lực khi đang xếp hàng tại cửa dock'}
      ]
    }
  };

  const chosen = presets[scenarioKey] || {};
  if (scenarioKey === 'baseline_b') {
    $('policySelect').value = 'V6_2_BASELINE';
    $('fefoSelect').value = 'STRICT_FEFO';
  }
  return {...common, ...chosen};
}

function initSession(customCfg = null) {
  playing = false;
  cancelActiveWorker();
  workerSnapshotOverride = null;
  lastWallMs = null;
  simAcc = 0;

  const cfg = customCfg || buildScenarioConfig($('scenario').value);
  engine = new WinMartEngine(cfg);

  const prevSelected = $('robot').value;
  $('robot').innerHTML = [...engine.robots.keys()].map(id => `<option value="${id}">${id}</option>`).join('');
  if (prevSelected && engine.robots.has(prevSelected)) $('robot').value = prevSelected;

  $('estopBtn').setAttribute('aria-pressed', 'false');
  $('estopBtn').textContent = 'Kích hoạt E-STOP';
  render();
}

function downloadBlob(bytes, fileName, mime) {
  const blob = new Blob([bytes], {type: mime});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function renderExcelReviewPanel(result, autoOpen = true) {
  const panel = $('excelReviewPanel');
  if (autoOpen) panel.classList.remove('hidden');

  const {fileName, valid, errors, warnings, plan} = result;
  $('excelFileTitle').textContent = `Tệp kế hoạch: ${fileName}${engine && engine.time > 0 ? ' (Phiên hiện tại đang ở ' + clock(engine.time) + ' — bấm Áp dụng để mở phiên mới t = 0)' : ''}`;

  const badge = $('excelValidBadge');
  badge.className = 'badge ' + (!valid ? 'err' : warnings.length ? 'warn' : 'ok');
  badge.textContent = !valid
    ? `CHẶN CHẠY · ${errors.length} lỗi cấu trúc`
    : warnings.length
      ? `HỢP LỆ CÓ CẢNH BÁO · ${warnings.length} cảnh báo`
      : 'HỢP LỆ TUYỆT ĐỐI · 0 lỗi, 0 cảnh báo';

  $('applyExcelPlanBtn').disabled = !valid || !plan;

  if (plan) {
    const pv = buildPreRunPlanPreview(plan, warnings);
    $('excelPreviewCards').innerHTML = [
      [pv.planId, `Ngày ${pv.shiftDate} · Bắt đầu ${pv.shiftStartTime}`],
      [`${pv.totalOrders} đơn`, `Tổng ${pv.totalPlannedPallets} pallet (${pv.wholePallets} nguyên · ${pv.mixedPallets} ghép)`],
      [`${pv.totalDemandCartons} kiện`, `Nhu cầu xuất / ${pv.totalAvailableCartons} kiện tồn khả dụng`],
      [`${pv.totalTrips} chuyến`, `Sức chứa ${pv.totalTripPalletCapacity} chỗ pallet trên dải dock`],
      [`${plan.shiftConfig.activeXnCount} XN · ${plan.shiftConfig.activeCpCount} CP`, `${plan.shiftConfig.assemblyTeams} đội ghép · ${plan.shiftConfig.qcInspectors} QC`]
    ].map(([big, sub]) => `<div class="preview-card"><strong>${big}</strong><span>${sub}</span></div>`).join('');

    $('excelRouteSummary').innerHTML = pv.routes.map(rt =>
      `<span class="route-pill"><strong>Tuyến ${rt.routeId}:</strong> ${rt.orders} đơn · ${rt.pallets} PL (${rt.weightKg} kg) · ${rt.trips} chuyến (${rt.tripCapacityPallets} chỗ)</span>`
    ).join('');
  } else {
    $('excelPreviewCards').innerHTML = '';
    $('excelRouteSummary').innerHTML = '';
  }

  const allIssues = [...errors, ...warnings];
  const wrap = $('excelIssuesWrap');
  if (allIssues.length) {
    wrap.classList.remove('hidden');
    $('excelIssuesBody').innerHTML = allIssues.slice(0, 80).map(iss => `
      <tr class="${iss.severity === 'ERROR' ? 'row-fault' : ''}">
        <td><strong>${iss.severity === 'ERROR' ? 'LỖI (Chặn)' : 'CẢNH BÁO'}</strong></td>
        <td>${iss.sheet}</td>
        <td>${iss.row || '—'}</td>
        <td><code>${iss.column}</code></td>
        <td><code>${iss.code}</code></td>
        <td>${iss.message}</td>
      </tr>
    `).join('');
  } else {
    wrap.classList.add('hidden');
    $('excelIssuesBody').innerHTML = '';
  }
}

function getActiveSnapshot() {
  if (workerSnapshotOverride) return workerSnapshotOverride;
  return engine.snapshot(engine.phase === 'STOPPED', true);
}

const mapX = xm => 40 + xm * 11;
const mapY = ym => ym < 0 ? 105 + (ym / 5.6) * 43 : 110 + ym * 11;

function drawOrientedVehicle(r) {
  const px = mapX(r.x);
  const py = mapY(r.y);
  const spec = VEHICLE_SPECS[r.type];
  const halfL = Math.max(7.5, (spec.unloadedLengthM * 11) * 0.44);
  const halfW = Math.max(5.5, (spec.unloadedWidthM * 11) * 0.44);

  let fill = r.type === 'RT' ? '#c26a15' : '#1d65a6';
  if (!r.active) fill = '#94a3b8';
  else if (['FAULT', 'WAITING_EXTERNAL_ASSISTANCE'].includes(r.status)) fill = '#b91c1c';
  else if (['RESCUE_SETUP', 'TOWING'].includes(r.status)) fill = '#7c3aed';
  else if (r.status === 'IN_MAINT') fill = '#0f766e';
  else if (r.status === 'WAITING_PATH') fill = '#d97706';

  // Local isolation halo around faulted corridor vehicles
  if (['FAULT', 'WAITING_EXTERNAL_ASSISTANCE', 'RESCUE_SETUP'].includes(r.status)) {
    ctx.save();
    ctx.strokeStyle = 'rgba(185, 28, 28, 0.75)';
    ctx.fillStyle = 'rgba(254, 226, 226, 0.38)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(px, py, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  const angle = Math.atan2(r.sin ?? -1, r.cos ?? 0);
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(angle);

  // Forks / heading nose indicator
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(halfL - 1, -halfW * 0.55);
  ctx.lineTo(halfL + 4.5, -halfW * 0.55);
  ctx.moveTo(halfL - 1, halfW * 0.55);
  ctx.lineTo(halfL + 4.5, halfW * 0.55);
  ctx.stroke();

  // Chassis
  ctx.fillStyle = fill;
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 1.2;
  ctx.fillRect(-halfL, -halfW, halfL * 2, halfW * 2);
  ctx.strokeRect(-halfL, -halfW, halfL * 2, halfW * 2);

  // Carried pallet overlay
  if (r.carried) {
    ctx.fillStyle = '#fde047';
    ctx.strokeStyle = '#713f12';
    ctx.lineWidth = 1.2;
    ctx.fillRect(-halfL * 0.45, -halfW * 0.82, halfL * 1.35, halfW * 1.64);
    ctx.strokeRect(-halfL * 0.45, -halfW * 0.82, halfL * 1.35, halfW * 1.64);
  }
  ctx.restore();

  // Label + mini SOC bar + lift indicator
  ctx.font = 'bold 10.5px Segoe UI, Arial';
  ctx.fillStyle = '#0f172a';
  const lbl = r.currentLiftM > 0.30 ? `${r.id}↑${r.currentLiftM.toFixed(1)}m` : r.id;
  ctx.fillText(lbl, px + 9, py - 2);

  if (r.active) {
    const bw = 18, bh = 3.2;
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(px + 9, py + 2, bw, bh);
    ctx.fillStyle = r.battery < 25 ? '#dc2626' : '#16a34a';
    ctx.fillRect(px + 9, py + 2, Math.max(1, (bw * Math.min(100, r.battery)) / 100), bh);
  }
}

function drawFloorplan(s) {
  ctx.clearRect(0, 0, 1180, 750);
  if (bg.complete) ctx.drawImage(bg, 0, 0);

  // 1. Subtle rack pallet markers at physical (rackX, rackY) inside rack bays (never blocking aisle centerlines)
  if (s.rackPallets) {
    for (const rp of s.rackPallets) {
      const rx = mapX(rp.x);
      const ry = mapY(rp.y);
      ctx.fillStyle = rp.allocated > 0 ? '#f59e0b' : (rp.level === 2 ? '#3b82f6' : rp.level === 1 ? '#64748b' : '#475569');
      ctx.fillRect(rx - 2.2, ry - 1.8, 4.4, 3.6);
    }
  }

  // 2. Maintenance bays (MAINT_CP1..2, MAINT_RT1..2)
  for (const m of [...LAYOUT.maintBays.CP, ...LAYOUT.maintBays.RT]) {
    const mx = mapX(m.x), my = mapY(m.y);
    ctx.save();
    ctx.strokeStyle = '#0f766e';
    ctx.fillStyle = 'rgba(204, 251, 241, 0.65)';
    ctx.setLineDash([3, 2]);
    ctx.lineWidth = 1.2;
    ctx.fillRect(mx - 12, my - 7.5, 24, 15);
    ctx.strokeRect(mx - 12, my - 7.5, 24, 15);
    ctx.restore();
    ctx.font = 'bold 8.5px Arial';
    ctx.fillStyle = '#115e59';
    ctx.fillText('M', mx - 3.5, my + 3);
  }

  // 3. Yard queue badges in the upper-right outdoor apron (x = 87..99 m, y = 49..104 px)
  const yardList = s.yardTrucks || [];
  if (yardList.length > 0) {
    ctx.fillStyle = '#eff6ff';
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.1;
    ctx.fillRect(mapX(86.4), 50, 146, 54);
    ctx.strokeRect(mapX(86.4), 50, 146, 54);
    ctx.font = 'bold 10px Segoe UI, Arial';
    ctx.fillStyle = '#1e3a8a';
    ctx.fillText(`Bãi chờ Yard: ${yardList.length} chuyến`, mapX(87.0), 63);
    yardList.slice(0, 4).forEach((yt, idx) => {
      const col = idx % 2, row = Math.floor(idx / 2);
      const bx = mapX(87.0) + col * 69;
      const by = 69 + row * 16;
      ctx.fillStyle = '#dbeafe';
      ctx.fillRect(bx, by, 64, 13);
      ctx.fillStyle = '#0f2942';
      ctx.font = '9.5px Segoe UI, Arial';
      ctx.fillText(`${yt.id}·${yt.route}`, bx + 3, by + 10);
    });
  }

  // 4. Active docked outbound trucks & DOCK_HOLD_FAULT safety lock highlight
  for (const t of (s.activeDocks || [])) {
    const cx = mapX(LAYOUT.outboundDockXs[t.bay]);
    const isHold = t.state === 'DOCK_HOLD_FAULT';
    ctx.save();
    ctx.strokeStyle = isHold ? '#dc2626' : (t.state === 'LOADING' ? '#15803d' : '#2563eb');
    ctx.lineWidth = isHold ? 3.0 : 2.2;
    ctx.strokeRect(cx - 13, 54, 26, 49);
    if (isHold) {
      ctx.fillStyle = '#dc2626';
      ctx.fillRect(cx - 16, 38, 32, 12);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 8.5px Arial';
      ctx.fillText('LOCK D2', cx - 14.5, 47);
    }
    ctx.restore();
  }

  // 5. Floor & truck-bed pallets
  if (s.floorPallets) {
    for (const fp of s.floorPallets) {
      const px = mapX(fp.x);
      if (fp.locKind === 'truck') {
        const slotIdx = Number(fp.locId.split('_')[1] || 0);
        const sy = 58 + slotIdx * 10.3;
        ctx.fillStyle = '#86efac';
        ctx.strokeStyle = '#15803d';
        ctx.lineWidth = 1;
        ctx.fillRect(px - 8, sy, 16, 7.8);
        ctx.strokeRect(px - 8, sy, 16, 7.8);
        ctx.beginPath();
        ctx.arc(px, 62 + slotIdx * 10.3, 3.3, 0, Math.PI * 2);
        ctx.fillStyle = '#0f2942';
        ctx.fill();
      } else {
        const py = mapY(fp.y);
        ctx.beginPath();
        ctx.arc(px, py, 4.2, 0, Math.PI * 2);
        ctx.fillStyle = fp.checked ? '#15803d' : '#0f2942';
        ctx.fill();
      }
    }
  }

  // 6. Active charger glow
  for (const chg of (s.chargers || [])) {
    if (chg.state === 'FREE') continue;
    const specPort = [...LAYOUT.rtChargers, ...LAYOUT.cpChargers].find(x => x.id === chg.id);
    if (!specPort) continue;
    const cx = mapX(specPort.x), cy = mapY(specPort.y);
    ctx.strokeStyle = '#eab308';
    ctx.lineWidth = 2.2;
    ctx.strokeRect(cx - 6.5, cy - 6.5, 13, 13);
  }

  // 7. Vehicles
  for (const r of (s.robots || [])) {
    drawOrientedVehicle(r);
  }
}

function renderAlerts(s) {
  const alerts = [];

  if (s.emergencyStop?.active) {
    alerts.push({
      cls: 'err',
      html: `<span><strong>DỪNG KHẨN CẤP E-STOP ĐANG KÍCH HOẠT (Vùng: ${s.emergencyStop.zone})</strong> — Mọi chuyển động trong vùng dừng cứng; đồng hồ ca và giờ cắt chuyến xe vẫn trôi trung thực.</span>
             <button type="button" data-action="clear-estop">Giải tỏa E-STOP</button>`
    });
  }

  const holdDocks = (s.activeDocks || []).filter(d => d.state === 'DOCK_HOLD_FAULT');
  if (holdDocks.length) {
    alerts.push({
      cls: 'err',
      html: `<span><strong>KHÓA AN TOÀN CỬA DOCK (DOCK_HOLD_FAULT):</strong> ${holdDocks.map(d => `${d.dockCode} (${d.id})`).join(', ')} đang giữ cứng chèn bánh D2 do thiết bị lỗi trong thùng xe.</span>`
    });
  }

  const awaitingRescue = (s.robots || []).filter(r => r.awaitingOperatorConfirm);
  for (const r of awaitingRescue) {
    alerts.push({
      cls: 'rescue',
      html: `<span><strong>Yêu cầu xác nhận cứu hộ cơ–điện (F3) cho ${r.id}:</strong> Thiết bị đang ở trạng thái <code>${ROBOT_STATUS_LABELS[r.status] || r.status}</code> tại (${r.x.toFixed(1)}m, ${r.y.toFixed(1)}m)${r.carried ? `, đang giữ pallet <strong>${r.carried}</strong>` : ''}.</span>
             <button type="button" class="btn-accent" data-rescue-id="${r.id}">Xác nhận điều tổ cứu hộ ${r.id}</button>`
    });
  }

  if (s.orderSummary?.shortageOrders > 0) {
    alerts.push({
      cls: 'warn',
      html: `<span><strong>Cảnh báo thiếu hụt tồn kho trung thực:</strong> Có <strong>${s.orderSummary.shortageOrders}</strong> đơn hàng chuyển sang <code>UNFULFILLED_SHORTAGE</code> do hết kiện khả dụng phù hợp hạn dùng (không tự sinh hàng giả).</span>`
    });
  }

  if (s.metrics?.detourCount > 0 || s.metrics?.reassignedTasks > 0) {
    alerts.push({
      cls: 'info',
      html: `<span><strong>Điều phối thích ứng cục bộ đang hoạt động:</strong> Đã giao lại <strong>${s.metrics.reassignedTasks}</strong> lệnh chưa mang hàng · Đổi lộ trình đi vòng an toàn <strong>${s.metrics.detourCount}</strong> lượt · Hoàn tất cứu hộ <strong>${s.metrics.rescuesCompleted}</strong> lượt.</span>`
    });
  }

  const box = $('alertStack');
  box.innerHTML = alerts.map(a => `<div class="alert-item ${a.cls}">${a.html}</div>`).join('');
  box.querySelectorAll('[data-rescue-id]').forEach(btn => {
    btn.onclick = () => {
      if (workerSnapshotOverride) workerSnapshotOverride = null;
      engine.authorizeRescue(btn.getAttribute('data-rescue-id'));
      render();
    };
  });
  const clearBtn = box.querySelector('[data-action="clear-estop"]');
  if (clearBtn) {
    clearBtn.onclick = () => {
      if (workerSnapshotOverride) workerSnapshotOverride = null;
      engine.triggerEmergencyStop(false, $('estopZone').value);
      $('estopBtn').setAttribute('aria-pressed', 'false');
      $('estopBtn').textContent = 'Kích hoạt E-STOP';
      render();
    };
  }
}

function render() {
  const s = getActiveSnapshot();
  const m = s.metrics;

  $('policyBadgeText').textContent = `${s.policy} · ${s.fefoMode}`;
  $('hashText').textContent = s.normalizedHash
    ? `SHA-256: ${s.normalizedHash.slice(0, 20)}…${lastWallMs != null ? ` (${lastWallMs} ms)` : ''}`
    : `Kế hoạch: ${s.planId}`;

  $('status').textContent =
    `${clock(s.time)} (Ca từ ${s.shiftStartTime}) · ${PHASE_LABELS[s.phase] || s.phase} · ` +
    `Đơn hoàn tất: ${s.orderSummary.shippedTotal}/${s.orderSummary.totalOrders} (Đúng hạn: ${s.orderSummary.shippedOnTime}) · ` +
    `Đang xử lý: ${s.unfinishedJobs} lệnh · Hỗ trợ chéo A⇄B: ${m.crossZoneTrips} · Đi vòng: ${m.detourCount}`;

  $('metrics').innerHTML = [
    [s.phase === 'INBOUND' ? m.received : `${s.orderSummary.shippedOnTime}/${s.orderSummary.totalOrders}`, s.phase === 'INBOUND' ? 'Pallet đã kiểm nhận' : 'Đơn đúng hạn / Đơn đã phát hành'],
    [m.assembled, `Pallet ghép xong (${m.multiWavePallets} đa đợt)`],
    [m.qcPassed, 'Pallet đạt kiểm định QC'],
    [m.departed, `Pallet rời kho (Chất xe: ${m.loaded} = ${m.direct} thẳng + ${m.viaStage} ST)`],
    [`${s.tripSummary.departedCount}/${s.tripSummary.totalTrips || 0}`, `Chuyến xe rời kho (${s.tripSummary.yardCount} chờ bãi)`],
    [`${m.windowFefoOptimizations}`, `Chọn lô khác trong cửa sổ FEFO (lô sớm: ${m.strictFefoPicks})`],
    [`${m.reassignedTasks} / ${m.detourCount}`, 'Lệnh giao lại / Lượt đi vòng']
  ].map(([val, label]) => `<div><strong>${val}</strong><span>${label}</span></div>`).join('');

  renderAlerts(s);
  drawFloorplan(s);

  // Yard + Active Docks
  const yardList = s.yardTrucks || [];
  $('yardSummary').innerHTML =
    `<strong>Bãi chờ ngoài nhà (AT_YARD): ${yardList.length} xe</strong> · Đang đỗ dock: <strong>${s.activeDocks.length}/${engine.config.activeOutboundDocks}</strong> · Đã rời: <strong>${s.departedCount}</strong> chuyến` +
    (yardList.length ? `<br><small>Sắp vào dock: ${yardList.slice(0, 4).map(y => `${y.id} (${y.route}, cắt giờ ${clock(y.committedDepartureSec)})`).join(' · ')}</small>` : '');

  $('truck').innerHTML = s.activeDocks.length
    ? s.activeDocks.map(t => `
        <div class="dock-row ${t.state === 'DOCK_HOLD_FAULT' ? 'hold-fault' : ''}">
          <strong>${t.dockCode} · ${t.id}</strong> (Tuyến ${t.route}) — ${TRUCK_STATUS_LABELS[t.state] || t.state}<br>
          Xếp: <strong>${t.pallets}/${t.maxPalletSlots}</strong> PL (đặt chỗ ${t.reserved}) · ${t.weight} kg · Hạn rời <strong>${clock(t.committedDepartureSec)}</strong>
        </div>
      `).join('')
    : `<p class="small-note">Hiện không có xe tải đang đỗ tại cửa dock xuất.</p>`;

  // 10 Assembly + QC Cells
  $('cells').innerHTML = (s.cells || []).map(c =>
    `<div class="${c.state}${c.isolated ? ' ISOLATED' : ''}">
      <strong>G${c.id}</strong> · ${CELL_LABELS[c.state] || c.state}
      ${c.orderId ? `<br><small>${c.orderId}${c.remaining > 0 ? ` (${c.remaining}s)` : ''}</small>` : ''}
    </div>`
  ).join('');

  // Chargers + Slot Occupancy
  const usedKw = (s.chargers || []).filter(c => c.state !== 'FREE').reduce((acc, c) => acc + c.kw, 0);
  $('chargersBox').innerHTML =
    `<div style="width:100%;font-size:12px;margin-bottom:4px">Công suất sạc: <strong>${usedKw.toFixed(1)} / 9,0 kW</strong> (trần ${engine.config.maxCharging} cổng)</div>` +
    (s.chargers || []).map(c => {
      const chgLabel = c.id.replace('CHG_', '').replace(/^RT/, 'Sạc XN').replace(/^CP/, 'Sạc CP');
      return `<span class="chg-chip ${c.state !== 'FREE' ? 'busy' : ''}">${chgLabel}: ${c.robotId || 'Trống'}</span>`;
    }).join('');

  const maxSlots = {inbound: 4, source: 20, output: 10, stage: 12, rack: 1764};
  const occNames = {inbound: 'Đệm nhập (IN0–IN3)', source: 'Đệm nguồn (N0–N19)', output: 'Thành phẩm (G0–G9)', stage: 'Chờ xuất (ST0–ST11)', rack: 'Kệ 3 tầng (L01–L14)'};
  $('occupancy').innerHTML = Object.entries(s.occupancy).map(([k, v]) =>
    `<p><span>${occNames[k]}</span><strong>${v} / ${maxSlots[k]}</strong></p>`
  ).join('');

  // Fleet Table
  $('robots').innerHTML = (s.robots || []).map(r => {
    const rowCls = ['FAULT', 'WAITING_EXTERNAL_ASSISTANCE'].includes(r.status)
      ? 'row-fault'
      : ['RESCUE_SETUP', 'TOWING', 'IN_MAINT'].includes(r.status)
        ? 'row-rescue'
        : '';
    const taskDesc = !r.active
      ? 'Tắt theo cấu hình đội xe'
      : r.status === 'IN_MAINT'
        ? `Sửa chữa tại ${r.maintBayId || 'MAINT'}`
        : r.taskLabel
          ? `${r.returning ? 'Nối chuyến/về bến sau ' : ''}${r.taskLabel}${r.carried ? ` (${r.carried})` : ''}`
          : (r.carried ? `Giữ an toàn ${r.carried}` : 'Đứng chờ tại bến');
    return `<tr class="${rowCls}">
      <td><strong>${r.id}</strong>${r.zone ? ` · Vùng ${r.zone}` : ' · Sàn thấp'}</td>
      <td>${ROBOT_STATUS_LABELS[r.status] || r.status}</td>
      <td>${taskDesc}</td>
      <td>${r.battery.toFixed(1)}%</td>
      <td>${r.type === 'RT' ? `${(r.currentLiftM || 0).toFixed(2)} m` : '0,15 m'}</td>
      <td>${(r.work / 60).toFixed(1)}</td>
      <td>${(r.charging / 60).toFixed(1)}</td>
      <td>${(r.waiting / 60).toFixed(1)}</td>
      <td>${(r.faultSeconds / 60).toFixed(1)}</td>
      <td>${r.distance.toFixed(0)}</td>
      <td>${r.type === 'RT' ? r.crossZoneCount : '—'}</td>
      <td>${r.detourCount} / ${r.reassignedCount}</td>
    </tr>`;
  }).join('');

  // Decision Traces & Recent Event Logs
  $('decisionLog').innerHTML = (s.decisionTraces || []).slice(-18).reverse()
    .map(d => `<li><strong>[${clock(d.time)} · ${d.category}]</strong> <code>${d.targetId}</code> — ${d.reason}</li>`)
    .join('') || '<li>Chưa phát sinh truy vết quyết định.</li>';

  $('log').innerHTML = (s.recentLogs || []).slice(-18).reverse()
    .map(x => `<li><strong>${clock(x.time)}</strong> — ${x.message}</li>`)
    .join('');

  $('play').textContent = playing ? 'Tạm dừng' : 'Chạy trực quan';
}

function ensureWorker() {
  if (simWorker) return simWorker;
  simWorker = new Worker(new URL('./sim_worker.mjs', import.meta.url), {type: 'module'});
  simWorker.onmessage = e => {
    const msg = e.data || {};
    if (msg.runId !== currentWorkerRunId) return;

    if (msg.type === 'PROGRESS') {
      $('workerProgressWrap').classList.remove('hidden');
      $('workerProgressBar').style.width = `${msg.pct}%`;
      $('workerProgressText').textContent = `${msg.label} — ${msg.pct}% (${clock(msg.simTime)} · ${msg.departed} PL rời kho)`;
      return;
    }

    $('workerProgressWrap').classList.add('hidden');
    $('cancelWorkerBtn').classList.add('hidden');
    $('fastRunBtn').disabled = false;
    $('compareBtn').disabled = false;

    if (msg.type === 'COMPLETE') {
      workerSnapshotOverride = msg.snapshot;
      lastWallMs = msg.wallMs;
      render();
    } else if (msg.type === 'COMPARE_COMPLETE') {
      workerSnapshotOverride = msg.proposed;
      lastWallMs = msg.proposedMs;
      renderComparisonTable(msg);
      render();
    } else if (msg.type === 'ERROR') {
      $('status').textContent = `Lỗi thực thi Worker: ${msg.message}`;
    }
  };
  return simWorker;
}

function cancelActiveWorker() {
  if (simWorker && currentWorkerRunId) {
    simWorker.postMessage({type: 'CANCEL', runId: currentWorkerRunId});
  }
  currentWorkerRunId++;
  $('workerProgressWrap').classList.add('hidden');
  $('cancelWorkerBtn').classList.add('hidden');
  $('fastRunBtn').disabled = false;
  $('compareBtn').disabled = false;
}

function renderComparisonTable({baseline, proposed, baselineFinal, proposedFinal, baselineMs, proposedMs}) {
  $('comparePanel').classList.remove('hidden');
  const fmtDelta = (b, c, unit = '', higherIsBetter = true) => {
    const diff = c - b;
    if (Math.abs(diff) < 1e-6) return '0' + unit;
    const good = higherIsBetter ? diff > 0 : diff < 0;
    const sign = diff > 0 ? '+' : '';
    return `<span class="${good ? 'delta-pos' : 'delta-neg'}">${sign}${Number.isInteger(diff) ? diff : diff.toFixed(1)}${unit}</span>`;
  };

  const rows = [
    ['Mốc đánh giá (giây mô phỏng)', baseline.time, proposed.time, 'Cùng thời lượng'],
    ['Đơn hàng xuất thành công (đơn)', baseline.orderSummary.shippedTotal, proposed.orderSummary.shippedTotal, fmtDelta(baseline.orderSummary.shippedTotal, proposed.orderSummary.shippedTotal, ' đơn', true)],
    ['Đơn xuất kho đúng hạn / tổng đơn', `${baseline.orderSummary.shippedOnTime}/${baseline.orderSummary.totalOrders}`, `${proposed.orderSummary.shippedOnTime}/${proposed.orderSummary.totalOrders}`, fmtDelta(baseline.orderSummary.shippedOnTime, proposed.orderSummary.shippedOnTime, ' đơn', true)],
    ['Tổng pallet xuất rời kho (pallet)', baseline.metrics.departed, proposed.metrics.departed, fmtDelta(baseline.metrics.departed, proposed.metrics.departed, ' PL', true)],
    ['Chuyến xe rời kho đúng hạn cắt giờ', `${baseline.tripSummary.onTimeTrips}/${baseline.tripSummary.departedCount}`, `${proposed.tripSummary.onTimeTrips}/${proposed.tripSummary.departedCount}`, 'Số chuyến có hàng đúng giờ / đã rời'],
    ['Lần chọn lô khác khi còn nguồn hạn sớm', baseline.metrics.windowFefoOptimizations, proposed.metrics.windowFefoOptimizations, 'Chỉ tiêu mô tả quyết định'],
    ['Lệnh giao lại tự động / Đi vòng tránh vật cản', `${baseline.metrics.reassignedTasks} / ${baseline.metrics.detourCount}`, `${proposed.metrics.reassignedTasks} / ${proposed.metrics.detourCount}`, `+${proposed.metrics.reassignedTasks - baseline.metrics.reassignedTasks} lệnh / +${proposed.metrics.detourCount - baseline.metrics.detourCount} lượt`],
    ['Pallet ghép / xuất nguyên đã rời kho', `${baseline.palletSummary.shippedMixed} / ${baseline.palletSummary.shippedWhole}`, `${proposed.palletSummary.shippedMixed} / ${proposed.palletSummary.shippedWhole}`, 'Đối chiếu từng pallet'],
    ['Pallet xuất thêm sau mốc đánh giá', baselineFinal.metrics.departed-baseline.metrics.departed, proposedFinal.metrics.departed-proposed.metrics.departed, 'Tách khỏi sản lượng trong ca'],
    ['Kết thúc bàn giao (giây mô phỏng)', baselineFinal.time, proposedFinal.time, 'Có thể còn đơn chưa xuất'],
    ['Thời gian chạy thực nghiệm trên máy (ms)', `${baselineMs} ms`, `${proposedMs} ms`, 'Đo thực tế trên Web Worker'],
    ['Mã băm xác định (Normalized SHA-256)', `<code>${baseline.normalizedHash.slice(0, 16)}…</code>`, `<code>${proposed.normalizedHash.slice(0, 16)}…</code>`, 'Đối chiếu khả năng tái lập']
  ];

  $('compareTableBody').innerHTML = rows.map(([k, b, c, d]) =>
    `<tr><td><strong>${k}</strong></td><td>${b}</td><td>${c}</td><td>${d}</td></tr>`
  ).join('');
}

// ==================== WIRE UI EVENTS ====================
$('scenario').onchange = () => initSession();
$('policySelect').onchange = () => initSession();
$('fefoSelect').onchange = () => initSession();
$('xnCountSelect').onchange = () => initSession();
$('cpCountSelect').onchange = () => initSession();
$('dockCountSelect').onchange = () => initSession();
$('reset').onclick = () => initSession();

$('play').onclick = () => {
  if (workerSnapshotOverride) {
    // Switching back to live step-by-step from a completed worker snapshot starts fresh
    initSession();
  }
  playing = !playing;
  render();
};

$('step').onclick = () => {
  if (workerSnapshotOverride) workerSnapshotOverride = null;
  engine.step(300);
  render();
};

$('shift').onclick = () => {
  if (workerSnapshotOverride) workerSnapshotOverride = null;
  engine.requestTransition();
  render();
};

$('fastRunBtn').onclick = () => {
  playing = false;
  workerSnapshotOverride = null;
  const cfg = buildScenarioConfig(activeExcelPlan && $('scenario').value === 'custom_excel' ? 'custom_excel' : $('scenario').value);
  const w = ensureWorker();
  const runId = ++currentWorkerRunId;
  $('fastRunBtn').disabled = true;
  $('compareBtn').disabled = true;
  $('cancelWorkerBtn').classList.remove('hidden');
  $('workerProgressWrap').classList.remove('hidden');
  $('workerProgressBar').style.width = '2%';
  $('workerProgressText').textContent = 'Đang khởi chạy mô phỏng tốc độ cao trên Web Worker...';
  w.postMessage({type: 'RUN_FAST', runId, config: cfg});
};

$('compareBtn').onclick = () => {
  playing = false;
  workerSnapshotOverride = null;
  const cfg = buildScenarioConfig(activeExcelPlan && $('scenario').value === 'custom_excel' ? 'custom_excel' : $('scenario').value);
  const w = ensureWorker();
  const runId = ++currentWorkerRunId;
  $('fastRunBtn').disabled = true;
  $('compareBtn').disabled = true;
  $('cancelWorkerBtn').classList.remove('hidden');
  $('workerProgressWrap').classList.remove('hidden');
  $('workerProgressBar').style.width = '2%';
  $('workerProgressText').textContent = 'Đang chạy đối chiếu kết quả cơ sở và đề xuất trên Web Worker...';
  w.postMessage({type: 'COMPARE_POLICIES', runId, baseConfig: cfg});
};

$('cancelWorkerBtn').onclick = () => cancelActiveWorker();
$('closeCompareBtn').onclick = () => $('comparePanel').classList.add('hidden');
$('closeExcelPanelBtn').onclick = () => $('excelReviewPanel').classList.add('hidden');

$('downloadStdTpl').onclick = () => {
  const bytes = generateSampleWorkbookBuffer('standard');
  downloadBlob(bytes, 'Mau_Ke_Hoach_Ca_Xuat_WinMart_V6_2.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
};

$('downloadFullTpl').onclick = () => {
  const bytes = generateSampleWorkbookBuffer('full_8h');
  downloadBlob(bytes, 'Mau_Ke_Hoach_Ca_Xuat_8h_Tai_Cao_V6_2.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
};

$('excelInput').onchange = async ev => {
  const file = ev.target.files?.[0];
  if (!file) return;
  const ab = await file.arrayBuffer();
  const parsed = parseAndValidateExcelWorkbook(ab);
  pendingExcelResult = {fileName: file.name, ...parsed};
  renderExcelReviewPanel(pendingExcelResult, true);
  ev.target.value = '';
};

$('applyExcelPlanBtn').onclick = () => {
  if (!pendingExcelResult?.valid || !pendingExcelResult.plan) return;
  activeExcelPlan = pendingExcelResult.plan;
  // Ensure custom_excel option exists in dropdown so UI reflects loaded file
  let opt = [...$('scenario').options].find(o => o.value === 'custom_excel');
  if (!opt) {
    opt = document.createElement('option');
    opt.value = 'custom_excel';
    $('scenario').prepend(opt);
  }
  opt.textContent = `Tệp đã nạp: ${pendingExcelResult.fileName} (${activeExcelPlan.shiftConfig.planId})`;
  $('scenario').value = 'custom_excel';
  initSession(buildScenarioConfig('custom_excel'));
};

$('exportExcelBtn').onclick = () => {
  const snap = getActiveSnapshot();
  if (!snap.normalizedHash) snap.normalizedHash = engine.computeNormalizedHash();
  const bytes = exportRunResultsToXlsx(snap);
  downloadBlob(bytes, `Ket_qua_Mo_phong_WinMart_V6_2_${snap.planId}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
};

$('exportJsonBtn').onclick = () => {
  const snap = getActiveSnapshot();
  if (!snap.normalizedHash) snap.normalizedHash = engine.computeNormalizedHash();
  downloadBlob(JSON.stringify(snap, null, 2), `winmart-v6.2-${snap.planId}.json`, 'application/json');
};

$('fault').onclick = () => {
  if (workerSnapshotOverride) workerSnapshotOverride = null;
  const id = $('robot').value;
  const repairMode = $('faultMode').value;
  engine.faultRobot(id, {
    repairMode,
    repairDurationSec: repairMode === 'IN_PLACE' ? 900 : 1200,
    reason: 'Kích hoạt kiểm thử sự cố từ bảng điều hành'
  });
  render();
};

$('rescueBtn').onclick = () => {
  if (workerSnapshotOverride) workerSnapshotOverride = null;
  engine.authorizeRescue($('robot').value);
  render();
};

$('recover').onclick = () => {
  if (workerSnapshotOverride) workerSnapshotOverride = null;
  engine.recoverRobot($('robot').value);
  render();
};

$('estopBtn').onclick = () => {
  if (workerSnapshotOverride) workerSnapshotOverride = null;
  const nextActive = !engine.emergencyStop.active;
  engine.triggerEmergencyStop(nextActive, $('estopZone').value);
  $('estopBtn').setAttribute('aria-pressed', String(nextActive));
  $('estopBtn').textContent = nextActive ? 'Giải tỏa E-STOP' : 'Kích hoạt E-STOP';
  render();
};

$('zoom').onclick = () => {
  const z = $('mapWrap').classList.toggle('zoomed');
  $('zoom').setAttribute('aria-pressed', String(z));
  $('zoom').textContent = z ? 'Thu vừa màn hình' : 'Phóng to bản đồ';
};

function animationFrame(ts) {
  if (playing && engine) {
    const dt = Math.min((ts - lastFrameTs) / 1000, 0.1);
    simAcc += dt * Number($('speed').value);
    const steps = Math.floor(simAcc);
    if (steps > 0) {
      try {
        engine.step(steps);
        simAcc -= steps;
        if (engine.phase === 'STOPPED') playing = false;
      } catch (err) {
        playing = false;
        $('status').textContent = `Dừng do vi phạm bất biến: ${err.message}`;
        throw err;
      }
      render();
    }
  }
  lastFrameTs = ts;
  requestAnimationFrame(animationFrame);
}

window.sim = {
  get engine() { return engine; },
  step(n) {
    workerSnapshotOverride = null;
    engine.step(n);
    render();
    return getActiveSnapshot();
  },
  getSnapshot: () => getActiveSnapshot(),
  loadExcelBuffer(ab, name = 'test.xlsx') {
    const parsed = parseAndValidateExcelWorkbook(ab);
    pendingExcelResult = {fileName: name, ...parsed};
    renderExcelReviewPanel(pendingExcelResult, true);
    return pendingExcelResult;
  }
};

bg.onload = () => { if (engine) render(); };
initSession();
requestAnimationFrame(animationFrame);
