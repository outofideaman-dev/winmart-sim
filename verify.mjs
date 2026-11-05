// c:/Users/lshie/Documents/project/stupidfuck/Bao_cao_WinMart_V6_1_5000m2/Mo_phong/verify.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  WinMartEngine,
  LAYOUT,
  VEHICLE_SPECS,
  generateStorageSlots,
  obbOverlap,
  parseAndValidateExcelWorkbook,
  generateSampleWorkbookBuffer,
  exportRunResultsToXlsx
} from './core.mjs';
import {WinMartEngine as WinMartEngineV61} from './core_v6_1.mjs';
import * as XLSX from './vendor/xlsx.mjs';

const checks = [];

function test(id, name, fn) {
  const t0 = performance.now();
  const details = fn() || {};
  const wallMs = Math.round((performance.now() - t0) * 10) / 10;
  checks.push({id, name, passed: true, wallMs, details});
  console.log(`PASS [${id}] ${name} (${wallMs} ms)`);
}

// 1. Unified Indoor 5,000 m² Geometry & OBB Clearance
test('V62-GEO-01', 'Hình học thống nhất 5.000 m², 1.764 ô kệ tách tọa độ vật lý/điểm lấy và kiểm chứng bao hình OBB', () => {
  assert.equal(LAYOUT.areas.reduce((s, a) => s + a[5], 0), 5000);
  const slots = generateStorageSlots();
  assert.equal(slots.length, 1764);
  const sampleSlot = slots[0];
  assert.notEqual(sampleSlot.rackX, sampleSlot.pickupX, 'Tọa độ tâm kệ vật lý phải tách khỏi điểm dừng xe nâng trên lối đi');
  assert.equal(LAYOUT.inboundDockXs.length, 6);
  assert.equal(LAYOUT.outboundDockXs.length, 12);
  assert.equal(LAYOUT.maintBays.CP.length + LAYOUT.maintBays.RT.length, 4);

  // OBB clearance: parked XN at rtHomeY=49.0m vs moving XN carrying pallet on rearY=46.8m
  const rtSpec = VEHICLE_SPECS.RT;
  assert.equal(
    obbOverlap(
      10.6, LAYOUT.rtHomeY, 0, -1, rtSpec.unloadedLengthM / 2, rtSpec.unloadedWidthM / 2,
      10.6, LAYOUT.rearY, 1, 0, (rtSpec.loadedLengthM + rtSpec.longitudinalMarginM) / 2, (rtSpec.loadedWidthM + rtSpec.lateralMarginM) / 2
    ),
    false,
    'Hành lang vòng hậu y=46.8m phải thông suốt, không chạm xe đỗ ở y=49.0m'
  );

  // OBB clearance: charging CP at y=9.2m vs moving CP on cpMidY=11.6m
  const cpSpec = VEHICLE_SPECS.CP;
  assert.equal(
    obbOverlap(
      88.0, 9.2, 1, 0, cpSpec.unloadedLengthM / 2, cpSpec.unloadedWidthM / 2,
      88.0, LAYOUT.cpMidY, 1, 0, (cpSpec.loadedLengthM + cpSpec.longitudinalMarginM) / 2, (cpSpec.loadedWidthM + cpSpec.lateralMarginM) / 2
    ),
    false,
    'Trạm sạc lõm CP y=9.2m không cản hành lang tránh y=11.6m'
  );
  return {slots: slots.length, rearY: LAYOUT.rearY, rtHomeY: LAYOUT.rtHomeY};
});

