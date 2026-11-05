// c:/Users/lshie/Documents/project/stupidfuck/Bao_cao_WinMart_V6_1_5000m2/Mo_phong/routing_and_hash.mjs
// Deterministic corridor Dijkstra router (with detour detection & obstacle avoidance) + pure-JS SHA-256 hash for WinMart V6.2.

import {LAYOUT} from './layout_spec.mjs';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function dedupPoints(pts) {
  const out = [];
  for (const p of pts) {
    if (!out.length || Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y) > 1e-5) {
      out.push({x: Number(p.x.toFixed(4)), y: Number(p.y.toFixed(4))});
    }
  }
  // Collapse collinear consecutive segments so trajectories stay smooth and exact.
  const simplified = [];
  for (const p of out) {
    if (simplified.length >= 2) {
      const a = simplified[simplified.length - 2];
      const b = simplified[simplified.length - 1];
      const cross = Math.abs((b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x));
      const dot = (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y);
      if (cross < 1e-5 && dot >= -1e-6) {
        simplified[simplified.length - 1] = p;
        continue;
      }
    }
    simplified.push(p);
  }
  return simplified;
}

// Axis-aligned / general segment intersection with expanded safety rectangle [bx - rx, bx + rx] x [by - ry, by + ry].
export function segmentHitsBox(p1, p2, box) {
  const minX = box.x - box.rx, maxX = box.x + box.rx;
  const minY = box.y - box.ry, maxY = box.y + box.ry;
  let t0 = 0, t1 = 1;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const checks = [
    [-dx, p1.x - minX],
    [dx, maxX - p1.x],
    [-dy, p1.y - minY],
    [dy, maxY - p1.y]
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) < 1e-8) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return t0 <= t1;
}

function isSegmentBlocked(p1, p2, obstacles) {
  if (!obstacles || obstacles.length === 0) return false;
  for (const obs of obstacles) {
    if (segmentHitsBox(p1, p2, obs)) return true;
  }
  return false;
}

