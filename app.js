// c:/Users/lshie/Documents/project/stupidfuck/Bao_cao_WinMart_V6_1_5000m2/Web_GitHub_Pages/app.js
import {WinMartEngine, LAYOUT} from './core.js';

const $ = id => document.getElementById(id);
const ctx = $('map').getContext('2d');
const bg = new Image();
bg.src = './map.svg';

let engine = new WinMartEngine(), playing = false, last = 0, acc = 0;
window.sim = {
  get engine() { return engine; },
  step(n) { engine.step(n); render(); }
};

const phase = {
  INBOUND: 'Ca nhập',
  OUTBOUND: 'Ca xuất',
  TRANSITION: 'Chuyển ca',
  STOPPED: 'Đã hoàn tất chuyển ca'
};
const state = {EMPTY: 'Trống', PREPARING: 'Chuẩn bị', ASSEMBLING: 'Đang ghép', COMPLETE: 'Hoàn tất'};
const rs = {IDLE: 'Rảnh', RUNNING: 'Làm việc', CHARGING: 'Sạc', FAULT: 'Lỗi'};
const ts = {NOT_ARRIVED: 'Chưa đến', DOCKING: 'Vào dock', READY: 'Sẵn sàng', LOADING: 'Đang chất', COMPLETE: 'Hoàn tất', DEPARTED: 'Rời kho'};

function clock(s) {
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map(x => String(x).padStart(2, '0')).join(':');
}

function render() {
  const e = engine, s = e.snapshot(), m = s.metrics;
  $('status').textContent = `${clock(e.time)} · ${phase[e.phase]} · ${s.queuedOrders} đơn chờ · ${s.unfinishedJobs} nhiệm vụ đang xử lý · Hỗ trợ chéo A⇄B: ${m.crossZoneTrips} chuyến`;
  $('metrics').innerHTML = [
    ['Đã nhận', m.received],
    ['Đã cất kệ', m.stored],
    ['Đã ghép', m.assembled],
    ['Đã chất lên xe', m.loaded],
    ['Đã rời kho', m.departed]
  ].map(([l, v]) => `<div><strong>${v}</strong><span>${l} · pallet</span></div>`).join('');

  ctx.clearRect(0, 0, 1180, 750);
  if (bg.complete) ctx.drawImage(bg, 0, 0);

  // Highlight active docked outbound trucks & pallet slots
  for (const t of e.activeTrucks()) {
    const cx = 40 + t.dockX * 11;
    ctx.strokeStyle = t.state === 'LOADING' ? '#15803d' : '#2563eb';
    ctx.lineWidth = 2.2;
    ctx.strokeRect(cx - 13, 54, 26, 49);
    ctx.lineWidth = 1;
  }

  for (const l of e.locations.values()) {
    if (l.kind !== 'rack' && (l.pallet || l.reservation)) {
      if (l.kind === 'truck') {
        const tr = e.trucks.find(x => x.id === l.truck);
        if (!tr || tr.state === 'DEPARTED') continue;
      }
      const px = 40 + l.x * 11;
      const py = l.kind === 'truck' ? 62 + l.index * 10.3 : 110 + l.y * 11;
      if (l.kind === 'truck' && l.pallet) {
        const sy = 58 + l.index * 10.3;
        ctx.fillStyle = '#86efac';
        ctx.strokeStyle = '#15803d';
        ctx.lineWidth = 1;
        ctx.fillRect(px - 8, sy, 16, 7.8);
        ctx.strokeRect(px - 8, sy, 16, 7.8);
      }
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#0f2942';
      ctx.strokeStyle = '#0f2942';
      l.pallet ? ctx.fill() : ctx.stroke();
    }
  }

  for (const r of e.robots.values()) {
    const x = 40 + r.x * 11;
    const y = r.y < 0 ? 105 + (r.y / 5.6) * 43 : 110 + r.y * 11;
    ctx.fillStyle = r.status === 'FAULT' ? '#b52828' : r.type === 'RT' ? '#b96409' : '#1e5790';
    ctx.fillRect(x - 7, y - 7, 14, 14);
    ctx.font = 'bold 11px Arial';
    ctx.fillText(r.id, x + 9, y + 4);
    if (r.carried) {
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1.6;
      ctx.strokeRect(x - 9, y - 9, 18, 18);
      ctx.lineWidth = 1;
    }
  }

  const active = s.activeDocks;
  const departedCount = s.departedCount;
  $('truck').innerHTML = active.length
    ? `<p><strong>Đang đỗ: ${active.length}/12 dock xuất</strong> · Đã rời: <strong>${departedCount}</strong> chuyến</p>` +
      active.map(t =>
        `<div style="font-size:13px;padding:4px 0;border-bottom:1px solid #e2e8f0">` +
        `<strong>${t.dockCode} (${t.id})</strong> · Tuyến ${t.route + 1} · ${ts[t.state]} — ` +
        `<strong>${t.pallets}/4</strong> pallet (${t.weight} kg · hạn ${clock(t.deadline)})</div>`
      ).join('')
    : `<p>Chưa có xe xuất tại dock (đã rời: ${departedCount} chuyến). Mốc đến tiếp theo: ${clock(e.nextTruck)}.</p>`;

  $('cells').innerHTML = e.cells.map(c => `<div class="${c.state}">G${c.id} · ${state[c.state]}</div>`).join('');
  const maxSlots = {inbound: 4, source: 20, output: 10, stage: 12, rack: 1764};
  $('occupancy').innerHTML = Object.entries(s.occupancy).map(([k, v]) =>
    `<p>${{inbound: 'Nhập', source: 'Nguồn', output: 'Ghép', stage: 'Chờ xuất', rack: 'Kệ 3 tầng'}[k]}: ${v} / ${maxSlots[k]}</p>`
  ).join('');

  $('robots').innerHTML = [...e.robots.values()].map(r =>
    `<tr><td>${r.id}${r.zone ? ' · Vùng ' + r.zone : ''}</td>` +
    `<td>${rs[r.status]}</td>` +
    `<td>${r.task ? (r.returning ? 'Đang rút/chờ nối chuyến' : r.task.label) : 'Chờ việc'}${r.carried ? ' · ' + r.carried : ''}</td>` +
    `<td>${r.battery.toFixed(0)}%</td>` +
    `<td>${(r.work / 60).toFixed(1)}</td>` +
    `<td>${(r.charging / 60).toFixed(1)}</td>` +
    `<td>${(r.waiting / 60).toFixed(1)}</td>` +
    `<td>${r.type === 'RT' ? r.crossZoneCount : '—'}</td></tr>`
  ).join('');

  $('log').innerHTML = e.logs.slice(-12).reverse().map(x => `<li>${clock(x.time)} — ${x.message}</li>`).join('');
  $('play').textContent = playing ? 'Tạm dừng' : 'Chạy';
}

