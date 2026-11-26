/* WebTopo – rozhranie: prístroje (Web Serial / Web Bluetooth), tabuľka, náčrt, dialógy. */
(() => {
  'use strict';
  const WT = window.WT, U = WT.UUID;
  const APP_VERSION = '1.3';
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => parseFloat(String(v).trim().replace(',', '.'));
  const validName = n => /^[A-Za-z0-9._\-]+$/.test(n);

  const ICON = {
    hand: '<svg viewBox="0 0 24 24"><path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11m0-1V4.5a1.5 1.5 0 0 1 3 0V11m0-5.5a1.5 1.5 0 0 1 3 0V12m0-3.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.6-2.8L3.3 15.6a1.6 1.6 0 0 1 2.4-2.1L8 15"/></svg>',
    erase: '<svg viewBox="0 0 24 24"><path d="M7 21h13M5.5 15.5l8-8 5 5-6.5 6.5H9z"/><path d="M13.5 7.5l2-2a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8l-2 2"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
    target: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
    fit: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    menu: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
    zin: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    zout: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
    chev: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>'
  };
  const PEN = { black: '#141414', gray: '#8a8a8a', brown: '#8d5524', blue: '#1565c0', red: '#d32f2f', green: '#2e7d32', orange: '#f57c00' };
  const PEN_SK = { black: 'čierna', gray: 'sivá', brown: 'hnedá', blue: 'modrá', red: 'červená', green: 'zelená', orange: 'oranžová' };

  // ---------------- nastavenia ----------------
  const DEF = { tolD: 0.05, tolA: 1.7, legShots: 3, branch: 'series', sound: true, vib: true, autoRe: true,
    sketchSplays: true, hideSplays: false, font: 'm', pen: 2, devType: 'distox2', wake: false, labels: true };
  let S = Object.assign({}, DEF);
  try { Object.assign(S, JSON.parse(localStorage.getItem('wt.settings') || '{}')); } catch (e) { /* prázdne */ }
  const saveSettings = () => { try { localStorage.setItem('wt.settings', JSON.stringify(S)); } catch (e) { /* plné */ } };

  // ---------------- úložisko (IndexedDB) ----------------
  const DB = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('webtopo', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('surveys', { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('surveys', mode), req = fn(t.objectStore('surveys'));
        t.oncomplete = () => res(req ? req.result : undefined);
        t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
    };
    return { put: s => tx('readwrite', st => st.put(s)), get: id => tx('readonly', st => st.get(id)),
      del: id => tx('readwrite', st => st.delete(id)), all: () => tx('readonly', st => st.getAll()) };
  })();

  // ---------------- stav ----------------
  let sv = null, geo = null, flashId = null, curView = 'vData', dev = null, persistAsked = false;
  let sel = null;   // zvýraznený bod {t:'st', name} alebo riadok {t:'sh', id}
  function select(x) { sel = x; applySel(); planView.requestRender(); elevView.requestRender(); }
  function rowSel(sh) { return !!sel && (sel.t === 'sh' ? sel.id === sh.id : (!!sh.to && sh.to === sel.name)); }
  function applySel() {
    document.querySelectorAll('#tbody tr[data-id]').forEach(tr => {
      const sh = sv.shots.find(x => x.id === tr.dataset.id);
      tr.classList.toggle('sel', !!sh && rowSel(sh));
    });
  }

  // ---------------- krok späť pre dáta (merania, úpravy, mazanie, stanice) ----------------
  let undoData = [];
  function snap() {
    if (!sv) return;
    const anc = [];
    for (const p of ['plan', 'elev']) for (const st of sv.sketch[p]) anc.push([st.id, st.anc]);
    undoData.push(JSON.stringify({ shots: sv.shots, cur: sv.cur, next: sv.next, ext: sv.ext, start: sv.start, fix: sv.fix, anc }));
    if (undoData.length > 60) undoData.shift();
    syncUndo();
  }
  function undoDataStep() {
    if (editing) finishEdit(false);
    const j = undoData.pop();
    if (!j) { toast('Nie je čo vrátiť'); return; }
    const o = JSON.parse(j);
    Object.assign(sv, { shots: o.shots, cur: o.cur, next: o.next, ext: o.ext, start: o.start, fix: o.fix });
    const m = new Map(o.anc);
    for (const p of ['plan', 'elev']) for (const st of sv.sketch[p]) if (m.has(st.id)) st.anc = m.get(st.id);
    if (sel && sel.t === 'sh' && !sv.shots.some(x => x.id === sel.id)) sel = null;
    syncUndo(); changed(true); toast('Krok späť');
  }
  function syncUndo() { const b = document.getElementById('btnUndoData'); if (b) b.disabled = !undoData.length; }
  let saveT = 0, saving = Promise.resolve();
  const devLogLines = [];

  function save(now) {
    clearTimeout(saveT);
    const doSave = () => { const copy = JSON.parse(JSON.stringify(sv)); saving = saving.then(() => DB.put(copy)).catch(e => toast('Chyba ukladania: ' + e.message, 'bad')); return saving; };
    if (now) return doSave();
    saveT = setTimeout(doSave, 400);
  }
  function changed(saveNow) {
    sv.modified = Date.now();
    geo = WT.compute(sv);
    save(saveNow);
    renderAll();
  }

  // ---------------- spätná väzba ----------------
  let actx = null;
  function beep(freqs) {
    if (!S.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      let t = actx.currentTime + 0.01;
      for (const f of freqs) {
        const o = actx.createOscillator(), g = actx.createGain();
        o.frequency.value = f; o.connect(g); g.connect(actx.destination);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
        o.start(t); o.stop(t + 0.13); t += 0.15;
      }
    } catch (e) { /* bez zvuku */ }
  }
  const vib = p => { if (S.vib && navigator.vibrate) navigator.vibrate(p); };
  let toastT = 0;
  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'show ' + (kind || '');
    clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, kind === 'bad' ? 5000 : 2600);
  }

  // ---------------- modálne okná ----------------
  const stack = [];
  function modal(title, body, buttons, opt) {
    opt = opt || {};
    const tt = $('#toast'); if (!tt.classList.contains('bad')) tt.className = '';
    const el = document.createElement('div');
    el.className = 'modal';
    el.innerHTML = '<div class="sheet' + (opt.wide ? ' wide' : '') + '"><div class="sh-h"><div class="ttl"><b></b><small></small></div><button class="x" aria-label="Zavrieť">✕</button></div><div class="sh-b"></div><div class="sh-f"></div></div>';
    el.querySelector('.sh-h b').textContent = title;
    if (opt.sub) el.querySelector('.sh-h small').textContent = opt.sub; else el.querySelector('.sh-h small').remove();
    // políčko pri písaní: okno sa zmestí nad klávesnicu, telo okna sa podľa potreby roluje
    el.addEventListener('focusin', e => {
      if (!/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      setTimeout(() => { try { e.target.scrollIntoView({ block: 'nearest' }); } catch (x) { /* */ } }, 350);
    });
    const b = el.querySelector('.sh-b');
    if (typeof body === 'string') b.innerHTML = body; else if (body) b.append(body);
    const m = { el, close: () => close(m) };
    const f = el.querySelector('.sh-f');
    for (const bt of buttons || []) {
      const x = document.createElement('button');
      x.className = 'btn ' + (bt.cls || ''); x.textContent = bt.label;
      x.onclick = async () => { let r; try { r = bt.onClick ? await bt.onClick(el, m) : undefined; } catch (e) { toast(e.message || String(e), 'bad'); r = false; } if (r !== false) close(m); };
      f.append(x);
    }
    if (!f.children.length) f.remove();
    el.querySelector('.x').onclick = () => close(m);
    el.addEventListener('pointerdown', e => { if (e.target === el) close(m); });
    m.onClose = opt.onClose;
    document.body.append(el);
    stack.push(m);
    const first = el.querySelector('input[autofocus]');
    if (first) setTimeout(() => first.focus(), 50);
    return m;
  }
  function close(m) {
    const k = stack.indexOf(m); if (k < 0) return;
    stack.splice(k, 1); m.el.remove();
    if (m.onClose) m.onClose();
  }
  const closeAll = () => { while (stack.length) close(stack[stack.length - 1]); };
  function confirmBox(msg, okLabel) {
    return new Promise(res => {
      let done = false;
      modal('Potvrdiť', '<p>' + esc(msg) + '</p>', [
        { label: 'Zrušiť', onClick: () => { done = true; res(false); } },
        { label: okLabel || 'Áno', cls: 'bad', onClick: () => { done = true; res(true); } }
      ], { onClose: () => { if (!done) res(false); } });
    });
  }
  // tlačidlo Späť na Androide: zavrie okno / vráti sa na dáta, aplikáciu hneď nezatvorí
  history.replaceState({ wt: 0 }, ''); history.pushState({ wt: 1 }, '');
  window.addEventListener('popstate', () => {
    if (stack.length) { close(stack[stack.length - 1]); history.pushState({ wt: 1 }, ''); return; }
    if (curView !== 'vData') { showView('vData'); history.pushState({ wt: 1 }, ''); return; }
    toast('Ešte raz Späť = zatvoriť aplikáciu');
    setTimeout(() => history.pushState({ wt: 1 }, ''), 2500);
  });

  // ============================== prístroje ==============================
  const DEV_TYPES = {
    distox2: { label: 'DistoX2 / DistoX', sub: 'klasický Bluetooth (SPP) · Web Serial', api: 'serial' },
    distoxble: { label: 'DistoX BLE', sub: 'nová doska DistoXBLE · Web Bluetooth', api: 'ble' },
    sap6: { label: 'SAP6 / DiscoX', sub: 'Web Bluetooth', api: 'ble' },
    sap5: { label: 'SAP5', sub: 'Web Bluetooth', api: 'ble' },
    bric: { label: 'BRIC4 / BRIC5', sub: 'Web Bluetooth', api: 'ble' },
    auto: { label: 'Iný BLE prístroj', sub: 'zobrazí všetky BLE zariadenia, protokol zistí sám', api: 'ble' },
    sim: { label: 'Simulátor', sub: 'bez prístroja – na vyskúšanie', api: 'none' }
  };
  const hasSerial = () => 'serial' in navigator;
  const hasBle = () => !!(navigator.bluetooth && navigator.bluetooth.requestDevice);

  class BaseDev {
    constructor(type) { this.type = type; this.state = 'off'; this.text = ''; this.stopped = false; this.name = DEV_TYPES[type].label; }
    setState(st, text) { this.state = st; this.text = text || ''; renderDev(); }
    log(t) { devLog(t); }
    emit(m) { onMeasurement({ d: m.d, a: m.a, i: m.i, dev: this.name }); }
    canShot() { return this.state === 'on'; }
  }

  class SerialDistoX extends BaseDev {
    async connect(user, opt) {
      if (!hasSerial()) throw new Error('Prehliadač nemá Web Serial. Treba Chrome 138+ na Androide (nie iPhone).');
      this.stopped = false;
      if (!this.port) {
        if (user && opt && opt.all) this.port = await navigator.serial.requestPort();
        else if (user) {
          try { this.port = await navigator.serial.requestPort({ filters: [{ bluetoothServiceClassId: U.SPP }] }); }
          catch (e) { if (e && e.name === 'TypeError') this.port = await navigator.serial.requestPort(); else throw e; }
        } else {
          const ps = await navigator.serial.getPorts();
          this.port = ps.find(p => String((p.getInfo && p.getInfo().bluetoothServiceClassId) || '').toLowerCase() === U.SPP) || ps[0];
          if (!this.port) throw new Error('Žiadny povolený prístroj');
        }
      }
      this.name = 'DistoX';
      this.open();
    }
    async open() {
      if (this.stopped || this.opening || this.reader) return;
      clearTimeout(this.rt);
      this.opening = true;
      this.setState('connecting', 'Pripájam…');
      try { await this.port.open({ baudRate: 9600 }); }
      catch (e) {
        if (!(e && e.name === 'InvalidStateError')) { this.opening = false; this.log('Nedá sa pripojiť: ' + (e.message || e)); this.retry(); return; }
      }
      this.opening = false;
      this.log('Spojenie otvorené');
      this.setState('on', this.name);
      this.loop();
    }
    async loop() {
      const stream = new WT.DistoXStream();
      let reader = null, writer = null;
      try {
        writer = this.port.writable.getWriter(); this.writer = writer;
        reader = this.port.readable.getReader(); this.reader = reader;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value || !value.length) continue;
          for (const r of stream.push(value)) {
            this.log('← ' + WT.hex(r.p) + ' ' + r.msg.type + (r.dup ? ' (opakovanie)' : ''));
            if (r.ack != null) await writer.write(Uint8Array.of(r.ack));
            if (r.msg.type === 'shot' && !r.dup) this.emit(r.msg);
          }
        }
      } catch (e) { this.log('Spojenie prerušené: ' + (e.message || e)); }
      try { if (reader) reader.releaseLock(); } catch (e) { /* */ }
      try { if (writer) writer.releaseLock(); } catch (e) { /* */ }
      this.reader = this.writer = null;
      try { await this.port.close(); } catch (e) { /* */ }
      if (this.stopped) this.setState('off', 'Odpojené'); else this.retry();
    }
    retry() {
      if (this.stopped) return;
      if (!S.autoRe) { this.setState('off', 'Odpojené'); return; }
      this.setState('wait', 'Čakám na prístroj…');
      clearTimeout(this.rt); this.rt = setTimeout(() => this.open(), 4000);
    }
    async command(c) {
      const b = WT.DISTOX_CMD[c];
      if (b == null || !this.writer) return false;
      await this.writer.write(Uint8Array.of(b)); this.log('→ ' + b.toString(16)); return true;
    }
    async disconnect() {
      this.stopped = true; clearTimeout(this.rt);
      try { if (this.reader) await this.reader.cancel(); else if (this.port) await this.port.close(); } catch (e) { /* */ }
      this.setState('off', 'Odpojené');
    }
  }

  class BleDev extends BaseDev {
    constructor(type) { super(type); this.q = Promise.resolve(); this.last = null; this.seen = new Set(); }
    options() {
      const all = [U.NUS_SVC, U.CC254X_SVC, U.RN4870_SVC, U.SAP6_SVC, U.BRIC_MEAS, U.BRIC_CTRL];
      switch (this.type) {
        case 'distoxble': return { filters: [{ namePrefix: 'DistoXBLE' }, { namePrefix: 'DistoX' }], optionalServices: [U.NUS_SVC] };
        case 'sap6': return { filters: [{ namePrefix: 'SAP6' }, { namePrefix: 'DiscoX' }, { services: [U.SAP6_SVC] }], optionalServices: [U.SAP6_SVC] };
        case 'sap5': return { filters: [{ namePrefix: 'Shetland' }, { namePrefix: 'SAP' }], optionalServices: [U.NUS_SVC, U.CC254X_SVC, U.RN4870_SVC] };
        case 'bric': return { filters: [{ namePrefix: 'BRIC' }], optionalServices: [U.BRIC_MEAS, U.BRIC_CTRL] };
        default: return { acceptAllDevices: true, optionalServices: all };
      }
    }
    async connect() {
      if (!hasBle()) throw new Error('Prehliadač nemá Web Bluetooth. Treba Chrome na Androide.');
      this.stopped = false;
      if (!this.device) {
        this.device = await navigator.bluetooth.requestDevice(this.options());
        this.device.addEventListener('gattserverdisconnected', () => this.onDisc());
      }
      this.name = this.device.name || DEV_TYPES[this.type].label;
      try { await this.open(); } catch (e) { this.log('Pripojenie zlyhalo: ' + e.message); this.retry(); }
    }
    async svc(server, uuid) { try { return await server.getPrimaryService(uuid); } catch (e) { return null; } }
    async open() {
      if (this.stopped || this.opening) return;
      clearTimeout(this.rt);
      this.opening = true;
      try { await this.open2(); } finally { this.opening = false; }
    }
    async open2() {
      this.setState('connecting', 'Pripájam…');
      for (const s of this.subs || []) s.chr.removeEventListener('characteristicvaluechanged', s.h);
      this.subs = [];
      const server = await this.device.gatt.connect();
      let kind = this.type;
      if (kind === 'auto') {
        if (await this.svc(server, U.SAP6_SVC)) kind = 'sap6';
        else if (await this.svc(server, U.BRIC_MEAS)) kind = 'bric';
        else if (await this.svc(server, U.NUS_SVC)) kind = /^DistoX/i.test(this.name) ? 'distoxble' : 'sap5';
        else kind = 'sap5';
        this.log('Zistený protokol: ' + kind);
      }
      this.proto = kind;
      const on = (chr, fn) => {
        const h = e => {
          const dv = e.target.value;
          fn(new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength)));
        };
        chr.addEventListener('characteristicvaluechanged', h);
        this.subs.push({ chr, h });
        return chr.startNotifications();
      };
      if (kind === 'distoxble') {
        const s = await server.getPrimaryService(U.NUS_SVC);
        this.wr = await s.getCharacteristic(U.NUS_RX);
        await on(await s.getCharacteristic(U.NUS_TX), v => this.onDistoXBle(v));
      } else if (kind === 'sap5') {
        let s = await this.svc(server, U.NUS_SVC), rd = null;
        if (s) {
          const cs = await s.getCharacteristics();
          rd = cs.find(c => c.properties.notify || c.properties.indicate);
          this.wr = cs.find(c => c !== rd && (c.properties.write || c.properties.writeWithoutResponse)) || rd;
        } else {
          s = (await this.svc(server, U.CC254X_SVC)) || (await this.svc(server, U.RN4870_SVC));
          if (!s) throw new Error('Nenašla sa sériová BLE služba');
          rd = this.wr = await s.getCharacteristic(s.uuid === U.CC254X_SVC ? U.CC254X_CHR : U.RN4870_CHR);
        }
        this.stream = new WT.DistoXStream();
        await on(rd, v => this.onSap5(v));
      } else if (kind === 'sap6') {
        const s = await server.getPrimaryService(U.SAP6_SVC);
        this.wr = await s.getCharacteristic(U.SAP6_CMD);
        await on(await s.getCharacteristic(U.SAP6_LEG), v => this.onSap6(v));
      } else if (kind === 'bric') {
        const s = await server.getPrimaryService(U.BRIC_MEAS);
        this.pending = null;
        await on(await s.getCharacteristic(U.BRIC_PRIM), v => { const m = WT.decodeBricPrimary(v); this.log('← BRIC ' + WT.hex(v)); if (m) this.pending = m; });
        await on(await s.getCharacteristic(U.BRIC_META), v => { const m = WT.decodeBricMeta(v); if (m && this.pending) this.pending.idx = m.idx; });
        await on(await s.getCharacteristic(U.BRIC_ERR), v => this.onBricErr(v));
        const c = await this.svc(server, U.BRIC_CTRL);
        this.wr = c ? await c.getCharacteristic(U.BRIC_CTRL_CHR) : null;
      }
      this.log('Pripojené: ' + this.name + ' (' + kind + ')');
      this.setState('on', this.name);
    }
    write(chr, bytes) {
      if (!chr) return Promise.resolve();
      const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
      this.q = this.q.then(() => (chr.properties.write ? chr.writeValueWithResponse(data) : chr.writeValueWithoutResponse(data)))
        .catch(e => this.log('Chyba zápisu: ' + e.message));
      return this.q;
    }
    isDup(v) { const d = !!this.last && this.last.length === v.length && this.last.every((x, k) => x === v[k]); this.last = v; return d; }
    onDistoXBle(v) {
      const r = WT.decodeDistoXBle(v), dup = this.isDup(v);
      this.log('← ' + WT.hex(v) + (dup ? ' (opakovanie)' : ''));
      if (r.kind === 'other') return;
      this.write(this.wr, WT.distoxBleFrame([r.ack]));
      if (r.kind === 'shot' && !dup && r.msg.type === 'shot') this.emit(r.msg);
    }
    onSap5(v) {
      for (const r of this.stream.push(v)) {
        this.log('← ' + WT.hex(r.p) + ' ' + r.msg.type + (r.dup ? ' (opakovanie)' : ''));
        if (r.ack != null) this.write(this.wr, [r.ack]);
        if (r.msg.type === 'shot' && !r.dup) this.emit(r.msg);
      }
    }
    onSap6(v) {
      const m = WT.decodeSap6(v), dup = this.isDup(v);
      this.log('← ' + WT.hex(v) + (dup ? ' (opakovanie)' : ''));
      if (!m) return;
      this.write(this.wr, [m.ack]);
      if (!dup) this.emit(m);
    }
    onBricErr(v) {
      const e = WT.decodeBricErr(v), m = this.pending; this.pending = null;
      if (!m) return;
      if (e.e1 || e.e2) { this.log('BRIC chyba ' + e.e1 + '/' + e.e2); toast('BRIC: chybné meranie (kód ' + (e.e1 || e.e2) + ')', 'bad'); return; }
      const key = m.idx != null ? 'i' + m.idx : m.time + m.d;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      this.emit(m);
    }
    async command(c) {
      if (this.state !== 'on') return false;
      if (this.proto === 'bric') { const t = WT.BRIC_CMD[c]; if (!t || !this.wr) return false; await this.write(this.wr, new TextEncoder().encode(t)); return true; }
      const b = (this.proto === 'sap6' ? WT.SAP6_CMD : WT.DISTOX_CMD)[c];
      if (b == null) return false;
      await this.write(this.wr, this.proto === 'distoxble' ? WT.distoxBleFrame([b]) : [b]);
      this.log('→ ' + c);
      return true;
    }
    onDisc() {
      this.log('Bluetooth odpojený');
      if (this.stopped) { this.setState('off', 'Odpojené'); return; }
      this.retry();
    }
    retry() {
      if (this.stopped) return;
      if (!S.autoRe) { this.setState('off', 'Odpojené'); return; }
      this.setState('wait', 'Čakám na prístroj…');
      clearTimeout(this.rt);
      this.rt = setTimeout(async () => { try { await this.open(); } catch (e) { this.log('Pokus zlyhal: ' + e.message); this.retry(); } }, 4000);
    }
    async disconnect() {
      this.stopped = true; clearTimeout(this.rt);
      try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) { /* */ }
      this.setState('off', 'Odpojené');
    }
  }

  class SimDev extends BaseDev {
    async connect() { this.sim = new WT.Simulator((Date.now() & 0xffff) + 1); this.name = 'Simulátor'; this.setState('on', 'Simulátor'); }
    async command(c) { if (c === 'shot') setTimeout(() => this.emit(this.sim.next()), 200); return true; }
    auto(on) { clearInterval(this.ti); if (on) this.ti = setInterval(() => this.command('shot'), 1500); }
    async disconnect() { this.auto(false); this.stopped = true; this.setState('off', 'Odpojené'); }
  }

  function makeDev(type) {
    const api = DEV_TYPES[type].api;
    if (api === 'serial') return new SerialDistoX(type);
    if (api === 'ble') return new BleDev(type);
    return new SimDev(type);
  }
  function devLog(t) {
    const d = new Date();
    devLogLines.push(String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0') + '  ' + t);
    if (devLogLines.length > 200) devLogLines.splice(0, devLogLines.length - 200);
    const el = document.getElementById('devLog');
    if (el) { el.textContent = devLogLines.slice(-60).join('\n'); el.scrollTop = el.scrollHeight; }
  }

  // ============================== merania ==============================
  function onMeasurement(m) {
    if (!sv) return;
    snap();
    const r = WT.addMeasurement(sv, m, { tolD: S.tolD, tolA: S.tolA, legShots: S.legShots });
    flashId = r.shot.id;
    if (r.kind === 'leg') {
      beep([880, 1320]); vib([70, 60, 70]);
      toast('Ťah ' + r.shot.from + ' → ' + r.shot.to + ' · ' + WT.fmt(r.shot.d, 2) + ' m', 'ok');
    } else if (r.kind === 'legplus') {
      beep([1320]); vib(40);
      toast('Ťah ' + r.shot.from + ' → ' + r.shot.to + ' spresnený (' + r.shot.raw.length + ' merania)', 'ok');
    } else {
      beep([880]); vib(35);
      toast('Zámer z ' + r.shot.from + ' · ' + WT.fmt(r.shot.d, 2) + ' m');
    }
    changed(true);
    if (r.kind === 'leg') for (const v of [planView, elevView]) v.follow();
    scrollTableEnd();
    if (navigator.storage && navigator.storage.persist && !persistAsked) { persistAsked = true; navigator.storage.persist().catch(() => {}); }
  }
  async function doShot() {
    if (dev && dev.state === 'on') {
      const ok = await dev.command('shot').catch(() => false);
      if (!ok) toast('Prístroj nepodporuje meranie na diaľku – stlač tlačidlo na prístroji');
    } else toast('Prístroj nie je pripojený');
  }

  // ============================== vykreslenie ==============================
  function renderAll() { renderHeader(); renderTable(); planView.requestRender(); elevView.requestRender(); }
  function renderHeader() {
    const st = WT.stats(sv);
    $('#svName').textContent = sv.name;
    $('#svStats').textContent = st.legs + ' ťahov · ' + st.splays + ' zámerov · ' + WT.fmt(st.len, 1) + ' m';
    $('#stCur').textContent = sv.cur;
    $('#stNext').textContent = sv.next;
    $('#stExt').textContent = sv.ext >= 0 ? '›' : '‹';
    const lg = sv.log[sv.log.length - 1];
    $('#stHint').innerHTML = lg ? '<small>posledné meranie</small><br><b>' + WT.fmt(lg.d, 2) + ' m · ' + WT.fmt(+WT.fmtAz(lg.a), 1) + '° · ' + WT.fmt(lg.i, 1) + '°</b>'
      : (S.legShots ? S.legShots + ' zhodné merania<br>= ťah' : 'ťahy sa zadávajú<br>ručne');
  }
  function renderDev() {
    const p = $('#devPill');
    const st = dev ? dev.state : 'off';
    p.className = 'pill ' + st;
    $('#devName').textContent = !dev || st === 'off' ? 'Pripojiť' : (st === 'on' ? dev.name : dev.text);
    const ds = document.getElementById('devState');
    if (ds) ds.textContent = !dev ? 'Nepripojené' : (dev.name + ' – ' + ({ on: 'pripojené', off: 'odpojené', wait: 'čakám na prístroj', connecting: 'pripájam' }[st] || st));
  }
  function rowHTML(sh) {
    const leg = !!sh.to;
    const cls = (leg ? 'leg' : 'splay') + (sh.id === flashId ? ' new' : '') + ((sh.to || sh.from) === sv.cur && leg ? ' cur' : '') + (rowSel(sh) ? ' sel' : '');
    return '<tr class="' + cls + '" data-id="' + sh.id + '"><td class="mn">' + ICON.chev + '</td><td class="st" data-f="from">' + esc(sh.from) +
      '</td><td class="st" data-f="to">' + (leg ? esc(sh.to) : '–') + (sh.c ? '<span class="cm">✎</span>' : '') +
      '</td><td data-f="d">' + WT.fmt(sh.d, 2) + '</td><td data-f="a">' + WT.fmt(+WT.fmtAz(sh.a), 1) + '</td><td data-f="i">' + WT.fmt(sh.i, 1) +
      '</td><td class="ex" data-f="ext">' + (leg ? (sh.ext >= 0 ? '›' : '‹') : '') + '</td></tr>';
  }
  function renderTable() {
    if (editing) { tablePending = true; return; }
    tablePending = false;
    const shots = S.hideSplays ? sv.shots.filter(x => x.to) : sv.shots;
    $('#tbody').innerHTML = shots.map(rowHTML).join('');
    $('#empty').style.display = sv.shots.length ? 'none' : '';
    document.body.dataset.font = S.font;
    renderEntry();
    syncUndo();
  }
  function renderEntry() {
    $('#enFrom').textContent = sv.cur;
    $('#enExt').textContent = sv.ext >= 0 ? '›' : '‹';
  }
  function scrollTableEnd() { const w = $('#tblWrap'); requestAnimationFrame(() => { w.scrollTop = w.scrollHeight; }); }

  // ---------------- priama úprava hodnoty v riadku (dvojklik / dlhé podržanie) ----------------
  let editing = null, tablePending = false;
  function applyShotEdit(sh, v) {
    const wasLeg = !!sh.to, old = { from: sh.from, to: sh.to };
    Object.assign(sh, v);
    const used = n => sv.shots.some(x => x.from === n || x.to === n);
    if (!wasLeg && sh.to && sh.from === sv.cur) WT.setCurrent(sv, sh.to);
    else if (old.to && sv.cur === old.to && !used(old.to)) WT.setCurrent(sv, sh.to || sh.from);
    else if (sv.cur === old.from && !used(old.from)) WT.setCurrent(sv, sh.from);
    else if (sv.next === sv.cur || (used(sv.next) && sv.next === old.to)) sv.next = WT.suggestNext(sv, sv.cur);
  }
  function startEdit(td) {
    if (editing) finishEdit(true);
    const tr = td.closest('tr'), f = td.dataset.f;
    const sh = tr && sv.shots.find(x => x.id === tr.dataset.id);
    if (!sh || !f) return;
    if (f === 'ext') { if (sh.to) { snap(); WT.setLegExt(sv, sh.id, sh.ext >= 0 ? -1 : 1); changed(); } return; }
    const val = f === 'from' ? sh.from : f === 'to' ? sh.to : f === 'd' ? WT.fmt(sh.d, 3) : f === 'a' ? WT.fmtAz(sh.a) : WT.fmt(sh.i, 2);
    const inp = document.createElement('input');
    inp.className = 'cell'; inp.value = val; inp.autocomplete = 'off';
    inp.setAttribute('autocapitalize', 'off'); inp.setAttribute('enterkeyhint', 'done');
    if (f === 'd' || f === 'a' || f === 'i') inp.inputMode = 'decimal';
    td.textContent = ''; td.append(inp); td.classList.add('editing');
    editing = { sh, f, inp, orig: val };
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); finishEdit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
    });
    inp.addEventListener('blur', () => finishEdit(true));
    inp.focus(); inp.select();
    setTimeout(() => { try { inp.scrollIntoView({ block: 'nearest' }); } catch (x) { /* */ } }, 300);
  }
  function finishEdit(commit) {
    const e = editing; if (!e) return;
    editing = null;
    const raw = e.inp.value.trim();
    if (commit && raw !== e.orig) {
      try {
        const v = {};
        if (e.f === 'from' || e.f === 'to') {
          if (e.f === 'from' && !raw) throw new Error('Od nesmie byť prázdne');
          if (raw && !validName(raw)) throw new Error('Názov stanice: len písmená bez diakritiky, číslice, bodka, - a _');
          if (raw && raw === (e.f === 'from' ? e.sh.to : e.sh.from)) throw new Error('Od a Do musia byť rôzne');
          v[e.f] = raw;
        } else {
          const x = num(raw);
          if (e.f === 'd' && !(x >= 0)) throw new Error('Dĺžka musí byť číslo ≥ 0');
          if (e.f === 'a' && !(x >= 0 && x <= 360)) throw new Error('Azimut musí byť 0–360°');
          if (e.f === 'i' && !(x >= -90 && x <= 90)) throw new Error('Sklon musí byť −90 až 90°');
          v[e.f] = e.f === 'a' ? WT.norm360(x) : x;
        }
        snap(); applyShotEdit(e.sh, v); changed(true);
        return;
      } catch (err) { toast(err.message, 'bad'); }
    }
    renderTable();
  }

  // ---------------- posledný riadok = nové meranie ručne ----------------
  function commitEntry(fromEnter) {
    const g = id => $(id).value.trim();
    if (!g('#enD') || !g('#enA') || !g('#enI')) { if (fromEnter) toast('Vyplň dĺžku, azimut a sklon'); return false; }
    const to = g('#enTo'), d = num(g('#enD')), a = num(g('#enA')), i = num(g('#enI'));
    try {
      if (to && !validName(to)) throw new Error('Názov stanice: len písmená bez diakritiky, číslice, bodka, - a _');
      if (to && to === sv.cur) throw new Error('Od a Do musia byť rôzne');
      if (!(d >= 0) || !(a >= 0 && a <= 360) || !(i >= -90 && i <= 90)) throw new Error('Skontroluj hodnoty: dĺžka ≥ 0, azimut 0–360°, sklon −90 až 90°');
    } catch (err) { toast(err.message, 'bad'); return false; }
    snap();
    const shot = { id: WT.uid(), from: sv.cur, to, d, a: WT.norm360(a), i, ext: sv.ext, t: Date.now(), c: '', manual: true };
    sv.shots.push(shot);
    if (to) WT.setCurrent(sv, to); else sv.next = WT.suggestNext(sv, sv.cur);
    flashId = shot.id;
    for (const id of ['#enTo', '#enD', '#enA', '#enI']) $(id).value = '';
    changed(true); scrollTableEnd();
    toast(to ? 'Ťah ' + shot.from + ' → ' + to : 'Zámer z ' + shot.from, 'ok');
    return true;
  }

  // ---------------- náčrt ----------------
  class SketchView {
    constructor(canvas, proj) {
      this.cv = canvas; this.ctx = canvas.getContext('2d'); this.proj = proj;
      this.v = null; this.ptrs = new Map(); this.tool = 'pan'; this.col = 'black';
      this.stroke = null; this.undo = []; this.raf = 0; this.W = 1; this.H = 1;
      canvas.addEventListener('pointerdown', e => this.down(e));
      canvas.addEventListener('pointermove', e => this.move(e));
      canvas.addEventListener('pointerup', e => this.up(e));
      canvas.addEventListener('pointercancel', e => this.up(e, true));
      canvas.addEventListener('wheel', e => { e.preventDefault(); this.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
      new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    }
    visible() { return curView === (this.proj === 'plan' ? 'vPlan' : 'vElev'); }
    resize() {
      const r = this.cv.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      if (r.width < 2 || r.height < 2) return;
      this.W = r.width; this.H = r.height; this.dpr = dpr;
      this.cv.width = Math.round(r.width * dpr); this.cv.height = Math.round(r.height * dpr);
      this.cv.style.width = r.width + 'px'; this.cv.style.height = r.height + 'px';
      if (!this.v) this.fit();
      this.render();
    }
    xy(P) { return WT.projXY(P, this.proj); }
    sx(x) { return this.W / 2 + (x - this.v.cx) * this.v.s; }
    sy(y) { return this.H / 2 - (y - this.v.cy) * this.v.s; }
    toModel(px, py) { return [this.v.cx + (px - this.W / 2) / this.v.s, this.v.cy - (py - this.H / 2) / this.v.s]; }
    fit() {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const see = (x, y) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
      if (geo) {
        for (const [, P] of geo.pos) { const q = this.xy(P); see(q[0], q[1]); }
        for (const sg of geo.segs) { const c = sg[this.proj === 'plan' ? 'p' : 'e']; see(c[2], c[3]); }
        for (const st of sv.sketch[this.proj]) { const a = WT.strokeAbs(st, geo, this.proj); for (let k = 0; k < a.length; k += 2) see(a[k], a[k + 1]); }
      }
      if (!isFinite(x0)) { x0 = y0 = -5; x1 = y1 = 5; }
      const w = Math.max(x1 - x0, 4), h = Math.max(y1 - y0, 4);
      const s = Math.min((this.W - 40) / w, (this.H - 40) / h);
      this.v = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, s: Math.max(2, Math.min(400, s)) };
      this.requestRender();
    }
    center() {
      const P = geo && geo.pos.get(sv.cur);
      if (!P) return this.fit();
      const q = this.xy(P);
      let mx = 0, my = 0;
      for (const [, Q] of geo.pos) {
        if (Q.comp !== P.comp) continue;
        const r = this.xy(Q);
        mx = Math.max(mx, Math.abs(r[0] - q[0])); my = Math.max(my, Math.abs(r[1] - q[1]));
      }
      const m = 34, fx = mx > 1e-6 ? (this.W / 2 - m) / mx : Infinity, fy = my > 1e-6 ? (this.H / 2 - m) / my : Infinity;
      let s = Math.min(fx, fy);
      if (!isFinite(s)) s = Math.max(this.v.s, 20);
      this.v = { cx: q[0], cy: q[1], s: Math.max(0.5, Math.min(400, s)) };
      this.requestRender();
    }
    follow() {
      if (!this.v || !geo) return;
      const P = geo.pos.get(sv.cur); if (!P) return;
      const q = this.xy(P), x = this.sx(q[0]), y = this.sy(q[1]), m = 50;
      if (x < m || y < m || x > this.W - m || y > this.H - m) { this.v.cx = q[0]; this.v.cy = q[1]; }
      this.requestRender();
    }
    zoomAt(px, py, f) {
      const before = this.toModel(px, py);
      this.v.s = Math.max(0.5, Math.min(800, this.v.s * f));
      const after = this.toModel(px, py);
      this.v.cx += before[0] - after[0]; this.v.cy += before[1] - after[1];
      this.requestRender();
    }
    requestRender() { if (this.raf || !this.visible()) return; this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); }); }
    render() {
      if (!this.v || !this.visible()) return;
      const c = this.ctx, dpr = this.dpr || 1, W = this.W, H = this.H, s = this.v.s;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = '#fbfaf5'; c.fillRect(0, 0, W, H);
      // mriežka: vždy 1 m (pri veľkom oddialení slabne, pod 3 px na meter sa nekreslí)
      const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
      if (s >= 3) {
        const [mx0, my1] = this.toModel(0, 0), [mx1, my0] = this.toModel(W, H);
        c.globalAlpha = s < 10 ? (s - 3) / 7 : 1;
        c.lineWidth = 1; c.strokeStyle = '#e6e1d3'; c.beginPath();
        for (let x = Math.floor(mx0); x <= mx1; x += 1) { const X = Math.round(this.sx(x)) + 0.5; c.moveTo(X, 0); c.lineTo(X, H); }
        for (let y = Math.floor(my0); y <= my1; y += 1) { const Y = Math.round(this.sy(y)) + 0.5; c.moveTo(0, Y); c.lineTo(W, Y); }
        c.stroke(); c.globalAlpha = 1;
      }
      if (!geo) return;
      const key = this.proj === 'plan' ? 'p' : 'e';
      // zámery
      if (S.sketchSplays) {
        c.strokeStyle = '#9fb0bc'; c.lineWidth = 1; c.beginPath();
        for (const sg of geo.segs) if (sg.kind === 'splay') { const q = sg[key]; c.moveTo(this.sx(q[0]), this.sy(q[1])); c.lineTo(this.sx(q[2]), this.sy(q[3])); }
        c.stroke();
      }
      // náčrt
      c.lineCap = 'round'; c.lineJoin = 'round';
      for (const st of sv.sketch[this.proj]) this.drawStroke(WT.strokeAbs(st, geo, this.proj), st.col, st.w);
      if (this.stroke) this.drawStroke(this.stroke.pts, this.col, S.pen);
      // vybraný riadok tabuľky
      if (sel && sel.t === 'sh') {
        const sg = geo.segs.find(x => x.id === sel.id);
        if (sg) { const q = sg[key]; c.strokeStyle = 'rgba(2,136,209,.28)'; c.lineWidth = 9; c.beginPath(); c.moveTo(this.sx(q[0]), this.sy(q[1])); c.lineTo(this.sx(q[2]), this.sy(q[3])); c.stroke(); }
      }
      // ťahy
      c.strokeStyle = '#b3261e'; c.lineWidth = 2.2; c.beginPath();
      for (const sg of geo.segs) if (sg.kind === 'leg') { const q = sg[key]; c.moveTo(this.sx(q[0]), this.sy(q[1])); c.lineTo(this.sx(q[2]), this.sy(q[3])); }
      c.stroke();
      // vybraný riadok tabuľky farebne nad ťahmi
      if (sel && sel.t === 'sh') {
        const sg = geo.segs.find(x => x.id === sel.id);
        if (sg) { const q = sg[key]; c.strokeStyle = '#0288d1'; c.lineWidth = sg.kind === 'leg' ? 3.4 : 2.2; c.beginPath(); c.moveTo(this.sx(q[0]), this.sy(q[1])); c.lineTo(this.sx(q[2]), this.sy(q[3])); c.stroke(); }
      }
      // stanice
      const showLabels = S.labels && s >= 6;
      c.font = '600 12px system-ui, sans-serif'; c.textBaseline = 'middle';
      for (const [name, P] of geo.pos) {
        const q = this.xy(P), X = this.sx(q[0]), Y = this.sy(q[1]);
        if (X < -40 || Y < -40 || X > W + 40 || Y > H + 40) continue;
        const isCur = name === sv.cur;
        if (sel && sel.t === 'st' && sel.name === name) {
          c.fillStyle = 'rgba(2,136,209,.16)'; c.strokeStyle = 'rgba(2,136,209,.55)'; c.lineWidth = 1.5;
          c.beginPath(); c.arc(X, Y, 14, 0, Math.PI * 2); c.fill(); c.stroke();
        }
        c.fillStyle = isCur ? '#0277bd' : '#b3261e';
        c.beginPath(); c.arc(X, Y, isCur ? 4.5 : 3, 0, Math.PI * 2); c.fill();
        if (isCur) { c.strokeStyle = '#0277bd'; c.lineWidth = 2; c.beginPath(); c.arc(X, Y, 10, 0, Math.PI * 2); c.stroke(); }
        if (showLabels || isCur) {
          c.lineWidth = 3; c.strokeStyle = 'rgba(251,250,245,.9)'; c.strokeText(name, X + 7, Y - 9);
          c.fillStyle = isCur ? '#01579b' : '#5d4037'; c.fillText(name, X + 7, Y - 9);
        }
      }
      if (!geo.pos.size) {
        c.fillStyle = '#7b8a97'; c.font = '14px system-ui, sans-serif'; c.textAlign = 'center';
        c.fillText('Zatiaľ žiadne merania', W / 2, H / 2); c.textAlign = 'left';
      }
      // mierka a sever
      const bar = steps.find(x => x * s >= 60) || 1000, bw = bar * s;
      c.fillStyle = '#37474f'; c.fillRect(12, H - 18, bw, 4);
      c.font = '12px system-ui, sans-serif'; c.fillText(bar + ' m', 12, H - 28);
      if (this.proj === 'plan') {
        c.save(); c.translate(W - 22, 28); c.fillStyle = '#37474f';
        c.beginPath(); c.moveTo(0, -12); c.lineTo(5.5, 6); c.lineTo(0, 2.5); c.lineTo(-5.5, 6); c.closePath(); c.fill();
        c.font = '700 10px system-ui, sans-serif'; c.textAlign = 'center'; c.fillText('S', 0, 16); c.restore(); c.textAlign = 'left';
      } else {
        c.fillStyle = '#607d8b'; c.font = '11px system-ui, sans-serif'; c.fillText('rozvinutý rez', W - 88, 18);
      }
    }
    drawStroke(a, col, w) {
      const c = this.ctx;
      c.strokeStyle = c.fillStyle = PEN[col] || '#141414';
      c.lineWidth = (w || 2) * Math.max(0.6, Math.min(2.5, this.v.s / 40));
      if (a.length === 2) { c.beginPath(); c.arc(this.sx(a[0]), this.sy(a[1]), c.lineWidth * 0.9, 0, Math.PI * 2); c.fill(); return; }
      c.beginPath(); c.moveTo(this.sx(a[0]), this.sy(a[1]));
      for (let k = 2; k < a.length; k += 2) c.lineTo(this.sx(a[k]), this.sy(a[k + 1]));
      c.stroke();
    }
    pt(e) { const r = this.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    down(e) {
      e.preventDefault();
      this.cv.setPointerCapture(e.pointerId);
      const p = this.pt(e);
      this.ptrs.set(e.pointerId, p);
      if (this.ptrs.size === 1) {
        this.tap = { x: p.x, y: p.y, t: performance.now(), moved: false };
        this.blocked = false;
        if (this.tool === 'pen') this.stroke = { pts: this.toModel(p.x, p.y), last: p, t: performance.now(), len: 0 };
        else if (this.tool === 'erase') { this.eraseSnap = sv.sketch[this.proj].slice(); this.eraseAt(p); }
        this.panLast = p;
      } else if (this.ptrs.size === 2) {
        if (this.stroke) { if (this.stroke.len > 60 && performance.now() - this.stroke.t > 400) this.commitStroke(); this.stroke = null; }
        const [a, b] = [...this.ptrs.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        this.blocked = true;
        this.requestRender();
      }
    }
    move(e) {
      if (!this.ptrs.has(e.pointerId)) return;
      const p = this.pt(e), prev = this.ptrs.get(e.pointerId);
      this.ptrs.set(e.pointerId, p);
      if (this.tap && Math.hypot(p.x - this.tap.x, p.y - this.tap.y) > 8) this.tap.moved = true;
      if (this.ptrs.size >= 2 && this.pinch) {
        const [a, b] = [...this.ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.v.cx -= (m.x - this.pinch.m.x) / this.v.s; this.v.cy += (m.y - this.pinch.m.y) / this.v.s;
        this.zoomAt(m.x, m.y, d / this.pinch.d);
        this.pinch = { d, m };
        return;
      }
      if (this.blocked) return;
      if (this.tool === 'pen' && this.stroke) {
        const st = this.stroke, dd = Math.hypot(p.x - st.last.x, p.y - st.last.y);
        if (dd < 2.5) return;
        const q = this.toModel(p.x, p.y);
        st.pts.push(q[0], q[1]); st.len += dd;
        const c = this.ctx; c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        c.strokeStyle = PEN[this.col]; c.lineCap = 'round';
        c.lineWidth = S.pen * Math.max(0.6, Math.min(2.5, this.v.s / 40));
        c.beginPath(); c.moveTo(st.last.x, st.last.y); c.lineTo(p.x, p.y); c.stroke();
        st.last = p;
      } else if (this.tool === 'erase') this.eraseAt(p);
      else { this.v.cx -= (p.x - prev.x) / this.v.s; this.v.cy += (p.y - prev.y) / this.v.s; this.requestRender(); }
    }
    up(e, cancel) {
      if (!this.ptrs.has(e.pointerId)) return;
      this.ptrs.delete(e.pointerId);
      if (this.ptrs.size < 2) this.pinch = null;
      if (this.ptrs.size) return;
      const tap = !cancel && this.tap && !this.tap.moved && !this.blocked && performance.now() - this.tap.t < 350;
      const hit = tap && this.tool !== 'erase' ? this.stationAt(this.tap) : null;
      if (hit) this.stroke = null;
      else if (this.stroke && !cancel && !this.blocked) this.commitStroke();
      this.stroke = null;
      if (this.tool === 'erase' && this.eraseSnap) {
        if (this.eraseSnap.length !== sv.sketch[this.proj].length) { this.pushUndo(this.eraseSnap); changed(); }
        this.eraseSnap = null;
      }
      this.tap = null; this.blocked = false;
      this.requestRender();
      if (hit) { select({ t: 'st', name: hit }); stationMenu(hit); }
      else if (tap && sel) select(null);
    }
    commitStroke() {
      const st = this.stroke; if (!st || st.pts.length < 2) return;
      if (st.pts.length === 2 && performance.now() - st.t < 120) return; // náhodný dotyk
      this.pushUndo(sv.sketch[this.proj].slice());
      sv.sketch[this.proj].push(WT.makeStroke(st.pts.map(v => +v.toFixed(3)), this.col, geo, this.proj, S.pen !== 2 ? S.pen : undefined));
      this.stroke = null;
      changed();
    }
    pushUndo(snap) { this.undo.push(snap); if (this.undo.length > 60) this.undo.shift(); }
    doUndo() {
      if (!this.undo.length) { toast('Nie je čo vrátiť'); return; }
      sv.sketch[this.proj] = this.undo.pop(); changed();
    }
    eraseAt(p) {
      const list = sv.sketch[this.proj], r = 14;
      const keep = list.filter(st => {
        const a = WT.strokeAbs(st, geo, this.proj);
        for (let k = 0; k < a.length; k += 2) {
          const x1 = this.sx(a[k]), y1 = this.sy(a[k + 1]);
          if (k + 2 >= a.length) { if (Math.hypot(p.x - x1, p.y - y1) < r) return false; continue; }
          const x2 = this.sx(a[k + 2]), y2 = this.sy(a[k + 3]);
          const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
          const t = L ? Math.max(0, Math.min(1, ((p.x - x1) * dx + (p.y - y1) * dy) / L)) : 0;
          if (Math.hypot(p.x - (x1 + t * dx), p.y - (y1 + t * dy)) < r) return false;
        }
        return true;
      });
      if (keep.length !== list.length) { sv.sketch[this.proj] = keep; this.requestRender(); }
    }
    stationAt(p) {
      if (!geo) return null;
      let best = null, bd = 26;
      for (const [name, P] of geo.pos) { const q = this.xy(P), d = Math.hypot(this.sx(q[0]) - p.x, this.sy(q[1]) - p.y); if (d < bd) { bd = d; best = name; } }
      return best;
    }
  }

  // ============================== dialógy ==============================
  const mbtn = (id, main, sub, o) => '<button class="mbtn' + (o && o.on ? ' on' : '') + (o && o.bad ? ' bad' : '') + '" data-a="' + id + '"' + (o && o.dis ? ' disabled' : '') +
    '><b>' + esc(main) + '</b><small>' + esc(sub) + '</small></button>';
  const extToast = (dir, all, n, leg) => {
    const w = dir > 0 ? 'vpravo ›' : '‹ vľavo';
    if (!all) toast('Ťah ' + leg.from + ' – ' + leg.to + ' rozvinutý ' + w);
    else toast('Odtiaľ ' + n + (n === 1 ? ' ťah rozvinutý ' : n < 5 ? ' ťahy rozvinuté ' : ' ťahov rozvinutých ') + w);
  };
  // Menu bodu: ťuknutie na bod v náčrte alebo šípka pri riadku ťahu (rowLeg = ťah z riadku).
  function stationMenu(name, rowLeg) {
    const inc = WT.incoming(sv, name, geo);
    const leg = rowLeg || (inc && inc.leg);
    const from = rowLeg ? rowLeg.from : inc && inc.from;
    const ext = leg ? (leg.ext >= 0 ? 1 : -1) : 0;
    let body = '<div class="mgrid r3">' +
      mbtn('rev', 'Otočiť ťah', leg ? leg.from + ' – ' + leg.to : 'bez ťahu', { dis: !leg }) +
      mbtn('cont', 'Pokračovať', 'z ' + name, { on: sv.cur === name }) +
      mbtn('ren', 'Premenovať', name) + '</div>' +
      '<div class="mgrid r4">' +
      mbtn('l1', '‹ Rozvinúť', 'vľavo', { dis: !leg, on: ext < 0 }) +
      mbtn('r1', 'Rozvinúť ›', 'vpravo', { dis: !leg, on: ext > 0 }) +
      mbtn('la', '‹ Všetko', 'odtiaľ vľavo') +
      mbtn('ra', 'Všetko ›', 'odtiaľ vpravo') + '</div>';
    if (rowLeg) {
      const nr = rowLeg.raw ? rowLeg.raw.length : 0;
      body += '<div class="mgrid r3">' +
        mbtn('edit', 'Upraviť', rowLeg.c ? '✎ poznámka' : 'aj poznámku') +
        mbtn('split', 'Rozdeliť', nr > 1 ? 'na ' + nr + ' zámery' : 'jedno meranie', { dis: nr < 2 }) +
        mbtn('del', 'Vymazať', 'riadok', { bad: true }) + '</div>';
    }
    const m = modal('Bod ' + name, body, [], { sub: from ? 'z bodu ' + from : (name === sv.start ? 'počiatočný bod' : '') });
    m.el.classList.add('compact');
    m.el.querySelector('.sh-b').addEventListener('click', async e => {
      const b = e.target.closest('button[data-a]'); if (!b || b.disabled) return;
      const a = b.dataset.a;
      close(m);
      if (a === 'rev') { snap(); WT.reverseShot(sv, leg.id); changed(); toast('Ťah teraz ' + leg.from + ' → ' + leg.to); }
      else if (a === 'cont') { snap(); WT.setCurrent(sv, name); changed(); toast('Pokračuješ z ' + name); }
      else if (a === 'ren') renameDialog(name);
      else if (a === 'edit') editDialog(rowLeg);
      else if (a === 'split') { snap(); WT.splitLeg(sv, rowLeg.id); changed(); }
      else if (a === 'del') { if (await confirmBox('Vymazať riadok ' + rowLeg.from + ' → ' + rowLeg.to + '?', 'Vymazať')) { snap(); WT.deleteShot(sv, rowLeg.id); changed(); } }
      else {
        const dir = a[0] === 'r' ? 1 : -1, all = a[1] === 'a';
        snap();
        let n = 1;
        if (all) n = WT.setExtend(sv, name, dir, true);
        if (leg && (!all || rowLeg)) WT.setLegExt(sv, leg.id, dir);
        changed();
        extToast(dir, all, n, leg);
      }
    });
  }
  function splayMenu(sh) {
    const to = sh.from === sv.cur ? sv.next : WT.suggestNext(sv, sh.from);
    const body = '<div class="mgrid r4">' +
      mbtn('leg', 'Na ťah', sh.from + ' → ' + to) +
      mbtn('cont', 'Pokračovať', 'z ' + sh.from, { on: sv.cur === sh.from }) +
      mbtn('edit', 'Upraviť', sh.c ? '✎ poznámka' : 'aj poznámku') +
      mbtn('del', 'Vymazať', 'riadok', { bad: true }) + '</div>';
    const m = modal('Zámer z ' + sh.from, body, [], { sub: WT.fmt(sh.d, 2) + ' m · ' + WT.fmt(+WT.fmtAz(sh.a), 1) + '° · ' + WT.fmt(sh.i, 1) + '°' });
    m.el.classList.add('compact');
    m.el.querySelector('.sh-b').addEventListener('click', async e => {
      const b = e.target.closest('button[data-a]'); if (!b || b.disabled) return;
      const a = b.dataset.a;
      close(m);
      if (a === 'leg') { snap(); WT.makeLeg(sv, sh.id, to); changed(); toast('Ťah ' + sh.from + ' → ' + to); }
      else if (a === 'cont') { snap(); WT.setCurrent(sv, sh.from); changed(); toast('Pokračuješ z ' + sh.from); }
      else if (a === 'edit') editDialog(sh);
      else if (a === 'del') { if (await confirmBox('Vymazať zámer z ' + sh.from + '?', 'Vymazať')) { snap(); WT.deleteShot(sv, sh.id); changed(); } }
    });
  }
  function renameDialog(name) {
    modal('Premenovať stanicu', '<label>Nový názov pre ' + esc(name) + '<input id="rnTo" autofocus autocapitalize="off" autocomplete="off" value="' + esc(name) + '"></label>', [
      { label: 'Zrušiť' },
      { label: 'Premenovať', cls: 'pri', onClick: el => {
        const to = el.querySelector('#rnTo').value.trim();
        if (!validName(to)) throw new Error('Názov môže mať len písmená bez diakritiky, číslice, bodku, - a _');
        if (WT.stationNames(sv).has(to) && to !== name) throw new Error('Stanica ' + to + ' už existuje');
        snap(); const n = WT.renameStation(sv, name, to); changed(); toast('Premenované (' + n + '×)');
      } }
    ]);
  }
  function stationDialog() {
    const names = [...WT.stationNames(sv)];
    const recent = [];
    for (let k = sv.shots.length - 1; k >= 0 && recent.length < 8; k--) for (const n of [sv.shots[k].to, sv.shots[k].from]) if (n && recent.indexOf(n) < 0 && recent.length < 8) recent.push(n);
    const body = '<datalist id="stList">' + names.map(n => '<option value="' + esc(n) + '">').join('') + '</datalist>' +
      '<div class="grid2"><label>Od (aktuálna)<input id="sdCur" list="stList" autocapitalize="off" autocomplete="off" value="' + esc(sv.cur) + '"></label>' +
      '<label>Do (ďalšia)<input id="sdNext" autocapitalize="off" autocomplete="off" value="' + esc(sv.next) + '"></label></div>' +
      (recent.length ? '<div class="chips">' + recent.map(n => '<button class="chip" data-n="' + esc(n) + '">' + esc(n) + '</button>').join('') + '</div>' : '') +
      '<label>Smer nového ťahu v reze<select id="sdExt"><option value="1">› doprava</option><option value="-1">‹ doľava</option></select></label>' +
      '<p class="muted">Ťuknutím na stanicu ju nastavíš ako „Od“. Názov „Do“ sa navrhne sám (z inej ako poslednej stanice začne novú sériu).</p>';
    const m = modal('Stanice', body, [
      { label: 'Zrušiť' },
      { label: 'Uložiť', cls: 'pri', onClick: el => {
        const cur = el.querySelector('#sdCur').value.trim(), nx = el.querySelector('#sdNext').value.trim();
        if (!validName(cur) || !validName(nx)) throw new Error('Názov môže mať len písmená bez diakritiky, číslice, bodku, - a _');
        if (cur === nx) throw new Error('Od a Do musia byť rôzne');
        snap();
        if (cur !== sv.cur) WT.setCurrent(sv, cur);
        sv.next = nx; sv.ext = +el.querySelector('#sdExt').value;
        changed();
      } }
    ]);
    const el = m.el;
    el.querySelector('#sdExt').value = String(sv.ext >= 0 ? 1 : -1);
    el.querySelectorAll('.chip').forEach(b => b.onclick = () => {
      el.querySelector('#sdCur').value = b.dataset.n;
      el.querySelector('#sdNext').value = WT.suggestNext(sv, b.dataset.n);
    });
    el.querySelector('#sdCur').addEventListener('change', e => { const v = e.target.value.trim(); if (v) el.querySelector('#sdNext').value = WT.suggestNext(sv, v); });
  }

  function shotForm(sh, isNew) {
    const names = [...WT.stationNames(sv)];
    return '<datalist id="stList2">' + names.map(n => '<option value="' + esc(n) + '">').join('') + '</datalist>' +
      '<div class="grid2">' +
      '<label>Od<input id="fFrom" list="stList2" autocapitalize="off" autocomplete="off" value="' + esc(sh.from) + '"></label>' +
      '<label>Do <small>(prázdne = zámer)</small><input id="fTo" list="stList2" autocapitalize="off" autocomplete="off" value="' + esc(sh.to) + '"></label>' +
      '<label>Dĺžka [m]<input id="fD" inputmode="decimal" ' + (isNew ? 'autofocus ' : '') + 'value="' + (isNew ? '' : WT.fmt(sh.d, 3)) + '"></label>' +
      '<label>Azimut [°]<input id="fA" inputmode="decimal" value="' + (isNew ? '' : WT.fmtAz(sh.a)) + '"></label>' +
      '<label>Sklon [°]<input id="fI" inputmode="decimal" value="' + (isNew ? '' : WT.fmt(sh.i, 2)) + '"></label>' +
      '<label>Rez<select id="fE"><option value="1">› doprava</option><option value="-1">‹ doľava</option></select></label>' +
      '</div><label>Poznámka<input id="fC" value="' + esc(sh.c || '') + '"></label>' +
      (sh.raw ? '<p class="muted mono">Merania ťahu:<br>' + sh.raw.map(r => WT.fmt(r[0], 3) + ' m  ' + WT.fmtAz(r[1]) + '°  ' + WT.fmt(r[2], 2) + '°').join('<br>') + '</p>' : '');
  }
  function readForm(el) {
    const v = { from: el.querySelector('#fFrom').value.trim(), to: el.querySelector('#fTo').value.trim(),
      d: num(el.querySelector('#fD').value), a: num(el.querySelector('#fA').value), i: num(el.querySelector('#fI').value),
      ext: +el.querySelector('#fE').value, c: el.querySelector('#fC').value.trim() };
    if (!validName(v.from) || (v.to && !validName(v.to))) throw new Error('Názov stanice: len písmená bez diakritiky, číslice, bodka, - a _');
    if (v.to === v.from) throw new Error('Od a Do musia byť rôzne');
    if (!(v.d >= 0) || !(v.a >= 0 && v.a <= 360) || !(v.i >= -90 && v.i <= 90)) throw new Error('Skontroluj hodnoty: dĺžka ≥ 0, azimut 0–360°, sklon −90 až 90°');
    v.a = WT.norm360(v.a);
    return v;
  }
  function editDialog(sh) {
    const m = modal('Upraviť meranie', shotForm(sh, false), [
      { label: 'Zrušiť' },
      { label: 'Uložiť', cls: 'pri', onClick: el => {
        const v = readForm(el);
        snap(); applyShotEdit(sh, v);
        changed();
      } }
    ]);
    m.el.querySelector('#fE').value = String(sh.ext >= 0 ? 1 : -1);
  }
  function deviceDialog() {
    const caps = '<div class="caps"><span class="' + (hasSerial() ? 'y' : 'n') + '">Web Serial ' + (hasSerial() ? '✓' : '✗') + '</span>' +
      '<span class="' + (hasBle() ? 'y' : 'n') + '">Web Bluetooth ' + (hasBle() ? '✓' : '✗') + '</span></div>';
    const opts = Object.keys(DEV_TYPES).map(k => {
      const t = DEV_TYPES[k], ok = t.api === 'none' || (t.api === 'serial' ? hasSerial() : hasBle());
      return '<label class="radio' + (ok ? '' : ' dis') + '"><input type="radio" name="dt" value="' + k + '"' + (S.devType === k ? ' checked' : '') + '><span><b>' + t.label + '</b><small>' + t.sub + '</small></span></label>';
    }).join('');
    const body = caps + '<p id="devState" class="state"></p>' + '<div class="radios">' + opts + '</div>' +
      '<div class="note" id="dtNote"></div>' +
      '<label class="check" id="dAllL"><input type="checkbox" id="dAll"> Ukázať všetky sériové zariadenia (ak DistoX v zozname chýba)</label>' +
      '<label class="check"><input type="checkbox" id="dAuto"' + (S.autoRe ? ' checked' : '') + '> Automaticky sa znovu pripájať</label>' +
      '<div class="row gap"><button class="btn" id="dLon">Laser zap.</button><button class="btn" id="dLoff">Laser vyp.</button><button class="btn" id="dShot">Meraj</button><button class="btn" id="dSimAuto">Sim. auto</button></div>' +
      '<details><summary>Denník komunikácie</summary><pre id="devLog" class="log"></pre></details>';
    const m = modal('Prístroj', body, [
      { label: 'Odpojiť', onClick: async () => { if (dev) await dev.disconnect(); return false; } },
      { label: 'Pripojiť', cls: 'pri', onClick: async el => {
        const type = (el.querySelector('input[name=dt]:checked') || {}).value || 'distox2';
        S.devType = type; S.autoRe = el.querySelector('#dAuto').checked; saveSettings();
        if (dev && (dev.type !== type || dev.state === 'off')) { try { await dev.disconnect(); } catch (e) { /* */ } dev = null; }
        if (!dev) dev = makeDev(type);
        try { await dev.connect(true, { all: el.querySelector('#dAll').checked }); }
        catch (e) {
          if (e && e.name === 'NotFoundError') { toast('Nevybral si žiadne zariadenie'); dev = null; renderDev(); return false; }
          dev = null; renderDev(); throw e;
        }
        renderDev(); return false;
      } }
    ]);
    const el = m.el;
    const note = () => {
      const type = (el.querySelector('input[name=dt]:checked') || {}).value;
      const n = {
        distox2: 'DistoX najprv spáruj v Nastaveniach Androidu → Bluetooth (PIN 0000). Potom Pripojiť a vyber ho zo zoznamu.',
        distoxble: 'Nespárovať v systéme – stačí zapnúť Bluetooth na DistoX a vybrať ho zo zoznamu.',
        bric: 'BRIC posiela merania s indexom – opakované merania po pripojení sa ignorujú.',
        auto: 'Zobrazí všetky BLE zariadenia v okolí; protokol sa zistí podľa služieb.',
        sim: 'Simulátor generuje merania ako skutočný prístroj (zámery + 3 zhodné merania = ťah).'
      }[type] || '';
      el.querySelector('#dtNote').textContent = n;
      el.querySelector('#dSimAuto').style.display = type === 'sim' ? '' : 'none';
      el.querySelector('#dAllL').style.display = type === 'distox2' ? '' : 'none';
    };
    el.querySelectorAll('input[name=dt]').forEach(r => r.onchange = note);
    note();
    el.querySelector('#dLon').onclick = () => dev && dev.command('laserOn');
    el.querySelector('#dLoff').onclick = () => dev && dev.command('laserOff');
    el.querySelector('#dShot').onclick = () => doShot();
    el.querySelector('#dSimAuto').onclick = () => { if (dev && dev.auto) { dev._auto = !dev._auto; dev.auto(dev._auto); toast(dev._auto ? 'Simulátor meria každé 1,5 s' : 'Simulátor zastavený'); } };
    el.querySelector('#dAuto').onchange = e => { S.autoRe = e.target.checked; saveSettings(); };
    devLog('—');
    renderDev();
  }

  function surveyProps() {
    const f = sv.fix || {};
    const body = '<label>Názov<input id="pName" value="' + esc(sv.name) + '"></label>' +
      '<div class="grid2"><label>Dátum<input id="pDate" type="date" value="' + esc(sv.date) + '"></label>' +
      '<label>Deklinácia [°]<input id="pDecl" inputmode="decimal" value="' + WT.fmt(+sv.decl || 0, 2) + '"></label></div>' +
      '<label>Tím <small>(oddeľ čiarkou)</small><input id="pTeam" value="' + esc(sv.team) + '"></label>' +
      '<label>Počiatočná stanica<input id="pStart" autocapitalize="off" value="' + esc(sv.start) + '"></label>' +
      '<label>Poznámka<textarea id="pCom" rows="2">' + esc(sv.comment) + '</textarea></label>' +
      '<details' + (sv.fix ? ' open' : '') + '><summary>Pevný bod (fix) pre Therion</summary><div class="grid2">' +
      '<label>Stanica<input id="fxSt" autocapitalize="off" value="' + esc(f.st || '') + '"></label><label>X<input id="fxX" inputmode="decimal" value="' + esc(f.x == null ? '' : f.x) + '"></label>' +
      '<label>Y<input id="fxY" inputmode="decimal" value="' + esc(f.y == null ? '' : f.y) + '"></label><label>Z<input id="fxZ" inputmode="decimal" value="' + esc(f.z == null ? '' : f.z) + '"></label></div></details>';
    modal('Vlastnosti prieskumu', body, [
      { label: 'Zrušiť' },
      { label: 'Uložiť', cls: 'pri', onClick: el => {
        const g = id => el.querySelector(id).value.trim();
        const decl = num(g('#pDecl') || '0');
        if (!isFinite(decl)) throw new Error('Deklinácia musí byť číslo');
        if (g('#pStart') && !validName(g('#pStart'))) throw new Error('Neplatný názov počiatočnej stanice');
        sv.name = g('#pName') || sv.name; sv.date = g('#pDate') || sv.date; sv.decl = decl;
        sv.team = g('#pTeam'); sv.start = g('#pStart') || sv.start; sv.comment = el.querySelector('#pCom').value;
        if (g('#fxSt')) {
          const x = num(g('#fxX')), y = num(g('#fxY')), z = num(g('#fxZ'));
          if (![x, y, z].every(isFinite)) throw new Error('Súradnice fixu musia byť čísla');
          sv.fix = { st: g('#fxSt'), x, y, z };
        } else sv.fix = null;
        changed(true);
      } }
    ]);
  }

  async function surveysDialog() {
    await save(true);
    const list = (await DB.all()).sort((a, b) => b.modified - a.modified);
    const rows = list.map(s => {
      const st = WT.stats(s);
      return '<div class="svrow' + (s.id === sv.id ? ' on' : '') + '" data-id="' + s.id + '"><div class="t"><b>' + esc(s.name) + '</b><small>' + esc(s.date) + ' · ' + st.legs + ' ťahov · ' + WT.fmt(st.len, 1) + ' m</small></div>' +
        '<button class="btn sm" data-a="open">Otvoriť</button><button class="btn sm bad" data-a="del">✕</button></div>';
    }).join('');
    const m = modal('Prieskumy', '<div class="svlist">' + rows + '</div>', [
      { label: 'Nový prieskum', cls: 'pri', onClick: () => { newSurveyDialog(); } }
    ]);
    m.el.querySelectorAll('.svrow').forEach(r => r.onclick = async e => {
      const a = e.target.dataset.a, id = r.dataset.id;
      if (a === 'del') {
        const s = list.find(x => x.id === id);
        if (!(await confirmBox('Natrvalo vymazať prieskum „' + s.name + '“? (Najprv si urob export.)', 'Vymazať'))) return;
        await DB.del(id);
        if (id === sv.id) {
          const rest = list.filter(x => x.id !== id);
          await openSurvey(rest[0] || WT.newSurvey('Prieskum ' + WT.isoDate(Date.now())), !rest[0]);
        }
        close(m); surveysDialog();
      } else {
        const s = await DB.get(id); close(m); await openSurvey(s);
      }
    });
  }
  function newSurveyDialog() {
    modal('Nový prieskum', '<label>Názov<input id="nName" autofocus value="Prieskum ' + WT.isoDate(Date.now()) + '"></label>' +
      '<label>Prvá stanica<input id="nSt" autocapitalize="off" value="1.0"></label>', [
      { label: 'Zrušiť' },
      { label: 'Vytvoriť', cls: 'pri', onClick: async el => {
        const st = el.querySelector('#nSt').value.trim() || '1.0';
        if (!validName(st)) throw new Error('Neplatný názov stanice');
        const s = WT.newSurvey(el.querySelector('#nName').value.trim() || 'Prieskum');
        WT.setCurrent(s, st);
        await openSurvey(s, true);
      } }
    ]);
  }
  async function openSurvey(s, isNew) {
    if (sv && !isNew) await save(true);
    sv = WT.normalizeSurvey(s);
    geo = WT.compute(sv);
    try { localStorage.setItem('wt.last', sv.id); } catch (e) { /* */ }
    if (isNew) await save(true);
    planView.undo = []; elevView.undo = []; sel = null; undoData = []; editing = null;
    planView.v = null; elevView.v = null;
    planView.resize(); elevView.resize();
    renderAll(); scrollTableEnd();
  }

  // ---------------- export / import ----------------
  function download(name, data, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  async function share(name, data, mime) {
    const file = new File([data], name, { type: mime || 'application/octet-stream' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); } catch (e) { if (e.name !== 'AbortError') toast('Zdieľanie zlyhalo: ' + e.message, 'bad'); }
    } else download(name, data, mime);
  }
  function exportDialog() {
    const b = WT.safeName(sv.name);
    const items = [
      { id: 'zip', label: 'Balík pre Therion (.zip)', sub: '.th, .th2 + .xvi pre xtherion, PocketTopo .txt, záloha' },
      { id: 'th', label: 'Therion centreline (.th)', sub: 'ťahy, zámery, extend, dátum' },
      { id: 'txt', label: 'PocketTopo export (.txt)', sub: 'rovnaký formát ako „Export Therion“ z PocketTopo' },
      { id: 'json', label: 'Záloha WebTopo (.json)', sub: 'všetko vrátane náčrtu a denníka meraní' }
    ];
    const canShareFiles = !!(navigator.canShare && window.File && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] }));
    const body = '<div class="exlist">' + items.map(x => '<div class="exrow"><div class="t"><b>' + x.label + '</b><small>' + x.sub + '</small></div>' +
      '<button class="btn sm" data-x="' + x.id + '" data-m="dl">Stiahnuť</button>' + (canShareFiles ? '<button class="btn sm pri" data-x="' + x.id + '" data-m="sh">Zdieľať</button>' : '') + '</div>').join('') + '</div>';
    const m = modal('Export', body, []);
    m.el.querySelectorAll('button[data-x]').forEach(bt => bt.onclick = async () => {
      await save(true);
      const x = bt.dataset.x; let name, data, mime = 'text/plain';
      if (x === 'zip') { name = (b.indexOf(sv.date) >= 0 ? b : b + '_' + sv.date) + '.zip'; data = WT.zip(WT.therionBundle(sv)); mime = 'application/zip'; }
      else if (x === 'th') { name = b + '.th'; data = WT.toTherion(sv); }
      else if (x === 'txt') { name = b + '_pockettopo.txt'; data = WT.toPocketTopo(sv); }
      else { name = b + '.webtopo.json'; data = JSON.stringify(sv); mime = 'application/json'; }
      if (bt.dataset.m === 'sh') await share(name, data, mime); else download(name, data, mime);
    });
  }
  function importFile() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,.txt,.top,application/json,text/plain';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try {
        if (/\.top$/i.test(f.name)) throw new Error('Binárny .top zatiaľ neviem – v PocketTopo použi Export → Therion (.txt)');
        const text = await f.text();
        const s = text.trim()[0] === '{' ? WT.fromJSON(text) : WT.fromPocketTopo(text, f.name.replace(/\.[^.]+$/, ''));
        if (!s.shots.length) throw new Error('V súbore som nenašiel žiadne merania');
        if (text.trim()[0] === '{') s.id = WT.uid();
        await openSurvey(s, true);
        closeAll();
        toast('Načítané: ' + WT.stats(s).legs + ' ťahov, ' + (s.sketch.plan.length + s.sketch.elev.length) + ' čiar náčrtu', 'ok');
      } catch (e) { toast('Import zlyhal: ' + e.message, 'bad'); }
    };
    inp.click();
  }

  function settingsDialog() {
    const body = '<div class="grid2"><label>Tolerancia dĺžky [m]<input id="sTolD" inputmode="decimal" value="' + S.tolD + '"></label>' +
      '<label>Tolerancia uhla [°]<input id="sTolA" inputmode="decimal" value="' + S.tolA + '"></label></div>' +
      '<label>Ťah = koľko zhodných meraní za sebou<select id="sLeg"><option value="3">3 (ako PocketTopo)</option><option value="2">2</option><option value="0">vypnuté (ťahy ručne)</option></select></label>' +
      '<label>Odbočka zo staršej stanice<select id="sBr"><option value="series">nová séria (1.3 → 2.1)</option><option value="continue">pokračovať číslovanie</option></select></label>' +
      '<label>Písmo tabuľky<select id="sFont"><option value="s">malé</option><option value="m">stredné</option><option value="l">veľké</option></select></label>' +
      '<label>Hrúbka pera<select id="sPen"><option value="1">tenké</option><option value="2">stredné</option><option value="3">hrubé</option></select></label>' +
      '<label class="check"><input type="checkbox" id="sSound"' + (S.sound ? ' checked' : '') + '> Zvuk pri meraní</label>' +
      '<label class="check"><input type="checkbox" id="sVib"' + (S.vib ? ' checked' : '') + '> Vibrácia pri meraní</label>' +
      '<label class="check"><input type="checkbox" id="sSpl"' + (S.sketchSplays ? ' checked' : '') + '> Zámery v náčrte</label>' +
      '<label class="check"><input type="checkbox" id="sLbl"' + (S.labels ? ' checked' : '') + '> Názvy staníc v náčrte</label>' +
      '<label class="check"><input type="checkbox" id="sHide"' + (S.hideSplays ? ' checked' : '') + '> Skryť zámery v tabuľke</label>';
    const m = modal('Nastavenia', body, [
      { label: 'Zrušiť' },
      { label: 'Uložiť', cls: 'pri', onClick: el => {
        const tolD = num(el.querySelector('#sTolD').value), tolA = num(el.querySelector('#sTolA').value);
        if (!(tolD > 0 && tolD < 1) || !(tolA > 0 && tolA < 10)) throw new Error('Tolerancie: dĺžka 0–1 m, uhol 0–10°');
        Object.assign(S, { tolD, tolA, legShots: +el.querySelector('#sLeg').value, branch: el.querySelector('#sBr').value,
          font: el.querySelector('#sFont').value, pen: +el.querySelector('#sPen').value,
          sound: el.querySelector('#sSound').checked, vib: el.querySelector('#sVib').checked, sketchSplays: el.querySelector('#sSpl').checked,
          labels: el.querySelector('#sLbl').checked, hideSplays: el.querySelector('#sHide').checked });
        saveSettings(); sv.branch = S.branch; sv.next = WT.suggestNext(sv, sv.cur); renderAll();
      } }
    ]);
    const el = m.el;
    el.querySelector('#sLeg').value = String(S.legShots); el.querySelector('#sBr').value = S.branch;
    el.querySelector('#sFont').value = S.font; el.querySelector('#sPen').value = String(S.pen);
  }

  function helpDialog() {
    modal('Ako to funguje', '<div class="help">' +
      '<p><b>Pripojenie.</b> Ťukni na <i>Pripojiť</i> vpravo hore. DistoX2 najprv spáruj v systéme (PIN 0000), BLE prístroje nie. Funguje v Chrome na Androide; iPhone nemá Web Serial ani Web Bluetooth.</p>' +
      '<p><b>Meranie.</b> Každé meranie je zámer z aktuálnej stanice (Od). Tri zhodné merania za sebou (±5 cm, ±1,7°) sa spoja do ťahu Od → Do a aktuálnou stanicou sa stane Do. Štvrté zhodné meranie ťah len spresní.</p>' +
      '<p><b>Stanice.</b> Ťukni na pásik „Od → Do“: nastavíš, odkiaľ pokračuješ, a názov ďalšej stanice. Z inej ako poslednej stanice začne nová séria (1.3 → 2.1).</p>' +
      '<p><b>Tabuľka.</b> Ťuknutie na riadok ho označí (aj v náčrte). Šípka ▸ pred riadkom otvorí menu bodu: otočiť ťah, rozvinúť, pokračovať, premenovať, upraviť, rozdeliť, vymazať. Dvojklik alebo dlhé podržanie na hodnote ju priamo upraví (na ‹ › prepne smer v reze). Posledný riadok je nové meranie ručne z aktuálnej stanice: Do (prázdne = zámer), dĺžka, azimut, sklon, Enter alebo +. Ikona ↶ vráti posledný krok v dátach.</p>' +
      '<p><b>Náčrt.</b> Pôdorys a rozvinutý rez. Predvolene posun: jedným prstom posúvaš, dvoma zväčšuješ, + a − priblížia a oddialia. Pero s farbami kreslí, guma maže celé čiary, ↶ vráti krok. Ťuknutím na bod otvoríš jeho menu. ⌖ dá aktívny bod do stredu a ukáže celý jeho polygón. Čiary sú ukotvené k najbližšej stanici, takže pri oprave dát sa posunú s ňou.</p>' +
      '<p><b>Therion.</b> Export → Balík pre Therion: .th, .th2 s vloženým .xvi podkladom pre xtherion a PocketTopo .txt (xtherion ho importuje ako doteraz). Import vie načítať PocketTopo .txt aj zálohu .json.</p>' +
      '<p><b>Offline.</b> Po prvom otvorení funguje bez signálu. Dáta sa ukladajú v telefóne po každom meraní; pravidelne si rob export.</p>' +
      '</div>', [{ label: 'Rozumiem', cls: 'pri' }]);
  }

  async function applyWake() {
    try {
      if (S.wake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        if (!window._wl) { window._wl = await navigator.wakeLock.request('screen'); window._wl.addEventListener('release', () => { window._wl = null; }); }
      } else if (window._wl) { await window._wl.release(); window._wl = null; }
    } catch (e) { /* nepodporované */ }
  }
  function menuDialog() {
    const st = WT.stats(sv);
    const m = modal('WebTopo ' + APP_VERSION, '<p class="muted">' + esc(sv.name) + ' · ' + st.legs + ' ťahov · ' + WT.fmt(st.len, 1) + ' m</p>', [
      { label: 'Prieskumy…', onClick: () => { surveysDialog(); } },
      { label: 'Vlastnosti prieskumu…', onClick: () => { surveyProps(); } },
      { label: 'Prístroj…', onClick: () => { deviceDialog(); } },
      { label: 'Export…', cls: 'pri', onClick: () => { exportDialog(); } },
      { label: 'Import (PocketTopo .txt / .json)…', onClick: () => { importFile(); } },
      { label: 'Nastavenia…', onClick: () => { settingsDialog(); } },
      { label: (S.wake ? '☑' : '☐') + ' Nezhasínať obrazovku', onClick: () => { S.wake = !S.wake; saveSettings(); applyWake(); toast(S.wake ? 'Obrazovka ostane zapnutá' : 'Obrazovka môže zhasnúť'); } },
      { label: 'Ako to funguje', onClick: () => { helpDialog(); } }
    ]);
    m.el.querySelector('.sh-f').classList.add('vert');
  }

  // ============================== zapojenie UI ==============================
  function showView(id) {
    curView = id;
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === id));
    document.querySelectorAll('#tabs [data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === id));
    document.body.classList.toggle('sketching', id !== 'vData');
    const pal = document.getElementById('palette'); if (pal) pal.hidden = true;
    const v = id === 'vPlan' ? planView : id === 'vElev' ? elevView : null;
    if (v) { v.resize(); if (!v.v) v.fit(); v.requestRender(); syncTools(); }
  }
  function activeSketch() { return curView === 'vPlan' ? planView : curView === 'vElev' ? elevView : null; }
  function syncTools() {
    const v = activeSketch(); if (!v) return;
    document.querySelectorAll('#tools [data-col]').forEach(b => b.classList.toggle('on', b.dataset.col === v.col));
    const pen = $('#tPen');
    pen.classList.toggle('on', v.tool === 'pen'); pen.style.setProperty('--c', PEN[v.col]);
    if (v.tool !== 'pen') $('#palette').hidden = true;
    document.querySelectorAll('#tools [data-tool]').forEach(b => b.classList.toggle('on', v.tool === b.dataset.tool));
  }

  let planView, elevView;
  function init() {
    $('#btnMenu').innerHTML = ICON.menu;
    const tools = $('#tools');
    tools.innerHTML = '<div id="palette" hidden>' + WT.COLORS.map(c => '<button class="tb col" data-col="' + c + '" title="' + PEN_SK[c] + '" style="--c:' + PEN[c] + '"><i></i></button>').join('') + '</div>' +
      '<button class="tb col pen" id="tPen" title="Pero – ťukni znova pre farbu" style="--c:' + PEN.black + '"><i></i><span>▴</span></button>' +
      '<button class="tb" data-tool="pan" title="Posun">' + ICON.hand + '</button>' +
      '<button class="tb" data-tool="erase" title="Guma">' + ICON.erase + '</button>' +
      '<button class="tb" id="tUndo" title="Späť">' + ICON.undo + '</button>' +
      '<button class="tb" id="tZout" title="Oddialiť">' + ICON.zout + '</button>' +
      '<button class="tb" id="tZin" title="Priblížiť">' + ICON.zin + '</button>' +
      '<button class="tb" id="tCenter" title="Na aktuálnu stanicu">' + ICON.target + '</button>' +
      '<button class="tb" id="tFit" title="Celý náčrt">' + ICON.fit + '</button>';
    planView = new SketchView($('#cvPlan'), 'plan');
    elevView = new SketchView($('#cvElev'), 'elev');
    tools.addEventListener('click', e => {
      const b = e.target.closest('button'); const v = activeSketch(); if (!b || !v) return;
      const pal = $('#palette');
      if (b.id === 'tPen') { if (v.tool === 'pen') pal.hidden = !pal.hidden; else v.tool = 'pen'; syncTools(); return; }
      pal.hidden = true;
      if (b.dataset.col) { v.tool = 'pen'; v.col = b.dataset.col; }
      else if (b.dataset.tool) v.tool = b.dataset.tool;
      else if (b.id === 'tUndo') v.doUndo();
      else if (b.id === 'tCenter') v.center();
      else if (b.id === 'tFit') v.fit();
      else if (b.id === 'tZin') v.zoomAt(v.W / 2, v.H / 2, 1.5);
      else if (b.id === 'tZout') v.zoomAt(v.W / 2, v.H / 2, 1 / 1.5);
      syncTools();
    });
    document.querySelectorAll('#tabs [data-v]').forEach(b => b.onclick = () => showView(b.dataset.v));
    $('#btnMenu').onclick = menuDialog;
    $('#devPill').onclick = deviceDialog;
    $('#stChip').onclick = stationDialog;
    // tabuľka: klik = označiť, šípka = menu, dvojklik / dlhé podržanie na hodnote = priama úprava
    const tb = $('#tbody');
    let lp = null, lastTap = null;
    tb.addEventListener('pointerdown', e => {
      const td = e.target.closest('td[data-f]');
      if (!td || td.classList.contains('editing')) { lp = null; return; }
      const me = { td, x: e.clientX, y: e.clientY, fired: false };
      me.timer = setTimeout(() => { if (lp === me && td.isConnected) { me.fired = true; vib(25); startEdit(td); } }, 550);
      lp = me;
    });
    tb.addEventListener('pointermove', e => { if (lp && !lp.fired && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) { clearTimeout(lp.timer); lp = null; } });
    tb.addEventListener('pointerup', () => { if (lp && !lp.fired) clearTimeout(lp.timer); });
    tb.addEventListener('pointercancel', () => { if (lp) clearTimeout(lp.timer); lp = null; });
    tb.addEventListener('contextmenu', e => e.preventDefault());
    tb.addEventListener('click', e => {
      if (e.target.closest('td.editing')) return;
      if (lp && lp.fired) { lp = null; return; }
      lp = null;
      const tr = e.target.closest('tr'); if (!tr || !tr.dataset.id) return;
      const sh = sv.shots.find(x => x.id === tr.dataset.id); if (!sh) return;
      if (e.target.closest('td.mn')) { lastTap = null; select({ t: 'sh', id: sh.id }); if (sh.to) stationMenu(sh.to, sh); else splayMenu(sh); return; }
      const td = e.target.closest('td[data-f]'), now = performance.now();
      if (td && lastTap && lastTap.id === sh.id && lastTap.f === td.dataset.f && now - lastTap.t < 400) { lastTap = null; startEdit(td); return; }
      lastTap = { id: sh.id, f: td && td.dataset.f, t: now };
      select({ t: 'sh', id: sh.id });
    });
    // nový riadok
    const order = ['#enTo', '#enD', '#enA', '#enI'];
    order.forEach((id, k) => $(id).addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (k < order.length - 1) $(order[k + 1]).focus();
      else if (commitEntry(true)) $('#enD').focus();
    }));
    $('#enAdd').onclick = () => commitEntry(true);
    $('#enFrom').onclick = stationDialog;
    $('#enExt').onclick = () => { sv.ext = sv.ext >= 0 ? -1 : 1; save(); renderHeader(); renderEntry(); };
    $('#btnUndoData').innerHTML = ICON.undo;
    $('#btnUndoData').onclick = undoDataStep;
    $('#emptyDev').onclick = deviceDialog;
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { if (sv) save(true); } else applyWake(); });
    window.addEventListener('pagehide', () => { if (sv) save(true); });
    document.addEventListener('pointerdown', () => { if (S.sound && !actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* */ } } }, { once: true });
    renderDev();
    applyWake();
    if (window.visualViewport) {
      const vv = window.visualViewport, root = document.documentElement;
      const fitVV = () => { root.style.setProperty('--vvh', vv.height + 'px'); root.style.setProperty('--vvt', vv.offsetTop + 'px'); };
      vv.addEventListener('resize', fitVV); vv.addEventListener('scroll', fitVV); fitVV();
    }
  }

  async function start() {
    init();
    let list = [];
    try { list = await DB.all(); } catch (e) { toast('Úložisko nie je dostupné: ' + e.message, 'bad'); }
    let last = null;
    try { last = localStorage.getItem('wt.last'); } catch (e) { /* */ }
    let s = list.find(x => x.id === last) || list.sort((a, b) => b.modified - a.modified)[0];
    const isNew = !s;
    if (!s) s = WT.newSurvey('Prieskum ' + WT.isoDate(Date.now()));
    await openSurvey(s, isNew);
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    window.WTapp = { get survey() { return sv; }, get geo() { return geo; }, get sel() { return sel; }, onMeasurement, showView, get dev() { return dev; }, planView: () => planView, elevView: () => elevView };
  }
  start();
})();