// Find shortest unobstructed corridor path for RT (XN) or CP.
// Returns { points: [{x, y}, ...], usedDetour: boolean, distance: number } or null if completely blocked.
export function findCorridorPath(start, goal, robotType, options = {}) {
  const obstacles = options.obstacles || [];
  const blockedAisles = options.blockedAisles || new Set();
  const allowRearDetour = options.allowRearDetour !== false;

  if (dist(start, goal) < 1e-4) {
    return {points: [{x: start.x, y: start.y}], usedDetour: false, distance: 0};
  }

  const nodes = [];
  const adj = [];
  const nodeIndex = new Map();

  const addNode = (x, y, tag = '') => {
    const nx = Number(x.toFixed(3)), ny = Number(y.toFixed(3));
    const key = `${nx},${ny}`;
    if (nodeIndex.has(key)) return nodeIndex.get(key);
    const id = nodes.length;
    nodes.push({id, x: nx, y: ny, tag});
    adj.push([]);
    nodeIndex.set(key, id);
    return id;
  };

  const addEdge = (u, v, penalty = 0, ignoreObs = false) => {
    if (u === v) return;
    const p1 = nodes[u], p2 = nodes[v];
    if (!ignoreObs && isSegmentBlocked(p1, p2, obstacles)) return;
    const w = dist(p1, p2) + penalty;
    adj[u].push({to: v, cost: w});
    adj[v].push({to: u, cost: w});
  };

  const sId = addNode(start.x, start.y, 'start');
  const gId = addNode(goal.x, goal.y, 'goal');

  if (robotType === 'RT') {
    const frontXs = new Set([
      ...LAYOUT.aisleXs,
      ...LAYOUT.rtChargers.map(c => c.x),
      start.x,
      goal.x
    ]);
    // Clamp frontXs to valid indoor RT front corridor [5.2 .. 97.8]
    const sortedFrontXs = [...frontXs]
      .map(x => Number(Math.max(5.2, Math.min(97.8, x)).toFixed(3)))
      .sort((a, b) => a - b);

    const frontIds = sortedFrontXs.map(x => addNode(x, LAYOUT.frontY, 'front'));
    for (let i = 0; i + 1 < frontIds.length; i++) {
      addEdge(frontIds[i], frontIds[i + 1], 0);
    }

    const rearXs = new Set([
      ...LAYOUT.aisleXs,
      ...LAYOUT.rtHomes.map(h => h.x),
      ...LAYOUT.maintBays.RT.map(m => m.x)
    ]);
    if (start.y >= LAYOUT.rearY - 0.1) rearXs.add(Math.max(5.2, Math.min(94.8, start.x)));
    if (goal.y >= LAYOUT.rearY - 0.1) rearXs.add(Math.max(5.2, Math.min(94.8, goal.x)));

    const sortedRearXs = [...rearXs]
      .map(x => Number(Math.max(5.2, Math.min(94.8, x)).toFixed(3)))
      .sort((a, b) => a - b);
    const rearIds = sortedRearXs.map(x => addNode(x, LAYOUT.rearY, 'rear'));
    for (let i = 0; i + 1 < rearIds.length; i++) {
      const x1 = nodes[rearIds[i]].x;
      const x2 = nodes[rearIds[i + 1]].x;
      if (allowRearDetour) {
        // Small preference penalty on rear corridor so normal traffic uses frontY=20.2 unless detouring or docking at home/maint.
        addEdge(rearIds[i], rearIds[i + 1], 0.35);
      } else {
        // In baseline mode (no rear corridor detour), only allow local pocket exit/entry to adjacent home aisle within same zone.
        const crossesZone = (x1 < 50 && x2 >= 50) || (x2 < 50 && x1 >= 50);
        const nearStartHome = start.y >= LAYOUT.rearY - 0.1 && (Math.abs(x1 - start.x) < 3.6 && Math.abs(x2 - start.x) < 3.6);
        const nearGoalHome = goal.y >= LAYOUT.rearY - 0.1 && (Math.abs(x1 - goal.x) < 3.6 && Math.abs(x2 - goal.x) < 3.6);
        if (!crossesZone && (nearStartHome || nearGoalHome)) {
          addEdge(rearIds[i], rearIds[i + 1], 0.35);
        }
      }
    }

    // Connect aisles between frontY and rearY
    for (let aisle = 0; aisle < LAYOUT.aisleXs.length; aisle++) {
      const ax = LAYOUT.aisleXs[aisle];
      const fNode = addNode(ax, LAYOUT.frontY, 'front');
      const rNode = addNode(ax, LAYOUT.rearY, 'rear');
      const startInThisAisle = Math.abs(start.x - ax) < 0.08 && start.y > LAYOUT.frontY + 0.05 && start.y < LAYOUT.rearY - 0.05;
      const goalInThisAisle = Math.abs(goal.x - ax) < 0.08 && goal.y > LAYOUT.frontY + 0.05 && goal.y < LAYOUT.rearY - 0.05;
      if (blockedAisles.has(aisle) && !startInThisAisle && !goalInThisAisle) continue;
      if (allowRearDetour || startInThisAisle || goalInThisAisle || Math.abs(start.y - LAYOUT.rtHomeY) < 0.2 || Math.abs(goal.y - LAYOUT.rtHomeY) < 0.2) {
        if (startInThisAisle && goalInThisAisle) {
          addEdge(sId, gId, 0);
        }
        if (startInThisAisle) {
          addEdge(sId, fNode, 0);
          if (allowRearDetour || goal.y >= LAYOUT.rearY - 0.1) addEdge(sId, rNode, 0.5);
        }
        if (goalInThisAisle) {
          addEdge(gId, fNode, 0);
          if (allowRearDetour || start.y >= LAYOUT.rearY - 0.1) addEdge(gId, rNode, 0.5);
        }
        if (!blockedAisles.has(aisle) && allowRearDetour) {
          // Through-aisle detour carries slight penalty so empty aisles aren't used unnecessarily when frontY is clear.
          addEdge(fNode, rNode, 1.5);
        } else if (!allowRearDetour && (Math.abs(start.x - ax) < 3.6 || Math.abs(goal.x - ax) < 3.6)) {
          addEdge(fNode, rNode, 0);
        }
      }
    }

    // Connect endpoints (SRC, ST, CHG_RT above frontY; RT_HOME, MAINT_RT below rearY; or directly on axes)
    const connectEndpointRT = (epId, ep) => {
      if (Math.abs(ep.x - goal.x) < 1e-4 && Math.abs(ep.y - goal.y) < 1e-4 && Math.abs(start.x - goal.x) < 1e-4) {
        addEdge(sId, gId, 0);
      }
      if (ep.y <= LAYOUT.frontY + 0.08) {
        const cx = Math.max(5.2, Math.min(97.8, ep.x));
        const fNode = addNode(cx, LAYOUT.frontY, 'front');
        addEdge(epId, fNode, 0);
      } else if (ep.y >= LAYOUT.rearY - 0.08) {
        const cx = Math.max(5.2, Math.min(94.8, ep.x));
        const rNode = addNode(cx, LAYOUT.rearY, 'rear');
        addEdge(epId, rNode, 0);
      }
    };
    connectEndpointRT(sId, start);
    connectEndpointRT(gId, goal);
  } else {
    // CP robot corridor graph: cpFrontY = 3.4, cpMidY = 11.6, crossXs = [28.6, 62.1, 85.0]
    const frontXs = new Set([
      ...LAYOUT.cpCrossXs,
      ...LAYOUT.outboundDockXs,
      ...LAYOUT.cpHomes.map(h => h.x),
      ...LAYOUT.maintBays.CP.map(m => m.x)
    ]);
    const midXs = new Set([
      8.0, 12.0, 16.0, 20.0,
      ...LAYOUT.cpCrossXs,
      ...LAYOUT.cpChargers.map(c => c.x)
    ]);

    const classifyCpEndpoint = ep => {
      if (Math.abs(ep.y - LAYOUT.cpFrontY) < 0.08) return 'front';
      if (Math.abs(ep.y - LAYOUT.cpMidY) < 0.08) return 'mid';
      const onCross = LAYOUT.cpCrossXs.find(cx => Math.abs(ep.x - cx) < 0.08 && ep.y > LAYOUT.cpFrontY && ep.y < LAYOUT.cpMidY);
      if (onCross != null) return 'cross';
      if (ep.x < 26.5) return 'mid'; // IN0..IN3
      if (ep.y > 8.6) return 'mid'; // SRC, ST, CHG_CP (y=9.2..14.8)
      return 'front'; // Docks, dock stage, OUT (y=6.5), CP_HOME (y=5.6), MAINT_CP (y=1.35)
    };

    const sLane = classifyCpEndpoint(start);
    const gLane = classifyCpEndpoint(goal);
    if (sLane === 'front') frontXs.add(Math.max(28.6, Math.min(97.0, start.x)));
    if (sLane === 'mid') midXs.add(Math.max(8.0, Math.min(97.0, start.x)));
    if (gLane === 'front') frontXs.add(Math.max(28.6, Math.min(97.0, goal.x)));
    if (gLane === 'mid') midXs.add(Math.max(8.0, Math.min(97.0, goal.x)));

    const sortedFront = [...frontXs].map(x => Number(x.toFixed(3))).sort((a, b) => a - b);
    const sortedMid = [...midXs].map(x => Number(x.toFixed(3))).sort((a, b) => a - b);

    const fNodes = sortedFront.map(x => addNode(x, LAYOUT.cpFrontY, 'cpFront'));
    for (let i = 0; i + 1 < fNodes.length; i++) addEdge(fNodes[i], fNodes[i + 1], 0);

    const mNodes = sortedMid.map(x => addNode(x, LAYOUT.cpMidY, 'cpMid'));
    for (let i = 0; i + 1 < mNodes.length; i++) addEdge(mNodes[i], mNodes[i + 1], 0);

    for (const cx of LAYOUT.cpCrossXs) {
      const fn = addNode(cx, LAYOUT.cpFrontY, 'cpFront');
      const mn = addNode(cx, LAYOUT.cpMidY, 'cpMid');
      addEdge(fn, mn, 0);
    }

    const connectEndpointCP = (epId, ep, lane) => {
      if (lane === 'cross') {
        const cx = LAYOUT.cpCrossXs.find(x => Math.abs(ep.x - x) < 0.08);
        addEdge(epId, addNode(cx, LAYOUT.cpFrontY, 'cpFront'), 0);
        addEdge(epId, addNode(cx, LAYOUT.cpMidY, 'cpMid'), 0);
      } else if (lane === 'front') {
        const cx = Number(Math.max(28.6, Math.min(97.0, ep.x)).toFixed(3));
        const fn = addNode(cx, LAYOUT.cpFrontY, 'cpFront');
        if (Math.abs(ep.x - cx) > 1e-3) {
          const midPt = addNode(ep.x, ep.y, 'spur');
          addEdge(epId, midPt, 0);
          addEdge(midPt, fn, 0);
        } else {
          addEdge(epId, fn, 0);
        }
      } else {
        const cx = Number(Math.max(8.0, Math.min(97.0, ep.x)).toFixed(3));
        const mn = addNode(cx, LAYOUT.cpMidY, 'cpMid');
        addEdge(epId, mn, 0);
      }
    };
    connectEndpointCP(sId, start, sLane);
    connectEndpointCP(gId, goal, gLane);
  }

  // Dijkstra shortest path from sId to gId
  const n = nodes.length;
  const best = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);
  best[sId] = 0;

  for (let iter = 0; iter < n; iter++) {
    let u = -1, minD = Infinity;
    for (let i = 0; i < n; i++) {
      if (!visited[i] && best[i] < minD) { minD = best[i]; u = i; }
    }
    if (u === -1 || u === gId) break;
    visited[u] = 1;
    for (const e of adj[u]) {
      if (!visited[e.to] && best[u] + e.cost < best[e.to]) {
        best[e.to] = best[u] + e.cost;
        prev[e.to] = u;
      }
    }
  }

  if (!Number.isFinite(best[gId])) return null;

  const rawPts = [];
  let cur = gId;
  let usedRearCorridor = false;
  while (cur !== -1) {
    const nd = nodes[cur];
    if (robotType === 'RT' && nd.tag === 'rear' && start.y < LAYOUT.rearY - 0.2 && goal.y < LAYOUT.rearY - 0.2) {
      usedRearCorridor = true;
    }
    rawPts.push({x: nd.x, y: nd.y});
    cur = prev[cur];
  }
  rawPts.reverse();
  const points = dedupPoints(rawPts);
  let totalDist = 0;
  for (let i = 1; i < points.length; i++) totalDist += dist(points[i - 1], points[i]);

  // For CP, detect detour if obstacles existed and path distance exceeded obstacle-free shortest distance by > 0.5m
  let usedDetour = usedRearCorridor;
  if (!usedDetour && obstacles.length > 0) {
    const cleanRef = findCorridorPath(start, goal, robotType, {obstacles: [], blockedAisles: new Set(), allowRearDetour});
    if (cleanRef && totalDist > cleanRef.distance + 0.5) usedDetour = true;
  }

  return {points, usedDetour, distance: Number(totalDist.toFixed(3))};
}

// Pure-JS SHA-256 (FIPS 180-4) — identical output in Node.js CLI and browser Web Worker.
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

export function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const bitLen = bytes.length * 8;
  const padLen = ((bytes.length + 9 + 63) & ~63);
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(padLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map(v => v.toString(16).padStart(8, '0')).join('');
}
