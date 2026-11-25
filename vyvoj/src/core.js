/* WebTopo – jadro bez UI: protokoly prístrojov, merania, geometria, exporty/importy.
   Beží v prehliadači (window.WT) aj v Node (require) kvôli testom. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WT = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const COLORS = ['black', 'gray', 'brown', 'blue', 'red', 'green', 'orange'];
  const XVI_K = 100 / 2.54; // px na meter pri 1:100 a 100 dpi (rovnako ako import PocketTopo v xtherione)

  const norm360 = a => ((a % 360) + 360) % 360;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const pad2 = n => (n < 10 ? '0' : '') + n;
  function isoDate(ms) { const d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function fmt(v, n) {
    const f = Math.pow(10, n);
    let r = Math.round(v * f) / f;
    if (r === 0) r = 0; // bez "-0.00"
    return r.toFixed(n);
  }
  function fmtAz(a) { let s = fmt(norm360(a), 2); if (s === '360.00') s = '0.00'; return s; }

  // ============================== Prístroje ==============================
  const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';
  const NUS_SVC = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
  const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
  const UUID = {
    SPP: SPP_UUID, NUS_SVC, NUS_RX, NUS_TX,
    CC254X_SVC: '0000ffe0-0000-1000-8000-00805f9b34fb', CC254X_CHR: '0000ffe1-0000-1000-8000-00805f9b34fb',
    RN4870_SVC: '49535343-fe7d-4ae5-8fa9-9fafd205e455', RN4870_CHR: '49535343-1e4d-4bd9-ba61-23c647249616',
    SAP6_SVC: '137c4435-8a64-4bcb-93f1-3792c6bdc965', SAP6_CMD: '137c4435-8a64-4bcb-93f1-3792c6bdc967', SAP6_LEG: '137c4435-8a64-4bcb-93f1-3792c6bdc968',
    BRIC_MEAS: '000058d0-0000-1000-8000-00805f9b34fb', BRIC_PRIM: '000058d1-0000-1000-8000-00805f9b34fb',
    BRIC_META: '000058d2-0000-1000-8000-00805f9b34fb', BRIC_ERR: '000058d3-0000-1000-8000-00805f9b34fb',
    BRIC_CTRL: '000058e0-0000-1000-8000-00805f9b34fb', BRIC_CTRL_CHR: '000058e1-0000-1000-8000-00805f9b34fb'
  };
  const DISTOX_CMD = { laserOn: 0x36, laserOff: 0x37, shot: 0x38, off: 0x34, calibOn: 0x31, calibOff: 0x30, silentOn: 0x33, silentOff: 0x32 };
  const SAP6_CMD = { laserOn: 0x36, laserOff: 0x37, shot: 0x38, off: 0x34 };
  const BRIC_CMD = { shot: 'shot', laserOn: 'laser', laserOff: 'laser', off: 'power off' };

  // Potvrdenie paketu DistoX: 0x55 + sekvenčný bit prijatého paketu.
  const distoxAck = b0 => (b0 & 0x80) | 0x55;

  // 8-bajtový paket DistoX (DistoX2/X310, DistoX A3, SAP5, vnútri DistoX BLE).
  function decodeDistoX(p) {
    const t = p[0] & 0x3f;
    if (t === 0x01) {
      const raw = ((p[0] & 0x40) ? 0x10000 : 0) + (p[1] | (p[2] << 8));
      const d = raw <= 100000 ? raw / 1000 : 100 + (raw - 100000) / 100; // nad 100 m rozlíšenie cm (X310)
      const a = (p[3] | (p[4] << 8)) * 180 / 32768;
      const c = p[5] | (p[6] << 8);
      const i = (c >= 32768 ? c - 65536 : c) * 90 / 16384;
      return { type: 'shot', d, a: norm360(a), i, roll: p[7] * 180 / 128 };
    }
    if (t === 0x02 || t === 0x03) return { type: 'calib' };
    if (t === 0x04) return { type: 'vector', back: !!(p[0] & 0x40) };
    if (t === 0x38) return { type: 'reply' };
    return { type: 'unknown' };
  }

  // Prúd bajtov zo sériového spojenia → pakety po 8 bajtov, s potvrdením a odfiltrovaním opakovaní.
  class DistoXStream {
    constructor() { this.buf = []; this.last = null; }
    push(bytes) {
      const out = [];
      for (let k = 0; k < bytes.length; k++) this.buf.push(bytes[k] & 0xff);
      while (this.buf.length >= 8) {
        const t = this.buf[0] & 0x3f;
        if (t !== 1 && t !== 2 && t !== 3 && t !== 4 && t !== 0x38) { this.buf.shift(); continue; } // resynchronizácia
        const p = Uint8Array.from(this.buf.splice(0, 8));
        const dup = !!this.last && this.last.every((v, k) => v === p[k]);
        this.last = p;
        const msg = decodeDistoX(p);
        out.push({ p, msg, dup, ack: msg.type === 'reply' ? null : distoxAck(p[0]) });
      }
      return out;
    }
  }

  // DistoX BLE: zápis je rámcovaný "data:" + dĺžka + obsah + CRLF.
  function distoxBleFrame(bytes) {
    const out = new Uint8Array(8 + bytes.length);
    out.set([0x64, 0x61, 0x74, 0x61, 0x3a, bytes.length], 0);
    out.set(bytes, 6);
    out.set([0x0d, 0x0a], 6 + bytes.length);
    return out;
  }
  // Notifikácia DistoX BLE: [0x01 | 0x02][8 B paket][8 B vektor]
  function decodeDistoXBle(v) {
    if (v.length >= 9 && (v[0] === 0x01 || v[0] === 0x02)) {
      const p = v.slice(1, 9);
      return { kind: v[0] === 0x01 ? 'shot' : 'calib', p, msg: decodeDistoX(p), ack: distoxAck(p[0]) };
    }
    return { kind: 'other' };
  }
  // SAP6 / DiscoX (caveble): [seq u8][azimut f32][sklon f32][roll f32][dĺžka f32], little-endian; ACK = 0x55 + seq
  function decodeSap6(v) {
    if (v.length < 17) return null;
    const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
    const seq = v[0];
    return { seq, a: norm360(dv.getFloat32(1, true)), i: dv.getFloat32(5, true), roll: dv.getFloat32(9, true), d: dv.getFloat32(13, true), ack: 0x55 + (seq & 1) };
  }
  // BRIC4/BRIC5: tri charakteristiky v poradí – primárna (čas, dĺžka, azimut, sklon), metadáta (index), chyby.
  function decodeBricPrimary(v) {
    if (v.length < 20) return null;
    const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
    return { d: dv.getFloat32(8, true), a: norm360(dv.getFloat32(12, true)), i: dv.getFloat32(16, true),
      time: dv.getUint16(0, true) + '-' + pad2(v[2]) + '-' + pad2(v[3]) + ' ' + pad2(v[4]) + ':' + pad2(v[5]) + ':' + pad2(v[6]) };
  }
  function decodeBricMeta(v) {
    if (v.length < 4) return null;
    return { idx: new DataView(v.buffer, v.byteOffset, v.byteLength).getUint32(0, true) };
  }
  function decodeBricErr(v) { return { e1: v.length > 0 ? v[0] : 0, e2: v.length > 9 ? v[9] : 0 }; }
  const hex = u8 => Array.from(u8, b => (b < 16 ? '0' : '') + b.toString(16)).join(' ');

  // ============================== Prieskum ==============================
  function newSurvey(name) {
    const now = Date.now();
    return {
      v: 1, id: uid(), name: name || 'Prieskum', created: now, modified: now, date: isoDate(now),
      decl: 0, team: '', comment: '', fix: null,
      start: '1.0', cur: '1.0', next: '1.1', ext: 1,
      shots: [], sketch: { plan: [], elev: [] }, log: []
    };
  }
  function normalizeSurvey(s) {
    const n = newSurvey(s.name);
    const out = Object.assign(n, s);
    out.sketch = Object.assign({ plan: [], elev: [] }, s.sketch || {});
    out.shots = (s.shots || []).map(x => Object.assign({ id: uid(), from: '', to: '', d: 0, a: 0, i: 0, ext: 1, t: out.created, c: '' }, x));
    out.log = s.log || [];
    if (!out.next) out.next = suggestNext(out, out.cur);
    return out;
  }

  function stationNames(s) {
    const set = new Set();
    for (const sh of s.shots) { if (sh.from) set.add(sh.from); if (sh.to) set.add(sh.to); }
    return set;
  }
  function splitName(n) { const m = /^(.*?)(\d+)$/.exec(n); return m ? { pre: m[1], num: parseInt(m[2], 10), w: m[2].length } : null; }
  const padNum = (num, w) => { const t = String(num); return t.length >= w ? t : '0'.repeat(w - t.length) + t; };

  // Návrh názvu ďalšej stanice. Z poslednej stanice série pokračuje (1.3 → 1.4),
  // z inej stanice založí novú sériu (1.1 → 2.1), ak branch === 'series'.
  function suggestNext(s, cur, branch) {
    branch = branch || s.branch || 'series';
    cur = cur || s.cur || '1.0';
    const names = stationNames(s); names.add(cur);
    const p = splitName(cur);
    if (!p) { let k = 1; while (names.has(cur + k)) k++; return cur + k; }
    let max = -Infinity;
    for (const n of names) { const q = splitName(n); if (q && q.pre === p.pre) max = Math.max(max, q.num); }
    const nextIn = () => { let k = max + 1; while (names.has(p.pre + padNum(k, p.w))) k++; return p.pre + padNum(k, p.w); };
    if (p.num === max || branch !== 'series') return nextIn();
    const ms = /^(.*?)(\d+)\.$/.exec(p.pre);
    if (!ms) return nextIn();
    let maxS = -Infinity;
    for (const n of names) { const m = /^(.*?)(\d+)\.(\d+)$/.exec(n); if (m && m[1] === ms[1]) maxS = Math.max(maxS, +m[2]); }
    let sn = maxS + 1, cand = ms[1] + sn + '.1';
    while (names.has(cand)) { sn++; cand = ms[1] + sn + '.1'; }
    return cand;
  }
  function setCurrent(s, name) {
    s.cur = name;
    if (!s.shots.some(x => x.to)) s.start = name; // kým nie je ťah, aktuálna stanica je aj počiatok
    s.next = suggestNext(s, name);
  }

  function dirVec(a, i) { const ci = Math.cos(i * D2R); return [ci * Math.sin(a * D2R), ci * Math.cos(a * D2R), Math.sin(i * D2R)]; }
  function angleBetween(s1, s2) {
    const u = dirVec(s1.a, s1.i), v = dirVec(s2.a, s2.i);
    const dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
    return Math.acos(dot) * R2D;
  }
  const shotsClose = (s1, s2, tolD, tolA) => Math.abs(s1.d - s2.d) <= tolD && angleBetween(s1, s2) <= tolA;
  function averageShots(list) { // priemer smerových vektorov – funguje aj pri zvislých zámeroch a prechode cez sever
    let x = 0, y = 0, z = 0, d = 0;
    for (const s of list) { const u = dirVec(s.a, s.i); x += u[0]; y += u[1]; z += u[2]; d += s.d; }
    const n = Math.hypot(x, y, z) || 1;
    return { d: d / list.length, a: norm360(Math.atan2(x, y) * R2D), i: Math.asin(Math.max(-1, Math.min(1, z / n))) * R2D };
  }

  const DEFAULT_OPT = { tolD: 0.05, tolA: 1.7, legShots: 3 };

  // Nové meranie z prístroja: zapíše sa ako zámer z aktuálnej stanice; 3 zhodné po sebe = ťah.
  function addMeasurement(s, m, opt) {
    opt = Object.assign({}, DEFAULT_OPT, opt || {});
    const t = m.t || Date.now();
    s.log.push({ t, d: +fmt(m.d, 3), a: +fmt(m.a, 2), i: +fmt(m.i, 2), dev: m.dev || '' });
    s.modified = Date.now();
    const last = s.shots[s.shots.length - 1];
    // ďalšie opakovanie ťahu (napr. 4. meranie) sa pridá do priemeru ťahu, nie ako zámer
    if (last && last.to && last.raw && last.to === s.cur && t - last.t < 120000 &&
        shotsClose(last, m, opt.tolD, opt.tolA) && !m.manual) {
      last.raw.push([m.d, m.a, m.i]);
      Object.assign(last, averageShots(last.raw.map(r => ({ d: r[0], a: r[1], i: r[2] }))));
      last.t = t;
      return { kind: 'legplus', shot: last };
    }
    const shot = { id: uid(), from: s.cur, to: '', d: m.d, a: norm360(m.a), i: m.i, ext: s.ext, t, c: '' };
    if (m.manual) shot.manual = true;
    s.shots.push(shot);
    return detectLeg(s, opt) || { kind: 'splay', shot };
  }
  function detectLeg(s, opt) {
    const k = opt.legShots || 3, n = s.shots.length;
    if (k < 2 || n < k) return null;
    const grp = s.shots.slice(n - k);
    if (!grp.every(x => !x.to && x.from === s.cur && !x.manual)) return null;
    for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) if (!shotsClose(grp[a], grp[b], opt.tolD, opt.tolA)) return null;
    const av = averageShots(grp);
    const to = s.next && s.next !== s.cur ? s.next : suggestNext(s, s.cur);
    const leg = { id: uid(), from: s.cur, to, d: av.d, a: av.a, i: av.i, ext: s.ext, t: grp[k - 1].t, c: '', raw: grp.map(x => [x.d, x.a, x.i]) };
    s.shots.splice(n - k, k, leg);
    setCurrent(s, to);
    return { kind: 'leg', shot: leg };
  }

  const findShot = (s, id) => s.shots.findIndex(x => x.id === id);
  const stationUsed = (s, name) => s.shots.some(x => x.from === name || x.to === name);

  function deleteShot(s, id) {
    const k = findShot(s, id); if (k < 0) return null;
    const [sh] = s.shots.splice(k, 1);
    if (sh.to && (s.cur === sh.to || s.cur === sh.from) && !stationUsed(s, s.cur)) setCurrent(s, s.cur === sh.to ? sh.from : sh.to);
    else s.next = suggestNext(s, s.cur);
    s.modified = Date.now();
    return sh;
  }
  function reverseShot(s, id) { // spätný zámer: prehodiť Od/Do, namerané hodnoty ostávajú
    const sh = s.shots[findShot(s, id)]; if (!sh || !sh.to) return;
    [sh.from, sh.to] = [sh.to, sh.from]; s.modified = Date.now();
  }
  function toggleExt(s, id) {
    const sh = s.shots[findShot(s, id)]; if (!sh) return;
    sh.ext = sh.ext >= 0 ? -1 : 1;
    const legs = s.shots.filter(x => x.to);
    if (legs.length && legs[legs.length - 1] === sh) s.ext = sh.ext;
    s.modified = Date.now();
  }
  function splitLeg(s, id) { // ťah späť na pôvodné zámery
    const k = findShot(s, id); const sh = s.shots[k];
    if (!sh || !sh.to || !sh.raw) return;
    const parts = sh.raw.map(r => ({ id: uid(), from: sh.from, to: '', d: r[0], a: r[1], i: r[2], ext: sh.ext, t: sh.t, c: '' }));
    s.shots.splice(k, 1, ...parts);
    if (s.cur === sh.to && !stationUsed(s, sh.to)) setCurrent(s, sh.from);
    s.modified = Date.now();
  }
  function makeLeg(s, id, to) { // zámer → ťah
    const sh = s.shots[findShot(s, id)]; if (!sh || sh.to) return;
    to = to || (sh.from === s.cur ? s.next : suggestNext(s, sh.from));
    sh.to = to;
    if (sh.from === s.cur) setCurrent(s, to); else s.next = suggestNext(s, s.cur);
    s.modified = Date.now();
  }
  function renameStation(s, from, to) {
    if (!from || !to || from === to) return 0;
    let n = 0;
    for (const sh of s.shots) { if (sh.from === from) { sh.from = to; n++; } if (sh.to === from) { sh.to = to; n++; } }
    for (const k of ['start', 'cur', 'next']) if (s[k] === from) s[k] = to;
    for (const p of ['plan', 'elev']) for (const st of s.sketch[p]) if (st.anc === from) st.anc = to;
    if (s.fix && s.fix.st === from) s.fix.st = to;
    s.modified = Date.now();
    return n;
  }

  function stats(s) {
    let legs = 0, splays = 0, len = 0;
    for (const sh of s.shots) { if (sh.to) { legs++; len += sh.d; } else splays++; }
    return { legs, splays, len };
  }

  // ============================== Geometria ==============================
  // Polohy staníc v pôdoryse (x = východ, y = sever, z) a v rozvinutom reze (ex = rozvinutá vzdialenosť).
  function compute(s) {
    const decl = +s.decl || 0;
    const legs = [], splays = [];
    for (const sh of s.shots) (sh.to ? legs : splays).push(sh);
    const adj = new Map();
    const link = (n, e) => { if (!adj.has(n)) adj.set(n, []); adj.get(n).push(e); };
    for (const L of legs) { link(L.from, { L, fwd: true }); link(L.to, { L, fwd: false }); }
    const vec = sh => {
      const h = sh.d * Math.cos(sh.i * D2R), az = (sh.a + decl) * D2R;
      return { h, dx: h * Math.sin(az), dy: h * Math.cos(az), dz: sh.d * Math.sin(sh.i * D2R) };
    };
    const pos = new Map();
    const starts = [s.start].concat(legs.map(L => L.from), splays.map(S => S.from));
    let comp = 0;
    for (const st of starts) {
      if (!st || pos.has(st)) continue;
      if (!adj.has(st) && !splays.some(S => S.from === st) && st !== s.start) continue;
      pos.set(st, { x: 0, y: 0, z: 0, ex: 0, comp });
      const q = [st];
      while (q.length) {
        const n = q.shift(), P = pos.get(n);
        for (const { L, fwd } of adj.get(n) || []) {
          const o = fwd ? L.to : L.from;
          if (pos.has(o)) continue;
          const v = vec(L), sg = fwd ? 1 : -1, e = L.ext >= 0 ? 1 : -1;
          pos.set(o, { x: P.x + sg * v.dx, y: P.y + sg * v.dy, z: P.z + sg * v.dz, ex: P.ex + sg * e * v.h, comp });
          q.push(o);
        }
      }
      comp++;
    }
    const segs = [];
    for (const L of legs) {
      const A = pos.get(L.from), B = pos.get(L.to);
      if (A && B) segs.push({ kind: 'leg', id: L.id, from: L.from, to: L.to, p: [A.x, A.y, B.x, B.y], e: [A.ex, A.z, B.ex, B.z] });
    }
    for (const S of splays) {
      const A = pos.get(S.from); if (!A) continue;
      const v = vec(S);
      // v reze sa zámer premieta na najrovnobežnejší ťah na stanici (so znamienkom jeho extend)
      let best = null;
      for (const { L } of adj.get(S.from) || []) {
        if (L.d * Math.cos(L.i * D2R) < 0.05) continue;
        const c = Math.cos((S.a - L.a) * D2R);
        if (!best || Math.abs(c) > Math.abs(best.c)) best = { c, e: L.ext >= 0 ? 1 : -1 };
      }
      const dex = best ? best.e * v.h * best.c : (S.ext >= 0 ? 1 : -1) * v.h;
      segs.push({ kind: 'splay', id: S.id, from: S.from, p: [A.x, A.y, A.x + v.dx, A.y + v.dy], e: [A.ex, A.z, A.ex + dex, A.z + v.dz] });
    }
    return { pos, segs };
  }
  const projXY = (P, proj) => (proj === 'plan' ? [P.x, P.y] : [P.ex, P.z]);

  // Ťahy náčrtu sú ukotvené k najbližšej stanici – pri oprave dát sa posúvajú so stanicou.
  function makeStroke(abs, col, geo, proj, width) {
    let bx = 0, by = 0; const n = abs.length / 2;
    for (let k = 0; k < abs.length; k += 2) { bx += abs[k]; by += abs[k + 1]; }
    bx /= n; by /= n;
    let anc = null, best = Infinity, o = [0, 0];
    for (const [name, P] of geo.pos) {
      const q = projXY(P, proj), dd = (q[0] - bx) ** 2 + (q[1] - by) ** 2;
      if (dd < best) { best = dd; anc = name; o = q; }
    }
    const pts = abs.map((v, k) => +(v - o[k & 1]).toFixed(3));
    const st = { id: uid(), col, anc, o: [+o[0].toFixed(3), +o[1].toFixed(3)], pts };
    if (width) st.w = width;
    return st;
  }
  function strokeAbs(st, geo, proj) {
    let o = st.o || [0, 0];
    if (st.anc && geo.pos.has(st.anc)) o = projXY(geo.pos.get(st.anc), proj);
    return st.pts.map((v, k) => v + o[k & 1]);
  }

  // ============================== Exporty ==============================
  function dateGroups(s) {
    const groups = [];
    for (const sh of s.shots) {
      const dt = isoDate(sh.t || s.created);
      let g = groups[groups.length - 1];
      if (!g || g.date !== dt) groups.push(g = { date: dt, shots: [] });
      g.shots.push(sh);
    }
    return groups;
  }
  const cleanComment = c => String(c || '').replace(/[\r\n]+/g, ' ').trim();

  function toTherion(s) {
    const L = ['encoding  utf-8', '# ' + s.name + ' – export WebTopo ' + isoDate(Date.now())];
    if (s.comment) L.push('# ' + cleanComment(s.comment));
    if (s.fix && s.fix.st) {
      L.push('', 'centreline', '  fix ' + s.fix.st + ' ' + s.fix.x + ' ' + s.fix.y + ' ' + s.fix.z, 'endcentreline');
    }
    for (const g of dateGroups(s)) {
      L.push('', 'centreline', '  date ' + g.date.replace(/-/g, '.'));
      for (const p of String(s.team || '').split(/[,;]+/)) if (p.trim()) L.push('  team "' + p.trim().replace(/"/g, '') + '"');
      if (+s.decl) L.push('  declination ' + fmt(+s.decl, 2) + ' degrees');
      L.push('  data normal from to length compass clino');
      let ext = 0;
      for (const sh of g.shots) {
        if (sh.to) {
          const e = sh.ext >= 0 ? 1 : -1;
          if (e !== ext) { L.push('  extend ' + (e > 0 ? 'right' : 'left')); ext = e; }
        }
        const c = cleanComment(sh.c);
        L.push('  ' + sh.from + ' ' + (sh.to || '-') + ' ' + fmt(sh.d, 3) + ' ' + fmtAz(sh.a) + ' ' + fmt(sh.i, 2) + (c ? '  # ' + c : ''));
      }
      L.push('endcentreline');
    }
    return L.join('\n') + '\n';
  }

  // Rovnaký formát ako "Export Therion" z PocketTopo (xtherion ho vie importovať do .th aj .xvi).
  function toPocketTopo(s) {
    const geo = compute(s), L = [];
    if (s.fix && s.fix.st) L.push('FIX', [s.fix.st, fmt(+s.fix.x, 3), fmt(+s.fix.y, 3), fmt(+s.fix.z, 3)].join('\t'));
    for (const g of dateGroups(s)) {
      L.push('TRIP', 'DATE ' + g.date + ' ', 'DECLINATION     ' + fmt(+s.decl || 0, 2), 'DATA');
      for (const sh of g.shots) L.push([sh.from, sh.to || '', fmtAz(sh.a), fmt(sh.i, 2), fmt(sh.d, 3), sh.ext >= 0 ? '>' : '<'].join('\t'));
      L.push('');
    }
    for (const [title, proj, key] of [['PLAN', 'plan', 'p'], ['ELEVATION', 'elev', 'e']]) {
      L.push(title, 'STATIONS');
      for (const [n, P] of geo.pos) { const q = projXY(P, proj); L.push(fmt(q[0], 3) + '\t' + fmt(q[1], 3) + '\t' + n); }
      L.push('SHOTS');
      for (const sg of geo.segs) L.push(sg[key].map(v => fmt(v, 3)).join('\t'));
      for (const st of s.sketch[proj]) {
        const a = strokeAbs(st, geo, proj);
        L.push('POLYLINE ' + String(st.col || 'black').toUpperCase());
        for (let k = 0; k < a.length; k += 2) L.push(fmt(a[k], 3) + '\t' + fmt(a[k + 1], 3));
      }
    }
    return L.join('\r\n') + '\r\n';
  }

  function xviGrid(geo, s, proj) {
    let minX = 0, minY = 0, maxX = 0, maxY = 0, first = true;
    const see = (x, y) => {
      if (first) { minX = maxX = x; minY = maxY = y; first = false; return; }
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    };
    for (const [, P] of geo.pos) { const q = projXY(P, proj); see(q[0], q[1]); }
    for (const sg of geo.segs) { const c = sg[proj === 'plan' ? 'p' : 'e']; see(c[0], c[1]); see(c[2], c[3]); }
    for (const st of s.sketch[proj]) { const a = strokeAbs(st, geo, proj); for (let k = 0; k < a.length; k += 2) see(a[k], a[k + 1]); }
    const x0 = Math.floor(minX) - 1, y0 = Math.floor(minY) - 1;
    const nx = Math.ceil(maxX) + 1 - x0, ny = Math.ceil(maxY) + 1 - y0;
    return { x0: x0 * XVI_K, y0: y0 * XVI_K, nx, ny, g: XVI_K };
  }
  function toXVI(s, proj) {
    const geo = compute(s), k = XVI_K, key = proj === 'plan' ? 'p' : 'e';
    const f = v => fmt(v * k, 2);
    const L = ['set XVIgrids {1.0 m}', 'set XVIstations {'];
    for (const [n, P] of geo.pos) { const q = projXY(P, proj); L.push('  {' + f(q[0]) + ' ' + f(q[1]) + ' ' + n + '}'); }
    L.push('}', 'set XVIshots {');
    for (const sg of geo.segs) L.push('  {' + sg[key].map(f).join(' ') + '}');
    L.push('}', 'set XVIsketchlines {');
    for (const st of s.sketch[proj]) {
      const a = strokeAbs(st, geo, proj);
      if (a.length < 4) continue;
      const pts = []; for (let j = 0; j < a.length; j += 2) pts.push(f(a[j]) + ' ' + f(a[j + 1]));
      L.push('  {' + (st.col || 'black') + '  ' + pts.join('  ') + '}');
    }
    const g = xviGrid(geo, s, proj);
    L.push('}', 'set XVIgrid {' + [fmt(g.x0, 2), fmt(g.y0, 2), fmt(g.g, 4), '0.0', '0.0', fmt(g.g, 4), g.nx, g.ny].join(' ') + '}');
    return L.join('\n') + '\n';
  }
  // .th2 so vloženým .xvi podkladom a bodmi staníc na správnych miestach (pre xtherion).
  function toTh2(s, proj, xviName, scrapName) {
    const geo = compute(s), k = XVI_K, g = xviGrid(geo, s, proj);
    const W = g.nx * g.g, H = g.ny * g.g;
    const L = ['encoding  utf-8',
      '##XTHERION## xth_me_area_adjust -128 -128 ' + fmt(W + 128, 2) + ' ' + fmt(H + 128, 2),
      '##XTHERION## xth_me_area_zoom_to 100'];
    const first = geo.pos.keys().next();
    if (!first.done) {
      const q = projXY(geo.pos.get(first.value), proj);
      L.push('##XTHERION## xth_me_image_insert {' + fmt(q[0] * k - g.x0, 2) + ' 1 1.0} {' + fmt(q[1] * k - g.y0, 2) + ' ' + first.value + '} ' + xviName + ' 0 {}');
    }
    L.push('', '', 'scrap ' + scrapName + ' -projection ' + (proj === 'plan' ? 'plan' : 'extended'));
    for (const [n, P] of geo.pos) {
      const q = projXY(P, proj);
      L.push('  point ' + fmt(q[0] * k - g.x0, 2) + ' ' + fmt(q[1] * k - g.y0, 2) + ' station -name ' + n);
    }
    L.push('endscrap', '');
    return L.join('\n');
  }

  function safeName(n) {
    return String(n || 'prieskum').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'prieskum';
  }
  function therionBundle(s) {
    const b = safeName(s.name);
    return [
      { name: b + '.th', text: toTherion(s) },
      { name: b + '_p.xvi', text: toXVI(s, 'plan') },
      { name: b + '_e.xvi', text: toXVI(s, 'elev') },
      { name: b + '_p.th2', text: toTh2(s, 'plan', b + '_p.xvi', b + '_p') },
      { name: b + '_e.th2', text: toTh2(s, 'elev', b + '_e.xvi', b + '_e') },
      { name: b + '_pockettopo.txt', text: toPocketTopo(s) },
      { name: b + '.webtopo.json', text: JSON.stringify(s) }
    ];
  }

  // ============================== Importy ==============================
  function fromPocketTopo(text, name) {
    const s = newSurvey(name || 'Import PocketTopo');
    const lines = String(text).split(/\r?\n/);
    let sec = null, sub = null, inData = false, stroke = null, date = s.date, first = true;
    const raw = { plan: [], elev: [] };
    for (const line of lines) {
      const ln = line.trim();
      if (ln === 'FIX' || ln === 'TRIP' || ln === 'PLAN' || ln === 'ELEVATION') { sec = ln; sub = null; inData = false; stroke = null; continue; }
      if (!ln) continue;
      if (sec === 'FIX') {
        const f = ln.split(/\s+/);
        if (f.length >= 4) s.fix = { st: f[0], x: +f[1], y: +f[2], z: +f[3] };
      } else if (sec === 'TRIP') {
        if (inData) {
          let f = line.split('\t').map(x => x.trim());
          if (f.length < 5) { const w = ln.split(/\s+/); f = w.length === 5 ? [w[0], ''].concat(w.slice(1)) : w; }
          if (f.length < 5) continue;
          const t = Date.parse(date + 'T12:00:00');
          const sh = { id: uid(), from: f[0], to: f[1], a: norm360(+f[2]), i: +f[3], d: +f[4], ext: f[5] === '<' ? -1 : 1, t: isNaN(t) ? s.created : t, c: '' };
          if (first) { s.start = sh.from; first = false; }
          s.shots.push(sh);
        } else if (/^DATE/.test(ln)) { date = ln.slice(4).trim(); if (s.shots.length === 0) s.date = date; }
        else if (/^DECLINATION/.test(ln)) s.decl = parseFloat(ln.slice(11)) || 0;
        else if (ln === 'DATA') inData = true;
      } else if (sec === 'PLAN' || sec === 'ELEVATION') {
        const proj = sec === 'PLAN' ? 'plan' : 'elev';
        if (ln === 'STATIONS' || ln === 'SHOTS') { sub = ln; stroke = null; continue; }
        if (/^POLYLINE/.test(ln)) {
          sub = 'POLY';
          let col = (ln.split(/\s+/)[1] || 'black').toLowerCase();
          if (col === 'grey') col = 'gray';
          if (COLORS.indexOf(col) < 0) col = 'black';
          stroke = { col, abs: [] }; raw[proj].push(stroke); continue;
        }
        if (sub === 'POLY' && stroke) { const w = ln.split(/\s+/); if (w.length >= 2) stroke.abs.push(+w[0], +w[1]); }
      }
    }
    const legs = s.shots.filter(x => x.to);
    if (legs.length) { s.cur = legs[legs.length - 1].to; s.ext = legs[legs.length - 1].ext; } else if (s.shots.length) s.cur = s.shots[s.shots.length - 1].from;
    s.next = suggestNext(s, s.cur);
    const geo = compute(s);
    for (const proj of ['plan', 'elev']) for (const st of raw[proj]) if (st.abs.length >= 2) s.sketch[proj].push(makeStroke(st.abs, st.col, geo, proj));
    return s;
  }
  function fromJSON(text) {
    const o = JSON.parse(text);
    if (!o || !Array.isArray(o.shots)) throw new Error('Súbor nie je záloha WebTopo');
    return normalizeSurvey(o);
  }

  // ============================== ZIP (bez kompresie) ==============================
  const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zip(files, when) { // files: [{name, text|data}]
    const enc = new TextEncoder(), d = new Date(when || Date.now());
    const dtime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const ddate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = [], central = []; let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = f.data || enc.encode(f.text || ''), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dtime, true); h.setUint16(12, ddate, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, dtime, true); c.setUint16(14, ddate, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + data.length;
    }
    const csize = central.reduce((n, p) => n + p.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, csize, true); e.setUint32(16, off, true);
    const all = parts.concat(central, [new Uint8Array(e.buffer)]);
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of all) { out.set(p, o); o += p.length; }
    return out;
  }

  // ============================== Simulátor ==============================
  // Vytvára realistické merania: na každej stanici niekoľko zámerov a potom 3 takmer zhodné merania ťahu.
  class Simulator {
    constructor(seed) { this.seed = seed || 12345; this.queue = []; this.az = 40; this.step = 0; }
    rnd() { this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff; return this.seed / 0x7fffffff; }
    plan() {
      const r = () => this.rnd();
      const ns = 3 + Math.floor(r() * 3);
      for (let k = 0; k < ns; k++) this.queue.push({ d: 0.4 + r() * 3, a: norm360(this.az + 90 * (k % 2 ? 1 : -1) + (r() - 0.5) * 60), i: (r() - 0.5) * 60 });
      if (r() < 0.6) this.queue.push({ d: 0.3 + r() * 2, a: r() * 360, i: 70 + r() * 18 });
      this.az = norm360(this.az + (r() - 0.5) * 70);
      const leg = { d: 2 + r() * 6, a: this.az, i: (r() - 0.5) * 40 };
      for (let k = 0; k < 3; k++) this.queue.push({ d: leg.d + (r() - 0.5) * 0.02, a: norm360(leg.a + (r() - 0.5) * 0.6), i: leg.i + (r() - 0.5) * 0.6 });
    }
    next() { if (!this.queue.length) this.plan(); const m = this.queue.shift(); return { d: +m.d.toFixed(3), a: +m.a.toFixed(2), i: +m.i.toFixed(2) }; }
  }

  return {
    D2R, COLORS, UUID, DISTOX_CMD, SAP6_CMD, BRIC_CMD, XVI_K,
    norm360, uid, isoDate, fmt, fmtAz, hex,
    distoxAck, decodeDistoX, DistoXStream, distoxBleFrame, decodeDistoXBle, decodeSap6, decodeBricPrimary, decodeBricMeta, decodeBricErr,
    newSurvey, normalizeSurvey, stationNames, suggestNext, setCurrent, angleBetween, shotsClose, averageShots,
    addMeasurement, detectLeg, deleteShot, reverseShot, toggleExt, splitLeg, makeLeg, renameStation, stats,
    compute, projXY, makeStroke, strokeAbs,
    toTherion, toPocketTopo, toXVI, toTh2, therionBundle, safeName, fromPocketTopo, fromJSON, crc32, zip, Simulator
  };
});
