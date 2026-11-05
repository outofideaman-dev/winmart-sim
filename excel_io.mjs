// c:/Users/lshie/Documents/project/stupidfuck/Bao_cao_WinMart_V6_1_5000m2/Mo_phong/excel_io.mjs
// Client/CLI Outbound Shift Excel I/O, cell-level validator, pre-run planner preview, and result exporter for WinMart V6.2.

import * as XLSX from './vendor/xlsx.mjs';
import {LAYOUT, PALLET_TYPES, generateStorageSlots, generateFloorLocations} from './layout_spec.mjs';

export const EXCEL_SCHEMA_VERSION = 'winmart-outbound-v6.2';

export const REQUIRED_SHEETS = [
  '01_Cau_hinh_ca',
  '02_Danh_muc_SKU',
  '03_Ton_kho_pallet',
  '04_Don_hang_xuat',
  '05_Chi_tiet_pallet_xuat',
  '06_Chuyen_xe_tai'
];

const ALL_SLOTS = generateStorageSlots();
const FLOOR_LOCS = generateFloorLocations();
const CANONICAL_SLOT_BY_CODE = new Map();
for (const s of ALL_SLOTS) {
  CANONICAL_SLOT_BY_CODE.set(s.id.toUpperCase(), s.id);
  CANONICAL_SLOT_BY_CODE.set(s.friendlyCode.toUpperCase(), s.id);
}
for (const f of FLOOR_LOCS) {
  if (f.kind === 'source') {
    CANONICAL_SLOT_BY_CODE.set(f.id.toUpperCase(), f.id);
    CANONICAL_SLOT_BY_CODE.set(f.alias.toUpperCase(), f.id);
  }
}

export function resolveStorageLocationCode(rawCode) {
  if (!rawCode) return null;
  const key = String(rawCode).trim().toUpperCase();
  return CANONICAL_SLOT_BY_CODE.get(key) || null;
}

export function parseClockToSeconds(val, anchorClock = '06:00:00') {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number' && Number.isFinite(val)) {
    // Excel fractional day (0 <= val < 1 and non-integer) vs plain seconds.
    if (val > 0 && val < 1 && !Number.isInteger(val)) {
      const clockSec = Math.round(val * 86400);
      const anchorSec = clockStringSeconds(anchorClock);
      return clockSec >= anchorSec ? clockSec - anchorSec : clockSec;
    }
    return Math.round(val);
  }
  const s = String(val).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]), ss = Number(m[3] || 0);
  if (hh > 47 || mm > 59 || ss > 59) return null;
  const total = hh * 3600 + mm * 60 + ss;
  const anchorSec = clockStringSeconds(anchorClock);
  return total >= anchorSec ? total - anchorSec : total;
}

function clockStringSeconds(clock = '06:00:00') {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(clock).trim());
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0);
}

