# UI test WebTopo v Chrome (mobilný viewport) s falošným DistoX2 cez Web Serial a falošným BLE prístrojom.
# python3 test/ui_test.py <dist_dir> <out_dir>
import sys, os, json, time, threading, zipfile, io, functools, http.server, socketserver
from playwright.sync_api import sync_playwright

DIST, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
DEMO = '/home/claude/ext/therion/samples/tests/pocket-topo/Demo.txt'

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=DIST)
class Quiet(Handler.func):
    def log_message(self, *a): pass
srv = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=DIST))
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{port}/index.html'

MOCK = r"""
(() => {
  // ---- falošný DistoX2 na Web Serial ----
  class FakePort {
    constructor() { this.acks = []; this.opens = 0; this.failNext = 0; }
    getInfo() { return { bluetoothServiceClassId: '00001101-0000-1000-8000-00805f9b34fb' }; }
    async open() {
      if (this.failNext > 0) { this.failNext--; throw new DOMException('Device off', 'NetworkError'); }
      this.opens++; const self = this;
      this.readable = new ReadableStream({ start(c) { self.ctrl = c; } });
      this.writable = new WritableStream({ write(ch) { self.acks.push(Array.from(ch)); } });
    }
    async close() {}
    push(b) { this.ctrl.enqueue(new Uint8Array(b)); }
    drop() { this.ctrl.error(new Error('link lost')); }
  }
  window.__port = new FakePort();
  Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => window.__port, getPorts: async () => [window.__port] } });

  // ---- falošné BLE zariadenie (DistoX BLE / SAP6) ----
  class Chr extends EventTarget {
    constructor(uuid, props) { super(); this.uuid = uuid; this.properties = props; this.writes = []; }
    async startNotifications() { return this; }
    async writeValueWithResponse(d) { this.writes.push(Array.from(new Uint8Array(d.buffer || d))); }
    async writeValueWithoutResponse(d) { this.writes.push(Array.from(new Uint8Array(d.buffer || d))); }
    notify(bytes) { const u = new Uint8Array(bytes); this.value = new DataView(u.buffer); this.dispatchEvent(new Event('characteristicvaluechanged')); }
  }
  const mk = (svcs) => ({ connected: false, async connect() { this.connected = true; return { async getPrimaryService(u) { if (!svcs[u]) throw new DOMException('no', 'NotFoundError'); return { uuid: u, async getCharacteristic(c) { return svcs[u][c]; }, async getCharacteristics() { return Object.values(svcs[u]); } }; } }; }, disconnect() { this.connected = false; } });
  const NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  window.__ble = {
    rx: new Chr('6e400002-b5a3-f393-e0a9-e50e24dcca9e', { write: true }),
    tx: new Chr('6e400003-b5a3-f393-e0a9-e50e24dcca9e', { notify: true })
  };
  window.__bleDev = Object.assign(new EventTarget(), { name: 'DistoXBLE-1234' });
  window.__bleDev.gatt = mk({ [NUS]: { '6e400002-b5a3-f393-e0a9-e50e24dcca9e': window.__ble.rx, '6e400003-b5a3-f393-e0a9-e50e24dcca9e': window.__ble.tx } });
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice: async () => window.__bleDev } });

  // kódovanie DistoX paketu (ako ho posiela prístroj)
  window.__pkt = (d, a, i, seq) => {
    const dm = Math.round(d * 1000), am = Math.round(((a % 360) + 360) % 360 * 32768 / 180) & 0xffff;
    let im = Math.round(i * 16384 / 90); if (im < 0) im += 65536;
    return [(seq ? 0x80 : 0) | (dm > 0xffff ? 0x40 : 0) | 0x01, dm & 0xff, (dm >> 8) & 0xff, am & 0xff, am >> 8, im & 0xff, im >> 8, 0];
  };
  window.__errors = [];
  window.addEventListener('error', e => window.__errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', e => window.__errors.push('rejection: ' + (e.reason && e.reason.message || e.reason)));
})();
"""

results = []
def check(name, cond, info=''):
    results.append((name, bool(cond), info))
    print(('ok  ' if cond else 'FAIL') + '  ' + name + ('  ' + str(info) if info else ''))