// 2. 6-Sheet Outbound Excel Template Generation, Validation & Error Blocking
test('V62-XLS-02', 'Bộ kiểm tra Excel 6 sheet ca xuất: mẫu chuẩn 0 lỗi, chặn ERROR cứng và cảnh báo WARNING thiếu tồn', () => {
  const stdBuf = generateSampleWorkbookBuffer('standard');
  const stdRes = parseAndValidateExcelWorkbook(stdBuf);
  assert.equal(stdRes.valid, true);
  assert.equal(stdRes.errors.length, 0);
  assert.equal(stdRes.warnings.length, 0);

  const fullBuf = generateSampleWorkbookBuffer('full_8h');
  const fullRes = parseAndValidateExcelWorkbook(fullBuf);
  assert.equal(fullRes.valid, true);
  assert.equal(fullRes.errors.length, 0);
  assert.ok(fullRes.summary.orders >= 140);

  // Tamper workbook to verify blocking ERRORs (invalid rack location + gross weight > 800kg + duplicate order_id)
  const wbErr = XLSX.read(stdBuf, {type: 'array'});
  const ordRows = XLSX.utils.sheet_to_json(wbErr.Sheets['04_Don_hang_xuat']);
  ordRows.push({...ordRows[0]});
  wbErr.Sheets['04_Don_hang_xuat'] = XLSX.utils.json_to_sheet(ordRows);

  const invRows = XLSX.utils.sheet_to_json(wbErr.Sheets['03_Ton_kho_pallet']);
  invRows[0].location_code = 'INVALID_SLOT_999';
  wbErr.Sheets['03_Ton_kho_pallet'] = XLSX.utils.json_to_sheet(invRows);

  const lineRows = XLSX.utils.sheet_to_json(wbErr.Sheets['05_Chi_tiet_pallet_xuat']);
  lineRows[0].qty_cartons = 180;
  wbErr.Sheets['05_Chi_tiet_pallet_xuat'] = XLSX.utils.json_to_sheet(lineRows);

  const badBuf = XLSX.write(wbErr, {type: 'array', bookType: 'xlsx'});
  const badRes = parseAndValidateExcelWorkbook(badBuf);
  assert.equal(badRes.valid, false, 'File có lỗi cấu trúc/vị trí/quá tải phải bị chặn nạp');
  assert.ok(badRes.errors.length >= 3);

  // Tamper unpinned stock downward to verify non-blocking WARNING on aggregate SKU shortage
  const wbWarn = XLSX.read(stdBuf, {type: 'array'});
  const warnLines = XLSX.utils.sheet_to_json(wbWarn.Sheets['05_Chi_tiet_pallet_xuat']);
  const pinnedSet = new Set(warnLines.map(l => String(l.pinned_source_pallet_id || '').trim()).filter(Boolean));
  const invWarn = XLSX.utils.sheet_to_json(wbWarn.Sheets['03_Ton_kho_pallet']);
  const targetSku = 'SKU03';
  for (const r of invWarn) {
    if (r.sku_code === targetSku && !pinnedSet.has(String(r.source_pallet_id || '').trim())) {
      r.available_cartons = 1;
    }
  }
  wbWarn.Sheets['03_Ton_kho_pallet'] = XLSX.utils.json_to_sheet(invWarn);
  const warnBuf = XLSX.write(wbWarn, {type: 'array', bookType: 'xlsx'});
  const warnRes = parseAndValidateExcelWorkbook(warnBuf);
  assert.equal(warnRes.valid, true, 'Thiếu tồn kho tổng hợp chỉ sinh WARNING cho phép chạy mô phỏng ghi nhận thiếu tồn');
  assert.ok(warnRes.warnings.length >= 1);

  return {stdOrders: stdRes.summary.orders, fullOrders: fullRes.summary.orders, blockedErrors: badRes.errors.length, shortageWarnings: warnRes.warnings.length};
});

// 3. Fault Case 1 & Case 2: Idle Fault + En-route Unloaded Task Reassignment
test('V62-FLT-03', 'Sự cố xe rảnh và xe đang đi rỗng: không đóng băng toàn cục, tự động thu hồi và giao lại lệnh cho xe khỏe', () => {
  const e = new WinMartEngine({outboundSeconds: 3600});
  // Case 1: Fault idle XN6 at t=0
  e.faultRobot('XN6', {repairMode: 'IN_PLACE', repairDurationSec: 600, reason: 'Lỗi cảm biến khi đỗ'});
  e.step(15);
  const activeHealthy = [...e.robots.values()].filter(r => r.id !== 'XN6' && r.task);
  assert.ok(activeHealthy.length >= 1, 'Đội xe khỏe vẫn được phân công và di chuyển bình thường khi XN6 hỏng tại bến');

  // Case 2: Catch a robot moving empty on corridor (not inside source aisle) and fault it
  let targetEmpty = null;
  for (let t = 0; t < 400; t++) {
    e.step(1);
    targetEmpty = [...e.robots.values()].find(r =>
      r.id !== 'XN6' && r.status === 'RUNNING' && !r.carried && r.task && !r.returning &&
      (r.type === 'CP' || r.y <= LAYOUT.frontY + 0.3 || r.y >= LAYOUT.rearY - 0.3)
    );
    if (targetEmpty) break;
  }
  assert.ok(targetEmpty, 'Phải bắt được ít nhất 1 xe đang chạy rỗng trên hành lang đi lấy pallet');
  const oldJobId = targetEmpty.task.id;
  e.faultRobot(targetEmpty.id, {repairMode: 'IN_PLACE', repairDurationSec: 900, reason: 'Mất áp thủy lực trên đường đi rỗng'});
  assert.equal(targetEmpty.task, null, 'Xe hỏng khi chưa mang hàng phải trả nhiệm vụ về hàng đợi');
  assert.ok(e.metrics.reassignedTasks >= 1, 'Bộ đếm giao lại nhiệm vụ phải tăng');
  e.step(300);
  const reassignedJob = e.jobs.find(j => j.id === oldJobId);
  assert.ok(reassignedJob && reassignedJob.robot !== targetEmpty.id, 'Nhiệm vụ được xe khỏe khác tiếp nhận');
  e.assertInvariants();
  return {reassignedTasks: e.metrics.reassignedTasks, newAssignee: reassignedJob.robot};
});

