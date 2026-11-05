// c:/Users/lshie/Documents/project/stupidfuck/Bao_cao_WinMart_V6_1_5000m2/Mo_phong/run_v6.mjs
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {
  WinMartEngine,
  LAYOUT,
  parseAndValidateExcelWorkbook,
  generateSampleWorkbookBuffer
} from './core.mjs';
import {buildSampleOutboundWorkbookSpec} from './excel_io.mjs';

const coreSHA256 = createHash('sha256').update(fs.readFileSync(new URL('core.mjs', import.meta.url))).digest('hex');

// Pre-parse the two canonical V6.2 Excel workbooks
const stdExcelPlan = parseAndValidateExcelWorkbook(generateSampleWorkbookBuffer('standard')).plan;
const fullExcelPlan = parseAndValidateExcelWorkbook(generateSampleWorkbookBuffer('full_8h')).plan;

function runV62Scenario({id, name, config, maxSimSec = null, faultHook = null}) {
  const t0 = performance.now();
  const e = new WinMartEngine(config);
  const hourly = [];
  let at8h = null;
  let incident = null;

  if (maxSimSec != null) {
    for (let s = 1; s <= maxSimSec; s++) {
      if (faultHook) incident = faultHook(e, incident);
      e.step(1);
      if (e.time % 3600 === 0 && e.time <= 28800) hourly.push(e.snapshot());
      if (e.time === 28800) at8h = e.snapshot();
      if (e.phase === 'STOPPED') break;
    }
  } else {
    while (e.phase !== 'STOPPED' && e.time < 90000) {
      if (faultHook) incident = faultHook(e, incident);
      e.step(1);
      if (e.time % 3600 === 0 && e.time <= 28800) hourly.push(e.snapshot());
      if (e.time === 28800) at8h = e.snapshot();
    }
  }

  e.assertInvariants();
  const wallMs = Math.round(performance.now() - t0);
  const final = e.snapshot();
  const normalizedHash = e.computeNormalizedHash();
  final.normalizedHash = normalizedHash;

  // Strip bulky excelPlan object from serialized config
  const {excelPlan, ...cleanConfig} = e.config;
  if (excelPlan) cleanConfig.excelPlanId = excelPlan.shiftConfig.planId;

  console.log(
    `[V6.2] ${id.padEnd(20)} | ${wallMs.toString().padStart(5)} ms | PL xuất: ${String(final.metrics.departed).padStart(3)} | Đơn: ${String(final.orderSummary.shippedTotal).padStart(3)}/${String(final.orderSummary.totalOrders).padStart(3)} (SLA ${final.orderSummary.shippedOnTime}) | Chuyến: ${final.tripSummary.departedCount}`
  );

  return {
    id,
    name,
    wallMs,
    normalizedHash,
    config: cleanConfig,
    incident,
    final,
    at8h,
    evaluation: maxSimSec === 144000 ? final : at8h,
    postShift: maxSimSec === 144000 ? null : {extraDeparted: final.metrics.departed - at8h.metrics.departed, endSeconds: final.time, handoverSeconds: final.time-28800, unfinishedOrders: final.orderSummary.totalOrders-final.orderSummary.shippedTotal, unshippedPallets: final.palletSummary.unshipped},
    inputPlanHash: excelPlan ? createHash('sha256').update(JSON.stringify(excelPlan)).digest('hex') : null,
    hourly
  };
}

console.log('Đang chạy 16 kịch bản; lưu riêng mốc 28.800 giây và cuối lượt chạy.');