$('robot').innerHTML = [...engine.robots.keys()].map(id => `<option>${id}</option>`).join('');
$('play').onclick = () => { playing = !playing; render(); };
$('step').onclick = () => { engine.step(300); render(); };
$('shift').onclick = () => { engine.requestTransition(); render(); };
$('fault').onclick = () => { engine.faultRobot($('robot').value); render(); };
$('recover').onclick = () => { engine.recoverRobot($('robot').value); render(); };
$('reset').onclick = () => {
  playing = false;
  const c = {
    base: {},
    nocross: {crossZone: false},
    slow: {operationMultiplier: 1.25},
    inbound: {startPhase: 'INBOUND', initialPerSKU: 0, inboundPallets: 128},
    cycle: {startPhase: 'INBOUND', initialPerSKU: 48, autoCycle: true, orderLimit: 600, inboundPallets: 112},
    late: {truckArrival: 7200},
    charge: {initialBattery: 15},
    low: {initialPerSKU: 2},
    stage: {direct: false}
  }[$('scenario').value];
  engine = new WinMartEngine(c);
  $('status').classList.remove('error');
  acc = 0;
  render();
};
$('export').onclick = () => {
  const blob = new Blob([JSON.stringify(engine.snapshot(), null, 2)], {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'winmart-v6.1-trang-thai.json';
  a.click();
  URL.revokeObjectURL(a.href);
};

function frame(t) {
  if (playing) {
    acc += Math.min((t - last) / 1000, 0.1) * Number($('speed').value);
    const n = Math.floor(acc);
    if (n) {
      try {
        engine.step(n);
        acc -= n;
      } catch (err) {
        playing = false;
        $('status').textContent = err.message;
        $('status').classList.add('error');
        throw err;
      }
    }
  }
  last = t;
  if (playing) render();
  requestAnimationFrame(frame);
}

bg.onload = render;
render();
requestAnimationFrame(frame);

$('zoom').onclick = () => {
  const z = document.querySelector('.map-wrap').classList.toggle('zoomed');
  $('zoom').setAttribute('aria-pressed', String(z));
  $('zoom').textContent = z ? 'Thu vừa màn hình' : 'Phóng to bản đồ';
};
