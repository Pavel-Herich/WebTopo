// Testy jadra WebTopo: node test/core.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const WT = require('../src/core.js');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok  ' + name); };
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, (msg || '') + ` ${a} != ${b} (±${tol})`);
const u8 = arr => Uint8Array.from(arr.map(x => x & 0xff));

ok('DistoX paket: vodorovný zámer (test SexyTopo)', () => {
  const m = WT.decodeDistoX(u8([1, -31, 7, -94, 50, 58, 3, -5]));
  assert.strictEqual(m.type, 'shot');
  near(m.d, 2.017, 0.0005); near(m.a, 71.2, 0.05); near(m.i, 4.5, 0.05);
});
ok('DistoX paket: strmý zámer nadol (test SexyTopo)', () => {
  const m = WT.decodeDistoX(u8([1, 84, 3, 113, -87, -83, -54, -13]));
  near(m.d, 0.852, 0.0005); near(m.a, 238.3, 0.05); near(m.i, -75.0, 0.05);
});
ok('DistoX paket: 17. bit dĺžky (> 65.535 m)', () => {
  const raw = 70123; // mm
  const p = u8([0x41, raw & 0xff, (raw >> 8) & 0xff, 0, 0, 0, 0, 0]);
  near(WT.decodeDistoX(p).d, 70.123, 1e-9);
});
ok('ACK = 0x55 so sekvenčným bitom', () => {
  assert.strictEqual(WT.distoxAck(0x01), 0x55);
  assert.strictEqual(WT.distoxAck(0x81), 0xd5);
});
ok('Prúd: delenie na pakety, opakovanie, resynchronizácia', () => {
  const st = new WT.DistoXStream();
  const a = [1, -31, 7, -94, 50, 58, 3, -5], b = [0x81, 84, 3, 113, -87, -83, -54, -13];
  let r = st.push(u8([0x00, 0x3f].concat(a.slice(0, 5)))); // smetie na začiatku + polovica paketu
  assert.strictEqual(r.length, 0);
  r = st.push(u8(a.slice(5).concat(a, b)));
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[0].dup, false); assert.strictEqual(r[1].dup, true); assert.strictEqual(r[2].dup, false);
  assert.strictEqual(r[2].ack, 0xd5);
});
ok('DistoX BLE: rámec zápisu a notifikácia', () => {
  const f = WT.distoxBleFrame([0x55]);
  assert.deepStrictEqual(Array.from(f), [0x64, 0x61, 0x74, 0x61, 0x3a, 1, 0x55, 0x0d, 0x0a]);
  const v = u8([1, 1, -31, 7, -94, 50, 58, 3, -5, 4, 0, 0, 0, 0, 0, 0, 0]);
  const m = WT.decodeDistoXBle(v);
  assert.strictEqual(m.kind, 'shot'); near(m.msg.d, 2.017, 0.0005); assert.strictEqual(m.ack, 0x55);
});
ok('SAP6: float32 little-endian a ACK', () => {
  const buf = new ArrayBuffer(17), dv = new DataView(buf);
  dv.setUint8(0, 1); dv.setFloat32(1, 123.5, true); dv.setFloat32(5, -12.25, true); dv.setFloat32(9, 0, true); dv.setFloat32(13, 4.567, true);
  const m = WT.decodeSap6(new Uint8Array(buf));
  near(m.a, 123.5, 1e-4); near(m.i, -12.25, 1e-4); near(m.d, 4.567, 1e-4); assert.strictEqual(m.ack, 0x56);
});
ok('BRIC: primárna charakteristika', () => {
  const buf = new ArrayBuffer(20), dv = new DataView(buf);
  dv.setUint16(0, 2026, true); dv.setUint8(2, 11); dv.setUint8(3, 25);
  dv.setFloat32(8, 3.21, true); dv.setFloat32(12, 359.9, true); dv.setFloat32(16, 45, true);
  const m = WT.decodeBricPrimary(new Uint8Array(buf));
  near(m.d, 3.21, 1e-5); near(m.a, 359.9, 1e-4); near(m.i, 45, 1e-5);
});