// 4. Fault Case 3: Carrying Low-Fork Conditional Rescue (F3 Kit) -> Pallet Transfer -> Tow to MAINT -> Recover
test('V62-FLT-04', 'Sự cố xe đang chở pallet ở tầm thấp: xác nhận cứu hộ F3, hạ chuyển pallet sang ô đệm và kéo 0,20 m/s về MAINT', () => {
  const e = new WinMartEngine({outboundSeconds: 7200});
  let carrier = null;
  for (let t = 0; t < 900; t++) {
    e.step(1);
    carrier = [...e.robots.values()].find(r =>
      r.type === 'CP' && r.carried && r.y >= 2.0 && r.y <= 14.2 && r.x >= 30 && r.x <= 82
    );
    if (carrier) break;
  }
  assert.ok(carrier, 'Phải bắt được robot CP đang chở pallet trên hành lang trong nhà');
  const carriedPalletId = carrier.carried;
  e.faultRobot(carrier.id, {repairMode: 'TOW_TO_MAINT', repairDurationSec: 600, reason: 'Lỗi truyền động khi đang mang hàng'});
  assert.equal(carrier.status, 'FAULT');
  assert.equal(carrier.awaitingOperatorConfirm, true, 'Chế độ TOW_TO_MAINT phải chờ kỹ thuật viên xác nhận tại hiện trường');
  assert.equal(carrier.carried, carriedPalletId, 'Chưa xác nhận cứu hộ thì pallet vẫn phải nằm trên xe hỏng');

  const authOk = e.authorizeRescue(carrier.id);
  assert.equal(authOk, true, 'Kỹ thuật viên xác nhận cứu hộ F3 hợp lệ');
  assert.equal(carrier.status, 'RESCUE_SETUP');

  // Step through 240s loaded rescue setup -> pallet transferred to safe buffer -> towing at 0.20 m/s to MAINT_CP
  e.step(245);
  assert.equal(carrier.carried, null, 'Sau thời gian thao tác kích tay F3, pallet phải được bàn giao vật lý sang ô đệm an toàn');
  assert.equal(carrier.status, 'TOWING');
  const transferredPallet = e.pallets.get(carriedPalletId);
  assert.notEqual(transferredPallet.location, carrier.id);

  // Complete towing to MAINT bay + repair duration -> recovers to IDLE and immediately rejoins active fleet (IDLE or RUNNING)
  e.step(1200);
  assert.ok(['IDLE', 'RUNNING'].includes(carrier.status), 'Sau khi kéo về ô bảo trì MAINT và hết thời gian sửa, thiết bị hồi phục và quay lại phục vụ đội xe');
  assert.ok(e.metrics.rescuesCompleted >= 1);
  e.assertInvariants();
  return {rescuedRobot: carrier.id, palletId: carriedPalletId, palletNewLoc: transferredPallet.location};
});