const scenarios = [
  {
    id: 'mC_proposed_8h',
    name: 'Ca xuất chuẩn · Phương án đề xuất',
    config: {dispatchPolicy: 'V6_2_PROPOSED', fefoMode: 'WINDOW_FEFO'}
  },
  {
    id: 'mB_baseline_8h',
    name: 'Ca xuất chuẩn · Phương án cơ sở',
    config: {dispatchPolicy: 'V6_2_BASELINE', fefoMode: 'STRICT_FEFO'}
  },
  {
    id: 'excel_std_mC',
    name: 'Kế hoạch Excel Chuẩn (66 đơn · Phương án đề xuất)',
    config: {excelPlan: stdExcelPlan, dispatchPolicy: 'V6_2_PROPOSED', fefoMode: 'WINDOW_FEFO'}
  },
  {
    id: 'excel_std_mB',
    name: 'Kế hoạch Excel Chuẩn (66 đơn · Phương án cơ sở)',
    config: {excelPlan: stdExcelPlan, dispatchPolicy: 'V6_2_BASELINE', fefoMode: 'STRICT_FEFO'}
  },
  {
    id: 'excel_full_mC',
    name: 'Kế hoạch Excel Tải cao 8 giờ (150 đơn · Phương án đề xuất)',
    config: {excelPlan: fullExcelPlan, dispatchPolicy: 'V6_2_PROPOSED', fefoMode: 'WINDOW_FEFO'}
  },
  {
    id: 'excel_full_mB',
    name: 'Kế hoạch Excel Tải cao 8 giờ (150 đơn · Phương án cơ sở)',
    config: {excelPlan: fullExcelPlan, dispatchPolicy: 'V6_2_BASELINE', fefoMode: 'STRICT_FEFO'}
  },
  {
    id: 'nocross_8h',
    name: 'Khóa cứng vùng kệ (tắt hỗ trợ chéo A⇄B)',
    config: {crossZone: false, dispatchPolicy: 'V6_2_PROPOSED'}
  },
  {
    id: 'skew80_cross',
    name: 'Lệch tải 80% SKU Vùng A (Bật hỗ trợ chéo A⇄B)',
    config: {demandSkewA: 0.8, crossZone: true, dispatchPolicy: 'V6_2_PROPOSED'}
  },
  {
    id: 'skew80_nocross',
    name: 'Lệch tải 80% SKU Vùng A (Tắt hỗ trợ chéo A⇄B)',
    config: {demandSkewA: 0.8, crossZone: false, dispatchPolicy: 'V6_2_PROPOSED'}
  },
  {
    id: 'slow_ops_25',
    name: 'Thời gian thao tác nhân công tăng 25%',
    config: {humanMultiplier: 1.25, dispatchPolicy: 'V6_2_PROPOSED'}
  },
  {
    id: 'stage_only',
    name: 'Bắt buộc 100% qua ô chờ xuất ST0–ST11',
    config: {direct: false, dispatchPolicy: 'V6_2_PROPOSED'}
  },
  {
    id: 'charge_15pct',
    name: 'Khởi đầu ca pin thấp 15% (sạc cân bằng vùng/nhóm)',
    config: {initialBattery: 15, dispatchPolicy: 'V6_2_PROPOSED'}
  },
  {
    id: 'fault_detour_rescue',
    name: 'Sự cố nghẽn hành lang + Cứu hộ F3 bàn giao pallet',
    config: {dispatchPolicy: 'V6_2_PROPOSED'},
    faultHook(e, inc) {
      if (!inc && e.time >= 3600) {
        const corridorXn = [...e.robots.values()].find(r =>
          r.type === 'RT' && Math.abs(r.y - LAYOUT.frontY) < 0.25 && r.x >= 35 && r.x <= 65 && r.status === 'RUNNING'
        );
        if (corridorXn) {
          e.faultRobot(corridorXn.id, {repairMode: 'IN_PLACE', repairDurationSec: 1800, reason: 'Dừng lỗi trên hành lang chính y=20,2m'});
          return {step: 1, blocker: corridorXn.id};
        }
      }
      if (inc?.step === 1 && e.time >= 4200) {
        const cp = [...e.robots.values()].find(r => r.type === 'CP' && r.carried && r.y >= 2.0 && r.y <= 14.0 && r.x >= 32 && r.x <= 66);
        if (cp) {
          e.faultRobot(cp.id, {repairMode: 'TOW_TO_MAINT', repairDurationSec: 900, reason: 'Lỗi truyền động khi chở hàng'});
          e.authorizeRescue(cp.id);
          return {...inc, step: 2, rescued: cp.id};
        }
      }
      return inc;
    }
  },
  {
    id: 'fault_dock_1h',
    name: 'Sự cố robot trong thùng xe 1 giờ (khóa DOCK_HOLD_FAULT)',
    config: {dispatchPolicy: 'V6_2_PROPOSED'},
    faultHook(e, inc) {
      if (!inc && e.time >= 5400) {
        const r = [...e.robots.values()].find(x => x.type === 'CP' && x.y < 0 && x.carried && x.task?.truck);
        if (r) {
          e.faultRobot(r.id, {repairMode: 'IN_PLACE', repairDurationSec: 3600, reason: 'Lỗi cảm biến trong thùng xe tải 1 giờ'});
          return {robot: r.id, truck: r.task?.truck?.id, start: e.time};
        }
      }
      return inc;
    }
  },
  {
    id: 'inbound_8h',
    name: 'Ca nhập 8 giờ độc lập (128 pallet · dỡ tuần tự, 2 luồng kiểm nhận)',
    config: {startPhase: 'INBOUND', initialPerSKU: 0, inboundPallets: 128},
    maxSimSec: 28800
  },
  {
    id: 'continuous_40h',
    name: 'Liên hoàn đa ca 40 giờ (Nhập – Chuyển ca – Xuất tuần hoàn)',
    config: {startPhase: 'INBOUND', initialPerSKU: 48, autoCycle: true, orderLimit: 600, inboundPallets: 112},
    maxSimSec: 144000
  }
];