ok('Ťah z 3 zhodných meraní + číslovanie staníc', () => {
  const s = WT.newSurvey('t');
  WT.addMeasurement(s, { d: 1.2, a: 90, i: 0 });
  WT.addMeasurement(s, { d: 0.8, a: 270, i: 5 });
  let r = WT.addMeasurement(s, { d: 5.00, a: 10.0, i: -3.0 });
  assert.strictEqual(r.kind, 'splay');
  WT.addMeasurement(s, { d: 5.02, a: 10.5, i: -3.3 });
  r = WT.addMeasurement(s, { d: 4.99, a: 9.6, i: -2.8 });
  assert.strictEqual(r.kind, 'leg');
  assert.strictEqual(r.shot.from, '1'); assert.strictEqual(r.shot.to, '2');
  near(r.shot.d, 5.003, 0.001); near(r.shot.a, 10.03, 0.05);
  assert.strictEqual(s.cur, '2'); assert.strictEqual(s.next, '3');
  assert.strictEqual(s.shots.length, 3); // 2 zámery + ťah
  // 4. opakovanie sa pripojí k ťahu
  r = WT.addMeasurement(s, { d: 5.01, a: 10.2, i: -3.1 });
  assert.strictEqual(r.kind, 'legplus'); assert.strictEqual(r.shot.raw.length, 4);
  // nezhodné merania ťah nevytvoria
  WT.addMeasurement(s, { d: 3, a: 100, i: 0 }); WT.addMeasurement(s, { d: 3.2, a: 100, i: 0 });
  r = WT.addMeasurement(s, { d: 3, a: 100, i: 0 });
  assert.strictEqual(r.kind, 'splay');
});
ok('Ťah cez sever (359°/1°) a zvislý ťah', () => {
  const s = WT.newSurvey('t');
  WT.addMeasurement(s, { d: 3, a: 359.6, i: 0 }); WT.addMeasurement(s, { d: 3, a: 0.4, i: 0 });
  const r = WT.addMeasurement(s, { d: 3.01, a: 0.0, i: 0.2 });
  assert.strictEqual(r.kind, 'leg'); assert(r.shot.a < 0.5 || r.shot.a > 359.5);
  WT.addMeasurement(s, { d: 10, a: 10, i: -89.6 }); WT.addMeasurement(s, { d: 10.02, a: 200, i: -89.5 });
  const r2 = WT.addMeasurement(s, { d: 10.01, a: 120, i: -89.7 });
  assert.strictEqual(r2.kind, 'leg', 'zvislé merania s rôznym azimutom sú zhodné');
});
ok('Predvolene čísla 1, 2, 3…; odbočka pokračuje ďalším voľným číslom', () => {
  const s = WT.newSurvey('t');
  assert.strictEqual(s.cur, '1'); assert.strictEqual(s.next, '2');
  for (const leg of [[5, 10, 0], [4, 50, 0], [3, 90, 0]]) for (let k = 0; k < 3; k++) WT.addMeasurement(s, { d: leg[0], a: leg[1], i: leg[2] });
  assert.deepStrictEqual(s.shots.map(x => x.from + '>' + x.to), ['1>2', '2>3', '3>4']);
  WT.setCurrent(s, '2');
  assert.strictEqual(s.next, '5');
});
ok('Odbočka zo staršej stanice = nová séria; pokračovanie série', () => {
  const s = WT.newSurvey('t');
  WT.setCurrent(s, '1.0');
  for (const leg of [[5, 10, 0], [4, 50, 0], [3, 90, 0]]) for (let k = 0; k < 3; k++) WT.addMeasurement(s, { d: leg[0], a: leg[1], i: leg[2] });
  assert.strictEqual(s.cur, '1.3');
  WT.setCurrent(s, '1.1');
  assert.strictEqual(s.next, '2.1');
  assert.strictEqual(WT.suggestNext(s, '1.3'), '1.4');
  assert.strictEqual(WT.suggestNext(s, 'A09'), 'A10');
});
ok('Mazanie, otočenie, rozdelenie ťahu, premenovanie', () => {
  const s = WT.newSurvey('t');
  for (let k = 0; k < 3; k++) WT.addMeasurement(s, { d: 5, a: 10, i: 0 });
  const leg = s.shots[0];
  WT.splitLeg(s, leg.id);
  assert.strictEqual(s.shots.length, 3); assert.strictEqual(s.cur, '1');
  WT.makeLeg(s, s.shots[2].id);
  assert.strictEqual(s.shots[2].to, '2'); assert.strictEqual(s.cur, '2');
  WT.reverseShot(s, s.shots[2].id);
  assert.strictEqual(s.shots[2].from, '2');
  WT.renameStation(s, '2', 'X1');
  assert.strictEqual(s.shots[2].from, 'X1'); assert.strictEqual(s.cur, 'X1');
  WT.deleteShot(s, s.shots[2].id);
  assert.strictEqual(s.cur, '1');
});