// 5. Fault Case 4 & Case 5: High-Lift Rack Fault + Cell Buffer Local Isolation (zero teleportation)
test('V62-FLT-05', 'Sự cố nâng cao tầng 2–3 khóa lối cục bộ (chờ kỹ thuật hạ tải) và sự cố tại ô ghép chỉ cô lập 1 bàn ghép', () => {
  const e = new WinMartEngine({outboundSeconds: 3600});
  let highCarrier = null;
  for (let t = 0; t < 600; t++) {
    e.step(1);
    highCarrier = [...e.robots.values()].find(r => r.type === 'RT' && r.carried && (r.currentLiftM || 0) > 0.5);
    if (highCarrier) break;
  }
  assert.ok(highCarrier, 'Phải bắt được 1 xe nâng XN đang thao tác nâng pallet ở tầng cao (> 0,5 m)');
  const faultAisle = LAYOUT.aisleXs.findIndex(ax => Math.abs(ax - highCarrier.x) < 0.4);
  const sameAisleSlot = e.slots.find(s => s.aisle === faultAisle && s.level === 0);
  const otherAisleSlot = e.slots.find(s => s.aisle === ((faultAisle + 3) % 14) && s.level === 0);

  e.faultRobot(highCarrier.id, {repairMode: 'TOW_TO_MAINT', repairDurationSec: 600, reason: 'Kẹt khung nâng tầng cao'});
  assert.equal(highCarrier.status, 'WAITING_EXTERNAL_ASSISTANCE', 'Xe kẹt càng trên cao chuyển sang WAITING_EXTERNAL_ASSISTANCE');
  assert.equal(highCarrier.awaitingOperatorConfirm, true, 'Không tự động kéo khi chưa có đội kỹ thuật chuyên trách xác nhận hạ tải');
  assert.equal(e.isLocationIsolated(sameAisleSlot.id), true, 'Lối kệ chứa xe lỗi nâng cao bị cô lập cục bộ');
  assert.equal(e.isLocationIsolated(otherAisleSlot.id), false, 'Các lối kệ khác vẫn mở bình thường');

  // Catch a robot physically arriving at a cell buffer (SRC or OUT) and fault it naturally
  let cellRobot = null;
  let affectedCellId = -1;
  for (let t = 0; t < 400; t++) {
    e.step(1);
    for (const r of e.robots.values()) {
      if (r.id === highCarrier.id || r.status !== 'RUNNING') continue;
      for (let cid = 0; cid < 10; cid++) {
        const s0 = e.locations.get(`SRC${2 * cid}`);
        const s1 = e.locations.get(`SRC${2 * cid + 1}`);
        const out = e.locations.get(`OUT${cid}`);
        if ([s0, s1, out].some(l => Math.hypot(r.x - l.x, r.y - l.y) < 1.2)) {
          cellRobot = r;
          affectedCellId = cid;
          break;
        }
      }
      if (cellRobot) break;
    }
    if (cellRobot) break;
  }
  assert.ok(cellRobot, 'Phải bắt được 1 thiết bị đang tiếp cận cửa ô nguồn/ô thành phẩm của bàn ghép');
  e.faultRobot(cellRobot.id, {repairMode: 'IN_PLACE', repairDurationSec: 900, reason: 'Dừng khẩn tại cửa ô đệm bàn ghép'});
  assert.equal(e.isCellIsolated(affectedCellId), true, 'Bàn ghép có thiết bị dừng lỗi bị cô lập cục bộ');
  const healthyCellId = (affectedCellId + 4) % 10;
  assert.equal(e.isCellIsolated(healthyCellId), false, 'Các bàn ghép cách xa vẫn hoạt động bình thường');

  e.step(1150);
  assert.ok(e.metrics.assembled >= 1, 'Các bàn ghép khỏe còn lại vẫn hoàn tất ghép hàng bình thường');
  e.assertInvariants();
  return {highLiftRobot: highCarrier.id, isolatedAisle: faultAisle + 1, isolatedCell: affectedCellId, assembledByHealthyCells: e.metrics.assembled};
});

