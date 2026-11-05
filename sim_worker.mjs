// c:/Users/lshie/Documents/project/stupidfuck/Bao_cao_WinMart_V6_1_5000m2/Mo_phong/sim_worker.mjs
// Off-main-thread Web Worker for fast full-shift / 40h simulation and Milestone B vs Milestone C scientific comparison.

import {WinMartEngine} from './core.mjs';

let activeRunId = null;
let cancelledRunId = null;

const yieldTick = () => new Promise(resolve => setTimeout(resolve, 0));

async function runEngineToCompletion(runId, config, progressMeta = {}) {
  const {pctTransform, ...serializableMeta} = progressMeta;
  const t0 = performance.now();
  const engine = new WinMartEngine(config);
  const targetSec = config.autoCycle
    ? 144000
    : (config.startPhase === 'INBOUND' ? (engine.config.inboundSeconds || 28800) : (engine.config.outboundSeconds || 28800));
  const hardCapSec = config.autoCycle ? 165000 : targetSec + 14400;
  const chunkSec = 600;
  let atCutoff = null;

  while (engine.phase !== 'STOPPED' && engine.time < hardCapSec) {
    if (cancelledRunId === runId) {
      return {cancelled: true};
    }
    if (config.autoCycle && engine.time >= targetSec) break;
    const boundary = engine.time < targetSec ? targetSec : hardCapSec;
    const chunkEnd = Math.min(engine.time + chunkSec, boundary);
    while (engine.time < chunkEnd && engine.phase !== 'STOPPED') engine.step(1);
    if (engine.time === targetSec) atCutoff = engine.snapshot(true, true);
    const rawPct = Math.min(99, Math.round((engine.time / targetSec) * 100));
    self.postMessage({
      type: 'PROGRESS',
      runId,
      ...serializableMeta,
      simTime: engine.time,
      targetSec,
      pct: pctTransform ? pctTransform(rawPct) : rawPct,
      phase: engine.phase,
      departed: engine.metrics.departed,
      shippedOrders: engine.orders.filter(o => o.state === 'SHIPPED').length
    });
    await yieldTick();
  }

  engine.assertInvariants();
  const wallMs = Math.round(performance.now() - t0);
  return {
    cancelled: false,
    wallMs,
    atCutoff,
    snapshot: engine.snapshot(true, true)
  };
}

self.onmessage = async event => {
  const msg = event.data || {};
  if (msg.type === 'CANCEL') {
    cancelledRunId = msg.runId ?? activeRunId;
    return;
  }

  if (msg.type === 'RUN_FAST') {
    const {runId, config} = msg;
    activeRunId = runId;
    try {
      const res = await runEngineToCompletion(runId, config, {mode: 'SINGLE', label: 'Đang mô phỏng tốc độ cao'});
      if (res.cancelled || cancelledRunId === runId) {
        self.postMessage({type: 'CANCELLED', runId});
        return;
      }
      self.postMessage({
        type: 'COMPLETE',
        runId,
        wallMs: res.wallMs,
        snapshot: res.snapshot,
        atCutoff: res.atCutoff
      });
    } catch (err) {
      self.postMessage({type: 'ERROR', runId, message: err?.message || String(err)});
    }
    return;
  }

  if (msg.type === 'COMPARE_POLICIES') {
    const {runId, baseConfig} = msg;
    activeRunId = runId;
    try {
      const totalT0 = performance.now();
      const baseCfg = {
        ...baseConfig,
        dispatchPolicy: 'V6_2_BASELINE',
        fefoMode: 'STRICT_FEFO',
        autoAuthorizeRescue: Boolean(baseConfig.faultSchedule?.length) ? true : Boolean(baseConfig.autoAuthorizeRescue)
      };
      const propCfg = {
        ...baseConfig,
        dispatchPolicy: 'V6_2_PROPOSED',
        fefoMode: 'WINDOW_FEFO',
        autoAuthorizeRescue: Boolean(baseConfig.faultSchedule?.length) ? true : Boolean(baseConfig.autoAuthorizeRescue)
      };

      const resB = await runEngineToCompletion(runId, baseCfg, {
        mode: 'COMPARE',
        stage: 'BASELINE',
        label: 'Đang chạy Phương án cơ sở (V6_2_BASELINE · FIFO + STRICT_FEFO)',
        pctTransform: p => Math.round(p * 0.5)
      });
      if (resB.cancelled || cancelledRunId === runId) {
        self.postMessage({type: 'CANCELLED', runId});
        return;
      }

      const resC = await runEngineToCompletion(runId, propCfg, {
        mode: 'COMPARE',
        stage: 'PROPOSED',
        label: 'Đang chạy Phương án đề xuất (V6_2_PROPOSED · Hạn có trọng số + WINDOW_FEFO)',
        pctTransform: p => 50 + Math.round(p * 0.5)
      });
      if (resC.cancelled || cancelledRunId === runId) {
        self.postMessage({type: 'CANCELLED', runId});
        return;
      }

      self.postMessage({
        type: 'COMPARE_COMPLETE',
        runId,
        wallMs: Math.round(performance.now() - totalT0),
        baselineMs: resB.wallMs,
        proposedMs: resC.wallMs,
        baseline: resB.atCutoff,
        proposed: resC.atCutoff,
        baselineFinal: resB.snapshot,
        proposedFinal: resC.snapshot
      });
    } catch (err) {
      self.postMessage({type: 'ERROR', runId, message: err?.message || String(err)});
    }
  }
};