const runs = scenarios.map(runV62Scenario);

const compareRow = r => ({
  simSeconds:r.at8h.time, departed:r.at8h.metrics.departed,
  shippedOrders:r.at8h.orderSummary.shippedTotal, totalOrders:r.at8h.orderSummary.totalOrders,
  shippedOnTime:r.at8h.orderSummary.shippedOnTime,
  onTimeTrips:r.at8h.tripSummary.onTimeTrips, departedTrips:r.at8h.tripSummary.departedCount,
  windowFefoOpts:r.at8h.metrics.windowFefoOptimizations, palletSummary:r.at8h.palletSummary,
  inputPlanHash:r.inputPlanHash
});
const summary = {
  version:'6.2', coreSHA256, generatedAt:new Date().toISOString(),
  evaluationRule:'Single-shift comparisons at exactly 28800 seconds; continuous scenario at 144000 seconds. Final run results kept separately.',
  scientificComparisons: {
    synthetic8h:{baseline:compareRow(runs[1]),proposed:compareRow(runs[0])},
    excelStandard:{baseline:compareRow(runs[3]),proposed:compareRow(runs[2])},
    excelFull8h:{baseline:compareRow(runs[5]),proposed:compareRow(runs[4])}
  },
  scenarios:runs.map(r=>{
    const s=r.evaluation;
    return {id:r.id,name:r.name,simSeconds:s.time,simHours:s.time/3600,
      ...s.metrics,shippedOrders:s.orderSummary.shippedTotal,totalOrders:s.orderSummary.totalOrders,
      shippedOnTime:s.orderSummary.shippedOnTime,departedTrips:s.tripSummary.departedCount,
      onTimeTrips:s.tripSummary.onTimeTrips,safetyDelayedTrips:s.tripSummary.safetyDelayedTrips,
      palletSummary:s.palletSummary,postShift:r.postShift,
      wallMs:r.wallMs,normalizedHash:r.normalizedHash};
  })
};
const deadlineAudit = Object.fromEntries(['standard','full_8h'].map(v=>[v,buildSampleOutboundWorkbookSpec(v).deadlineRules]));
fs.writeFileSync(new URL('data/deadline_rules.json',import.meta.url),JSON.stringify({
 rule:'Lead seconds = 7200 whole / 10800 mixed <=2 source lines / 14400 mixed >2 source lines, plus 1200 per extra pallet; due = max(old due, min(28800, release + lead)); unchanged trip schedule.',
 componentsMinutes:{whole:[15,30,75],mixed:[30,60,90],multiSource:[50,100,90]},
 scope:'Synthetic initial outbound Excel plans; no real delivery commitments. Same input per comparison pair.',
 plans:deadlineAudit
},null,2));

fs.writeFileSync(
  new URL('data/results.json', import.meta.url),
  JSON.stringify({version: '6.2', coreSHA256, generatedAt: summary.generatedAt, runs}, null, 2)
);
fs.writeFileSync(
  new URL('data/summary.json', import.meta.url),
  JSON.stringify(summary, null, 2)
);
console.log('\nĐã lưu Mo_phong/data/results.json và Mo_phong/data/summary.json thành công.');