// ---------- porovnanie so vzorovým exportom PocketTopo z testov Therionu ----------
const demoDir = '/home/claude/ext/therion/samples/tests/pocket-topo';
const demoTxt = fs.readFileSync(path.join(demoDir, 'Demo.txt'), 'utf8');
const demo = WT.fromPocketTopo(demoTxt, 'Demo');

function ptStations(txt, section) {
  const L = txt.split(/\r?\n/); const i = L.indexOf(section); const out = {};
  let inSt = false;
  for (let k = i + 1; k < L.length; k++) {
    if (L[k] === 'STATIONS') { inSt = true; continue; }
    if (L[k] === 'SHOTS' || L[k] === 'PLAN' || L[k] === 'ELEVATION') break;
    if (inSt) { const f = L[k].split('\t'); out[f[2]] = [+f[0], +f[1]]; }
  }
  return out;
}
ok('Import PocketTopo .txt: počty ťahov, zámerov a náčrtov', () => {
  const st = WT.stats(demo);
  assert.strictEqual(st.legs, 10); assert.strictEqual(st.splays, 41);
  assert.strictEqual(demo.sketch.plan.length + demo.sketch.elev.length, 399);
  assert.strictEqual(demo.start, '503.0'); assert.strictEqual(demo.cur, '504.6');
});
ok('Geometria = PocketTopo (pôdorys aj rozvinutý rez staníc)', () => {
  const geo = WT.compute(demo);
  const plan = ptStations(demoTxt, 'PLAN'), elev = ptStations(demoTxt, 'ELEVATION');
  let maxP = 0, maxE = 0;
  for (const nme of Object.keys(plan)) {
    const P = geo.pos.get(nme);
    maxP = Math.max(maxP, Math.hypot(P.x - plan[nme][0], P.y - plan[nme][1]));
    maxE = Math.max(maxE, Math.hypot(P.ex - elev[nme][0], P.z - elev[nme][1]));
  }
  console.log('     max. odchýlka staníc: pôdorys ' + maxP.toFixed(3) + ' m, rez ' + maxE.toFixed(3) + ' m');
  assert(maxP < 0.05 && maxE < 0.05);
});
ok('Náčrt po importe sedí na pôvodných súradniciach', () => {
  const geo = WT.compute(demo);
  const L = demoTxt.split(/\r?\n/); const k = L.indexOf('POLYLINE BLUE');
  const a = WT.strokeAbs(demo.sketch.plan[0], geo, 'plan');
  near(a[0], +L[k + 1].split('\t')[0], 0.03); near(a[1], +L[k + 1].split('\t')[1], 0.03);
});
ok('Export .th = to isté ako demo.th z Therionu (rovnaké zámery, ťahy, extend)', () => {
  const th = WT.toTherion(demo);
  const mine = th.split('\n').map(x => x.trim()).filter(x => /^\S+ \S+ [-\d.]+ [-\d.]+ [-\d.]+/.test(x) && !/^(date|data|team|declination|fix)/.test(x))
    .map(x => { const f = x.split(/\s+/); return [f[0], f[1], (+f[3]).toFixed(2), (+f[4]).toFixed(2), (+f[2]).toFixed(3)].join(' '); });
  const ref = fs.readFileSync(path.join(demoDir, 'demo.th'), 'utf8').split('\n').map(x => x.trim())
    .filter(x => /^\d/.test(x)).map(x => { const f = x.split(/\s+/); return [f[0], f[1], (+f[2]).toFixed(2), (+f[3]).toFixed(2), (+f[4]).toFixed(3)].join(' '); });
  assert.deepStrictEqual(mine, ref.filter(x => !x.startsWith('503.0 600123')));
  const ext = th.split('\n').filter(x => /extend/.test(x)).map(x => x.trim());
  assert.deepStrictEqual(ext, ['extend left', 'extend right']);
  assert(/fix 503\.0 600123 200456 777\.77/.test(th));
});
ok('Export PocketTopo .txt → import → rovnaké dáta (round-trip)', () => {
  const txt = WT.toPocketTopo(demo);
  const again = WT.fromPocketTopo(txt, 'x');
  assert.strictEqual(again.shots.length, demo.shots.length);
  for (let k = 0; k < demo.shots.length; k++) {
    const a = demo.shots[k], b = again.shots[k];
    assert.strictEqual(a.from + a.to, b.from + b.to); near(a.d, b.d, 0.0005); near(a.a, b.a, 0.005); assert.strictEqual(a.ext, b.ext);
  }
  assert.strictEqual(again.sketch.plan.length, demo.sketch.plan.length);
});
ok('XVI pôdorys: stanice v mierke ako z xtherionu', () => {
  const xvi = WT.toXVI(demo, 'plan');
  const ref = fs.readFileSync(path.join(demoDir, 'Demo_p.xvi'), 'utf8');
  const grab = t => { const m = {}; const blk = t.split('set XVIstations {')[1].split('}\nset')[0]; for (const r of blk.matchAll(/\{([-\d.]+) ([-\d.]+) (\S+)\}/g)) m[r[3]] = [+r[1], +r[2]]; return m; };
  const a = grab(xvi), b = grab(ref);
  // vzor z xtherionu je v 39,37 jednotkách na meter, náš export v 78,74 (ako PocketTopo podklad v PreTherione)
  for (const k of Object.keys(b)) { near(a[k][0] / 2, b[k][0], 2.0, k); near(a[k][1] / 2, b[k][1], 2.0, k); }
  assert(/set XVIsketchlines \{\n  \{blue  /.test(xvi));
  assert(/set XVIgrid \{/.test(xvi));
});
ok('th2: mierka v hlavičke scrapu (10 m = 787,402 jednotky)', () => {
  const p = WT.toTh2(demo, 'plan', 'Demo_p.xvi', 'Demo_p'), e = WT.toTh2(demo, 'elev', 'Demo_e.xvi', 'Demo_e');
  assert(/scrap Demo_p -projection plan -scale \[0 0 787\.402 0 0 0 10 0 m\]/.test(p), p.split('\n')[5]);
  assert(/scrap Demo_e -projection extended -scale \[0 0 787\.402 0 0 0 10 0 m\]/.test(e));
  assert(/set XVIgrid \{[-\d.]+ [-\d.]+ 78\.7402 0\.0 0\.0 78\.7402 /.test(WT.toXVI(demo, 'plan')));
});
ok('Rozvinutie: ťah do bodu a všetko odtiaľ ďalej', () => {
  const s = WT.fromPocketTopo(demoTxt, 'D');
  const inc = WT.incoming(s, '504.2');
  assert.strictEqual(inc.from, '504.1'); assert.strictEqual(inc.leg.from + inc.leg.to, '504.1504.2');
  assert.strictEqual(WT.incoming(s, '503.0'), null);
  WT.setExtend(s, '504.2', -1, false);
  const ext = n => s.shots.find(x => x.to && x.from + '>' + x.to === n).ext;
  assert.strictEqual(ext('504.1>504.2'), -1); assert.strictEqual(ext('504.2>504.3'), 1);
  const n = WT.setExtend(s, '504.2', -1, true);
  assert.strictEqual(n, 5);  // 504.1>504.2 … 504.5>504.6
  for (const k of ['504.2>504.3', '504.3>504.4', '504.4>504.5', '504.5>504.6']) assert.strictEqual(ext(k), -1, k);
  assert.strictEqual(ext('504.0>504.1'), 1); assert.strictEqual(ext('503.0>503.1'), -1);
  assert.strictEqual(s.ext, -1, 'nové ťahy pokračujú vľavo');
  WT.setExtend(s, '503.0', 1, true);
  assert(s.shots.filter(x => x.to).every(x => x.ext === 1), 'z počiatku = celý prieskum');
});
ok('ZIP balík sa dá rozbaliť', () => {
  const files = WT.therionBundle(demo);
  const z = WT.zip(files.map(f => ({ name: f.name, text: f.text })));
  fs.writeFileSync('/tmp/webtopo_test.zip', Buffer.from(z));
  const out = require('child_process').execSync('python3 -c "import zipfile;z=zipfile.ZipFile(\'/tmp/webtopo_test.zip\');print(z.testzip());print(len(z.namelist()))"').toString().trim().split('\n');
  assert.strictEqual(out[0], 'None'); assert.strictEqual(+out[1], files.length);
});
ok('Simulátor produkuje ťahy', () => {
  const sim = new WT.Simulator(7), s = WT.newSurvey('sim');
  for (let k = 0; k < 60; k++) WT.addMeasurement(s, sim.next());
  assert(WT.stats(s).legs >= 5, 'aspoň 5 ťahov');
});
console.log('\n' + n + ' testov prešlo');