with sync_playwright() as p:
    br = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    ctx = br.new_context(viewport={'width': 412, 'height': 860}, device_scale_factor=2.5, is_mobile=True, has_touch=True, locale='sk-SK', accept_downloads=True)
    ctx.add_init_script(MOCK)
    page = ctx.new_page()
    console = []
    page.on('console', lambda m: console.append(m.type + ': ' + m.text))
    page.on('pageerror', lambda e: console.append('pageerror: ' + str(e)))
    page.goto(URL)
    page.wait_for_function('window.WTapp && window.WTapp.survey')
    page.screenshot(path=f'{OUT}/01_prazdny.png')
    check('štart: prázdny prieskum', page.locator('#empty').is_visible())

    # --- DistoX2 cez Web Serial ---
    page.click('#devPill')
    page.check('input[name=dt][value=distox2]')
    page.click('.sheet .btn.pri:has-text("Pripojiť")')
    page.wait_for_function("window.WTapp.dev && window.WTapp.dev.state === 'on'")
    page.screenshot(path=f'{OUT}/02_pristroj.png')
    page.click('.sheet .x')
    check('DistoX2 pripojený (Web Serial)', page.locator('#devPill.on').count() == 1)

    shots = [(1.85, 300.0, 2.0), (0.92, 210.0, 8.0),            # zámery z 1.0
             (5.38, 263.2, -26.1), (5.39, 263.5, -26.0), (5.37, 263.0, -26.2),   # ťah 1.0 → 1.1
             (1.28, 32.8, -3.8), (2.58, 44.5, 66.4),            # zámery z 1.1
             (3.12, 67.4, -69.3), (3.13, 67.6, -69.5), (3.12, 67.2, -69.2),       # ťah 1.1 → 1.2
             (4.20, 323.5, -25.7), (4.21, 323.4, -25.6), (4.19, 323.7, -25.8)]    # ťah 1.2 → 1.3
    seq = 0
    for k, (d, a, i) in enumerate(shots):
        pk = page.evaluate(f'__pkt({d},{a},{i},{seq})')
        page.evaluate(f'__port.push({json.dumps(pk)})')
        if k == 3:  # stratené ACK → prístroj pošle ten istý paket ešte raz
            page.evaluate(f'__port.push({json.dumps(pk)})')
        seq ^= 1
        page.wait_for_timeout(60)
    page.wait_for_timeout(300)
    st = page.evaluate('(() => { const s = WTapp.survey; return { n: s.shots.length, legs: s.shots.filter(x => x.to).map(x => x.from + ">" + x.to), cur: s.cur, next: s.next, log: s.log.length }; })()')
    acks = page.evaluate('__port.acks')
    check('ťahy rozpoznané z 3 zhodných meraní', st['legs'] == ['1.0>1.1', '1.1>1.2', '1.2>1.3'], st['legs'])
    check('zámery ostali zámermi', st['n'] == 3 + 4, st['n'])
    check('opakovaný paket ignorovaný, všetko potvrdené', len(acks) == len(shots) + 1 and st['log'] == len(shots), (len(acks), st['log']))
    check('ACK so sekvenčným bitom', [a[0] for a in acks[:3]] == [0x55, 0xd5, 0x55], acks[:3])
    check('aktuálna stanica 1.3 → 1.4', st['cur'] == '1.3' and st['next'] == '1.4', st)
    page.screenshot(path=f'{OUT}/03_data.png')
    check('posledné meranie v hornom pásiku', '4.19 m' in page.inner_text('#stHint'), page.inner_text('#stHint'))

    # výpadok spojenia → automatické znovupripojenie
    page.evaluate('__port.failNext = 1; __port.drop()')
    page.wait_for_function("WTapp.dev.state === 'wait'", timeout=3000)
    check('výpadok: čaká na prístroj', True)
    page.wait_for_function("WTapp.dev.state === 'on'", timeout=15000)
    check('znovu pripojené po výpadku', page.evaluate('__port.opens') >= 2, page.evaluate('__port.opens'))
    for k in range(3):
        page.evaluate(f'__port.push({json.dumps(page.evaluate(f"__pkt(2.5, 120, 5, {k % 2})"))})')
        page.wait_for_timeout(60)
    page.wait_for_timeout(200)
    check('merania po znovupripojení dorazia', page.evaluate("WTapp.survey.shots.filter(x => x.to).length") == 4)

    # --- riadok tabuľky: zmena smeru v reze ---
    page.click('#tbody tr.leg >> nth=1')
    page.click('.sheet .btn:has-text("Rez:")')
    ext = page.evaluate("WTapp.survey.shots.filter(x => x.to)[1].ext")
    check('zmena extend cez menu riadku', ext == -1, ext)
    check('kliknutý riadok ostane zvýraznený', page.locator('#tbody tr.sel').count() == 1 and page.locator('#tbody tr.leg >> nth=1').get_attribute('class').find('sel') >= 0)

    # --- náčrt: pôdorys ---
    page.click('#tabs [data-v=vPlan]')
    page.wait_for_timeout(300)
    box = page.locator('#cvPlan').bounding_box()
    cx, cy = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    page.click('#tPen'); page.screenshot(path=f'{OUT}/04a_paleta.png'); page.click('#palette [data-col=black]')
    page.mouse.move(cx - 80, cy - 60); page.mouse.down()
    for k in range(20): page.mouse.move(cx - 80 + k * 8, cy - 60 + (k % 5) * 4)
    page.mouse.up()
    page.click('#tPen'); page.click('#palette [data-col=blue]')
    page.mouse.move(cx - 60, cy + 40); page.mouse.down()
    for k in range(15): page.mouse.move(cx - 60 + k * 9, cy + 40 - k * 2)
    page.mouse.up()
    page.wait_for_timeout(200)
    n_plan = page.evaluate('WTapp.survey.sketch.plan.length')
    check('kreslenie v pôdoryse', n_plan == 2, n_plan)
    page.screenshot(path=f'{OUT}/04_podorys.png')
    page.click('#tools #tUndo')
    check('späť (undo)', page.evaluate('WTapp.survey.sketch.plan.length') == 1)
    # guma
    page.click('#tools [data-tool=erase]')
    page.mouse.move(cx - 80, cy - 70); page.mouse.down(); page.mouse.move(cx + 60, cy - 50, steps=12); page.mouse.up()
    check('guma zmaže čiaru', page.evaluate('WTapp.survey.sketch.plan.length') == 0)
    page.click('#tools #tUndo')
    # --- ťuknutie na bod v náčrte: kontextové menu ---
    page.click('#tPen')
    n_before = page.evaluate('WTapp.survey.sketch.plan.length')
    pos = page.evaluate("(() => { const v = WTapp.planView(), P = WTapp.geo.pos.get('1.3'), q = v.xy(P), r = v.cv.getBoundingClientRect(); return [r.left + v.sx(q[0]), r.top + v.sy(q[1])]; })()")
    page.mouse.click(pos[0] + 4, pos[1] - 3)
    page.wait_for_selector('.modal.compact')
    hdr = page.inner_text('.modal.compact .sh-h .ttl')
    check('menu bodu: nadpis a „z bodu“', 'Bod 1.3' in hdr and 'z bodu 1.2' in hdr, hdr.replace('\n', ' | '))
    check('menu bodu: dva riadky tlačidiel, bez Zavrieť', page.locator('.modal.compact .mgrid').count() == 2 and page.locator('.modal.compact .sh-f').count() == 0)
    check('ťuknutie perom na bod nič nenakreslí', page.evaluate('WTapp.survey.sketch.plan.length') == n_before)
    page.wait_for_timeout(300)
    page.screenshot(path=f'{OUT}/04b_menu_bodu.png')
    page.click('.modal.compact button[data-a=la]')
    exts = page.evaluate("WTapp.survey.shots.filter(x => x.to).map(x => x.from + '>' + x.to + ':' + x.ext)")
    check('Všetko ‹ rozvinie ťah do bodu aj ďalej', exts == ['1.0>1.1:1', '1.1>1.2:-1', '1.2>1.3:-1', '1.3>1.4:-1'], exts)
    page.mouse.click(pos[0] + 4, pos[1] - 3)
    page.wait_for_selector('.modal.compact')
    page.click('.modal.compact button[data-a=r1]')
    exts = page.evaluate("WTapp.survey.shots.filter(x => x.to).map(x => x.from + '>' + x.to + ':' + x.ext)")
    check('Rozvinúť › len ťah do bodu', exts == ['1.0>1.1:1', '1.1>1.2:-1', '1.2>1.3:1', '1.3>1.4:-1'], exts)
    check('ťuknutý bod je zvýraznený', page.evaluate('JSON.stringify(WTapp.sel)') == '{"t":"st","name":"1.3"}')
    page.click('#tools [data-tool=pan]')
    page.evaluate("WTapp.planView().v.s = 400")
    page.click('#tCenter')
    page.wait_for_timeout(250)
    r = page.evaluate("""(() => { const v = WTapp.planView(), g = WTapp.geo, P = g.pos.get(WTapp.survey.cur), q = v.xy(P);
        const pts = [...g.pos.values()].filter(Q => Q.comp === P.comp).map(Q => { const r = v.xy(Q); return [v.sx(r[0]), v.sy(r[1])]; });
        return { c: [v.sx(q[0]) - v.W / 2, v.sy(q[1]) - v.H / 2], inside: pts.every(p => p[0] >= 0 && p[0] <= v.W && p[1] >= 0 && p[1] <= v.H), s: v.v.s }; })()""")
    check('terčík: aktívny bod v strede a celý polygón na obrazovke', abs(r['c'][0]) < 1 and abs(r['c'][1]) < 1 and r['inside'] and r['s'] < 400, r)
    page.screenshot(path=f'{OUT}/04d_tercik.png')
    # --- okno nad klávesnicou ---
    page.click('#tabs [data-v=vData]')
    page.click('#stChip')
    page.focus('#sdNext')
    page.set_viewport_size({'width': 412, 'height': 380})   # klávesnica zaberie spodok obrazovky
    page.wait_for_timeout(500)
    sh = page.locator('.modal .sheet').bounding_box()
    btn = page.locator('.modal .sh-f .btn.pri').bounding_box()
    scrollable = page.evaluate("(() => { const b = document.querySelector('.modal .sh-b'); return b.scrollHeight > b.clientHeight; })()")
    check('okno je celé nad klávesnicou', sh['y'] >= 0 and sh['y'] + sh['height'] <= 380.5 and btn['y'] + btn['height'] <= 380.5, (round(sh['y']), round(sh['y'] + sh['height'])))
    check('telo okna sa roluje, keď sa nezmestí', scrollable)
    page.screenshot(path=f'{OUT}/04c_klavesnica.png')
    page.set_viewport_size({'width': 412, 'height': 860})
    page.click('.modal .x')
    page.click('#tabs [data-v=vPlan]')
    # --- rez ---
    page.click('#tabs [data-v=vElev]')
    page.wait_for_timeout(300)
    page.screenshot(path=f'{OUT}/05_rez.png')

    # --- export balíka ---
    page.click('#tabs [data-v=vData]')
    page.click('#btnMenu')
    page.click('.sheet .btn:has-text("Export")')
    with page.expect_download() as dl:
        page.click('.exrow:has-text("Balík") button[data-m=dl]')
    path = dl.value.path()
    z = zipfile.ZipFile(path)
    names = z.namelist()
    check('export ZIP obsahuje .th, .th2, .xvi, .txt, .json', all(any(n.endswith(s) for n in names) for s in ('.th', '_p.th2', '_e.th2', '_p.xvi', '_e.xvi', '_pockettopo.txt', '.json')), names)
    th = z.read([n for n in names if n.endswith('.th')][0]).decode()
    check('.th: ťahy, zámery a extend', '1.0 1.1 5.380' in th and ' - 1.850 ' in th and 'extend left' in th, th.splitlines()[5:9])
    open(f'{OUT}/export.th', 'w').write(th)
    page.click('.sheet .x')

    # --- BLE: DistoX BLE ---
    page.click('#devPill')
    page.check('input[name=dt][value=distoxble]')
    page.click('.sheet .btn.pri:has-text("Pripojiť")')
    page.wait_for_function("WTapp.dev && WTapp.dev.type === 'distoxble' && WTapp.dev.state === 'on'")
    page.click('.sheet .x')
    before = page.evaluate('WTapp.survey.shots.length')
    for k in range(3):
        pk = page.evaluate(f'__pkt(3.33, 45, -10, {k % 2})')
        page.evaluate(f'__ble.tx.notify([1].concat({json.dumps(pk)}, [4,0,0,0,0,0,0,0]))')
        page.wait_for_timeout(60)
    page.wait_for_timeout(200)
    legs = page.evaluate('WTapp.survey.shots.filter(x => x.to).map(x => x.from + ">" + x.to)')
    wr = page.evaluate('__ble.rx.writes')
    check('DistoX BLE: 3 merania = ťah', len(legs) == 5 and page.evaluate('WTapp.survey.shots.length') == before + 1, legs)
    check('DistoX BLE: ACK rámcované "data:"', wr and wr[0] == [0x64, 0x61, 0x74, 0x61, 0x3a, 1, 0x55, 0x0d, 0x0a], wr[:2])
    page.evaluate("__bleDev.dispatchEvent(new Event('gattserverdisconnected'))")
    page.wait_for_function("WTapp.dev.state === 'wait'", timeout=3000)
    page.wait_for_function("WTapp.dev.state === 'on'", timeout=15000)
    n0, legs0 = len(page.evaluate('__ble.rx.writes')), page.evaluate('WTapp.survey.shots.filter(x => x.to).length')
    for k in range(3):
        pk = page.evaluate(f'__pkt(2.22, 100, 3, {k % 2})')
        page.evaluate(f'__ble.tx.notify([1].concat({json.dumps(pk)}, [4,0,0,0,0,0,0,0]))')
        page.wait_for_timeout(60)
    page.wait_for_timeout(200)
    n1, legs1 = len(page.evaluate('__ble.rx.writes')), page.evaluate('WTapp.survey.shots.filter(x => x.to).length')
    check('BLE: znovupripojenie bez zdvojených odberov', n1 - n0 == 3 and legs1 == legs0 + 1, (n1 - n0, legs1 - legs0))

    # --- import PocketTopo .txt ---
    page.click('#btnMenu')
    with page.expect_file_chooser() as fc:
        page.click('.sheet .btn:has-text("Import")')
    fc.value.set_files(DEMO)
    page.wait_for_function("WTapp.survey.name === 'Demo'")
    imp = page.evaluate('(() => { const s = WTapp.survey; return [s.shots.length, s.sketch.plan.length, s.sketch.elev.length]; })()')
    check('import PocketTopo Demo.txt', imp == [51, 199, 200] or (imp[0] == 51 and imp[1] + imp[2] == 399), imp)
    page.screenshot(path=f'{OUT}/06_import_data.png')
    page.click('#tabs [data-v=vPlan]'); page.wait_for_timeout(400)
    page.screenshot(path=f'{OUT}/07_import_podorys.png')
    page.click('#tabs [data-v=vElev]'); page.wait_for_timeout(400)
    page.screenshot(path=f'{OUT}/08_import_rez.png')

    # --- pretrvanie po obnovení stránky ---
    page.reload()
    page.wait_for_function("window.WTapp && WTapp.survey && WTapp.survey.name === 'Demo'")
    check('dáta ostanú po obnovení (IndexedDB)', page.evaluate('WTapp.survey.shots.length') == 51)
    page.click('#btnMenu'); page.click('.sheet .btn:has-text("Prieskumy")')
    page.wait_for_timeout(300)
    n_sv = page.locator('.svrow').count()
    check('zoznam prieskumov', n_sv == 2, n_sv)
    page.screenshot(path=f'{OUT}/09_prieskumy.png')
    page.click('.sheet .x')

    # --- dialógy na snímky ---
    page.click('#stChip'); page.wait_for_timeout(200); page.screenshot(path=f'{OUT}/10_stanice.png'); page.click('.sheet .x')
    page.click('#tbody tr.leg >> nth=2'); page.wait_for_timeout(200); page.screenshot(path=f'{OUT}/11_menu_riadku.png'); page.click('.sheet .x')
    page.click('#devPill'); page.wait_for_timeout(200); page.screenshot(path=f'{OUT}/12_pristroj_dialog.png'); page.click('.sheet .x')

    errs = page.evaluate('window.__errors')
    bad = [c for c in console if c.startswith('error') or c.startswith('pageerror')]
    check('bez chýb v konzole', not errs and not bad, (errs, bad[:5]))
    br.close()
srv.shutdown()
failed = [r for r in results if not r[1]]
print(f'\n{len(results) - len(failed)}/{len(results)} OK')
sys.exit(1 if failed else 0)