// 6. Fault Case 6a, 6b, 6c: Corridor Detour, Double-Blockage WAITING_PATH & Dock Truck-Bed Hold
test('V62-FLT-06', 'Đi vòng hành lang khi nghẽn đơn, chờ đường WAITING_PATH khi nghẽn kép và giữ khóa an toàn trong thùng xe tải', () => {
  // 6a: Wait until an XN crosses frontY=20.2 near mid-warehouse, then fault it in-place -> healthy XN detours via rearY=46.8
  const eDetour = new WinMartEngine({outboundSeconds: 3600, demandSkewA: 0.85, crossZone: true});
  let corridorXn = null;
  for (let t = 0; t < 600; t++) {
    eDetour.step(1);
    corridorXn = [...eDetour.robots.values()].find(r =>
      r.type === 'RT' && Math.abs(r.y - LAYOUT.frontY) < 0.25 && r.x >= 35 && r.x <= 65
    );
    if (corridorXn) break;
  }
  assert.ok(corridorXn, 'Bắt được xe nâng XN đang lưu thông trên trục chính y=20,2m');
  eDetour.faultRobot(corridorXn.id, {repairMode: 'IN_PLACE', repairDurationSec: 2400, reason: 'Chắn ngang hành lang chính y=20,2m'});
  eDetour.step(1200);
  assert.ok(eDetour.metrics.detourCount >= 1, 'Bộ định tuyến phải kích hoạt lộ trình đi vòng qua hành lang hậu y=46,8m');
  eDetour.assertInvariants();

  // 6b: Block BOTH frontY=20.2 AND rearY=46.8 at x=50 when active XN is already assigned -> WAITING_PATH without collision
  const eDouble = new WinMartEngine({initialPerSKU: 0, orderLimit: 0});
  const slotB = eDouble.slots.find(s => s.aisle === 10 && s.level === 0);
  const pTest = eDouble.createPallet({sku: 0, cartons: 60}, slotB.id);
  eDouble.initialBySKU[0] = 60;
  const jCross = eDouble.queue(pTest, 'SRC0', 'RT', 'Cấp nguồn xuyên vùng', {urgency: 3});
  for (const id of ['XN2', 'XN3', 'XN4', 'XN5', 'XN6']) eDouble.robots.get(id).active = false;
  eDouble.dispatch();
  const xn1 = eDouble.robots.get('XN1');
  assert.equal(xn1.status, 'RUNNING');
  eDouble.step(5); // XN1 is heading toward Zone B
  // Now activate and fault two blockers at x=50 on frontY and rearY
  const b1 = eDouble.robots.get('XN2'); b1.active = true; b1.x = 50.0; b1.y = LAYOUT.frontY;
  const b2 = eDouble.robots.get('XN5'); b2.active = true; b2.x = 50.0; b2.y = LAYOUT.rearY;
  eDouble.faultRobot('XN2', {repairMode: 'IN_PLACE', repairDurationSec: 600, allowReassign: false});
  eDouble.faultRobot('XN5', {repairMode: 'IN_PLACE', repairDurationSec: 600, allowReassign: false});
  assert.equal(xn1.status, 'WAITING_PATH', 'Khi cả hành lang chính lẫn hành lang hậu đều bị khóa, xe đang đi chuyển sang WAITING_PATH an toàn');
  eDouble.recoverRobot('XN5');
  eDouble.step(60); // XN5 physically walks off rearY into its home pocket (y=49.0m), clearing rearY for XN1
  assert.equal(xn1.status, 'RUNNING', 'Sau khi XN5 rời hành lang hậu về bến đỗ, xe WAITING_PATH tự động định tuyến vòng qua y=46,8m và chạy tiếp');
  eDouble.assertInvariants();

  // 6c: In-truck-bed fault -> DOCK_HOLD_FAULT, committedDepartureSec unchanged, safety delay recorded
  const eDock = new WinMartEngine({outboundSeconds: 7200});
  let inBed = null;
  for (let t = 0; t < 1800; t++) {
    eDock.step(1);
    inBed = [...eDock.robots.values()].find(r => r.type === 'CP' && r.y < 0 && r.carried && r.task?.truck);
    if (inBed) break;
  }
  assert.ok(inBed, 'Phải bắt được robot CP đang xếp hàng bên trong lòng thùng xe tải');
  const truck = inBed.task.truck;
  const origCommitted = truck.committedDepartureSec;
  eDock.faultRobot(inBed.id, {repairMode: 'IN_PLACE', repairDurationSec: 3600, reason: 'Sự cố trong thùng xe 1 giờ'});
  assert.equal(truck.state, 'DOCK_HOLD_FAULT', 'Xe tải phải chuyển sang khóa cứng an toàn DOCK_HOLD_FAULT');
  eDock.step(2500);
  assert.equal(truck.committedDepartureSec, origCommitted, 'Không được tự động dời mốc committedDepartureSec để che giấu độ trễ');
  assert.notEqual(truck.state, 'DEPARTED', 'Xe tải tuyệt đối không được rời dock khi robot còn nằm trong thùng');
  eDock.recoverRobot(inBed.id);
  eDock.step(1200);
  assert.equal(truck.state, 'DEPARTED', 'Sau khi robot phục hồi và rút khỏi thùng, chuyến xe hoàn tất rời bến');
  assert.ok(truck.departureLatenessSec > 0, 'Độ trễ rời bến do giữ an toàn được ghi nhận trung thực');
  eDock.assertInvariants();
  return {detours: eDetour.metrics.detourCount, dockSafetyLatenessSec: truck.departureLatenessSec};
});

