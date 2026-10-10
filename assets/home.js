/* =========================================================================
   Kankana homepage — scroll engine, films, explore venues, arches, player
   ========================================================================= */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const seg = (p, a, b) => clamp((p - a) / (b - a));
  const eo = t => 1 - Math.pow(1 - t, 3);
  const eio = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const lerp = (a, b, t) => a + (b - a) * t;
  let VW = innerWidth, VH = innerHeight;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  /* smooth, eased scrolling — skipped for reduced motion and touch (native momentum is better there) */
  const lenis = (!reduced && window.Lenis && matchMedia('(pointer:fine)').matches) ? new Lenis({ lerp: 0.1, smoothWheel: true, wheelMultiplier: 0.9 }) : null;
  if (lenis) {
    const raf = t => { lenis.raf(t); requestAnimationFrame(raf); }; requestAnimationFrame(raf);
    const sync = () => { const b = document.body.classList; (b.contains('lock') || b.contains('intro-lock')) ? lenis.stop() : lenis.start(); };
    new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] }); sync();
  }
  const isMobile = () => VW < 860;
  const U = (id, w = 1600) => id.startsWith('assets/') ? id
    : `https://images.unsplash.com/${id.startsWith('flagged/') ? id : 'photo-' + id}?w=${w}&q=80&auto=format&fit=crop`;
  const F = n => `assets/hero-frames/f_${String(n).padStart(4, '0')}.webp`;

  /* ------------------------------------------------------------------ frames */
  const N = 240;
  const frames = new Array(N), ok = new Uint8Array(N);
  const films = [];
  const nearest = f => {
    let i = clamp(Math.round(f), 0, N - 1);
    if (ok[i]) return i;
    for (let d = 1; d < N; d++) {
      if (i - d >= 0 && ok[i - d]) return i - d;
      if (i + d < N && ok[i + d]) return i + d;
    }
    return -1;
  };
  function loadFrame(i) {
    return new Promise(res => {
      if (ok[i]) return res();
      const im = new Image();
      im.decoding = 'async';
      im.onload = () => {
        frames[i] = im; ok[i] = 1;
        films.forEach(fl => { if (fl.shown < 0 || Math.abs(i - fl.f) < Math.abs(fl.shown - fl.f)) { fl.shown = -2; fl.draw(fl.f); } });
        res();
      };
      im.onerror = () => res();
      im.src = F(i + 1);
    });
  }
  class Film {
    constructor(canvas) { this.c = canvas; this.ctx = canvas.getContext('2d', { alpha: false }); this.shown = -1; this.f = 0; films.push(this); }
    size() {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const w = this.c.clientWidth || VW, h = this.c.clientHeight || VH;
      this.c.width = Math.max(1, Math.round(w * dpr)); this.c.height = Math.max(1, Math.round(h * dpr));
      this.shown = -1; this.draw(this.f);
    }
    draw(f) {
      this.f = f;
      const idx = nearest(f);
      if (idx < 0 || idx === this.shown) return;
      const img = frames[idx], cw = this.c.width, ch = this.c.height, ir = img.naturalWidth / img.naturalHeight;
      let dw, dh;
      if (cw / ch > ir) { dw = cw; dh = cw / ir; } else { dh = ch; dw = ch * ir; }
      this.ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
      this.shown = idx;
    }
  }
  function frameQueue() {
    const q = [], seen = new Set(), add = i => { if (i >= 0 && i < N && !seen.has(i)) { seen.add(i); q.push(i); } };
    add(0); add(48);
    for (let i = 0; i <= 48; i += 4) add(i);
    for (let i = 0; i <= 48; i++) add(i);
    for (let i = 48; i < N; i += 6) add(i);
    for (let i = 48; i < N; i += 2) add(i);
    for (let i = 0; i < N; i++) add(i);
    return q;
  }
  async function pumpFrames() {
    const q = frameQueue(); let k = 0;
    await loadFrame(0);
    await Promise.all(Array.from({ length: 6 }, async () => { while (k < q.length) await loadFrame(q[k++]); }));
  }

  /* ------------------------------------------------------------------ scenes */
  const scenes = [];
  function scene(sel, fn, mode = 'pin') { const el = $(sel); if (el) scenes.push({ el, fn, mode, p: -1, t: 0 }); }
  let themed = [], chapters = [];
  function measure() {
    VW = innerWidth; VH = innerHeight;
    films.forEach(f => f.size());
    themed = $$('[data-theme]'); chapters = $$('[data-ch]');
    const tr = $('.rh-track'); if (tr) rhW = tr.scrollWidth;
    skyKeys();
    if (lenis) lenis.resize();
  }

  /* ------------------------------------------------------------------ the sky
     One fixed colour field behind every section. Its colour is a function of
     scroll position, so sections never meet at a hard edge. */
  const C = { film: '#0e0806', ivory: '#f3eee5', night: '#150509', wine: '#2a0a0f', ember: '#120607', foot: '#2a0509', palace: '#170709' };
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, k) => { const A = hex(a), B = hex(b); return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * k)).join(',')})`; };
  const skyEl = $('#sky'), rootS = document.documentElement.style;
  let KEYS = [], skyLum = 0, skyLast = '';
  const docTop = sel => { const el = $(sel); return el ? el.getBoundingClientRect().top + scrollY : 0; };
  function skyKeys() {
    const V = VH, F = docTop('#film'), T = docTop('#twelve'), Te = T + ($('#twelve')?.offsetHeight || 0) - V,
      D = docTop('#dawn'), Ti = docTop('#twelve-intro'), Hm = docTop('#home'), O = docTop('#outro'), Ft = docTop('footer');
    KEYS = [
      [F, C.film], [F + 9.95 * V, C.film], [F + 10.3 * V, C.palace],
      [Ti - 0.55 * V, C.palace], [Ti - 0.1 * V, '#6a3a2c'], [Ti + 0.25 * V, C.ivory],
      [T, C.ivory], [Te, C.night],
      [D - 0.55 * V, C.night], [D - 0.12 * V, '#4a1820'], [D + 0.18 * V, '#cf9566'], [D + 0.5 * V, C.ivory],
      [Hm - 0.55 * V, C.ivory], [Hm + 0.05 * V, C.wine],
      [O - 0.4 * V, C.wine], [O + 0.2 * V, C.ember], [O + 1.0 * V, C.ember], [Ft - 0.5 * V, C.foot]
    ].sort((a, b) => a[0] - b[0]);
  }
  function sky() {
    const y = scrollY + VH * 0.5 - VH * 0.5;
    let c = KEYS.length ? KEYS[0][1] : C.film, rgb;
    if (KEYS.length && y >= KEYS[KEYS.length - 1][0]) c = KEYS[KEYS.length - 1][1];
    for (let i = 0; i < KEYS.length - 1; i++) {
      const [a, ca] = KEYS[i], [b, cb] = KEYS[i + 1];
      if (y >= a && y < b) { c = b > a ? mix(ca, cb, (y - a) / (b - a)) : cb; break; }
    }
    if (c === skyLast) return; skyLast = c;
    rgb = c[0] === '#' ? hex(c) : c.match(/\d+/g).map(Number);
    skyEl.style.background = c;
    skyLum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    rootS.setProperty('--sky-ink', skyLum < 140 ? 'var(--cream)' : 'var(--ink)');
  }
  let lastY = -1;
  function tick() {
    for (const s of scenes) {
      const r = s.el.getBoundingClientRect();
      if (r.bottom < -VH * 0.6 || r.top > VH * 1.6) {
        const t = r.top > 0 ? 0 : 1;
        if (s.p !== t) { s.p = s.t = t; s.fn(t, s, r); }
        continue;
      }
      s.t = s.mode === 'pin' ? clamp(-r.top / Math.max(1, r.height - VH)) : clamp((VH - r.top) / (VH + r.height));
      if (s.p < 0) s.p = s.t;
      const d = s.t - s.p;
      s.p = Math.abs(d) < 0.0003 ? s.t : s.p + d * (lenis ? 0.32 : 0.13);
      s.fn(s.p, s, r);
    }
    if (scrollY !== lastY || !(tick.n % 10)) { lastY = scrollY; sky(); ui(); }
    if (!(tick.n++ % 90)) skyKeys();
    requestAnimationFrame(tick);
  }
  tick.n = 0;
  const railNo = $('#railNo'), railBar = $('#railBar');
  function ui() {
    let theme = 'dark';
    for (const el of themed) { const r = el.getBoundingClientRect(); if (r.top <= 44 && r.bottom > 44) theme = el.dataset.theme; }
    if (theme === 'sky') theme = skyLum < 140 ? 'dark' : 'light';
    if (document.body.dataset.nt !== theme) document.body.dataset.nt = theme;
    let cur = chapters[0];
    for (const el of chapters) if (el.getBoundingClientRect().top <= VH * 0.5) cur = el;
    if (cur && railNo.textContent !== cur.dataset.ch) railNo.textContent = cur.dataset.ch;
    const max = document.documentElement.scrollHeight - VH;
    railBar.style.height = (clamp(scrollY / Math.max(1, max)) * 100) + '%';
  }

  /* reveals */
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.18 });
  $$('.rv:not(.handoff-flat)').forEach(el => io.observe(el));

  /* count-up */
  const cio = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return; cio.unobserve(e.target);
    const el = e.target, to = +el.dataset.count, t0 = performance.now();
    const step = t => { const k = eo(clamp((t - t0) / 1600)); el.firstChild.nodeValue = String(Math.round(to * k)).padStart(el.dataset.pad || 0, '0'); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), { threshold: 0.4 });
  $$('[data-count]').forEach(el => cio.observe(el));

  /* ================================================================ 02 EXPLORE VENUES */
  const COL = { blue: '#3d6fe0', green: '#4f9a3c', yellow: '#cfc43a', orange: '#e08a2a', navy: '#3a3aa6' };
  const SUITE = '1613553474179-e1eda3ea5734', BED = '1718894071528-1108a094cc78', LOUNGE = '1668277157922-ecd8330ea809';
  /* The estate's real facilities. Zone layouts are illustrative; capacities match the booking catalog defaults. */
  const SPACES = [
    { n: '01', name: 'The Amphitheatre', id: 'amphitheatre', x: .50, y: .52, tag: 'Performances · Sangeet under the open sky', photo: F(133), outer: [80, 50, 840, 520], view: ['West arcade', 'East arcade'],
      zones: [
        { n: 'West Tiers', t: 'lawn', c: 'green', r: [110, 80, 230, 460], cap: 180, best: 'Tiered seating · Audience', pos: 'West of the stage', ph: F(121) },
        { n: 'Fountain Deck', t: 'pool', c: 'navy', r: [360, 80, 280, 330], cap: 120, best: 'Orchestra pit · Fountain', pos: 'In front of the stage', ph: F(157) },
        { n: 'Amphitheatre Stage', t: 'stage', c: 'blue', r: [360, 430, 280, 110], cap: 600, best: 'Sangeet · Concerts · Screenings', pos: 'South, facing the tiers', ph: F(145) },
        { n: 'East Tiers', t: 'lawn', c: 'orange', r: [660, 80, 230, 460], cap: 180, best: 'Tiered seating · Audience', pos: 'East of the stage', ph: F(169) }] },
    { n: '02', name: 'The Colonnade', id: 'colonnade', x: .58, y: .35, tag: 'Pheras · Vows beneath the arches', photo: F(193), outer: [70, 110, 860, 400], view: ['Water court', 'Sunset fields'],
      zones: [
        { n: 'North Arcade', t: 'lounge', c: 'blue', r: [100, 140, 200, 340], cap: 80, best: 'Lounge · Bar', pos: 'North wing', ph: F(205) },
        { n: 'Mandap Hall', t: 'ceremony', c: 'yellow', r: [320, 140, 360, 340], cap: 500, best: 'Pheras · Vows', pos: 'Central hall', ph: F(193) },
        { n: 'South Arcade', t: 'lounge', c: 'green', r: [700, 140, 200, 340], cap: 80, best: 'Family lounge', pos: 'South wing', ph: F(181) }] },
    { n: '03', name: 'Garden Pavilions', id: 'garden-pavilions', x: .22, y: .50, tag: 'Mehndi · Haldi under the banyan', photo: F(109), outer: [90, 70, 820, 480], view: ['Orchard', 'Water court'],
      zones: [
        { n: 'Mehndi Garden', t: 'lawn', c: 'green', r: [120, 100, 400, 250], cap: 250, best: 'Mehndi · Haldi', pos: 'Under the banyan', ph: F(109) },
        { n: 'Haldi Lawn', t: 'dining', c: 'yellow', r: [120, 370, 400, 150], cap: 120, best: 'Haldi brunch', pos: 'South lawn', ph: F(121) },
        { n: 'Banyan Deck', t: 'lounge', c: 'orange', r: [540, 100, 340, 420], cap: 60, best: 'Cocktails · Lounge', pos: 'East terrace', ph: F(205) }] },
    { n: '04', name: 'The Sunset Terrace', id: 'sunset-terrace', x: .93, y: .26, tag: 'Sundowners · Toasts', photo: F(229), outer: [130, 130, 740, 360], view: ['Palace', 'Sunset fields'],
      zones: [
        { n: 'Sunset Lounge', t: 'lounge', c: 'orange', r: [160, 160, 420, 300], cap: 60, best: 'Sundowners · Toasts', pos: 'West-facing', ph: F(229) },
        { n: 'Cocktail Deck', t: 'dining', c: 'blue', r: [600, 160, 240, 300], cap: 150, best: 'After-party · Dessert', pos: 'North-west corner', ph: F(217) }] },
    { n: '05', name: 'Reception & Dining Halls', id: 'reception-hall', x: .10, y: .30, tag: 'Receptions · Seated dinners', photo: F(181), outer: [60, 90, 880, 440], view: ['Garden pavilions', 'Forecourt'],
      zones: [
        { n: 'Reception Hall', id: 'reception-hall', t: 'stage', ty: 'Hall', c: 'yellow', r: [90, 120, 480, 380], cap: 800, best: 'Receptions · Sangeet', pos: 'West wing', ph: F(169) },
        { n: 'Dining Hall', id: 'dining-hall', t: 'dining', ty: 'Hall', c: 'green', r: [590, 120, 320, 380], cap: 300, best: 'Wedding feasts · Buffets', pos: 'Beside the reception hall', ph: F(121) }] },
    { n: '06', name: 'The Water Court', id: 'water-court', x: .82, y: .46, tag: 'Sangeet · Reception by still water', photo: F(145), outer: [120, 90, 760, 440], view: ['Colonnade', 'Sunset terrace'],
      zones: [
        { n: 'The Water Court', t: 'dining', ty: 'Event venue', c: 'orange', r: [150, 120, 700, 380], cap: 300, best: 'Sangeet dinner · Reception', pos: 'East wing', ph: F(145) }] },
    { n: '07', name: 'Villas & Rooms', id: 'villa', x: .62, y: .17, tag: 'Six private villas · Twenty guest rooms', photo: U(SUITE), outer: [50, 110, 900, 400], view: ['Courtyard', 'Desert view'],
      zones: [
        { n: 'Private Villas', id: 'villa', t: 'suite', ty: '6 villas', c: 'yellow', r: [80, 140, 400, 340], cap: 4, unit: 'per villa', best: 'The couple · Parents · Close family', pos: 'Upper floor & garden wing', ph: U(BED) },
        { n: 'Guest Rooms', id: 'room', t: 'suite', ty: '20 rooms', c: 'navy', r: [500, 140, 420, 340], cap: 2, unit: 'per room', best: 'Wedding guests · Friends', pos: 'Around the courtyard', ph: U(LOUNGE) }] },
    { n: '08', name: 'Café & Courts', id: 'cafe', x: .18, y: .14, tag: 'The café · Turf · Pickleball', photo: F(85), outer: [60, 90, 880, 440], view: ['Orchard', 'Palace'],
      zones: [
        { n: 'The Café', id: 'cafe', t: 'dining', ty: 'Café', c: 'orange', r: [90, 120, 260, 380], cap: 40, unit: 'seats', best: 'Coffee · Breakfast · Long lunches', pos: 'By the orchard', ph: F(97) },
        { n: 'Turf', id: 'turf', t: 'lawn', ty: 'Sport', c: 'green', r: [370, 120, 340, 380], cap: 22, unit: 'players', best: 'Football · Cricket nets · Games', pos: 'Beyond the garden wall', ph: F(73) },
        { n: 'Pickleball Court', id: 'pickleball', t: 'lawn', ty: 'Sport', c: 'blue', r: [730, 120, 180, 380], cap: 4, unit: 'players', best: 'Doubles · Morning games', pos: 'Next to the turf', ph: F(85) }] }
  ];
  const TYPE = { arrival: 'Arrival', lawn: 'Garden', lounge: 'Lounge', dining: 'Dining', pool: 'Water deck', stage: 'Stage', ceremony: 'Ceremony', suite: 'Suite' };

  /* --- plan drawing --- */
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function rnd(seed) { let s = seed; return () => (s = (s * 9301 + 49297) % 233280) / 233280; }
  function furniture(t, x, y, w, h, S, Fl, label) {
    let o = '';
    const T = (tx, ty, txt, size = 10) => label ? `<text x="${tx}" y="${ty}" font-size="${size}" letter-spacing="2" text-anchor="middle" fill="${S}" font-family="Jost,sans-serif">${txt}</text>` : '';
    if (t === 'dining') {
      const sp = Math.max(70, Math.min(95, Math.min(w, h) / 2.2)), cols = Math.max(1, Math.floor((w - 20) / sp)), rows = Math.max(1, Math.floor((h - 20) / sp));
      const ox = x + (w - (cols - 1) * sp) / 2, oy = y + (h - (rows - 1) * sp) / 2;
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        const cx = ox + i * sp, cy = oy + j * sp;
        o += `<circle cx="${cx}" cy="${cy}" r="${sp * .22}" fill="${Fl}" stroke="${S}"/>`;
        for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; o += `<circle cx="${cx + Math.cos(a) * sp * .33}" cy="${cy + Math.sin(a) * sp * .33}" r="${sp * .05}" fill="none" stroke="${S}"/>`; }
      }
      o += T(x + w / 2, y + h - 8, 'DINING');
    } else if (t === 'ceremony') {
      const m = Math.min(w * .36, h * .36, 150), mx = x + w / 2 - m / 2, my = y + 24;
      o += `<rect x="${mx}" y="${my}" width="${m}" height="${m}" fill="${Fl}" stroke="${S}" stroke-width="1.4"/>`;
      [[0, 0], [m, 0], [0, m], [m, m]].forEach(([a, b]) => { o += `<circle cx="${mx + a}" cy="${my + b}" r="6" fill="${S}"/>`; });
      o += `<rect x="${mx + m / 2 - 12}" y="${my + m / 2 - 12}" width="24" height="24" fill="none" stroke="${S}"/>` + T(x + w / 2, my + m + 20, 'MANDAP');
      for (let yy = my + m + 44; yy < y + h - 18; yy += 22) for (let xx = x + 22; xx < x + w - 30; xx += 20) { if (Math.abs(xx + 7 - (x + w / 2)) < 26) continue; o += `<rect x="${xx}" y="${yy}" width="13" height="11" fill="none" stroke="${S}"/>`; }
    } else if (t === 'lounge') {
      const gx = w > 240 ? 170 : w - 30, gy = 130, cols = Math.max(1, Math.floor((w - 20) / gx)), rows = Math.max(1, Math.floor((h - 20) / gy));
      const ox = x + (w - cols * gx) / 2, oy = y + (h - rows * gy) / 2;
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        const cx = ox + i * gx + gx / 2, cy = oy + j * gy + gy / 2, sw = Math.min(100, gx * .62);
        o += `<rect x="${cx - sw / 2}" y="${cy - 40}" width="${sw}" height="24" rx="4" fill="${Fl}" stroke="${S}"/><circle cx="${cx}" cy="${cy}" r="12" fill="none" stroke="${S}"/><rect x="${cx - sw / 2}" y="${cy + 18}" width="26" height="24" rx="4" fill="${Fl}" stroke="${S}"/><rect x="${cx + sw / 2 - 26}" y="${cy + 18}" width="26" height="24" rx="4" fill="${Fl}" stroke="${S}"/>`;
      }
      o += T(x + w / 2, y + h - 8, 'LOUNGE');
    } else if (t === 'stage') {
      o += `<rect x="${x + w * .12}" y="${y + 14}" width="${w * .76}" height="${Math.min(46, h * .38)}" fill="${Fl}" stroke="${S}" stroke-width="1.4"/>` + T(x + w / 2, y + 14 + Math.min(46, h * .38) / 2 + 4, 'STAGE');
      const fy = y + 14 + Math.min(46, h * .38) + 10, fh = y + h - 12 - fy, sq = 18;
      for (let yy = fy; yy < fy + fh - sq + 1; yy += sq) for (let xx = x + w * .2; xx < x + w * .8 - sq + 1; xx += sq) if (((xx - x) / sq + (yy - fy) / sq | 0) % 2 === 0) o += `<rect x="${xx}" y="${yy}" width="${sq}" height="${sq}" fill="${S}" fill-opacity=".12"/>`;
    } else if (t === 'lawn') {
      const r = rnd(Math.round(x + y)); const n = Math.max(4, Math.round(w * h / 9000));
      for (let i = 0; i < n; i++) { const cx = x + 30 + r() * (w - 60), cy = y + 30 + r() * (h - 60), rr = 14 + r() * 20; o += `<circle cx="${cx}" cy="${cy}" r="${rr}" fill="${Fl}" fill-opacity=".6" stroke="${S}" stroke-dasharray="3 3"/><circle cx="${cx}" cy="${cy}" r="3" fill="${S}"/>`; }
      o += T(x + w / 2, y + h - 8, 'GARDEN');
    } else if (t === 'arrival') {
      const pw = w * .22, px = x + w / 2 - pw / 2;
      o += `<rect x="${px}" y="${y}" width="${pw}" height="${h}" fill="${Fl}" stroke="${S}"/>`;
      for (let yy = y + 16; yy < y + h - 10; yy += 34) o += `<rect x="${px - 16}" y="${yy}" width="8" height="8" fill="${S}"/><rect x="${px + pw + 8}" y="${yy}" width="8" height="8" fill="${S}"/>`;
      [[x + 40, y + 40], [x + w - 40, y + 40], [x + 40, y + h - 40], [x + w - 40, y + h - 40]].forEach(([a, b]) => { o += `<circle cx="${a}" cy="${b}" r="18" fill="none" stroke="${S}"/>`; });
      o += T(x + w / 2, y + h / 2, 'ARRIVAL PATH', 9);
    } else if (t === 'pool') {
      o += `<rect x="${x + w * .22}" y="${y + h * .12}" width="${w * .56}" height="${h * .62}" rx="4" fill="${label ? '#cfe6ea' : 'rgba(140,210,230,.18)'}" stroke="${S}"/><circle cx="${x + w / 2}" cy="${y + h * .43}" r="${Math.min(w, h) * .07}" fill="none" stroke="${S}"/>` + T(x + w / 2, y + h * .12 + h * .62 + 22, 'FOUNTAIN POOL', 9);
      for (let yy = y + h * .16; yy < y + h * .7; yy += 34) o += `<rect x="${x + 10}" y="${yy}" width="${w * .14}" height="14" rx="3" fill="none" stroke="${S}"/><rect x="${x + w - 10 - w * .14}" y="${yy}" width="${w * .14}" height="14" rx="3" fill="none" stroke="${S}"/>`;
    } else if (t === 'suite') {
      const bw = w * .52, bh = h * .3, bx = x + w * .12, by = y + h * .18;
      o += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="3" fill="${Fl}" stroke="${S}"/><rect x="${bx + 8}" y="${by + 6}" width="${bw / 2 - 12}" height="16" rx="4" fill="none" stroke="${S}"/><rect x="${bx + bw / 2 + 4}" y="${by + 6}" width="${bw / 2 - 12}" height="16" rx="4" fill="none" stroke="${S}"/>` + T(bx + bw / 2, by + bh + 20, 'BEDROOM', 9);
      o += `<rect x="${x + w * .7}" y="${y + 12}" width="${w * .26}" height="${h * .3}" fill="none" stroke="${S}"/><ellipse cx="${x + w * .83}" cy="${y + 12 + h * .15}" rx="${w * .09}" ry="${h * .08}" fill="none" stroke="${S}"/>` + T(x + w * .83, y + 12 + h * .3 + 16, 'BATH', 9);
      o += `<rect x="${x + 10}" y="${y + h * .62}" width="${w * .42}" height="20" rx="4" fill="${Fl}" stroke="${S}"/>` + T(x + 10 + w * .21, y + h * .62 + 42, 'LOUNGE', 9);
      o += `<line x1="${x}" y1="${y + h * .86}" x2="${x + w}" y2="${y + h * .86}" stroke="${S}" stroke-dasharray="6 4"/>` + T(x + w / 2, y + h * .95, 'BALCONY', 9);
    }
    return o;
  }
  function spacePlan(sp) {
    const [ox, oy, ow, oh] = sp.outer, W = 'rgba(255,248,235,.9)', S = 'rgba(255,248,235,.45)';
    let s = `<svg viewBox="0 0 1000 620" xmlns="http://www.w3.org/2000/svg">`;
    s += `<rect x="${ox - 8}" y="${oy - 8}" width="${ow + 16}" height="${oh + 16}" fill="none" stroke="${W}" stroke-width="1"/><rect x="${ox}" y="${oy}" width="${ow}" height="${oh}" fill="rgba(255,248,235,.03)" stroke="${W}" stroke-width="3"/>`;
    sp.zones.forEach((z, i) => {
      const [x, y, w, h] = z.r, c = COL[z.c];
      s += `<g class="zn" data-z="${i}" style="--i:${i}"><rect class="f" x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}" fill-opacity=".5" stroke="${c}" stroke-width="1.5"/>${furniture(z.t, x, y, w, h, S, 'none', false)}<text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" fill="#fff" font-size="12" letter-spacing="3" font-family="Jost,sans-serif">${esc(z.n.toUpperCase())}</text><text x="${x + w / 2}" y="${y + h / 2 + 18}" text-anchor="middle" fill="#fff" fill-opacity=".7" font-size="9.5" letter-spacing="2" font-family="Jost,sans-serif">UP TO ${z.cap} GUESTS</text></g>`;
    });
    s += `<text x="${ox + ow / 2}" y="${oy - 22}" text-anchor="middle" fill="${S}" font-size="9" letter-spacing="3" font-family="Jost,sans-serif">${esc(sp.view[0].toUpperCase())}</text>`;
    s += `<text x="${ox + ow / 2}" y="${oy + oh + 34}" text-anchor="middle" fill="${S}" font-size="9" letter-spacing="3" font-family="Jost,sans-serif">${esc(sp.view[1].toUpperCase())}</text></svg>`;
    return s;
  }
  function zonePlan(sp, z) {
    const [zx, zy, zw, zh] = z.r, S = '#2a2420', Fl = '#e7dcc8';
    const ax = 70, ay = 90, aw = 660, ah = 520, k = Math.min(aw / zw, ah / zh), w = zw * k, h = zh * k, x = ax + (aw - w) / 2, y = ay + (ah - h) / 2;
    let s = `<svg viewBox="0 0 1000 700" xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="700" fill="#f7f4ee"/>`;
    s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#efe8dc" stroke="${S}" stroke-width="7"/>`;
    s += furniture(z.t, x + 10, y + 10, w - 20, h - 20, S, Fl, true);
    s += `<path d="M${x + w / 2 - 9} ${y - 22} l18 0 l-9 14 z" fill="#c8372d"/>`;
    s += `<line x1="${x}" y1="${y + h + 26}" x2="${x + w}" y2="${y + h + 26}" stroke="${S}" stroke-width=".8"/><text x="${x + w / 2}" y="${y + h + 44}" text-anchor="middle" fill="${S}" font-size="10" letter-spacing="3" font-family="Jost,sans-serif">${esc(sp.view[1].toUpperCase())}</text>`;
    /* key plan */
    const [ox, oy, ow, oh] = sp.outer, kk = 170 / ow, kx = 790, ky = 70;
    s += `<rect x="${kx}" y="${ky}" width="${ow * kk}" height="${oh * kk}" fill="none" stroke="${S}" stroke-width="1.2"/>`;
    sp.zones.forEach(q => { const [a, b, c, d] = q.r; s += `<rect x="${kx + (a - ox) * kk}" y="${ky + (b - oy) * kk}" width="${c * kk}" height="${d * kk}" fill="${COL[q.c]}" fill-opacity="${q === z ? .85 : .15}" stroke="${COL[q.c]}"/>`; });
    s += `<text x="${kx}" y="${ky - 14}" fill="${S}" font-size="9" letter-spacing="3" font-family="Jost,sans-serif">KEY PLAN</text>`;
    s += `<g transform="translate(875 ${ky + oh * kk + 50})"><path d="M0 -22 L8 10 L0 4 L-8 10 Z" fill="${S}"/><text y="26" text-anchor="middle" font-size="10" fill="${S}" font-family="Jost,sans-serif">N</text></g>`;
    const rows = [['ZONE AREA', z.area], ['CAPACITY', `${z.cap} ${z.t === 'suite' ? 'guests' : 'guests'}`], ['BEST FOR', z.best]];
    rows.forEach(([a, b], i) => { s += `<text x="960" y="${560 + i * 26}" text-anchor="end" fill="${S}" font-size="10" letter-spacing="2" font-family="Jost,sans-serif">${a} = ${esc(String(b).toUpperCase())}</text>`; });
    return s + '</svg>';
  }

  const ex = $('#explore'), exZoom = $('#exZoom'), exScan = $('#exScan'), exList = $('#exList'), exHs = $('#exHs');
  let curS = 0, curZ = 0;
  function exBuild() {
    exHs.innerHTML = SPACES.map((s, i) => `<button class="hs" data-s="${i}" style="left:${s.x * 100}%;top:${s.y * 100}%" aria-label="${esc(s.name)}"><span class="dot"></span><b>${s.n} · ${esc(s.name)}</b></button>`).join('');
    exList.innerHTML = SPACES.map((s, i) => `<button class="ex-li" data-s="${i}"><span>${esc(s.name)}</span><i></i><b>${s.n}</b></button>`).join('');
    const hover = i => {
      ex.classList.toggle('hovering', i >= 0);
      $$('.hs', exHs).forEach((h, j) => h.classList.toggle('on', j === i));
      if (ex.dataset.view === 'overview') $$('.ex-li', exList).forEach((h, j) => h.classList.toggle('on', j === i));
      if (i < 0) return;
      const s = SPACES[i];
      exScan.style.top = (s.y * 100) + '%';
      $('#exNow').innerHTML = `<div class="cap">${s.n} · Space</div><h3>${esc(s.name)}</h3><p>${esc(s.tag)}</p><p class="cap sm" style="opacity:.6;margin-top:6px">${s.zones.length > 1 ? s.zones.length + ' spaces' : 'Up to ' + s.zones[0].cap + ' guests'}</p>`;
    };
    [exHs, exList].forEach(box => {
      box.addEventListener('mouseover', e => { const b = e.target.closest('[data-s]'); if (b) hover(+b.dataset.s); });
      box.addEventListener('mouseleave', () => { if (ex.dataset.view === 'overview') hover(-1); });
      box.addEventListener('focusin', e => { const b = e.target.closest('[data-s]'); if (b) hover(+b.dataset.s); });
      box.addEventListener('click', e => { const b = e.target.closest('[data-s]'); if (b) openSpace(+b.dataset.s); });
    });
    $('#exBack').onclick = () => { ex.dataset.view = 'overview'; ex.classList.remove('hovering'); $$('.ex-li', exList).forEach(h => h.classList.remove('on')); };
    $('#zBack').onclick = () => { ex.dataset.view = 'space'; };
    $('#zToggle').onclick = () => { const c = $('#zCard'); c.classList.toggle('photo'); $('#zToggle').firstChild.nodeValue = c.classList.contains('photo') ? 'View plan ' : 'View photo '; };
    const plan = $('#exPlan');
    plan.addEventListener('mouseover', e => { const g = e.target.closest('.zn'); plan.classList.toggle('hov', !!g); $$('.zn', plan).forEach(z => z.classList.toggle('on', z === g)); });
    plan.addEventListener('mouseleave', () => { plan.classList.remove('hov'); $$('.zn', plan).forEach(z => z.classList.remove('on')); });
    plan.addEventListener('click', e => { const g = e.target.closest('.zn'); if (g) openZone(+g.dataset.z); });
    addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (ex.dataset.view === 'zone') ex.dataset.view = 'space'; else if (ex.dataset.view === 'space') $('#exBack').click(); });
    hover(-1);
    $('#exNow').innerHTML = `<p class="cap sm" style="opacity:.6">Hover a space on the palace to begin</p>`;
  }
  function openSpace(i) {
    curS = i; const s = SPACES[i];
    exZoom.style.transformOrigin = `${s.x * 100}% ${s.y * 100}%`;
    $$('.ex-li', exList).forEach((h, j) => h.classList.toggle('on', j === i));
    const was = ex.dataset.view;
    const render = () => {
      $('#spName').textContent = s.name;
      $('#spZones').textContent = s.zones.map(z => z.n).join(' · ');
      $('#spCap').textContent = `Typical layout · ${s.name}`;
      $('#spL').textContent = s.view[0]; $('#spR').textContent = s.view[1];
      const plan = $('#exPlan'); plan.classList.remove('hov'); plan.innerHTML = spacePlan(s);
    };
    if (was === 'space') { const L = $('.ex-spl'); L.style.opacity = 0; setTimeout(() => { render(); L.style.opacity = ''; }, 350); }
    else render();
    ex.dataset.view = 'space';
  }
  function openZone(j) {
    curZ = j; const s = SPACES[curS], z = s.zones[j];
    $('#zSpace').textContent = s.name;
    $('#zName').textContent = z.n;
    $('#zType').textContent = z.ty || `${TYPE[z.t]} · Type ${String.fromCharCode(65 + j)}`;
    const cap = z.unit === 'seats' ? `${z.cap} seats` : z.unit === 'players' ? `Up to ${z.cap} players` : z.unit ? `Sleeps ${z.cap} ${z.unit}` : `Up to ${z.cap} guests`;
    const id = z.id || s.id;
    $('#zDl').innerHTML = [['Capacity', cap], ['Area', z.area], ['Best for', z.best], ['Position', z.pos]].filter(r => r[1]).map(([a, b]) => `<dt>${a}</dt><dd>${esc(b)}</dd>`).join('')
      + (id ? `<dt>Book</dt><dd><a class="ul" href="book.html?item=${encodeURIComponent(id)}">Check availability &rarr;</a></dd>` : '');
    $('#zPlan').innerHTML = zonePlan(s, z);
    const img = $('#zPhoto'); img.src = z.ph || s.photo; img.alt = `${z.n}, ${s.name}`;
    $('#zCard').classList.remove('photo'); $('#zToggle').firstChild.nodeValue = 'View photo ';
    ex.dataset.view = 'zone';
  }
  exBuild();

  /* ================================================================ 01–03 ONE CONTINUOUS FILM
     U = viewport-heights scrolled into #film (0 → 11):
     0–3.4 hero flight · 3.4–4.9 the venue map · 4.9–10 through the gate · 10–11 the frame folds into an arch */
  const heroFilm = new Film($('#heroCanvas'));
  const H = { title: $('#heroTitle'), ch1: $('#heroCh1'), ch2: $('#heroCh2'), dim: $('#heroDim'), lg: $('#heroLg'), cue: $('#heroCue'), mark: $('#heroMark'), clip: $('#filmClip') };
  const wcs = $$('#film .wc'), wEnd = $('#welEnd');
  const WIN = [[0.03, 0.2], [0.26, 0.44], [0.5, 0.68], [0.73, 0.86]];
  let exLive = false;
  scene('#film', (p, s) => {
    const u = p * 11;
    /* hero (old timings remapped onto 0–3.4) */
    const hp = seg(u, 0, 3.4), pw = seg(u, 4.9, 10);
    heroFilm.draw(u < 4.9 ? seg(hp, 0, 0.94) * 48 : 48 + seg(pw, 0, 0.9) * (N - 1 - 48));
    const t0 = 1 - seg(hp, 0.05, 0.17);
    H.title.style.opacity = t0; H.title.style.transform = `translateY(calc(-40% - ${(1 - t0) * 50}px))`;
    H.mark.style.opacity = 0.92 * (1 - seg(hp, 0.8, 0.95));
    H.cue.style.opacity = 1 - seg(hp, 0, 0.05);
    const c1 = seg(hp, 0.22, 0.32) * (1 - seg(hp, 0.5, 0.58));
    H.ch1.style.opacity = c1;
    H.ch1.style.filter = `blur(${(1 - seg(hp, 0.22, 0.32)) * 12 + seg(hp, 0.5, 0.58) * 10}px)`;
    H.ch1.style.transform = `scale(${1.06 - seg(hp, 0.22, 0.4) * 0.06})`;
    H.dim.style.opacity = c1 * 0.9;
    const c2 = seg(hp, 0.62, 0.72) * (1 - seg(u, 3.3, 3.6));
    H.ch2.style.opacity = c2; H.ch2.style.transform = `translateY(${(1 - seg(hp, 0.62, 0.72)) * 30 - seg(u, 3.3, 3.6) * 30}px)`;
    H.lg.style.opacity = Math.max(1 - seg(hp, 0.08, 0.2), c2);
    /* the venue map rises out of the film, then hands back to it */
    const ev = seg(u, 3.4, 3.7) * (1 - seg(u, 4.6, 4.9));
    const live = ev > 0.001;
    if (live !== exLive) {
      exLive = live; ex.classList.toggle('live', live);
      if (!live) { ex.dataset.view = 'overview'; ex.classList.remove('hovering'); $$('.ex-li', exList).forEach(h => h.classList.remove('on')); }
    }
    ex.style.opacity = ev; ex.style.pointerEvents = ev > 0.6 ? 'auto' : 'none';
    /* through the gate */
    wcs.forEach((c, i) => { const [a, b] = WIN[i]; const v = seg(pw, a, a + 0.04) * (1 - seg(pw, b - 0.04, b)); c.style.opacity = v; c.style.transform = `translateY(${(1 - v) * 22}px)`; });
    const e = seg(pw, 0.9, 0.97) * (1 - seg(u, 9.95, 10.2));
    wEnd.style.opacity = e; wEnd.style.pointerEvents = e > 0.5 ? 'auto' : 'none';
    /* the whole frame folds into an arch and travels on into the page */
    const f = eio(seg(u, 10.15, 11));
    H.clip.style.clipPath = f > 0 ? archInset(1 - f, isMobile() ? VW * 0.46 : Math.min(VW * 0.2, 330), VH * 0.5, VH * 0.52) : 'none';
  });

  /* ================================================================ 04 CELEBRATIONS
     Choose an occasion → walk into it full screen → scroll between occasions through a glass lens */
  const cel = $('#celebrate'), arches = $$('#celebrate .arch'), archWrap = $('#celebrate .arches'), glows = $$('#celGlow canvas');
  const noHover = matchMedia('(hover: none)').matches;
  const OCC = arches.map(a => ({
    a, media: $('.aw img', a), full: a.dataset.img, p: null,
    name: a.dataset.title.replace(/<br>/g, ' ').replace(/^The\s+/i, ''), sub: a.dataset.sub, body: a.dataset.body
  }));

  /* ---- the glow behind the arches, in each occasion's colour */
  let celOn = -1, celRaf = 0;
  glows.forEach(c => { c.width = 48; c.height = 64; });
  const paint = i => {
    const m = OCC[i].media, c = glows[i]; if (!m || !c) return;
    const w = m.videoWidth || m.naturalWidth, h = m.videoHeight || m.naturalHeight; if (!w || !h) return;
    const r = Math.max(c.width / w, c.height / h), dw = w * r, dh = h * r, x = c.getContext('2d');
    x.globalAlpha = 1; x.fillStyle = arches[i].dataset.tint || '#c08040'; x.fillRect(0, 0, c.width, c.height);
    x.globalAlpha = 0.6; try { x.drawImage(m, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh); } catch (e) {}
  };
  const glowLoop = () => { celRaf = 0; if (celOn < 0 || OCC[celOn].media.tagName !== 'VIDEO') return; paint(celOn); celRaf = setTimeout(() => requestAnimationFrame(glowLoop), 90); };
  const light = i => {
    if (i === celOn) return; celOn = i;
    arches.forEach((a, j) => a.classList.toggle('on', j === i));
    glows.forEach((c, j) => c.classList.toggle('on', j === i));
    archWrap.classList.toggle('lit', i >= 0);
    if (i >= 0) { paint(i); if (!celRaf) glowLoop(); }
  };
  const vio = new IntersectionObserver(es => es.forEach(e => { const v = e.target; if (e.isIntersecting || room.classList.contains('open')) { const pr = v.play(); if (pr && pr.catch) pr.catch(() => {}); } else v.pause(); }), { threshold: 0.15 });
  OCC.forEach((o, i) => {
    const im = o.media, a = o.a;
    if (im.complete) paint(i); else im.addEventListener('load', () => paint(i), { once: true });
    /* drop-in video: if assets/celebrate/<name>.mp4 exists it replaces the photo everywhere */
    const src = a.dataset.video;
    if (src && !reduced) {
      const v = document.createElement('video');
      Object.assign(v, { muted: true, loop: true, playsInline: true, preload: 'auto', poster: im.src });
      v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('aria-hidden', 'true');
      v.addEventListener('loadeddata', () => { $('.aw', a).classList.add('has-v'); o.media = v; o.p = Promise.resolve(v); paint(i); vio.observe(v); }, { once: true });
      v.addEventListener('error', () => v.remove(), { once: true });
      v.src = src; im.after(v);
    }
    if (!noHover) { a.addEventListener('mouseenter', () => light(i)); a.addEventListener('focus', () => light(i)); }
    a.addEventListener('click', () => openOcc(i));
  });
  if (!noHover) archWrap.addEventListener('mouseleave', () => light(-1));
  else scene('#celebrate', () => {
    let best = -1, bd = VH * 0.32;
    arches.forEach((a, i) => { const r = a.getBoundingClientRect(), d = Math.abs(r.top + r.height / 2 - VH / 2); if (d < bd) { bd = d; best = i; } });
    light(best);
  }, 'view');

  /* full-size pictures, loaded CORS-clean so the lens can bend them */
  const full = i => OCC[i].p || (OCC[i].p = new Promise(res => {
    const im = new Image(); im.crossOrigin = 'anonymous'; im.decoding = 'async';
    im.onload = () => res(im); im.onerror = () => { OCC[i].p = null; res(null); }; im.src = OCC[i].full;
  }));
  new IntersectionObserver((es, o) => { if (es[0].isIntersecting) { OCC.forEach((_, i) => full(i)); o.disconnect(); } }, { rootMargin: '100% 0px' }).observe(cel);

  /* ---- the glass lens (WebGL): next scene grows inside a refracting disc */
  const glc = $('#roomGl');
  const Lens = (() => {
    let gl = null;
    try { gl = glc.getContext('webgl', { alpha: false, antialias: false }) || glc.getContext('experimental-webgl'); } catch (e) {}
    if (!gl) return null;
    const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const FS = `precision mediump float;
uniform sampler2D uA,uB;uniform vec4 uCA,uCB;uniform vec2 uRes;uniform float uR;
vec3 tx(sampler2D s,vec4 c,vec2 p,float asp){vec2 uv=p/vec2(asp,1.)+.5;uv=clamp(uv*c.xy+c.zw,0.001,.999);return texture2D(s,uv).rgb;}
void main(){
  float asp=uRes.x/uRes.y;vec2 f=gl_FragCoord.xy/uRes;f.y=1.-f.y;vec2 p=(f-.5)*vec2(asp,1.);
  float d=length(p),R=uR,rim=min(.13,R*.55);vec3 col;
  if(R>0.&&d<R-rim){
    vec2 q=p*(.78+.22*d/max(R-rim,.001));col=tx(uB,uCB,q,asp);
  }else if(R>0.&&d<R){
    float t=(d-(R-rim))/rim;vec2 n=p/max(d,1e-4);float rr=(R-rim)*(1.-t*1.7);vec2 q=n*rr;
    float ca=.018*sin(t*3.1416);
    col=vec3(tx(uB,uCB,q*(1.+ca),asp).r,tx(uB,uCB,q,asp).g,tx(uB,uCB,q*(1.-ca),asp).b);
    vec3 outer=tx(uA,uCA,p*(1.-.35*sin(t*3.1416)),asp);
    col=mix(col,outer,smoothstep(.45,1.,t)*.65);
    float hl=pow(max(0.,dot(n,normalize(vec2(-.55,.8)))),4.)*(1.-abs(t-.42)*2.2);
    col+=max(hl,0.)*.45;col*=.88+.24*t;
  }else{
    float e=d-R;float k=R>0.?exp(-e*16.)*.2:0.;col=tx(uA,uCA,p*(1.-k),asp);
    if(R>0.)col+=exp(-e*45.)*.07;
  }
  gl_FragColor=vec4(col,1.);
}`;
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'));
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(pr); gl.useProgram(pr);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = n => gl.getUniformLocation(pr, n);
    const u = { A: U('uA'), B: U('uB'), CA: U('uCA'), CB: U('uCB'), res: U('uRes'), R: U('uR') };
    gl.uniform1i(u.A, 0); gl.uniform1i(u.B, 1);
    const mk = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]].forEach(([k, v]) => gl.texParameteri(gl.TEXTURE_2D, k, v)); return t; };
    const slot = [{ t: mk(), el: null }, { t: mk(), el: null }];
    const put = (i, el) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, slot[i].t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, el); };
    const cover = el => {
      const w = el.videoWidth || el.naturalWidth || 1, h = el.videoHeight || el.naturalHeight || 1, ta = w / h, sa = glc.width / glc.height;
      const sx = sa > ta ? 1 : sa / ta, sy = sa > ta ? ta / sa : 1; return [sx, sy, 0.5 - 0.5 * sx, 0.5 - 0.5 * sy];
    };
    return {
      size() { const dpr = Math.min(devicePixelRatio || 1, 1.75); glc.width = Math.round(VW * dpr); glc.height = Math.round(VH * dpr); gl.viewport(0, 0, glc.width, glc.height); },
      set(i, el) { put(i, el); slot[i].el = el; },          /* throws if the picture isn't CORS-clean */
      swap() { const t = slot[0]; slot[0] = slot[1]; slot[1] = t; },
      draw(R) {
        for (let i = 0; i < 2; i++) { const s = slot[i]; if (!s.el) continue; if (s.el.tagName === 'VIDEO' && s.el.readyState >= 2) put(i, s.el); gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, s.t); }
        if (slot[0].el) gl.uniform4fv(u.CA, cover(slot[0].el));
        if (slot[1].el) gl.uniform4fv(u.CB, cover(slot[1].el));
        gl.uniform2f(u.res, glc.width, glc.height); gl.uniform1f(u.R, R);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    };
  })();

  /* ---- the full-screen occasion */
  const room = $('#room'), rImg = $('#roomImg'), ocT = $('#ocT'), ocNav = $('#ocNav'), ocNo = $('#ocNo');
  ocNav.innerHTML = OCC.map((o, i) => `<button type="button" data-i="${i}"><b>${esc(o.name)}</b><span>${String(i + 1).padStart(2, '0')}</span></button>`).join('');
  let cur = 0, busy = false, glOn = false, clips = [], loopOn = false, lensT0 = 0, lensDur = 1500, lensRes = null, shownT = 0;
  const archClip = el => { const r = el.getBoundingClientRect(), rad = VW < 860 ? 4 : 6; return `inset(${r.top}px ${VW - r.right}px ${VH - r.bottom}px ${r.left}px round ${rad}px)`; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const setText = i => {
    $('#roomTitle').textContent = OCC[i].name; $('#roomSub').textContent = OCC[i].sub; $('#roomBody').textContent = OCC[i].body;
    $('#ocKick').textContent = `The celebrations · ${String(i + 1).padStart(2, '0')}`;
    ocNo.textContent = String(i + 1).padStart(2, '0');
    $$('button', ocNav).forEach((b, j) => b.classList.toggle('on', j === i));
  };
  const rMax = () => Math.hypot(VW / VH / 2, 0.5) + 0.16;
  const loop = t => {
    if (!room.classList.contains('open') && !room.style.visibility) { loopOn = false; return; }
    let R = 0;
    if (lensRes) { const k = clamp((t - lensT0) / lensDur); R = eio(k) * rMax(); if (k >= 1) { const r = lensRes; lensRes = null; r(); R = 0; } }
    if (glOn) Lens.draw(R);
    requestAnimationFrame(loop);
  };
  const startLoop = () => { if (!loopOn) { loopOn = true; requestAnimationFrame(loop); } };

  async function openOcc(i) {
    if (busy || room.classList.contains('open')) return; busy = true;
    const el = await Promise.race([full(i), wait(1400).then(() => null)]);
    glOn = false;
    if (Lens && el) { try { Lens.size(); Lens.set(0, el); glOn = true; } catch (e) { glOn = false; } }
    room.classList.toggle('gl', glOn);
    rImg.src = OCC[i].full; rImg.style.opacity = 1;
    cur = i; setText(i); ocT.classList.remove('out');
    clips = arches.map(a => archClip($('.aw', a)));
    /* the camera walks forward through the arch you chose */
    const aw = $('.aw', arches[i]), wr = archWrap.getBoundingClientRect(), ar = aw.getBoundingClientRect();
    archWrap.style.setProperty('--wo', `${ar.left + ar.width / 2 - wr.left}px ${ar.top + ar.height * 0.55 - wr.top}px`);
    cel.classList.add('walk');
    room.style.setProperty('--from', clips[i]);
    $('.room-img', room).style.transition = 'none'; room.classList.remove('open', 'shown');
    room.style.visibility = 'visible'; void room.offsetWidth;
    $('.room-img', room).style.transition = '';
    room.classList.add('open'); document.body.classList.add('lock', 'ui-hide');
    if (glOn) { Lens.draw(0); startLoop(); }
    clearTimeout(shownT); shownT = setTimeout(() => room.classList.add('shown'), 1700);
    if (OCC[i].media.tagName === 'VIDEO') OCC[i].media.play().catch(() => {});
    busy = false;
  }

  async function go(j) {
    const n = OCC.length; j = (j + n) % n;
    if (busy || j === cur || !room.classList.contains('open')) return; busy = true;
    const el = await full(j);
    ocT.classList.add('out');
    if (OCC[j].media.tagName === 'VIDEO') OCC[j].media.play().catch(() => {});
    let lens = false;
    if (glOn && el) { try { Lens.set(1, el); lens = true; } catch (e) { lens = false; } }
    if (lens) {
      lensT0 = performance.now(); lensDur = reduced ? 1 : 1500;
      setTimeout(() => { setText(j); ocT.classList.remove('out'); }, reduced ? 0 : 820);
      await new Promise(r => { lensRes = r; startLoop(); });
      Lens.swap(); Lens.draw(0);
    } else {
      room.classList.remove('gl'); glOn = false;
      rImg.style.opacity = 0; await wait(450);
      rImg.src = OCC[j].full; setText(j); ocT.classList.remove('out'); rImg.style.opacity = 1; await wait(400);
    }
    cur = j; busy = false;
  }

  const closeRoom = () => {
    if (!room.classList.contains('open') || busy) return;
    room.style.setProperty('--from', clips[cur] || clips[0]);
    room.classList.remove('open', 'shown'); document.body.classList.remove('lock', 'ui-hide');
    cel.classList.remove('walk');
    setTimeout(() => { if (!room.classList.contains('open')) room.style.visibility = ''; }, 1150);
  };
  $('#roomBack').onclick = closeRoom;
  ocNav.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) go(+b.dataset.i); });
  addEventListener('keydown', e => {
    if (!room.classList.contains('open')) return;
    if (e.key === 'Escape') closeRoom();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(cur + 1); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(cur - 1); }
  });
  let wAcc = 0, wT = 0;
  room.addEventListener('wheel', e => {
    e.preventDefault();
    const now = performance.now(); if (now - wT > 260) wAcc = 0; wT = now;
    if (busy) return;
    wAcc += e.deltaY + e.deltaX;
    if (Math.abs(wAcc) > 60) { go(cur + (wAcc > 0 ? 1 : -1)); wAcc = 0; }
  }, { passive: false });
  let tY = null, tX = null;
  room.addEventListener('touchstart', e => { tY = e.touches[0].clientY; tX = e.touches[0].clientX; }, { passive: true });
  room.addEventListener('touchend', e => {
    if (tY == null) return; const dy = tY - e.changedTouches[0].clientY, dx = tX - e.changedTouches[0].clientX; tY = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) > 50) go(cur + ((Math.abs(dy) > Math.abs(dx) ? dy : dx) > 0 ? 1 : -1));
  }, { passive: true });
  addEventListener('resize', () => { if (glOn && room.classList.contains('open')) Lens.size(); });

  /* ================================================================ 05 A WEDDING DAY, HOUR BY HOUR */
  const DY = { el: $('#twelve .dy'), t: $$('#twelve .dy-t'), x: $$('#twelve .dy-x'), f: $$('#twelve .dy-fig'), r: $$('#twelve .dy-rail span'), c: $('#dyCount'), arc: $('#dyArc'), orb: $('#dyOrb') };
  const HRS = [7, 9, 11, 13, 15, 16, 17, 18, 19, 20.5, 22, 24];
  /* sky colour for each moment: morning ivory → golden hour → night burgundy */
  const SKY = ['#f4efe6', '#f3ece0', '#f1e5d0', '#eedcbf', '#ead0a8', '#e4bf88', '#d9a266', '#c07a45', '#7e3a2a', '#431218', '#2a0a0f', '#150509'];
  const ARC_L = DY.arc.getTotalLength();
  DY.arc.style.strokeDasharray = ARC_L;
  const arcT = h => clamp((h - 6) / 18);
  $('#dyTicks').innerHTML = HRS.map(h => {
    const pt = DY.arc.getPointAtLength(ARC_L * arcT(h)), lab = h === 24 ? '12' : String(h > 12 ? Math.floor(h - 12) : Math.floor(h)) + (h % 1 ? '½' : '');
    return `<line class="dy-tick" x1="${pt.x}" y1="${pt.y - 6}" x2="${pt.x}" y2="${pt.y + 6}"/><text class="dy-tick-l" x="${pt.x}" y="${pt.y - 16}" text-anchor="middle">${lab}</text>`;
  }).join('');
  let dyCur = -1;
  scene('#twelve', (p, s) => {
    const n = HRS.length, q = seg(p, 0.03, 0.97), fl = q * (n - 1), i0 = Math.floor(fl), k = fl - i0, i1 = Math.min(n - 1, i0 + 1);
    const idx = Math.min(n - 1, Math.round(fl));
    /* sky + ink */
    const bg = mix(SKY[i0], SKY[i1], k);
    DY.el.style.background = bg;
    const lum = hex(SKY[i0]).reduce((a, v) => a + v, 0) * (1 - k) + hex(SKY[i1]).reduce((a, v) => a + v, 0) * k;
    const dark = lum < 420;
    DY.el.style.color = dark ? '#f6ecd8' : '#1d1210';
    s.el.dataset.theme = dark ? 'dark' : 'light';
    /* sun → moon along the arc */
    const h = HRS[i0] + (HRS[i1] - HRS[i0]) * k, at = arcT(h), pt = DY.arc.getPointAtLength(ARC_L * at);
    DY.orb.setAttribute('transform', `translate(${pt.x} ${pt.y})`);
    DY.arc.style.strokeDashoffset = ARC_L * (1 - at);
    const moon = seg(h, 19.5, 21);
    DY.orb.querySelector('.dy-sun').style.opacity = 1 - moon;
    DY.orb.querySelector('.dy-glow').style.opacity = 0.28 * (1 - moon) + 0.12 * moon;
    DY.orb.querySelector('.dy-glow').style.fill = moon > 0.5 ? '#f1e4c8' : '#f3c56a';
    DY.orb.querySelector('.dy-moon').style.opacity = moon;
    if (idx !== dyCur) {
      dyCur = idx;
      const set = (list) => list.forEach((el, i) => { el.classList.toggle('on', i === idx); el.classList.toggle('past', i < idx); });
      set(DY.t); set(DY.x); set(DY.f);
      DY.r.forEach((el, i) => el.classList.toggle('on', i === idx));
      DY.c.textContent = `${String(idx + 1).padStart(2, '0')} / ${n}`;
      DY.f.forEach((fig, i) => { const v = fig.querySelector('video'); if (!v) return; if (i === idx) { const pr = v.play(); if (pr && pr.catch) pr.catch(() => {}); } else v.pause(); });
    }
  });

  /* ================================================================ 06 RHYTHM (horizontal) */
  const rhTrack = $('.rh-track'), rhPar = $$('.rh-track [data-par]');
  let rhW = 0;
  const rhExp = $('#rhExp'), rhImg = $('#rhExp img'), rhFig = $('.rh-5 .archf'), rhFigImg = $('.rh-5 .archf img');
  const rhShade = document.createElement('div'); rhShade.className = 'pl-shade'; rhExp.appendChild(rhShade);
  const poolPin = $('#pool > .pin');
  scene('#rhythm', p => {
    const x = -(Math.max(0, rhW - VW)) * seg(p, 0.03, 0.8);
    rhTrack.style.transform = `translate3d(${x}px,0,0)`;
    rhPar.forEach(el => { el.style.transform = `translate3d(${x * +el.dataset.par}px,0,0)`; });
    /* the last arch opens out until it *is* the pool */
    const e = eio(seg(p, 0.84, 0.99));
    if (e <= 0) { rhExp.style.opacity = 0; rhFig.style.visibility = ''; return; }
    const r = rhFig.getBoundingClientRect(), pin = rhExp.parentNode.getBoundingClientRect();
    const fx = r.left - pin.left, fy = r.top - pin.top, rad = lerp(r.width / 2, 0, e);
    Object.assign(rhExp.style, {
      opacity: 1, overflow: 'hidden', inset: 'auto',
      left: lerp(fx, 0, e) + 'px', top: lerp(fy, 0, e) + 'px', width: lerp(r.width, VW, e) + 'px', height: lerp(r.height, VH, e) + 'px',
      borderRadius: `${rad}px ${rad}px 0 0`
    });
    const par = x * -0.08;
    Object.assign(rhImg.style, { width: lerp(120, 100, e) + '%', maxWidth: 'none', marginLeft: lerp(-10, 0, e) + '%', transform: `translate3d(${lerp(par, 0, e)}px,0,0) scale(${lerp(1, 1.14, e)})` });
    rhShade.style.opacity = e;
    rhFig.style.visibility = 'hidden';
  });

  /* ================================================================ 07 POOL → LESS RUSH */
  const pl = { img: $('#pool .pl-bg img'), t: $('#pool .pl-t'), hot: $('#pool .pl-hot'), c: $('#pool .pl-circle'), in: $('#pool .pl-in') };
  scene('#pool', (p, s, r) => {
    const here = r.top <= 1 && r.bottom > 0;
    poolPin.style.opacity = here ? 1 : 0; poolPin.style.pointerEvents = here ? '' : 'none';
    pl.img.style.transform = `scale(${1.14 - 0.14 * eo(seg(p, 0, 0.45))})`;
    const t = seg(p, 0.04, 0.14) * (1 - seg(p, 0.42, 0.52));
    pl.t.style.opacity = t; pl.t.style.transform = `translateY(${(1 - seg(p, 0.04, 0.14)) * 30}px)`; pl.hot.style.opacity = t;
    const c = eio(seg(p, 0.44, 0.84)), R = Math.hypot(VW / 2, VH) * 1.05 * c;
    pl.c.style.clipPath = `circle(${R}px at 50% 100%)`;
    const k = seg(p, 0.68, 0.84);
    pl.in.style.opacity = k; pl.in.style.transform = `translateY(${(1 - k) * 30}px)`;
    s.el.dataset.theme = c > 0.9 ? 'light' : 'dark';
  });

  /* ================================================================ 08 ABOVE THE EVERYDAY */
  const ab = { box: $('#above .ab-img'), img: $('#above .ab-img img'), t: $('#above .ab-t'), foot: $('#above .ab-foot'), pre: $('#above .ab-pre') };
  const archInset = (e, w0, h0, cy) => {
    const w = lerp(w0, VW, e), h = lerp(h0, VH, e), cx = VW / 2, y = lerp(cy - h0 / 2, 0, e);
    const r = lerp(w0 / 2, 0, e);
    return `inset(${y}px ${VW - (cx + w / 2)}px ${Math.max(0, VH - (y + h))}px ${cx - w / 2}px round ${r}px ${r}px 0 0)`;
  };
  const gen = $('#gen'), genArch = $('#genArch');
  let genLive = false;
  scene('#above', (p, s) => {
    const e = eio(seg(p, 0.06, 0.5)), c = eio(seg(p, 0.78, 0.98));
    ab.img.style.transform = `scale(${1.22 - 0.22 * e})`;
    ab.pre.style.opacity = 0.6 * (1 - seg(p, 0.05, 0.2));
    const t = seg(p, 0.3, 0.45) * (1 - seg(p, 0.68, 0.76));
    ab.t.style.opacity = t; ab.t.style.transform = `translateY(${(1 - seg(p, 0.3, 0.45)) * 40 - seg(p, 0.68, 0.76) * 40}px) scale(${1.04 - seg(p, 0.3, 0.45) * 0.04})`;
    ab.foot.style.opacity = seg(p, 0.5, 0.6) * (1 - seg(p, 0.68, 0.76));
    if (c <= 0) {
      Object.assign(ab.box.style, { inset: '', left: '', top: '', width: '', height: '', borderRadius: '', overflow: '' });
      ab.box.style.clipPath = archInset(e, isMobile() ? VW * 0.62 : Math.min(VW * 0.3, 520), VH * 0.6, VH * 0.56);
    } else {
      /* fold down into the arch that waits in the next section */
      const g = genArch.getBoundingClientRect(), gs = gen.getBoundingClientRect();
      const tx = g.left, ty = g.top - gs.top, rad = lerp(0, g.width / 2, c);
      Object.assign(ab.box.style, {
        clipPath: 'none', overflow: 'hidden', inset: 'auto',
        left: lerp(0, tx, c) + 'px', top: lerp(0, ty, c) + 'px', width: lerp(VW, g.width, c) + 'px', height: lerp(VH, g.height, c) + 'px',
        borderRadius: `${rad}px ${rad}px 0 0`
      });
    }
    ab.box.style.setProperty('--sh', 1 - c);
    s.el.dataset.theme = e > 0.85 && c < 0.4 ? 'dark' : 'light';
    const live = p >= 0.995 || gen.getBoundingClientRect().top < VH * 0.02;
    if (live !== genLive) { genLive = live; gen.classList.toggle('live', live); if (live) gen.classList.add('in'); }
  });

  /* ================================================================ view-mode parallax */
  const par = (el, amt) => p => { el.style.transform = `translate3d(0,${(0.5 - p) * amt}px,0)`; };
  const pv = (sel, fn) => { const el = $(sel); if (el) scenes.push({ el, fn: (p) => fn(p, el), mode: 'view', p: -1, t: 0 }); };
  pv('#gen', (p) => {
    $('#gen .gen-small img').style.transform = `translate3d(0,${(p - 0.5) * -60}px,0)`;
    $('#gen .gen-small').style.transform = `translate3d(0,${(0.5 - p) * 140}px,0)`;
    $('#gen .gen-word').style.transform = `translate3d(${(0.2 - p) * 60}vw,0,0)`;
  });
  pv('#home', (p) => {
    const e = eo(seg(p, 0.12, 0.5));
    $('#home .hm-main').style.transform = `translate3d(0,${(1 - e) * 80}px,0) rotate(${(1 - e) * -2}deg)`;
    $('#home .hm-a').style.transform = `translate3d(${(1 - e) * -140}px,${(1 - e) * 120}px,0) rotate(${(1 - e) * -10}deg)`;
    $('#home .hm-b').style.transform = `translate3d(${(1 - e) * 160}px,${(1 - e) * -40}px,0) rotate(${(1 - e) * 9}deg)`;
    $('#home .hm-t').style.transform = `translate3d(${(1 - e) * -60}px,0,0)`;
    $('#home .hm-t').style.opacity = e;
  });
  pv('#considered', p => { $('#considered .cs-img img').style.transform = `translate3d(0,${(p - 0.5) * -90}px,0)`; });
  pv('#reach', p => { const bg = $('#reach .rc-bg'); bg.style.opacity = seg(p, 0.04, 0.3) * (1 - seg(p, 0.72, 0.96)); $('img', bg).style.transform = `scale(${1.2 - p * 0.18})`; });
  const dawnSun = $('#dawn .dn-sun');
  pv('#dawn', p => { const e = eo(seg(p, 0.05, 0.62)); dawnSun.style.transform = `translate3d(0,${(1 - e) * 45}vh,0)`; dawnSun.style.opacity = 0.2 + e * 0.8; });
  pv('#plan', p => {
    const e = eo(seg(p, 0.12, 0.55));
    $('#plan .pn-card').style.transform = `rotateX(${(1 - e) * 52}deg) translateY(${(1 - e) * 60}px) scale(${0.92 + e * 0.08})`;
  });

  /* ================================================================ 14 YOUR NEXT CHAPTER */
  const cp = { img: $('#chapter .cp-img'), im: $('#chapter .cp-img img'), word: $('#chapter .cp-word'), top: $('#chapter .cp-top'), sub: $('#chapter .cp-sub'), end: $('#chapter .cp-end'), dark: $('#chapter .cp-dark') };
  scene('#chapter', p => {
    const w0 = isMobile() ? VW * 0.5 : Math.min(VW * 0.2, 340), h0 = VH * 0.44, cy = VH * 0.52;
    const e = eio(seg(p, 0.22, 0.78));
    cp.img.style.clipPath = archInset(e, w0, h0, cy);
    cp.im.style.transform = `scale(${1.25 - 0.25 * e})`;
    cp.word.style.opacity = 1 - seg(p, 0.35, 0.6);
    cp.word.style.transform = `scale(${1 + e * 0.12})`;
    cp.top.style.opacity = 0.7 * (1 - seg(p, 0.1, 0.25));
    cp.sub.style.top = `${cy + h0 / 2 + 30}px`;
    const sv = 1 - seg(p, 0.12, 0.26);
    cp.sub.style.opacity = sv; cp.sub.style.pointerEvents = sv > 0.5 ? 'auto' : 'none';
    const en = seg(p, 0.76, 0.86) * (1 - seg(p, 0.9, 0.96));
    cp.dark.style.opacity = seg(p, 0.9, 1);
    cp.end.style.opacity = en; cp.end.style.pointerEvents = en > 0.5 ? 'auto' : 'none';
  });

  /* ================================================================ 16 OUTRO */
  const ot = { path: $('#otPath'), arch: $('#outro .ot-arch'), glow: $('#outro .ot-glow'), logo: $('#outro .ot-logo'), tag: $('#outro .ot-tag') };
  const L = ot.path.getTotalLength ? ot.path.getTotalLength() : 800;
  ot.path.style.strokeDasharray = L;
  scene('#outro', p => {
    ot.path.style.strokeDashoffset = L * (1 - eo(seg(p, 0.04, 0.42)));
    ot.arch.style.opacity = 1 - seg(p, 0.46, 0.56);
    ot.glow.style.opacity = seg(p, 0.42, 0.52) * (1 - seg(p, 0.56, 0.7));
    const g = seg(p, 0.5, 0.7);
    ot.logo.style.opacity = g; ot.logo.style.filter = `blur(${(1 - g) * 16}px)`; ot.logo.style.transform = `scale(${1.06 - g * 0.06})`;
    ot.tag.style.opacity = 0.85 * seg(p, 0.66, 0.8);
  });

  /* ================================================================ chapters menu + anchors */
  const chx = $('#chx');
  const openCh = o => { chx.classList.toggle('open', o); document.body.classList.toggle('lock', o); };
  $('#chBtn').onclick = () => openCh(true);
  $('#chClose').onclick = () => openCh(false);
  addEventListener('keydown', e => { if (e.key === 'Escape') openCh(false); });
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href^="#"]'); if (!a) return;
    const id = a.getAttribute('href'); if (id.length < 2) return;
    const t = $(id); if (!t) return;
    e.preventDefault(); openCh(false);
    const y = t.getBoundingClientRect().top + scrollY, far = Math.abs(y - scrollY) > VH * 8;
    if (lenis) { lenis.start(); lenis.scrollTo(y, { immediate: far, duration: 1.6 }); }
    else scrollTo({ top: y, behavior: far ? 'auto' : 'smooth' });
  });

  /* ================================================================ film player */
  const fxm = $('#filmModal'), fxFilm = new Film($('#fxCanvas')), fxBar = $('#fxBar'), fxTime = $('#fxTime'), fxPlay = $('#fxPlay'), fxCap = $('#fxCap');
  const CAPS = [[0, 'The Arrival'], [56, 'The Gate'], [100, 'The Water Court'], [170, 'The Colonnade'], [212, 'The Terrace']];
  let fxOn = false, fxF = 0, fxT = 0;
  const fmt = s => `0:${String(Math.floor(s)).padStart(2, '0')}`;
  function fxStep(t) {
    if (!fxOn) return;
    const dt = fxT ? (t - fxT) / 1000 : 0; fxT = t;
    fxF += dt * 24;
    if (fxF >= N - 1) { fxF = N - 1; setPlay(false); }
    fxDraw();
    if (fxOn) requestAnimationFrame(fxStep);
  }
  function fxDraw() {
    fxFilm.draw(fxF);
    fxBar.style.width = (fxF / (N - 1) * 100) + '%';
    fxTime.textContent = `${fmt(fxF / 24)} / ${fmt(N / 24)}`;
    let c = CAPS[0][1]; CAPS.forEach(([f, n]) => { if (fxF >= f) c = n; }); fxCap.textContent = c;
  }
  const setPlay = on => { fxOn = on; fxT = 0; fxPlay.textContent = on ? '❚❚' : '▶'; fxPlay.setAttribute('aria-label', on ? 'Pause' : 'Play'); if (on) requestAnimationFrame(fxStep); };
  $$('[data-film]').forEach(b => b.addEventListener('click', () => {
    fxm.classList.add('open'); document.body.classList.add('lock', 'ui-hide');
    fxFilm.size(); if (fxF >= N - 1) fxF = 0; fxDraw(); setPlay(true);
  }));
  fxPlay.onclick = () => { if (!fxOn && fxF >= N - 1) fxF = 0; setPlay(!fxOn); };
  $('#fxClose').onclick = () => { setPlay(false); fxm.classList.remove('open'); document.body.classList.remove('lock', 'ui-hide'); };
  $('.fx-bar').addEventListener('click', e => { const r = e.currentTarget.getBoundingClientRect(); fxF = clamp((e.clientX - r.left) / r.width) * (N - 1); fxDraw(); });

  /* ================================================================ boot */
  addEventListener('resize', () => { measure(); scenes.forEach(s => { s.p = -1; }); });
  addEventListener('load', measure);
  measure();
  requestAnimationFrame(tick);
  pumpFrames();
})();