export function formatSecondsAsClock(sec, anchorClock = '06:00:00') {
  const base = clockStringSeconds(anchorClock) + Math.max(0, Math.round(sec || 0));
  const hh = Math.floor(base / 3600);
  const mm = Math.floor((base % 3600) / 60);
  const ss = base % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function parseBool(v, fallback = null) {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1') return true;
  if (v === 0 || v === '0') return false;
  if (v === null || v === undefined || String(v).trim() === '') return fallback;
  const s = String(v).trim().toUpperCase();
  if (['TRUE', 'YES', 'CO', 'CÓ', 'Y', 'BAT', 'BẬT'].includes(s)) return true;
  if (['FALSE', 'NO', 'KHONG', 'KHÔNG', 'N', 'TAT', 'TẮT'].includes(s)) return false;
  return undefined;
}

function parseIsoDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    const parsed = XLSX.SSF.parse_date_code(v);
    if (!parsed) return null;
    return `${String(parsed.y).padStart(4, '0')}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== mo || dt.getUTCDate() !== d) return null;
  return s;
}

export function daysBetweenIso(d1, d2) {
  const t1 = Date.parse(`${d1}T00:00:00Z`);
  const t2 = Date.parse(`${d2}T00:00:00Z`);
  return Math.round((t2 - t1) / 86400000);
}

function sheetRowsWithMeta(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return null;
  const matrix = XLSX.utils.sheet_to_json(ws, {header: 1, defval: ''});
  if (!matrix.length) return {headers: [], rows: []};
  const headers = matrix[0].map(h => String(h || '').trim());
  const rows = [];
  for (let r = 1; r < matrix.length; r++) {
    const arr = matrix[r];
    if (!arr || arr.every(c => String(c ?? '').trim() === '')) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      if (headers[c]) obj[headers[c]] = arr[c] ?? '';
    }
    rows.push({excelRow: r + 1, data: obj});
  }
  return {headers, rows};
}

export function validateOutboundWorkbook(inputBufferOrWb) {
  const errors = [];
  const warnings = [];
  const addErr = (sheet, row, column, code, message) =>
    errors.push({severity: 'ERROR', sheet, row, column, code, message});
  const addWarn = (sheet, row, column, code, message) =>
    warnings.push({severity: 'WARNING', sheet, row, column, code, message});

  let wb;
  try {
    wb = inputBufferOrWb?.SheetNames
      ? inputBufferOrWb
      : XLSX.read(inputBufferOrWb, {
          type: (inputBufferOrWb instanceof ArrayBuffer || ArrayBuffer.isView(inputBufferOrWb)) ? 'array' : 'buffer'
        });
  } catch (err) {
    addErr('WORKBOOK', 1, '*', 'INVALID_XLSX', `Không đọc được tệp Excel (.xlsx): ${err.message}`);
    return {valid: false, ok: false, canRunWithConfirmation: false, errors, warnings, plan: null, preview: null, summary: null};
  }

  for (const req of REQUIRED_SHEETS) {
    if (!wb.SheetNames.includes(req)) {
      addErr(req, 1, '*', 'MISSING_SHEET', `Thiếu trang tính bắt buộc "${req}".`);
    }
  }
  if (errors.length) {
    return {valid: false, ok: false, canRunWithConfirmation: false, errors, warnings, plan: null, preview: null, summary: null};
  }

  // 1. Parse 01_Cau_hinh_ca (supports key-value rows param_key/value or horizontal single row).
  const cfgSheet = sheetRowsWithMeta(wb, '01_Cau_hinh_ca');
  const rawCfg = {};
  const cfgRowMap = {};
  if (cfgSheet.headers.includes('param_key') && cfgSheet.headers.includes('value')) {
    for (const r of cfgSheet.rows) {
      const k = String(r.data.param_key || '').trim();
      if (k) {
        rawCfg[k] = r.data.value;
        cfgRowMap[k] = r.excelRow;
      }
    }
  } else if (cfgSheet.rows.length > 0) {
    Object.assign(rawCfg, cfgSheet.rows[0].data);
    for (const k of Object.keys(rawCfg)) cfgRowMap[k] = cfgSheet.rows[0].excelRow;
  } else {
    addErr('01_Cau_hinh_ca', 2, 'param_key', 'EMPTY_CONFIG', 'Trang cấu hình ca không có dữ liệu.');
  }

  const schemaVersion = String(rawCfg.schema_version ?? '').trim();
  if (schemaVersion !== EXCEL_SCHEMA_VERSION) {
    addErr('01_Cau_hinh_ca', cfgRowMap.schema_version || 2, 'schema_version', 'SCHEMA_MISMATCH',
      `schema_version phải là "${EXCEL_SCHEMA_VERSION}" (nhận "${schemaVersion || 'rỗng'}").`);
  }
  const planId = String(rawCfg.plan_id ?? 'KH-CA-XUAT').trim() || 'KH-CA-XUAT';
  const shiftDate = parseIsoDate(rawCfg.shift_date || '2026-11-05');
  if (!shiftDate) {
    addErr('01_Cau_hinh_ca', cfgRowMap.shift_date || 2, 'shift_date', 'INVALID_DATE', 'shift_date phải theo định dạng YYYY-MM-DD.');
  }
  const shiftStartTime = String(rawCfg.shift_start_time ?? '06:00:00').trim();
  if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(shiftStartTime)) {
    addErr('01_Cau_hinh_ca', cfgRowMap.shift_start_time || 2, 'shift_start_time', 'INVALID_TIME', 'shift_start_time phải theo dạng HH:MM:SS.');
  }

  const intParam = (key, min, max, defVal) => {
    const raw = rawCfg[key] ?? defVal;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      addErr('01_Cau_hinh_ca', cfgRowMap[key] || 2, key, 'INVALID_RANGE', `${key} phải là số nguyên trong đoạn [${min}..${max}] (nhận "${raw}").`);
      return defVal;
    }
    return n;
  };

  const shiftDurationSec = intParam('shift_duration_sec', 1800, 86400, 28800);
  const activeXnCount = intParam('active_xn_count', 1, 6, 6);
  const activeCpCount = intParam('active_cp_count', 1, 4, 4);
  const assemblyTeams = intParam('assembly_teams', 1, 4, 4);
  const qcInspectors = intParam('qc_inspectors', 1, 4, 1);
  const fefoWindowDays = intParam('fefo_window_days', 0, 180, 14);

  const crossZoneEnabled = parseBool(rawCfg.cross_zone_enabled, true);
  if (crossZoneEnabled === undefined) {
    addErr('01_Cau_hinh_ca', cfgRowMap.cross_zone_enabled || 2, 'cross_zone_enabled', 'INVALID_BOOL', 'cross_zone_enabled phải là TRUE hoặc FALSE.');
  }
  const directLoadEnabled = parseBool(rawCfg.direct_load_enabled, true);
  if (directLoadEnabled === undefined) {
    addErr('01_Cau_hinh_ca', cfgRowMap.direct_load_enabled || 2, 'direct_load_enabled', 'INVALID_BOOL', 'direct_load_enabled phải là TRUE hoặc FALSE.');
  }
  const fefoMode = String(rawCfg.fefo_mode || 'WINDOW_FEFO').trim().toUpperCase();
  if (!['STRICT_FEFO', 'WINDOW_FEFO'].includes(fefoMode)) {
    addErr('01_Cau_hinh_ca', cfgRowMap.fefo_mode || 2, 'fefo_mode', 'INVALID_ENUM', 'fefo_mode phải là STRICT_FEFO hoặc WINDOW_FEFO.');
  }
  const dispatchPolicy = String(rawCfg.dispatch_policy || 'V6_2_PROPOSED').trim().toUpperCase();
  if (!['V6_2_PROPOSED', 'V6_2_BASELINE'].includes(dispatchPolicy)) {
    addErr('01_Cau_hinh_ca', cfgRowMap.dispatch_policy || 2, 'dispatch_policy', 'INVALID_ENUM', 'dispatch_policy phải là V6_2_PROPOSED hoặc V6_2_BASELINE.');
  }

  const shiftConfig = {
    schemaVersion,
    planId,
    shiftDate: shiftDate || '2026-11-05',
    shiftStartTime,
    shiftDurationSec,
    activeXnCount,
    activeCpCount,
    assemblyTeams,
    qcInspectors,
    crossZoneEnabled: crossZoneEnabled ?? true,
    directLoadEnabled: directLoadEnabled ?? true,
    fefoMode: ['STRICT_FEFO', 'WINDOW_FEFO'].includes(fefoMode) ? fefoMode : 'WINDOW_FEFO',
    fefoWindowDays,
    dispatchPolicy: ['V6_2_PROPOSED', 'V6_2_BASELINE'].includes(dispatchPolicy) ? dispatchPolicy : 'V6_2_PROPOSED'
  };

  // 2. Parse 02_Danh_muc_SKU
  const skuSheet = sheetRowsWithMeta(wb, '02_Danh_muc_SKU');
  const reqSkuCols = ['sku_code', 'sku_name', 'unit_name', 'carton_weight_kg', 'carton_volume_m3', 'max_cartons_per_pallet', 'preferred_zone'];
  for (const c of reqSkuCols) {
    if (!skuSheet.headers.includes(c)) addErr('02_Danh_muc_SKU', 1, c, 'MISSING_COLUMN', `Thiếu cột "${c}".`);
  }
  const skus = new Map();
  for (const {excelRow, data} of skuSheet.rows) {
    const code = String(data.sku_code || '').trim().toUpperCase();
    if (!code) { addErr('02_Danh_muc_SKU', excelRow, 'sku_code', 'EMPTY_KEY', 'Mã SKU không được để trống.'); continue; }
    if (skus.has(code)) { addErr('02_Danh_muc_SKU', excelRow, 'sku_code', 'DUPLICATE_SKU', `Trùng mã SKU "${code}".`); continue; }
    const unit = String(data.unit_name || '').trim().toUpperCase();
    if (unit !== 'CARTON') {
      addErr('02_Danh_muc_SKU', excelRow, 'unit_name', 'INVALID_UNIT', `Đơn vị tính của "${code}" phải là CARTON (nhận "${data.unit_name}").`);
    }
    const weight = Number(data.carton_weight_kg);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 100) {
      addErr('02_Danh_muc_SKU', excelRow, 'carton_weight_kg', 'INVALID_WEIGHT', `Khối lượng kiện của "${code}" không hợp lệ (${data.carton_weight_kg}).`);
    }
    const vol = Number(data.carton_volume_m3);
    if (!Number.isFinite(vol) || vol <= 0 || vol > 1.5) {
      addErr('02_Danh_muc_SKU', excelRow, 'carton_volume_m3', 'INVALID_VOLUME', `Thể tích kiện của "${code}" không hợp lệ (${data.carton_volume_m3}).`);
    }
    const maxCartons = Number(data.max_cartons_per_pallet);
    if (!Number.isInteger(maxCartons) || maxCartons < 1 || maxCartons > 400) {
      addErr('02_Danh_muc_SKU', excelRow, 'max_cartons_per_pallet', 'INVALID_MAX_CARTONS', `Số kiện tối đa/pallet của "${code}" phải là số nguyên dương.`);
    }
    const zone = String(data.preferred_zone || 'ANY').trim().toUpperCase();
    if (!['A', 'B', 'ANY'].includes(zone)) {
      addErr('02_Danh_muc_SKU', excelRow, 'preferred_zone', 'INVALID_ZONE', `preferred_zone của "${code}" phải thuộc {A, B, ANY}.`);
    }
    skus.set(code, {
      skuCode: code,
      skuName: String(data.sku_name || code).trim(),
      unitName: 'CARTON',
      cartonWeightKg: weight,
      cartonVolumeM3: vol,
      maxCartonsPerPallet: maxCartons,
      preferredZone: zone
    });
  }
  if (skus.size === 0) addErr('02_Danh_muc_SKU', 2, 'sku_code', 'EMPTY_CATALOG', 'Danh mục SKU không được rỗng.');

  // 3. Parse 03_Ton_kho_pallet
  const invSheet = sheetRowsWithMeta(wb, '03_Ton_kho_pallet');
  const reqInvCols = ['pallet_id', 'sku_code', 'location_code', 'available_cartons', 'pallet_tare_kg', 'lot_code', 'expiry_date', 'qc_status'];
  for (const c of reqInvCols) {
    if (!invSheet.headers.includes(c)) addErr('03_Ton_kho_pallet', 1, c, 'MISSING_COLUMN', `Thiếu cột "${c}".`);
  }
  const sourcePallets = new Map();
  const occupiedLocations = new Map();
  for (const {excelRow, data} of invSheet.rows) {
    const pid = String(data.pallet_id || '').trim();
    if (!pid) { addErr('03_Ton_kho_pallet', excelRow, 'pallet_id', 'EMPTY_PALLET_ID', 'pallet_id không được để trống.'); continue; }
    if (sourcePallets.has(pid)) { addErr('03_Ton_kho_pallet', excelRow, 'pallet_id', 'DUPLICATE_PALLET_ID', `Trùng mã pallet nguồn "${pid}".`); continue; }
    const skuCode = String(data.sku_code || '').trim().toUpperCase();
    const sku = skus.get(skuCode);
    if (!sku) {
      addErr('03_Ton_kho_pallet', excelRow, 'sku_code', 'UNKNOWN_SKU', `Pallet "${pid}" tham chiếu SKU chưa khai báo "${skuCode}".`);
    }
    const canonicalLoc = resolveStorageLocationCode(data.location_code);
    if (!canonicalLoc) {
      addErr('03_Ton_kho_pallet', excelRow, 'location_code', 'INVALID_LOCATION',
        `Vị trí "${data.location_code}" của pallet "${pid}" không thuộc ô kệ (S0_0_0_0_0..S13_6_1_2_2 / L01..L14) hoặc ô nguồn N0..N19.`);
    } else if (occupiedLocations.has(canonicalLoc)) {
      addErr('03_Ton_kho_pallet', excelRow, 'location_code', 'DUPLICATE_LOCATION',
        `Vị trí "${canonicalLoc}" bị gán trùng cho cả "${occupiedLocations.get(canonicalLoc)}" và "${pid}".`);
    } else {
      occupiedLocations.set(canonicalLoc, pid);
    }

    const cartons = Number(data.available_cartons);
    if (!Number.isInteger(cartons) || cartons < 1) {
      addErr('03_Ton_kho_pallet', excelRow, 'available_cartons', 'INVALID_CARTONS', `available_cartons của "${pid}" phải là số nguyên >= 1.`);
    } else if (sku && cartons > sku.maxCartonsPerPallet) {
      addErr('03_Ton_kho_pallet', excelRow, 'available_cartons', 'EXCEEDS_PALLET_STACK',
        `Pallet "${pid}" có ${cartons} kiện, vượt trần xếp pallet của ${skuCode} (${sku.maxCartonsPerPallet} kiện).`);
    }

    const pType = String(data.pallet_type || 'STD_WOOD').trim().toUpperCase();
    const tareDefault = PALLET_TYPES[pType]?.tareKg ?? 25;
    const tare = data.pallet_tare_kg === '' ? tareDefault : Number(data.pallet_tare_kg);
    if (!Number.isFinite(tare) || tare <= 0 || tare > 80) {
      addErr('03_Ton_kho_pallet', excelRow, 'pallet_tare_kg', 'INVALID_TARE', `Khối lượng vỏ pallet "${pid}" không hợp lệ (${data.pallet_tare_kg}).`);
    }
    if (sku && Number.isFinite(tare) && Number.isInteger(cartons)) {
      const gross = tare + cartons * sku.cartonWeightKg;
      if (gross > 800 + 1e-6) {
        addErr('03_Ton_kho_pallet', excelRow, 'available_cartons', 'EXCEEDS_800KG',
          `Khối lượng gộp pallet "${pid}" đạt ${gross.toFixed(1)} kg > giới hạn an toàn kệ/càng 800 kg.`);
      }
    }

    const lotCode = String(data.lot_code || '').trim();
    if (!lotCode) addErr('03_Ton_kho_pallet', excelRow, 'lot_code', 'EMPTY_LOT', `Pallet "${pid}" thiếu mã lô (lot_code).`);
    const expiry = parseIsoDate(data.expiry_date);
    if (!expiry) {
      addErr('03_Ton_kho_pallet', excelRow, 'expiry_date', 'INVALID_EXPIRY', `Hạn dùng của "${pid}" phải theo chuẩn YYYY-MM-DD.`);
    } else if (shiftDate && daysBetweenIso(shiftDate, expiry) < 0) {
      addWarn('03_Ton_kho_pallet', excelRow, 'expiry_date', 'EXPIRED_STOCK',
        `Pallet "${pid}" có hạn dùng ${expiry} đã quá hạn so với ngày ca ${shiftDate}; hệ thống sẽ không cấp xuất.`);
    }

    const qcStatus = String(data.qc_status || 'AVAILABLE').trim().toUpperCase();
    if (!['AVAILABLE', 'HOLD'].includes(qcStatus)) {
      addErr('03_Ton_kho_pallet', excelRow, 'qc_status', 'INVALID_QC_STATUS', `qc_status của "${pid}" phải là AVAILABLE hoặc HOLD.`);
    }

    sourcePallets.set(pid, {
      palletId: pid,
      skuCode,
      locationCode: canonicalLoc,
      rawLocationCode: String(data.location_code || '').trim(),
      availableCartons: cartons,
      palletType: PALLET_TYPES[pType] ? pType : 'STD_WOOD',
      palletTareKg: tare,
      lotCode,
      expiryDate: expiry || '2099-12-31',
      qcStatus,
      excelRow
    });
  }

  // 4. Parse 06_Chuyen_xe_tai before checking pinned trips in 04 & 05
  const tripSheet = sheetRowsWithMeta(wb, '06_Chuyen_xe_tai');
  const reqTripCols = [
    'trip_id', 'vehicle_type', 'vehicle_plate', 'route_id',
    'arrival_time', 'committed_departure', 'max_wait_loading_sec',
    'late_policy', 'max_pallet_slots', 'max_load_weight_kg'
  ];
  for (const c of reqTripCols) {
    if (!tripSheet.headers.includes(c)) addErr('06_Chuyen_xe_tai', 1, c, 'MISSING_COLUMN', `Thiếu cột "${c}".`);
  }
  const trips = new Map();
  for (const {excelRow, data} of tripSheet.rows) {
    const tripId = String(data.trip_id || '').trim();
    if (!tripId) { addErr('06_Chuyen_xe_tai', excelRow, 'trip_id', 'EMPTY_TRIP_ID', 'trip_id không được để trống.'); continue; }
    if (trips.has(tripId)) { addErr('06_Chuyen_xe_tai', excelRow, 'trip_id', 'DUPLICATE_TRIP_ID', `Trùng mã chuyến xe "${tripId}".`); continue; }
    const routeId = String(data.route_id || '').trim().toUpperCase();
    if (!routeId) addErr('06_Chuyen_xe_tai', excelRow, 'route_id', 'EMPTY_ROUTE', `Chuyến "${tripId}" thiếu mã tuyến (route_id).`);

    const arrSec = parseClockToSeconds(data.arrival_time, shiftStartTime);
    const depSec = parseClockToSeconds(data.committed_departure, shiftStartTime);
    if (arrSec === null || arrSec < 0 || arrSec > shiftDurationSec) {
      addErr('06_Chuyen_xe_tai', excelRow, 'arrival_time', 'INVALID_ARRIVAL',
        `arrival_time của "${tripId}" phải nằm trong khoảng [0..${shiftDurationSec}s] của ca.`);
    }
    if (depSec === null || (arrSec !== null && depSec <= arrSec)) {
      addErr('06_Chuyen_xe_tai', excelRow, 'committed_departure', 'INVALID_DEPARTURE',
        `committed_departure của "${tripId}" phải lớn hơn arrival_time.`);
    }
    const maxWait = Number(data.max_wait_loading_sec);
    if (!Number.isInteger(maxWait) || maxWait < 60) {
      addErr('06_Chuyen_xe_tai', excelRow, 'max_wait_loading_sec', 'INVALID_MAX_WAIT', `max_wait_loading_sec của "${tripId}" phải >= 60 giây.`);
    }
    const latePolicy = String(data.late_policy || 'DEPART_AT_CUTOFF').trim().toUpperCase();
    if (!['DEPART_AT_CUTOFF', 'DEPART_WHEN_FULL_OR_CUTOFF'].includes(latePolicy)) {
      addErr('06_Chuyen_xe_tai', excelRow, 'late_policy', 'INVALID_LATE_POLICY',
        `late_policy của "${tripId}" phải là DEPART_AT_CUTOFF hoặc DEPART_WHEN_FULL_OR_CUTOFF.`);
    }
    const maxSlots = Number(data.max_pallet_slots);
    if (!Number.isInteger(maxSlots) || maxSlots < 1 || maxSlots > 4) {
      addErr('06_Chuyen_xe_tai', excelRow, 'max_pallet_slots', 'INVALID_SLOTS', `max_pallet_slots của "${tripId}" phải là số nguyên 1..4.`);
    }
    const maxWeight = Number(data.max_load_weight_kg);
    if (!Number.isFinite(maxWeight) || maxWeight <= 0 || maxWeight > 15000) {
      addErr('06_Chuyen_xe_tai', excelRow, 'max_load_weight_kg', 'INVALID_PAYLOAD', `max_load_weight_kg của "${tripId}" không hợp lệ.`);
    }
    const pinnedDock = String(data.pinned_dock_code || '').trim().toUpperCase();
    let pinnedBay = null;
    if (pinnedDock) {
      const m = /^DX([1-9]|1[0-2])$/.exec(pinnedDock);
      if (!m) {
        addErr('06_Chuyen_xe_tai', excelRow, 'pinned_dock_code', 'INVALID_DOCK', `pinned_dock_code "${pinnedDock}" phải thuộc DX1..DX12.`);
      } else {
        pinnedBay = Number(m[1]) - 1;
      }
    }

    trips.set(tripId, {
      tripId,
      vehicleType: String(data.vehicle_type || 'BOX_TRUCK_4PL').trim(),
      vehiclePlate: String(data.vehicle_plate || tripId).trim(),
      routeId,
      arrivalTimeSec: arrSec ?? 0,
      committedDepartureSec: depSec ?? 1800,
      maxWaitLoadingSec: maxWait,
      latePolicy,
      maxPalletSlots: maxSlots,
      maxLoadWeightKg: maxWeight,
      pinnedDockCode: pinnedDock || null,
      pinnedBay,
      excelRow
    });
  }
  if (trips.size === 0) addErr('06_Chuyen_xe_tai', 2, 'trip_id', 'EMPTY_TRIPS', 'Cần ít nhất 1 chuyến xe tải trong 06_Chuyen_xe_tai.');

  // 5. Parse 04_Don_hang_xuat
  const ordSheet = sheetRowsWithMeta(wb, '04_Don_hang_xuat');
  const reqOrdCols = ['order_id', 'store_code', 'route_id', 'release_time', 'due_time', 'priority', 'allow_split_trips', 'stop_sequence'];
  for (const c of reqOrdCols) {
    if (!ordSheet.headers.includes(c)) addErr('04_Don_hang_xuat', 1, c, 'MISSING_COLUMN', `Thiếu cột "${c}".`);
  }
  const orders = new Map();
  for (const {excelRow, data} of ordSheet.rows) {
    const orderId = String(data.order_id || '').trim();
    if (!orderId) { addErr('04_Don_hang_xuat', excelRow, 'order_id', 'EMPTY_ORDER_ID', 'order_id không được để trống.'); continue; }
    if (orders.has(orderId)) { addErr('04_Don_hang_xuat', excelRow, 'order_id', 'DUPLICATE_ORDER_ID', `Trùng mã đơn hàng "${orderId}".`); continue; }
    const storeCode = String(data.store_code || '').trim();
    if (!storeCode) addErr('04_Don_hang_xuat', excelRow, 'store_code', 'EMPTY_STORE', `Đơn "${orderId}" thiếu store_code.`);
    const routeId = String(data.route_id || '').trim().toUpperCase();
    if (!routeId) addErr('04_Don_hang_xuat', excelRow, 'route_id', 'EMPTY_ROUTE', `Đơn "${orderId}" thiếu route_id.`);

    const relSec = parseClockToSeconds(data.release_time, shiftStartTime);
    const dueSec = parseClockToSeconds(data.due_time, shiftStartTime);
    if (relSec === null || relSec < 0 || relSec >= shiftDurationSec) {
      addErr('04_Don_hang_xuat', excelRow, 'release_time', 'INVALID_RELEASE', `release_time của đơn "${orderId}" phải thuộc [0..${shiftDurationSec - 1}s].`);
    }
    if (dueSec === null || (relSec !== null && dueSec <= relSec)) {
      addErr('04_Don_hang_xuat', excelRow, 'due_time', 'INVALID_DUE', `due_time của đơn "${orderId}" phải lớn hơn release_time.`);
    }
    const prio = Number(data.priority);
    if (!Number.isInteger(prio) || prio < 1 || prio > 5) {
      addErr('04_Don_hang_xuat', excelRow, 'priority', 'INVALID_PRIORITY', `priority của đơn "${orderId}" phải là số nguyên 1..5.`);
    }
    const allowSplit = parseBool(data.allow_split_trips, false);
    if (allowSplit === undefined) {
      addErr('04_Don_hang_xuat', excelRow, 'allow_split_trips', 'INVALID_BOOL', `allow_split_trips của đơn "${orderId}" phải là TRUE hoặc FALSE.`);
    }
    const stopSeq = Number(data.stop_sequence ?? 1);
    if (!Number.isInteger(stopSeq) || stopSeq < 1) {
      addErr('04_Don_hang_xuat', excelRow, 'stop_sequence', 'INVALID_STOP_SEQ', `stop_sequence của đơn "${orderId}" phải là số nguyên >= 1.`);
    }

    orders.set(orderId, {
      orderId,
      storeCode,
      routeId,
      releaseTimeSec: relSec ?? 0,
      dueTimeSec: dueSec ?? 3600,
      priority: prio,
      allowSplitTrips: allowSplit ?? false,
      stopSequence: stopSeq,
      plannedPallets: [],
      excelRow
    });
  }
  if (orders.size === 0) addErr('04_Don_hang_xuat', 2, 'order_id', 'EMPTY_ORDERS', 'Cần ít nhất 1 đơn hàng trong 04_Don_hang_xuat.');

  // 6. Parse 05_Chi_tiet_pallet_xuat
  const lineSheet = sheetRowsWithMeta(wb, '05_Chi_tiet_pallet_xuat');
  const reqLineCols = ['out_pallet_id', 'line_no', 'order_id', 'dispatch_mode', 'pallet_type', 'sku_code', 'qty_cartons'];
  for (const c of reqLineCols) {
    if (!lineSheet.headers.includes(c)) addErr('05_Chi_tiet_pallet_xuat', 1, c, 'MISSING_COLUMN', `Thiếu cột "${c}".`);
  }

  const outPallets = new Map();
  const seenPalletLines = new Set();
  const pinnedCartonsBySource = new Map();

  for (const {excelRow, data} of lineSheet.rows) {
    const outPalletId = String(data.out_pallet_id || '').trim();
    if (!outPalletId) { addErr('05_Chi_tiet_pallet_xuat', excelRow, 'out_pallet_id', 'EMPTY_OUT_PALLET', 'out_pallet_id không được để trống.'); continue; }
    const lineNo = Number(data.line_no);
    if (!Number.isInteger(lineNo) || lineNo < 1) {
      addErr('05_Chi_tiet_pallet_xuat', excelRow, 'line_no', 'INVALID_LINE_NO', `line_no của "${outPalletId}" phải là số nguyên >= 1.`);
      continue;
    }
    const lineKey = `${outPalletId}::${lineNo}`;
    if (seenPalletLines.has(lineKey)) {
      addErr('05_Chi_tiet_pallet_xuat', excelRow, 'line_no', 'DUPLICATE_LINE_NO', `Trùng dòng line_no=${lineNo} trong pallet xuất "${outPalletId}".`);
      continue;
    }
    seenPalletLines.add(lineKey);

    const orderId = String(data.order_id || '').trim();
    const order = orders.get(orderId);
    if (!order) {
      addErr('05_Chi_tiet_pallet_xuat', excelRow, 'order_id', 'UNKNOWN_ORDER', `Pallet xuất "${outPalletId}" tham chiếu đơn không tồn tại "${orderId}".`);
    }

    const dispatchMode = String(data.dispatch_mode || '').trim().toUpperCase();
    if (!['WHOLE_PALLET', 'MIXED_PALLET'].includes(dispatchMode)) {
      addErr('05_Chi_tiet_pallet_xuat', excelRow, 'dispatch_mode', 'INVALID_DISPATCH_MODE',
        `dispatch_mode của "${outPalletId}" phải là WHOLE_PALLET hoặc MIXED_PALLET.`);
    }

    const palletType = String(data.pallet_type || 'STD_WOOD').trim().toUpperCase();
    if (!PALLET_TYPES[palletType]) {
      addErr('05_Chi_tiet_pallet_xuat', excelRow, 'pallet_type', 'INVALID_PALLET_TYPE',
        `pallet_type của "${outPalletId}" phải là STD_WOOD hoặc PLASTIC_HD.`);
    }

    const skuCode = String(data.sku_code || '').trim().toUpperCase();
    const sku = skus.get(skuCode);
    if (!sku) {
      addErr('05_Chi_tiet_pallet_xuat', excelRow, 'sku_code', 'UNKNOWN_SKU', `Dòng ${lineNo} của "${outPalletId}" dùng SKU chưa khai báo "${skuCode}".`);
    }

    const qty = Number(data.qty_cartons);
    if (!Number.isInteger(qty) || qty < 1) {
      addErr('05_Chi_tiet_pallet_xuat', excelRow, 'qty_cartons', 'INVALID_QTY', `qty_cartons dòng ${lineNo} của "${outPalletId}" phải là số nguyên >= 1.`);
    }

    const minShelfRaw = String(data.min_shelf_life_days ?? '').trim();
    let minShelfLifeDays = 0;
    if (minShelfRaw !== '') {
      minShelfLifeDays = Number(minShelfRaw);
      if (!Number.isInteger(minShelfLifeDays) || minShelfLifeDays < 0) {
        addErr('05_Chi_tiet_pallet_xuat', excelRow, 'min_shelf_life_days', 'INVALID_SHELF_LIFE', 'min_shelf_life_days phải là số nguyên >= 0.');
      }
    }

    const pinnedSrcId = String(data.pinned_source_pallet_id || '').trim() || null;
    if (pinnedSrcId) {
      const src = sourcePallets.get(pinnedSrcId);
      if (!src) {
        addErr('05_Chi_tiet_pallet_xuat', excelRow, 'pinned_source_pallet_id', 'UNKNOWN_PINNED_SOURCE',
          `Pallet nguồn chỉ định "${pinnedSrcId}" không tồn tại trong 03_Ton_kho_pallet.`);
      } else {
        if (src.skuCode !== skuCode) {
          addErr('05_Chi_tiet_pallet_xuat', excelRow, 'pinned_source_pallet_id', 'PINNED_SOURCE_SKU_MISMATCH',
            `Pallet nguồn "${pinnedSrcId}" chứa ${src.skuCode}, không khớp SKU yêu cầu ${skuCode}.`);
        }
        if (src.qcStatus !== 'AVAILABLE') {
          addErr('05_Chi_tiet_pallet_xuat', excelRow, 'pinned_source_pallet_id', 'PINNED_SOURCE_ON_HOLD',
            `Pallet nguồn "${pinnedSrcId}" đang ở trạng thái QC "${src.qcStatus}", không được phép xuất.`);
        }
        if (shiftDate && daysBetweenIso(shiftDate, src.expiryDate) < minShelfLifeDays) {
          addErr('05_Chi_tiet_pallet_xuat', excelRow, 'pinned_source_pallet_id', 'PINNED_SOURCE_SHELF_LIFE',
            `Pallet nguồn "${pinnedSrcId}" (hạn ${src.expiryDate}) không đạt hạn còn lại tối thiểu ${minShelfLifeDays} ngày.`);
        }
        if (dispatchMode === 'WHOLE_PALLET' && src.availableCartons !== qty) {
          addErr('05_Chi_tiet_pallet_xuat', excelRow, 'pinned_source_pallet_id', 'WHOLE_PALLET_QTY_MISMATCH',
            `Xuất nguyên pallet từ "${pinnedSrcId}" đòi hỏi số kiện khớp đúng tồn pallet (${src.availableCartons} kiện, nhận ${qty}).`);
        }
        const used = (pinnedCartonsBySource.get(pinnedSrcId) || 0) + (Number.isInteger(qty) ? qty : 0);
        pinnedCartonsBySource.set(pinnedSrcId, used);
        if (used > src.availableCartons) {
          addErr('05_Chi_tiet_pallet_xuat', excelRow, 'pinned_source_pallet_id', 'PINNED_SOURCE_OVERALLOCATED',
            `Tổng số kiện chỉ định rút từ "${pinnedSrcId}" (${used}) vượt tồn khả dụng (${src.availableCartons}).`);
        }
      }
    }

    const pinnedTripId = String(data.pinned_trip_id || '').trim() || null;
    if (pinnedTripId) {
      const tr = trips.get(pinnedTripId);
      if (!tr) {
        addErr('05_Chi_tiet_pallet_xuat', excelRow, 'pinned_trip_id', 'UNKNOWN_PINNED_TRIP',
          `Chuyến xe chỉ định "${pinnedTripId}" không tồn tại trong 06_Chuyen_xe_tai.`);
      } else if (order && tr.routeId !== order.routeId) {
        addErr('05_Chi_tiet_pallet_xuat', excelRow, 'pinned_trip_id', 'PINNED_TRIP_ROUTE_MISMATCH',
          `Chuyến xe "${pinnedTripId}" thuộc tuyến ${tr.routeId}, khác tuyến ${order.routeId} của đơn "${orderId}".`);
      }
    }

    let op = outPallets.get(outPalletId);
    if (!op) {
      op = {
        outPalletId,
        orderId,
        dispatchMode,
        palletType: PALLET_TYPES[palletType] ? palletType : 'STD_WOOD',
        pinnedTripId,
        lines: [],
        firstRow: excelRow
      };
      outPallets.set(outPalletId, op);
      if (order) order.plannedPallets.push(op);
    } else {
      if (op.orderId !== orderId) {
        addErr('05_Chi_tiet_pallet_xuat', excelRow, 'order_id', 'INCONSISTENT_PALLET_ORDER',
          `Mọi dòng của "${outPalletId}" phải thuộc cùng một đơn hàng (đang trộn "${op.orderId}" và "${orderId}").`);
      }
      if (op.dispatchMode !== dispatchMode) {
        addErr('05_Chi_tiet_pallet_xuat', excelRow, 'dispatch_mode', 'INCONSISTENT_DISPATCH_MODE',
          `Mọi dòng của "${outPalletId}" phải thống nhất dispatch_mode.`);
      }
      if (op.palletType !== palletType) {
        addErr('05_Chi_tiet_pallet_xuat', excelRow, 'pallet_type', 'INCONSISTENT_PALLET_TYPE',
          `Mọi dòng của "${outPalletId}" phải thống nhất pallet_type.`);
      }
      if ((op.pinnedTripId || null) !== pinnedTripId) {
        addErr('05_Chi_tiet_pallet_xuat', excelRow, 'pinned_trip_id', 'INCONSISTENT_PINNED_TRIP',
          `Mọi dòng của "${outPalletId}" phải thống nhất pinned_trip_id.`);
      }
    }

    op.lines.push({
      lineNo,
      skuCode,
      qtyCartons: qty,
      pinnedSourcePalletId: pinnedSrcId,
      minShelfLifeDays,
      excelRow
    });
  }

  // Validate pallet-level physical geometry/weight & order-level trip constraints
  const pinnedLoadByTrip = new Map();
  for (const op of outPallets.values()) {
    op.lines.sort((a, b) => a.lineNo - b.lineNo);
    if (op.dispatchMode === 'WHOLE_PALLET' && op.lines.length !== 1) {
      addErr('05_Chi_tiet_pallet_xuat', op.firstRow, 'dispatch_mode', 'WHOLE_PALLET_MULTI_LINE',
        `Pallet nguyên "${op.outPalletId}" chỉ được phép có đúng 1 dòng SKU (đang có ${op.lines.length} dòng).`);
    }
    const tare = PALLET_TYPES[op.palletType]?.tareKg ?? 25;
    let cargoWeight = 0;
    let stackFraction = 0;
    let totalCartons = 0;
    for (const ln of op.lines) {
      const sku = skus.get(ln.skuCode);
      if (!sku || !Number.isInteger(ln.qtyCartons)) continue;
      cargoWeight += ln.qtyCartons * sku.cartonWeightKg;
      stackFraction += ln.qtyCartons / sku.maxCartonsPerPallet;
      totalCartons += ln.qtyCartons;
    }
    op.tareWeightKg = tare;
    op.grossWeightKg = Number((tare + cargoWeight).toFixed(3));
    op.stackFraction = Number(stackFraction.toFixed(4));
    op.totalCartons = totalCartons;

    if (op.grossWeightKg > 800 + 1e-6) {
      addErr('05_Chi_tiet_pallet_xuat', op.firstRow, 'qty_cartons', 'OUT_PALLET_OVERWEIGHT',
        `Pallet xuất "${op.outPalletId}" nặng ${op.grossWeightKg.toFixed(1)} kg (gồm vỏ ${tare} kg), vượt trần 800 kg.`);
    }
    if (op.stackFraction > 1.0001) {
      addErr('05_Chi_tiet_pallet_xuat', op.firstRow, 'qty_cartons', 'OUT_PALLET_OVERVOLUME',
        `Pallet xuất "${op.outPalletId}" vượt sức chứa hình học cho phép (tỷ lệ lấp đầy thể tích/chiều cao = ${(op.stackFraction * 100).toFixed(1)}% > 100%).`);
    }
    if (op.pinnedTripId && trips.has(op.pinnedTripId)) {
      const cur = pinnedLoadByTrip.get(op.pinnedTripId) || {slots: 0, weight: 0};
      cur.slots += 1;
      cur.weight += op.grossWeightKg;
      pinnedLoadByTrip.set(op.pinnedTripId, cur);
    }
  }

  for (const [tripId, used] of pinnedLoadByTrip.entries()) {
    const tr = trips.get(tripId);
    if (used.slots > tr.maxPalletSlots) {
      addErr('06_Chuyen_xe_tai', tr.excelRow, 'max_pallet_slots', 'PINNED_TRIP_SLOT_OVERFLOW',
        `Chuyến "${tripId}" bị chỉ định cứng ${used.slots} pallet nhưng chỉ có ${tr.maxPalletSlots} chỗ.`);
    }
    if (used.weight > tr.maxLoadWeightKg + 1e-6) {
      addErr('06_Chuyen_xe_tai', tr.excelRow, 'max_load_weight_kg', 'PINNED_TRIP_WEIGHT_OVERFLOW',
        `Chuyến "${tripId}" bị chỉ định cứng ${used.weight.toFixed(1)} kg, vượt tải trọng cho phép ${tr.maxLoadWeightKg} kg.`);
    }
  }

  const tripsByRoute = new Map();
  for (const tr of trips.values()) {
    if (!tripsByRoute.has(tr.routeId)) tripsByRoute.set(tr.routeId, []);
    tripsByRoute.get(tr.routeId).push(tr);
  }

  for (const ord of orders.values()) {
    if (ord.plannedPallets.length === 0) {
      addErr('04_Don_hang_xuat', ord.excelRow, 'order_id', 'ORDER_WITHOUT_PALLETS',
        `Đơn hàng "${ord.orderId}" chưa có dòng pallet xuất nào trong 05_Chi_tiet_pallet_xuat.`);
      continue;
    }
    const routeTrips = tripsByRoute.get(ord.routeId) || [];
    if (routeTrips.length === 0) {
      addErr('04_Don_hang_xuat', ord.excelRow, 'route_id', 'ROUTE_WITHOUT_TRIPS',
        `Đơn hàng "${ord.orderId}" thuộc tuyến "${ord.routeId}" nhưng không có chuyến xe nào phục vụ tuyến này.`);
      continue;
    }

    const totalOrderSlots = ord.plannedPallets.length;
    const totalOrderWeight = ord.plannedPallets.reduce((s, p) => s + p.grossWeightKg, 0);
    ord.totalPallets = totalOrderSlots;
    ord.totalGrossWeightKg = Number(totalOrderWeight.toFixed(3));
    ord.totalCartons = ord.plannedPallets.reduce((s, p) => s + p.totalCartons, 0);

    if (!ord.allowSplitTrips) {
      const pinnedSet = new Set(ord.plannedPallets.map(p => p.pinnedTripId).filter(Boolean));
      if (pinnedSet.size > 1) {
        addErr('04_Don_hang_xuat', ord.excelRow, 'allow_split_trips', 'SPLIT_FORBIDDEN_CONFLICT',
          `Đơn "${ord.orderId}" đặt allow_split_trips=FALSE nhưng các pallet con đang chỉ định vào nhiều chuyến khác nhau (${[...pinnedSet].join(', ')}).`);
      }
      const feasibleSingleTrip = routeTrips.some(tr => tr.maxPalletSlots >= totalOrderSlots && tr.maxLoadWeightKg + 1e-6 >= totalOrderWeight);
      if (!feasibleSingleTrip) {
        addErr('04_Don_hang_xuat', ord.excelRow, 'allow_split_trips', 'UNFEASIBLE_UNSPLIT_ORDER',
          `Đơn "${ord.orderId}" (${totalOrderSlots} pallet, ${totalOrderWeight.toFixed(1)} kg) đặt allow_split_trips=FALSE nhưng không có chuyến xe đơn lẻ nào trên tuyến ${ord.routeId} đủ sức chứa.`);
      }
    }

    const maxDep = Math.max(...routeTrips.map(t => t.committedDepartureSec));
    if (ord.releaseTimeSec >= maxDep) {
      addWarn('04_Don_hang_xuat', ord.excelRow, 'release_time', 'ORDER_AFTER_LAST_TRIP',
        `Đơn "${ord.orderId}" mở lúc ${ord.releaseTimeSec}s nhưng chuyến muộn nhất tuyến ${ord.routeId} rời kho lúc ${maxDep}s.`);
    }
    const minEstSec = ord.plannedPallets.some(p => p.dispatchMode === 'MIXED_PALLET') ? 950 : 260;
    if (ord.dueTimeSec - ord.releaseTimeSec < minEstSec) {
      addWarn('04_Don_hang_xuat', ord.excelRow, 'due_time', 'TIGHT_DUE_TIME',
        `Đơn "${ord.orderId}" có cửa sổ xử lý (${ord.dueTimeSec - ord.releaseTimeSec}s) rất sát thời gian công nghệ tối thiểu (~${minEstSec}s).`);
    }
  }

  // Aggregate supply vs demand checks -> WARNING (permits Shortage Exploration Mode when no hard ERROR exists)
  const availBySku = new Map();
  const fullPalletsBySku = new Map();
  for (const code of skus.keys()) { availBySku.set(code, 0); fullPalletsBySku.set(code, []); }
  for (const sp of sourcePallets.values()) {
    if (sp.qcStatus === 'AVAILABLE' && (!shiftDate || daysBetweenIso(shiftDate, sp.expiryDate) >= 0)) {
      availBySku.set(sp.skuCode, (availBySku.get(sp.skuCode) || 0) + sp.availableCartons);
      fullPalletsBySku.get(sp.skuCode)?.push(sp.availableCartons);
    }
  }

  const demandBySku = new Map();
  const wholeDemandBySku = new Map();
  for (const op of outPallets.values()) {
    for (const ln of op.lines) {
      demandBySku.set(ln.skuCode, (demandBySku.get(ln.skuCode) || 0) + (ln.qtyCartons || 0));
      if (op.dispatchMode === 'WHOLE_PALLET') {
        if (!wholeDemandBySku.has(ln.skuCode)) wholeDemandBySku.set(ln.skuCode, []);
        wholeDemandBySku.get(ln.skuCode).push(ln.qtyCartons);
      }
    }
  }

  for (const [skuCode, dem] of demandBySku.entries()) {
    const av = availBySku.get(skuCode) || 0;
    if (dem > av) {
      addWarn('03_Ton_kho_pallet', 2, 'available_cartons', 'SKU_SHORTAGE',
        `Thiếu tồn kho khả dụng cho ${skuCode}: tổng cầu = ${dem} kiện > tồn khả dụng = ${av} kiện (thiếu ${dem - av} kiện).`);
    }
  }
  for (const [skuCode, reqList] of wholeDemandBySku.entries()) {
    const pool = [...(fullPalletsBySku.get(skuCode) || [])];
    let missingWhole = 0;
    for (const reqQty of reqList) {
      const idx = pool.indexOf(reqQty);
      if (idx >= 0) pool.splice(idx, 1);
      else missingWhole++;
    }
    if (missingWhole > 0) {
      addWarn('05_Chi_tiet_pallet_xuat', 2, 'dispatch_mode', 'WHOLE_PALLET_SHORTAGE',
        `SKU ${skuCode} có ${missingWhole} yêu cầu WHOLE_PALLET không tìm được pallet nguồn nguyên kiện khớp quy cách.`);
    }
  }

  for (const [routeId, rTrips] of tripsByRoute.entries()) {
    const routeOrders = [...orders.values()].filter(o => o.routeId === routeId);
    const demSlots = routeOrders.reduce((s, o) => s + o.plannedPallets.length, 0);
    const capSlots = rTrips.reduce((s, t) => s + t.maxPalletSlots, 0);
    if (demSlots > capSlots) {
      addWarn('06_Chuyen_xe_tai', 2, 'max_pallet_slots', 'ROUTE_TRIP_CAPACITY_SHORTAGE',
        `Tuyến ${routeId} cần chở ${demSlots} pallet nhưng tổng sức chứa các chuyến xe khai báo chỉ có ${capSlots} chỗ.`);
    }
  }

  if (errors.length > 0) {
    return {valid: false, ok: false, canRunWithConfirmation: false, errors, warnings, plan: null, preview: null, summary: null};
  }

  const plan = {
    shiftConfig,
    skus: [...skus.values()],
    sourcePallets: [...sourcePallets.values()],
    orders: [...orders.values()],
    outPallets: [...outPallets.values()],
    trips: [...trips.values()]
  };

  const preview = buildPreRunPlanPreview(plan, warnings);
  return {
    valid: true,
    ok: warnings.length === 0,
    canRunWithConfirmation: true,
    errors,
    warnings,
    plan,
    preview,
    summary: preview
  };
}

export const parseAndValidateExcelWorkbook = validateOutboundWorkbook;

export function buildPreRunPlanPreview(plan, warnings = []) {
  const wholeCount = plan.outPallets.filter(p => p.dispatchMode === 'WHOLE_PALLET').length;
  const mixedCount = plan.outPallets.length - wholeCount;
  const multiWaveCount = plan.outPallets.filter(p => p.dispatchMode === 'MIXED_PALLET' && p.lines.length > 2).length;
  const multiPalletOrders = plan.orders.filter(o => o.plannedPallets.length > 1).length;
  const availPallets = plan.sourcePallets.filter(p => p.qcStatus === 'AVAILABLE');
  const totalAvailableCartons = availPallets.reduce((s, p) => s + p.availableCartons, 0);
  const holdPallets = plan.sourcePallets.length - availPallets.length;
  const distinctRoutes = new Set(plan.trips.map(t => t.routeId));
  const distinctLots = new Set(plan.sourcePallets.map(p => p.lotCode));
  const totalDemandCartons = plan.outPallets.reduce((s, p) => s + p.totalCartons, 0);
  const totalTripPalletCapacity = plan.trips.reduce((s, t) => s + t.maxPalletSlots, 0);

  const routeBreakdown = [...distinctRoutes].sort().map(routeId => {
    const rOrders = plan.orders.filter(o => o.routeId === routeId);
    const rPallets = plan.outPallets.filter(p => p.routeId === routeId);
    const rTrips = plan.trips.filter(t => t.routeId === routeId);
    const reqPallets = rOrders.reduce((s, o) => s + o.plannedPallets.length, 0);
    const weightKg = Math.round(rPallets.reduce((s, p) => s + p.grossWeightKg, 0));
    const capPallets = rTrips.reduce((s, t) => s + t.maxPalletSlots, 0);
    return {
      routeId,
      orders: rOrders.length,
      plannedPallets: reqPallets,
      pallets: reqPallets,
      weightKg,
      trips: rTrips.length,
      tripSlotCapacity: capPallets,
      tripCapacityPallets: capPallets
    };
  });

  return {
    planId: plan.shiftConfig.planId,
    shiftDate: plan.shiftConfig.shiftDate,
    shiftStartTime: plan.shiftConfig.shiftStartTime,
    shiftDurationHours: Number((plan.shiftConfig.shiftDurationSec / 3600).toFixed(2)),
    dispatchPolicy: plan.shiftConfig.dispatchPolicy,
    fefoMode: plan.shiftConfig.fefoMode,
    fleetSummary: `${plan.shiftConfig.activeXnCount} XN + ${plan.shiftConfig.activeCpCount} CP · ${plan.shiftConfig.assemblyTeams} đội ghép · ${plan.shiftConfig.qcInspectors} QC`,
    skuCount: plan.skus.length,
    sourcePalletCount: plan.sourcePallets.length,
    availableSourcePallets: availPallets.length,
    totalAvailableCartons,
    holdSourcePallets: holdPallets,
    distinctLotCount: distinctLots.size,
    orders: plan.orders.length,
    orderCount: plan.orders.length,
    totalOrders: plan.orders.length,
    multiPalletOrderCount: multiPalletOrders,
    plannedPalletCount: plan.outPallets.length,
    totalPlannedPallets: plan.outPallets.length,
    wholePalletCount: wholeCount,
    wholePallets: wholeCount,
    mixedPalletCount: mixedCount,
    mixedPallets: mixedCount,
    multiWavePalletCount: multiWaveCount,
    totalPlannedCartons: totalDemandCartons,
    totalDemandCartons,
    tripCount: plan.trips.length,
    totalTrips: plan.trips.length,
    totalTripPalletCapacity,
    routeCount: distinctRoutes.size,
    warningCount: warnings.length,
    shortageModeRequired: warnings.length > 0,
    routeBreakdown,
    routes: routeBreakdown
  };
}

// Build a rich, realistic, fully-valid V6.2 sample outbound plan covering multi-SKU, multi-lot/FEFO,
// multi-pallet orders, whole + 2-SKU + 3-SKU multi-wave mixed pallets, pinned source/trip, HOLD QC stock, and multi-trip routes.
export function buildSampleOutboundWorkbookSpec(variant = 'standard') {
  const isFullShift = variant === 'full_8h';
  const skuDefs = [
    ['SKU01', 'Mì khoai tây Omachi thùng 30 gói', 6.5, 0.022, 60, 'A'],
    ['SKU02', 'Nước mắm Nam Ngư 750ml thùng 18 chai', 14.2, 0.024, 50, 'B'],
    ['SKU03', 'Dầu ăn Neptune Light 1L thùng 12 chai', 11.4, 0.020, 60, 'A'],
    ['SKU04', 'Gạo ST25 WinEco túi 5kg kiện 4 túi', 20.2, 0.028, 35, 'B'],
    ['SKU05', 'Sữa tươi tiệt trùng Vinamilk thùng 48 hộp', 9.6, 0.019, 60, 'A'],
    ['SKU06', 'Nước giặt OMO Matic túi 3.6kg thùng 4 túi', 14.8, 0.026, 45, 'B'],
    ['SKU07', 'Bánh quy Cosy Marie thùng 24 hộp', 7.8, 0.030, 50, 'A'],
    ['SKU08', 'Cà phê hòa tan G7 3in1 thùng 24 hộp', 8.4, 0.021, 60, 'B'],
    ['SKU09', 'Nước khoáng Lavie 500ml thùng 24 chai', 12.6, 0.022, 55, 'A'],
    ['SKU10', 'Giấy vệ sinh WinMart Home kiện 10 dây', 5.2, 0.038, 40, 'B'],
    ['SKU11', 'Tương ớt Chin-su 250g thùng 24 chai', 7.4, 0.016, 65, 'A'],
    ['SKU12', 'Ngũ cốc dinh dưỡng VinaCafé thùng 20 bịch', 8.0, 0.025, 55, 'B'],
    ['SKU13', 'Nước tương Tam Thái Tử thùng 24 chai', 12.8, 0.022, 55, 'A'],
    ['SKU14', 'Khăn giấy rút lụa WinMart kiện 30 gói', 6.0, 0.033, 45, 'B']
  ];

  const cfgRows = [
    ['schema_version', EXCEL_SCHEMA_VERSION, '-', 'Bắt buộc', 'Phiên bản đặc tả biểu mẫu kế hoạch ca xuất WinMart V6.2'],
    ['plan_id', isFullShift ? 'KH-WM-V62-8H-BENCH' : 'KH-WM-V62-MAU-01', '-', 'Bắt buộc', 'Mã kế hoạch ca xuất'],
    ['shift_date', '2026-11-05', 'YYYY-MM-DD', 'Bắt buộc', 'Ngày thực hiện ca xuất (mốc đối chiếu hạn dùng FEFO)'],
    ['shift_start_time', '06:00:00', 'HH:MM:SS', 'Bắt buộc', 'Giờ bắt đầu ca xuất (quy ước ứng với t = 0 giây)'],
    ['shift_duration_sec', 28800, 'giây', 'Bắt buộc', 'Thời lượng ca xuất (28.800 giây = 8 giờ)'],
    ['active_xn_count', 6, 'xe (1..6)', 'Bắt buộc', 'Số xe nâng tự hành XN hoạt động trong ca'],
    ['active_cp_count', 4, 'robot (1..4)', 'Bắt buộc', 'Số robot pallet CP hoạt động trong ca'],
    ['assembly_teams', 4, 'đội (1..4)', 'Bắt buộc', 'Số đội nhân công ghép đơn đồng thời (2 người/đội)'],
    ['qc_inspectors', 2, 'người (1..4)', 'Bắt buộc', 'Số nhân viên QC xuất & quấn màng thành phẩm (60 giây/pallet)'],
    ['cross_zone_enabled', 'TRUE', 'TRUE/FALSE', 'Bắt buộc', 'Cho phép XN hỗ trợ chéo Vùng A ⇄ Vùng B qua trục y = 20,2 m / 46,8 m'],
    ['direct_load_enabled', 'TRUE', 'TRUE/FALSE', 'Bắt buộc', 'Cho phép CP đưa thẳng từ G0–G9 lên xe tải nếu xe đã sẵn sàng'],
    ['fefo_mode', 'WINDOW_FEFO', 'STRICT_FEFO/WINDOW_FEFO', 'Bắt buộc', 'Chế độ chọn hạn dùng nguồn (tối ưu trong cửa sổ 14 ngày hoặc cứng tuyệt đối)'],
    ['fefo_window_days', 14, 'ngày', 'Tùy chọn', 'Biên độ cửa sổ hạn dùng khi bật WINDOW_FEFO'],
    ['dispatch_policy', 'V6_2_PROPOSED', 'V6_2_PROPOSED/V6_2_BASELINE', 'Bắt buộc', 'Chính sách điều phối (Phương án đề xuất hoặc phương án cơ sở)']
  ];

  const invRows = [];
  const palletsPerSku = isFullShift ? 28 : 16;
  const expiries = ['2027-01-20', '2027-01-29', '2027-04-15', '2027-08-30'];
  let slotCursorA = 0, slotCursorB = 0;
  const slotsA = ALL_SLOTS.filter(s => s.zone === 'A');
  const slotsB = ALL_SLOTS.filter(s => s.zone === 'B');
  let pCounter = 1;

  for (let sIdx = 0; sIdx < skuDefs.length; sIdx++) {
    const [skuCode, , , , maxC, prefZone] = skuDefs[sIdx];
    for (let k = 0; k < palletsPerSku; k++) {
      const pid = `PL-SRC-${String(pCounter++).padStart(4, '0')}`;
      const slot = prefZone === 'A' ? slotsA[slotCursorA++] : slotsB[slotCursorB++];
      const exp = expiries[k % expiries.length];
      const lot = `LOT-${skuCode}-${exp.slice(2, 4)}${exp.slice(5, 7)}-${(k % 2) + 1}`;
      // Include partial leftover pallets on early-window expiry so WINDOW_FEFO vs STRICT_FEFO difference is observable!
      const isHold = (!isFullShift && sIdx === 0 && k === palletsPerSku - 1);
      const cartons = (k === 1 || k === 5) ? Math.min(maxC, 30) : maxC;
      const pType = k % 4 === 3 ? 'PLASTIC_HD' : 'STD_WOOD';
      const tare = PALLET_TYPES[pType].tareKg;
      invRows.push([pid, skuCode, slot.id, cartons, pType, tare, lot, exp, isHold ? 'HOLD' : 'AVAILABLE']);
    }
  }

  const routes = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06'];
  const orderRows = [];
  const lineRows = [];
  const tripRows = [];

  const targetOrderCount = isFullShift ? 150 : 66;
  let outPalletSeq = 1;

  // Build trips per route across waves so multiple trips per route & concurrent dock usage occur naturally.
  const wavesPerRoute = isFullShift ? 10 : 5;
  for (let w = 0; w < wavesPerRoute; w++) {
    for (let rIdx = 0; rIdx < routes.length; rIdx++) {
      const routeId = routes[rIdx];
      const tripId = `TRIP-${routeId}-${String(w + 1).padStart(2, '0')}`;
      const arrSec = Math.min(24600, w * (isFullShift ? 2350 : 3800) + rIdx * 120);
      const depSec = Math.min(28500, arrSec + (isFullShift ? 2650 : 3200));
      const pinnedDock = (w === 0 && rIdx === 0) ? 'DX1' : '';
      tripRows.push([
        tripId,
        'BOX_TRUCK_4PL',
        `29H-${810 + rIdx}.${String(w + 11).padStart(2, '0')}`,
        routeId,
        formatSecondsAsClock(arrSec, '06:00:00'),
        formatSecondsAsClock(depSec, '06:00:00'),
        1800,
        'DEPART_WHEN_FULL_OR_CUTOFF',
        4,
        3200,
        pinnedDock
      ]);
    }
  }

  for (let oIdx = 0; oIdx < targetOrderCount; oIdx++) {
    const orderId = `ORD-${String(oIdx + 1).padStart(3, '0')}`;
    const rIdx = oIdx % routes.length;
    const routeId = routes[rIdx];
    const storeCode = `WM-${routeId}-CH${String(Math.floor(oIdx / routes.length) + 1).padStart(2, '0')}`;
    const wave = Math.floor(oIdx / (routes.length * 3));
    const relSec = Math.min(22200, wave * (isFullShift ? 2400 : 3400) + (oIdx % 6) * 45);
    const dueSec = Math.min(28500, relSec + (oIdx % 5 === 0 ? 3000 : 4200));
    const prio = (oIdx % 7 === 0) ? 5 : ((oIdx % 3 === 0) ? 3 : 2);
    const palletCountForOrder = (oIdx % 5 === 1) ? 2 : ((oIdx === 4) ? 3 : 1);
    const allowSplit = palletCountForOrder === 3 ? 'TRUE' : 'FALSE';
    const stopSeq = (Math.floor(oIdx / routes.length) % 4) + 1;

    orderRows.push([
      orderId,
      storeCode,
      routeId,
      formatSecondsAsClock(relSec, '06:00:00'),
      formatSecondsAsClock(dueSec, '06:00:00'),
      prio,
      allowSplit,
      stopSeq
    ]);

    for (let pSub = 0; pSub < palletCountForOrder; pSub++) {
      const outId = `OPL-${String(outPalletSeq++).padStart(4, '0')}`;
      const pType = (outPalletSeq % 5 === 0) ? 'PLASTIC_HD' : 'STD_WOOD';
      const pinnedTrip = (oIdx === 0 && pSub === 0) ? 'TRIP-R01-01' : '';

      if ((oIdx + pSub) % 7 === 0) {
        // Whole pallet
        const sIdx = (oIdx + pSub) % skuDefs.length;
        const [skuCode, , , , maxC] = skuDefs[sIdx];
        const pinnedSrc = (oIdx === 0 && pSub === 0) ? 'PL-SRC-0001' : '';
        lineRows.push([outId, 1, orderId, 'WHOLE_PALLET', pType, skuCode, maxC, pinnedSrc, pinnedTrip, 30]);
      } else if ((oIdx + pSub) % 9 === 4) {
        // 3-SKU Mixed Pallet -> triggers Multi-Wave Cell Feeding (> 2 source lines)!
        const s1 = skuDefs[(oIdx * 2) % skuDefs.length];
        const s2 = skuDefs[(oIdx * 2 + 1) % skuDefs.length];
        const s3 = skuDefs[(oIdx * 2 + 3) % skuDefs.length];
        lineRows.push([outId, 1, orderId, 'MIXED_PALLET', pType, s1[0], 10, '', pinnedTrip, 15]);
        lineRows.push([outId, 2, orderId, 'MIXED_PALLET', pType, s2[0], 10, '', pinnedTrip, 15]);
        lineRows.push([outId, 3, orderId, 'MIXED_PALLET', pType, s3[0], 8, '', pinnedTrip, 15]);
      } else {
        // Standard 2-SKU Mixed Pallet
        const s1 = skuDefs[(oIdx * 2 + pSub) % skuDefs.length];
        const s2 = skuDefs[(oIdx * 2 + pSub + 1) % skuDefs.length];
        lineRows.push([outId, 1, orderId, 'MIXED_PALLET', pType, s1[0], 15, '', pinnedTrip, 15]);
        lineRows.push([outId, 2, orderId, 'MIXED_PALLET', pType, s2[0], 15, '', pinnedTrip, 15]);
      }
    }
  }

  // Deterministic planning allowance, independent of observed simulation completion times.
  // Handling (incl. QC 60s) + resource queue + route wait: 120/180/240 minutes;
  // add 20 minutes for each additional pallet of the same order. Keep the 8h cutoff.
  const deadlineRules = [];
  for (const row of orderRows) {
    const lines = lineRows.filter(l => l[2] === row[0]);
    const ids = [...new Set(lines.map(l => l[0]))];
    const allWhole = lines.every(l => l[3] === 'WHOLE_PALLET');
    const multiSource = ids.some(id => lines.filter(l => l[0] === id).length > 2);
    const complexity = allWhole ? 'WHOLE' : multiSource ? 'MULTI_SOURCE' : 'MIXED';
    const leadSec = (allWhole ? 7200 : multiSource ? 14400 : 10800) + 1200 * (ids.length - 1);
    const releaseSec = parseClockToSeconds(row[3]);
    const originalDueSec = parseClockToSeconds(row[4]);
    const dueSec = Math.max(originalDueSec, Math.min(28800, releaseSec + leadSec));
    row[4] = formatSecondsAsClock(dueSec);
    const handlingSec = (allWhole ? 900 : multiSource ? 3000 : 1800) + 1200 * (ids.length - 1);
    const feasibleTrips = tripRows.filter(t => t[3] === row[2] &&
      parseClockToSeconds(t[5]) <= dueSec &&
      Math.min(parseClockToSeconds(t[5]), parseClockToSeconds(t[4]) + 60 + t[6]) >= releaseSec + handlingSec);
    deadlineRules.push({orderId: row[0], complexity, palletCount: ids.length, releaseSec,
      originalDueSec, dueSec, leadSec, adjustmentSec: dueSec-originalDueSec,
      allowanceExceedsShift: releaseSec+leadSec>28800,
      feasibleTripIds: feasibleTrips.map(t => t[0])});
  }

  const guideRows = [
    ['BẢNG HƯỚNG DẪN NHẬP KẾ HOẠCH CA XUẤT KHO KHÔ WINMART V6.2 (5.000 m²)', '', '', ''],
    ['Trang tính', 'Ý nghĩa nghiệp vụ', 'Quy tắc bắt buộc & đơn vị', 'Ghi chú vận hành mô phỏng'],
    ['01_Cau_hinh_ca', 'Khai báo mốc giờ ca xuất, cấu hình đội xe XN/CP, đội nhân công và chính sách điều phối.', 'schema_version = winmart-outbound-v6.2; thời lượng tính bằng giây; giờ bắt đầu HH:MM:SS ứng với t = 0s.', 'Chỉ nạp kế hoạch khi khởi tạo phiên mới (t = 0), không ghi đè giữa ca đang chạy.'],
    ['02_Danh_muc_SKU', 'Danh mục mặt hàng động theo mã SKU, khối lượng kiện (kg), thể tích (m³) và trần kiện/pallet.', 'unit_name = CARTON; kiểm tra đồng thời trần 800 kg và tỷ lệ lấp đầy thể tích/chiều cao <= 100%.', 'Hỗ trợ số lượng SKU bất kỳ, ưu tiên vùng kệ A, B hoặc ANY.'],
    ['03_Ton_kho_pallet', 'Tồn kho pallet nguồn đầu ca trên kệ 3 tầng (1.764 ô) hoặc ô nguồn N0–N19.', 'location_code chấp nhận mã chuẩn S0_0_0_0_0 hoặc mã thân thiện L01-B1-T1-T1; qc_status = AVAILABLE/HOLD.', 'Pallet HOLD hoặc quá hạn dùng tự động bị loại khỏi nguồn cấp.'],
    ['04_Don_hang_xuat', 'Danh sách đơn hàng cửa hàng/siêu thị, tuyến giao, giờ mở đơn, hạn hoàn thành và cờ tách chuyến.', 'allow_split_trips mặc định FALSE (toàn bộ pallet của đơn phải đi cùng 1 chuyến xe tải).', 'stop_sequence là thứ tự giao hàng ngoài kho cho trước, dùng để xếp thứ tự pallet trong thùng.'],
    ['05_Chi_tiet_pallet_xuat', 'Cơ cấu dòng SKU của từng pallet xuất (WHOLE_PALLET nguyên pallet hoặc MIXED_PALLET ghép lẻ).', 'Một đơn có thể gồm nhiều out_pallet_id; MIXED_PALLET > 2 dòng tự động kích hoạt cấp nguồn đa đợt.', 'Có thể ghim cứng pallet nguồn (pinned_source_pallet_id) hoặc chuyến xe (pinned_trip_id).'],
    ['06_Chuyen_xe_tai', 'Kế hoạch các chuyến xe tải đường bộ nhận hàng tại 12 dock xuất (DX1–DX12).', 'Phân biệt rõ xe tải vận tải ngoài kho với đội xe tự hành XN/CP nội bộ; hạn rời kho cam kết KHÔNG tự nới.', 'Cho phép nhiều chuyến xe hoạt động đồng thời trên cùng một tuyến nếu còn dock trống.']
  ];

  return {
    deadlineRules,
    guideRows,
    cfgRows,
    skuRows: skuDefs,
    invRows,
    orderRows,
    lineRows,
    tripRows
  };
}

export function createOutboundWorkbookFromSpec(spec) {
  const wb = XLSX.utils.book_new();

  if (spec.guideRows) {
    const wsGuide = XLSX.utils.aoa_to_sheet(spec.guideRows);
    wsGuide['!cols'] = [{wch: 24}, {wch: 46}, {wch: 52}, {wch: 52}];
    XLSX.utils.book_append_sheet(wb, wsGuide, '00_Huong_dan');
  }

  const wsCfg = XLSX.utils.aoa_to_sheet([
    ['param_key', 'value', 'unit', 'required', 'description'],
    ...spec.cfgRows
  ]);
  wsCfg['!cols'] = [{wch: 24}, {wch: 26}, {wch: 24}, {wch: 14}, {wch: 62}];
  XLSX.utils.book_append_sheet(wb, wsCfg, '01_Cau_hinh_ca');

  const wsSku = XLSX.utils.aoa_to_sheet([
    ['sku_code', 'sku_name', 'unit_name', 'carton_weight_kg', 'carton_volume_m3', 'max_cartons_per_pallet', 'preferred_zone'],
    ...spec.skuRows.map(r => [r[0], r[1], 'CARTON', r[2], r[3], r[4], r[5]])
  ]);
  wsSku['!cols'] = [{wch: 12}, {wch: 42}, {wch: 12}, {wch: 18}, {wch: 18}, {wch: 22}, {wch: 16}];
  XLSX.utils.book_append_sheet(wb, wsSku, '02_Danh_muc_SKU');

  const wsInv = XLSX.utils.aoa_to_sheet([
    ['pallet_id', 'sku_code', 'location_code', 'available_cartons', 'pallet_type', 'pallet_tare_kg', 'lot_code', 'expiry_date', 'qc_status'],
    ...spec.invRows
  ]);
  wsInv['!cols'] = [{wch: 16}, {wch: 12}, {wch: 18}, {wch: 18}, {wch: 14}, {wch: 15}, {wch: 20}, {wch: 14}, {wch: 14}];
  XLSX.utils.book_append_sheet(wb, wsInv, '03_Ton_kho_pallet');

  const wsOrd = XLSX.utils.aoa_to_sheet([
    ['order_id', 'store_code', 'route_id', 'release_time', 'due_time', 'priority', 'allow_split_trips', 'stop_sequence'],
    ...spec.orderRows
  ]);
  wsOrd['!cols'] = [{wch: 14}, {wch: 18}, {wch: 12}, {wch: 15}, {wch: 15}, {wch: 10}, {wch: 18}, {wch: 15}];
  XLSX.utils.book_append_sheet(wb, wsOrd, '04_Don_hang_xuat');

  const wsLine = XLSX.utils.aoa_to_sheet([
    ['out_pallet_id', 'line_no', 'order_id', 'dispatch_mode', 'pallet_type', 'sku_code', 'qty_cartons', 'pinned_source_pallet_id', 'pinned_trip_id', 'min_shelf_life_days'],
    ...spec.lineRows
  ]);
  wsLine['!cols'] = [{wch: 16}, {wch: 10}, {wch: 14}, {wch: 16}, {wch: 14}, {wch: 12}, {wch: 14}, {wch: 24}, {wch: 18}, {wch: 20}];
  XLSX.utils.book_append_sheet(wb, wsLine, '05_Chi_tiet_pallet_xuat');

  const wsTrip = XLSX.utils.aoa_to_sheet([
    ['trip_id', 'vehicle_type', 'vehicle_plate', 'route_id', 'arrival_time', 'committed_departure', 'max_wait_loading_sec', 'late_policy', 'max_pallet_slots', 'max_load_weight_kg', 'pinned_dock_code'],
    ...spec.tripRows
  ]);
  wsTrip['!cols'] = [{wch: 16}, {wch: 18}, {wch: 16}, {wch: 12}, {wch: 15}, {wch: 20}, {wch: 20}, {wch: 26}, {wch: 18}, {wch: 18}, {wch: 18}];
  XLSX.utils.book_append_sheet(wb, wsTrip, '06_Chuyen_xe_tai');

  return wb;
}

export function generateSampleWorkbookBuffer(variant = 'standard') {
  const wb = createOutboundWorkbookFromSpec(buildSampleOutboundWorkbookSpec(variant));
  return XLSX.write(wb, {type: 'array', bookType: 'xlsx'});
}

export function exportRunResultsToXlsx(snapshot) {
  const wb = XLSX.utils.book_new();
  const anchor = snapshot.shiftStartTime || '06:00:00';

  const kpiRows = [
    ['CHỈ SỐ TỔNG HỢP KẾT QUẢ MÔ PHỎNG CA XUẤT WINMART V6.2', ''],
    ['Mã kế hoạch / Kịch bản', snapshot.planId || snapshot.scenarioName || 'Mặc định'],
    ['Chính sách điều phối', snapshot.policy || 'V6_2_PROPOSED'],
    ['Chế độ FEFO', snapshot.fefoMode || 'WINDOW_FEFO'],
    ['Thời gian mô phỏng đã chạy (giây)', snapshot.time],
    ['Mã băm chuẩn hóa trạng thái (SHA-256)', snapshot.normalizedHash || '-'],
    ['Tổng đơn đã phát hành tại mốc xuất dữ liệu', snapshot.orderSummary?.totalOrders ?? snapshot.ordersDetail?.length ?? 0],
    ['Đơn xuất kho đủ số lượng đúng hạn', snapshot.orderSummary?.shippedOnTime ?? 0],
    ['Đơn xuất kho đủ số lượng nhưng trễ hạn', snapshot.orderSummary?.shippedLate ?? 0],
    ['Đơn giao một phần / thiếu hụt', (snapshot.orderSummary?.partialOrders ?? 0) + (snapshot.orderSummary?.shortageOrders ?? 0)],
    ['Tổng pallet rời kho trên xe tải', snapshot.metrics?.departed ?? 0],
    ['Tổng kiện hàng đã xuất', (snapshot.shipped || []).reduce((a, b) => a + b, 0)],
    ['Số chuyến xe đã rời bến', snapshot.tripSummary?.departedCount ?? 0],
    ['Số chuyến xe rời đúng hạn cam kết', snapshot.tripSummary?.onTimeTrips ?? 0],
    ['Số chuyến xe trễ hạn do khóa an toàn sự cố', snapshot.tripSummary?.safetyDelayedTrips ?? 0],
    ['Số lần kiểm định bất biến thành công', snapshot.metrics?.checks ?? 0]
  ];
  const wsKpi = XLSX.utils.aoa_to_sheet(kpiRows);
  wsKpi['!cols'] = [{wch: 46}, {wch: 36}];
  XLSX.utils.book_append_sheet(wb, wsKpi, '01_Tong_hop_KPI');

  const ordRows = [
    ['order_id', 'store_code', 'route_id', 'priority', 'planned_pallets', 'shipped_pallets', 'planned_cartons', 'shipped_cartons', 'due_clock', 'completed_clock', 'lateness_sec', 'state', 'trip_ids']
  ];
  for (const o of (snapshot.ordersDetail || [])) {
    ordRows.push([
      o.id, o.storeCode || '-', o.route, o.priority,
      o.plannedPalletCount, o.shippedPalletCount,
      o.plannedCartons, o.shippedCartons,
      formatSecondsAsClock(o.due, anchor),
      o.completedAt != null ? formatSecondsAsClock(o.completedAt, anchor) : '-',
      o.latenessSec || 0,
      o.state,
      (o.tripIds || []).join(', ')
    ]);
  }
  const wsOrd = XLSX.utils.aoa_to_sheet(ordRows);
  wsOrd['!cols'] = Array(13).fill({wch: 16});
  XLSX.utils.book_append_sheet(wb, wsOrd, '02_Ket_qua_Don_hang');

  const allocRows = [
    ['out_pallet_id', 'order_id', 'dispatch_mode', 'sku_code', 'qty_cartons', 'source_pallet_id', 'lot_code', 'expiry_date', 'status', 'shipped_trip_id', 'decision_reason']
  ];
  for (const a of (snapshot.allocationsDetail || [])) {
    allocRows.push([
      a.outPalletId, a.orderId, a.dispatchMode, a.skuCode, a.qtyCartons,
      a.sourcePalletId || '-', a.lotCode || '-', a.expiryDate || '-',
      a.status, a.tripId || '-', a.decisionReason || '-'
    ]);
  }
  const wsAlloc = XLSX.utils.aoa_to_sheet(allocRows);
  wsAlloc['!cols'] = [{wch: 16}, {wch: 14}, {wch: 16}, {wch: 12}, {wch: 14}, {wch: 18}, {wch: 20}, {wch: 14}, {wch: 16}, {wch: 16}, {wch: 44}];
  XLSX.utils.book_append_sheet(wb, wsAlloc, '03_Truy_xuat_Lo_FEFO');

  const tripRows = [
    ['trip_id', 'route_id', 'dock_code', 'state', 'arrival_clock', 'committed_dep_clock', 'actual_dep_clock', 'loaded_pallets', 'max_slots', 'weight_kg', 'cartons', 'departure_lateness_sec', 'decision_reason']
  ];
  for (const t of (snapshot.trucks || [])) {
    tripRows.push([
      t.id, t.route, t.dockCode || '-', t.state,
      formatSecondsAsClock(t.arrivalTimeSec ?? t.arrived ?? 0, anchor),
      formatSecondsAsClock(t.committedDepartureSec ?? t.deadline ?? 0, anchor),
      t.departed != null ? formatSecondsAsClock(t.departed, anchor) : '-',
      Array.isArray(t.pallets) ? t.pallets.length : t.pallets,
      t.maxPalletSlots ?? 4,
      t.weight,
      t.cartons || 0,
      t.departureLatenessSec || 0,
      t.decisionReason || '-'
    ]);
  }
  const wsTrip = XLSX.utils.aoa_to_sheet(tripRows);
  wsTrip['!cols'] = Array(13).fill({wch: 16});
  XLSX.utils.book_append_sheet(wb, wsTrip, '04_Chuyen_xe_Dock');

  const robRows = [
    ['robot_id', 'type', 'zone', 'status', 'work_sec', 'charging_sec', 'waiting_sec', 'fault_sec', 'battery_pct', 'distance_m', 'cross_zone_trips', 'detours', 'reassigned_tasks']
  ];
  for (const r of (snapshot.robots || [])) {
    robRows.push([
      r.id, r.type, r.zone || '-', r.status || 'IDLE',
      r.work, r.charging, r.waiting, r.faultSeconds,
      Number((r.battery ?? 0).toFixed(1)),
      Number((r.distance ?? 0).toFixed(1)),
      r.crossZoneCount || 0,
      r.detourCount || 0,
      r.reassignedCount || 0
    ]);
  }
  const wsRob = XLSX.utils.aoa_to_sheet(robRows);
  wsRob['!cols'] = Array(13).fill({wch: 15});
  XLSX.utils.book_append_sheet(wb, wsRob, '05_Hieu_suat_Doi_xe');

  return XLSX.write(wb, {type: 'array', bookType: 'xlsx'});
}