// 7. Multi-Wave Assembly (>2 Source Pallets) + Mandatory QC Stage + Non-Split Orders + Export XLSX
test('V62-OPS-07', 'Ghép hàng nhiều đợt (>2 pallet nguồn), bắt buộc qua kiểm đếm–quấn màng QC và bảo toàn không tách đơn', () => {
  const stdBuf = generateSampleWorkbookBuffer('standard');
  const parsed = parseAndValidateExcelWorkbook(stdBuf);
  const e = new WinMartEngine({excelPlan: parsed.plan, dispatchPolicy: 'V6_2_PROPOSED', fefoMode: 'WINDOW_FEFO'});
  const snap = e.runToCompletion();
  assert.equal(e.phase, 'STOPPED');
  assert.ok(e.metrics.multiWavePallets >= 4, 'Phải thực thi các pallet xuất ghép nhiều đợt (>2 pallet nguồn)');
  assert.equal(e.metrics.assembled, e.metrics.qcPassed, '100% pallet ghép xong phải đi qua công đoạn QC & quấn màng');

  for (const o of e.orders) {
    if (!o.allowSplitTrips && o.state === 'SHIPPED') {
      assert.equal(o.tripIds.length, 1, `Đơn ${o.id} (allow_split_trips=FALSE) không được tách lên nhiều chuyến xe`);
    }
    assert.notEqual(o.state, 'PARTIALLY_SHIPPED', `Đơn ${o.id} không được xuất dở dang một phần khi khóa tách chuyến`);
  }

  const outXlsx = exportRunResultsToXlsx(snap);
  const wbOut = XLSX.read(outXlsx, {type: 'array'});
  assert.deepEqual(wbOut.SheetNames, [
    '01_Tong_hop_KPI',
    '02_Ket_qua_Don_hang',
    '03_Truy_xuat_Lo_FEFO',
    '04_Chuyen_xe_Dock',
    '05_Hieu_suat_Doi_xe'
  ]);
  return {
    shippedOrders: snap.orderSummary.shippedTotal,
    multiWavePallets: e.metrics.multiWavePallets,
    qcPassed: e.metrics.qcPassed,
    departedPallets: e.metrics.departed
  };
});

// 8. Low-Battery 15% Balanced Charging + Deterministic SHA-256 + Milestone A Check
test('V62-DET-08', 'Sạc cân bằng từ 15% pin theo vùng/nhóm xe, bảo toàn bất biến và tính tất định mã băm SHA-256', () => {
  const eCharge = new WinMartEngine({initialBattery: 15, outboundSeconds: 7200});
  eCharge.step(7200);
  const cpCharged = [...eCharge.robots.values()].filter(r => r.type === 'CP' && r.charging > 0).length;
  const xnCharged = [...eCharge.robots.values()].filter(r => r.type === 'RT' && r.charging > 0).length;
  assert.ok(cpCharged >= 2 && xnCharged >= 2, 'Cả đội CP lẫn đội XN đều được điều phối sạc cân bằng');
  assert.ok(eCharge.metrics.departed > 0, 'Kho vẫn duy trì sản lượng xuất trong khi luân phiên sạc từ 15% pin');
  eCharge.assertInvariants();

  // Deterministic SHA-256 parity across two independent runs
  const e1 = new WinMartEngine({outboundSeconds: 7200, dispatchPolicy: 'V6_2_PROPOSED'});
  e1.step(7200);
  const e2 = new WinMartEngine({outboundSeconds: 7200, dispatchPolicy: 'V6_2_PROPOSED'});
  e2.step(7200);
  const h1 = e1.computeNormalizedHash();
  const h2 = e2.computeNormalizedHash();
  assert.equal(h1, h2, 'Hai lần chạy cùng cấu hình phải cho mã băm SHA-256 chuẩn hóa trùng khớp tuyệt đối');

  // Milestone A historical engine sanity check
  const eOld = new WinMartEngineV61({outboundSeconds: 1800});
  eOld.step(1800);
  eOld.assertInvariants();

  return {hash: h1.slice(0, 16), cpCharged, xnCharged};
});

const outData = {
  version: '6.2',
  generatedAt: new Date().toISOString(),
  totalChecks: checks.length,
  passedChecks: checks.filter(c => c.passed).length,
  checks
};
fs.writeFileSync(new URL('data/verification.json', import.meta.url), JSON.stringify(outData, null, 2));
console.log(`ALL ${checks.length}/${checks.length} V6.2 VERIFICATION SUITES PASSED.`);
