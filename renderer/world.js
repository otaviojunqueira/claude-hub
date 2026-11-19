'use strict';
/**
 * Prédio animado do Escritório (canvas 2D, pixel art).
 *  - layout: hall à esquerda, fileiras de salas (uma por departamento + Recepção, Copa e Cérebro) e corredores;
 *  - grade de caminhada + A*, e uma pequena simulação: funcionários sentam e digitam, levantam a mão,
 *    vão à copa tomar café, sentam no sofá, leem no Cérebro, chegam e saem pela entrada;
 *  - o app fornece os dados (salas e funcionários) e os elementos HTML por cima (barra da sala, balões, etiquetas).
 * Nada aqui toca em rede ou disco.
 */
(function () {
  const T = 16;
  const HALL = 3;
  const ROOM_W = 15;
  const WALL_H = 3;
  const COR_H = 2;
  const FREE = 1;
  const MAX_SEATS = 9; // além do líder

  const h = (tag, cls, kids) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    for (const k of kids || []) el.append(k);
    return el;
  };

  /* ------------------------------------------------------------------ A* */
  class Heap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.v.length; }
    push(key, val) {
      const k = this.k; const v = this.v;
      let i = v.length;
      k.push(key); v.push(val);
      while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; }
    }
    pop() {
      const k = this.k; const v = this.v;
      const top = v[0];
      const lk = k.pop(); const lv = v.pop();
      if (v.length) {
        k[0] = lk; v[0] = lv;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1; const r = l + 1; let m = i;
          if (l < v.length && k[l] < k[m]) m = l;
          if (r < v.length && k[r] < k[m]) m = r;
          if (m === i) break;
          [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m;
        }
      }
      return top;
    }
  }

  /** Caminho 4-direções (sem o ponto de partida, com o destino); [] se já está lá, null se não há caminho. */
  function findPath(cells, w, hh, sx, sy, gx, gy) {
    if (sx === gx && sy === gy) return [];
    const ok = (x, y) => x >= 0 && y >= 0 && x < w && y < hh && cells[y * w + x] !== 0;
    if (!ok(gx, gy)) return null;
    const n = w * hh;
    const g = new Float32Array(n).fill(1e9);
    const from = new Int32Array(n).fill(-1);
    const dirIn = new Int8Array(n).fill(-1);
    const open = new Heap();
    const s = sy * w + sx;
    g[s] = 0;
    open.push(0, s);
    const DX = [1, -1, 0, 0];
    const DY = [0, 0, 1, -1];
    while (open.size) {
      const cur = open.pop();
      const cx = cur % w; const cy = (cur / w) | 0;
      if (cx === gx && cy === gy) {
        const out = [];
        let c = cur;
        while (c !== s) { out.push([c % w, (c / w) | 0]); c = from[c]; }
        return out.reverse();
      }
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d]; const ny = cy + DY[d];
        if (!ok(nx, ny)) continue;
        const ni = ny * w + nx;
        const cost = g[cur] + 1 + (dirIn[cur] >= 0 && dirIn[cur] !== d ? 0.35 : 0);
        if (cost < g[ni]) {
          g[ni] = cost; from[ni] = cur; dirIn[ni] = d;
          open.push(cost + Math.abs(gx - nx) + Math.abs(gy - ny), ni);
        }
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ layout */
  const ROOM_KINDS = { reception: 'Recepção', copa: 'Copa', brain: 'Cérebro' };

  function deptRows(n) {
    return Math.max(1, Math.ceil(Math.max(0, n - 1) / 4));
  }

  function computeLayout(rooms, cols) {
    const rows = [];
    for (let i = 0; i < rooms.length; i += cols) rows.push(rooms.slice(i, i + cols));
    let y = 1;
    const placed = [];
    const corridors = [];
    for (const row of rows) {
      let F = 7;
      for (const r of row) {
        if (r.kind === 'dept') F = Math.max(F, 3 + 3 * deptRows(r.n));
        if (r.kind === 'copa') F = Math.max(F, 8);
      }
      const outerH = WALL_H + F + 1;
      row.forEach((r, i) => {
        placed.push({ ...r, tx: HALL + i * ROOM_W, ty: y, w: ROOM_W, F, outerH, fx: HALL + i * ROOM_W + 1, fy: y + WALL_H, fw: ROOM_W - 2 });
      });
      corridors.push({ ty: y + outerH, w: HALL + cols * ROOM_W });
      y += outerH + COR_H;
    }
    return { rooms: placed, corridors, W: HALL + cols * ROOM_W, H: y + 1, cols };
  }

  /* ------------------------------------------------------------------ mundo */
  const POSE = {
    stand: [2, 700], walk: [4, 150], type: [4, 140], raise: [2, 300], sleep: [2, 900],
    drink: [2, 700], cheer: [2, 260], read: [2, 900], sulk: [2, 1100],
  };

  function create(opts) {
    const o = opts || {};
    const root = h('div', 'world');
    const canvas = h('canvas', 'w-canvas');
    const roomsLayer = h('div', 'w-rooms');
    const seatsLayer = h('div', 'w-seats');
    root.append(canvas, roomsLayer, seatsLayer);
    const ctx = canvas.getContext('2d');

    let Z = 2;
    let L = null; // layout
    let layoutSig = '';
    let bg = null; // canvas de fundo
    let cells = null;
    let gw = 0;
    let gh = 0;
    let statics = []; // móveis ordenados
    let spots = null;
    const roomInfo = new Map(); // id -> {rect, seats:[...], leaderSeat, ...}
    const agents = new Map(); // key -> agente
    let model = { rooms: [] };
    let firstFill = true;
    let rafId = 0;
    let lastDraw = 0;
    let lastTick = 0;
    let pendingCheer = new Map();

    /* ---------- construção do cenário ---------- */
    function build(layout) {
      L = layout;
      gw = L.W;
      gh = L.H;
      cells = new Uint8Array(gw * gh);
      const blockR = (x, y, w, hh) => { for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + w; xx++) if (xx >= 0 && yy >= 0 && xx < gw && yy < gh) cells[yy * gw + xx] = 0; };
      const freeR = (x, y, w, hh) => { for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + w; xx++) if (xx >= 0 && yy >= 0 && xx < gw && yy < gh) cells[yy * gw + xx] = FREE; };
      // hall e corredores
      freeR(0, 1, HALL, gh - 2);
      for (const c of L.corridors) freeR(0, c.ty, c.w, COR_H);

      bg = Pixel.mkCanvas(gw * T, gh * T);
      const b = bg.getContext('2d');
      b.fillStyle = '#161a27';
      b.fillRect(0, 0, bg.width, bg.height);
      const tileAt = (img, x, y, w, hh) => { for (let yy = 0; yy < hh; yy++) for (let xx = 0; xx < w; xx++) b.drawImage(img, (x + xx) * T, (y + yy) * T); };

      // hall + corredores (mármore) e a entrada (elevador)
      const marble = Sprites.floorTile('marble', 0);
      tileAt(marble, 0, 1, HALL, gh - 2);
      for (const c of L.corridors) tileAt(marble, 0, c.ty, c.w, COR_H);
      b.fillStyle = '#2a2f3d';
      b.fillRect(0, 0, HALL * T, T);
      b.fillStyle = '#4a5268';
      b.fillRect(8, 3, 16, 13);
      b.fillStyle = '#8aa0c8';
      b.fillRect(10, 5, 5, 11);
      b.fillRect(17, 5, 5, 11);
      b.fillStyle = '#46e08e';
      b.fillRect(14, 1, 4, 2);
      b.fillStyle = '#e8d9a0';
      b.fillRect(T + 2, T + 14, 28, 2);
      // tapete da entrada
      b.fillStyle = '#6a4a6d';
      b.fillRect(6, T * 2 + 4, 36, 12);
      b.fillStyle = '#8a5a90';
      b.fillRect(8, T * 2 + 6, 32, 8);

      statics = [];
      roomInfo.clear();
      spots = { coffee: [], sofa: [], cooler: [], shelf: [], table: [] };
      for (const r of L.rooms) buildRoom(r, b, freeR, blockR);
      statics.sort((a, c) => a.y - c.y);
    }

    function hashIdx(id) { return Pixel.hashStr(id) % Pixel.THEMES.length; }

    function addStatic(sp, x, y, dyn, sortY) {
      // (x, y) = ponto de âncora do sprite no mundo; sortY ordena a profundidade
      statics.push({ y: sortY == null ? y : sortY, draw: (c, t) => { c.drawImage(sp.c, Math.round(x - sp.ax), Math.round(y - sp.ay)); if (dyn) dyn(c, t); } });
    }

    function buildRoom(r, b, freeR, blockR) {
      const th = hashIdx(r.id);
      const x0 = r.tx * T; const y0 = r.ty * T;
      const kindFloor = r.kind === 'dept' ? (Pixel.hashStr(r.id + 'f') % 2 ? 'wood' : 'carpet') : r.kind === 'copa' ? 'tile' : r.kind === 'reception' ? 'carpet' : 'carpet';
      const floorImg = Sprites.floorTile(kindFloor, th);
      for (let yy = 0; yy < r.F; yy++) for (let xx = 0; xx < r.fw; xx++) b.drawImage(floorImg, (r.fx + xx) * T, (r.fy + yy) * T);
      // parede de fundo
      const wall = Sprites.wallTile(th);
      const trim = Pixel.theme(th).trim;
      for (let xx = 0; xx < r.w; xx++) for (let yy = 0; yy < WALL_H; yy++) b.drawImage(wall, (r.tx + xx) * T, (r.ty + yy) * T);
      b.fillStyle = Pixel.shade(trim, 10);
      b.fillRect(x0, y0, r.w * T, 3);
      b.fillStyle = trim;
      b.fillRect(x0, y0 + WALL_H * T - 4, r.w * T, 4);
      b.fillStyle = Pixel.shade(trim, 40);
      b.fillRect(x0, y0 + WALL_H * T - 4, r.w * T, 1);
      b.fillStyle = '#00000040';
      b.fillRect(x0, y0 + WALL_H * T, r.w * T, 3);
      // paredes laterais e de baixo (com porta)
      const side = (xx) => {
        b.fillStyle = Pixel.shade(trim, -25); b.fillRect(xx, y0, T, r.outerH * T);
        b.fillStyle = Pixel.shade(trim, 15); b.fillRect(xx + (xx === x0 ? 0 : 6), y0, 10, r.outerH * T);
        b.fillStyle = Pixel.shade(trim, 45); b.fillRect(xx + (xx === x0 ? 0 : 6), y0, 2, r.outerH * T);
      };
      side(x0); side(x0 + (r.w - 1) * T);
      const by = (r.ty + WALL_H + r.F) * T;
      const doorX = (r.tx + 6) * T;
      b.fillStyle = trim; b.fillRect(x0, by, r.w * T, T);
      b.fillStyle = Pixel.shade(trim, 40); b.fillRect(x0, by, r.w * T, 2);
      b.fillStyle = '#00000050'; b.fillRect(x0, by + T - 3, r.w * T, 3);
      b.drawImage(Sprites.floorTile('marble', 0), doorX, by); b.drawImage(Sprites.floorTile('marble', 0), doorX + T, by);
      b.fillStyle = Pixel.shade(trim, -40); b.fillRect(doorX - 2, by, 2, T); b.fillRect(doorX + 2 * T, by, 2, T);
      freeR(r.tx + 6, r.ty + WALL_H + r.F, 2, 1); // porta
      freeR(r.fx, r.fy, r.fw, r.F);
      const info = { r, seats: [], leader: null, bx: x0, by: y0 };
      roomInfo.set(r.id, info);

      const F = (lx, ly) => [r.fx + lx, r.fy + ly]; // tile global
      const place = (name, lx, ly, wTiles, blocked, dyn) => {
        const sp = Sprites.furn[name]();
        const [gx, gy] = F(lx, ly);
        addStatic(sp, (gx + wTiles / 2) * T, (gy + 1) * T, dyn);
        if (blocked) blockR(gx, gy, wTiles, 1);
        return [gx, gy];
      };
      const wallDecor = (name, lx, dy) => { const sp = Sprites.furn[name](); b.drawImage(sp.c, Math.round((r.fx + lx) * T - sp.ax), Math.round(y0 + dy)); };

      if (r.kind === 'dept') {
        wallDecor('window', 2, 28); wallDecor('board', 6, 28); wallDecor('window', 10, 28);
        // tapete sob as mesas
        const rows = deptRows(r.n);
        const rug = Sprites.furn.rug(11 * T, rows * 3 * T - 6, Pixel.shade(Pixel.theme(th).carpet, 10), Pixel.shade(Pixel.theme(th).carpet2, 6));
        b.globalAlpha = 0.55; b.drawImage(rug.c, (r.fx + 1) * T + 0, (r.fy + 3) * T + 4); b.globalAlpha = 1;
        // mesa do líder: ele senta ao norte da mesa, de frente
        const [ldx, ldy] = F(5, 1);
        const dsk = Sprites.desk('leader');
        const lx = (ldx + 1) * T;
        addStatic(Sprites.chair('north'), lx, ldy * T - 1, null, ldy * T - 6);
        addStatic(dsk, ldx * T, (ldy + 1) * T, null);
        blockR(ldx, ldy, 2, 1);
        const scr = { x: ldx * T - 3 + 22, y: (ldy + 1) * T - 34 + 5 };
        info.leader = { room: r.id, tile: [ldx, ldy - 1], px: lx, py: ldy * T - 2, dir: 'down', key: null };
        statics.push({ y: (ldy + 1) * T + 0.5, draw: (c, t) => { const a = info.leader.agent; Sprites.screen(c, scr.x, scr.y, a ? a.status : 'ended', a ? a.kind : null, t); } });
        // mesas dos funcionários
        for (let i = 0; i < MAX_SEATS; i++) {
          const col = i % 4; const row = Math.floor(i / 4);
          if (row >= rows) break;
          const [dx, dy] = F(1 + 3 * col, 3 + 3 * row);
          const d = Sprites.desk('emp');
          const cx = (dx + 1) * T;
          const seat = { room: r.id, tile: [dx, dy + 1], px: cx, py: (dy + 2) * T - 3, dir: 'up', idx: i, scr: { x: dx * T - 3 + 12, y: (dy + 1) * T - 34 + 5 }, key: null };
          info.seats.push(seat);
          addStatic(d, dx * T, (dy + 1) * T, null);
          statics.push({ y: (dy + 1) * T + 0.5, draw: (c, t) => { const a = seat.agent; Sprites.screen(c, seat.scr.x, seat.scr.y, a ? a.status : 'ended', a ? a.kind : null, t); } });
          blockR(dx, dy, 2, 1);
          addStatic(Sprites.chair('south'), cx, (dy + 2) * T - 4, null, (dy + 2) * T - 5);
        }
        place('plant', 0, 0, 1, true); place('plant', 12, r.F - 1, 1, true); place('plant', 0, r.F - 1, 1, true);
        const [cx2, cy2] = place('cooler', 12, 0, 1, true);
        spots.cooler.push({ room: r.id, tile: [cx2 - 1, cy2], dir: 'right' });
        info.cooler = [cx2 - 1, cy2];
      } else if (r.kind === 'reception') {
        wallDecor('window', 2, 28); wallDecor('board', 10, 28);
        const [px0, py0] = F(5, 1);
        const sp = Sprites.furn.counter();
        addStatic(sp, px0 * T + 4, (py0 + 1) * T, (c, t) => { if (model.waiting) { const f = Math.floor(t / 180) % 2; c.fillStyle = f ? '#ffb340' : '#ffd98a'; c.fillRect(px0 * T + 8, py0 * T - 6 + 6, 4, 2); } });
        blockR(px0, py0, 3, 1);
        place('bench', 1, 5, 2, true); place('plant', 0, 0, 1, true); place('plant', 12, 0, 1, true); place('plant', 12, r.F - 1, 1, true); place('cooler', 0, 2, 1, true);
        info.counter = { x: px0 * T + 24, y: py0 * T };
      } else if (r.kind === 'copa') {
        wallDecor('window', 6, 28);
        const [mx, my] = place('coffee', 1, 0, 1, true);
        spots.coffee.push({ room: r.id, tile: [mx, my + 1], dir: 'up' });
        spots.coffee.push({ room: r.id, tile: [mx + 1, my + 1], dir: 'up' });
        place('fridge', 12, 0, 1, true);
        // duas mesas redondas com banquinhos
        for (const tx0 of [3, 8]) {
          const [tx, ty] = place('table', tx0, 3, 2, true);
          for (const [sx, sy, d] of [[tx, ty - 1, 'down'], [tx + 1, ty - 1, 'down'], [tx, ty + 1, 'up'], [tx + 1, ty + 1, 'up']]) {
            addStatic(Sprites.furn.stool(), sx * T + 8, (sy + 1) * T - 1, null);
            spots.table.push({ room: r.id, tile: [sx, sy], px: sx * T + 8, py: (sy + 1) * T - (d === 'down' ? 4 : 3), dir: d });
          }
        }
        // sofá + tv
        const [sx0, sy0] = F(5, r.F - 2);
        addStatic(Sprites.furn.sofa(), (sx0 + 1) * T, (sy0 + 1) * T, null);
        cells[sy0 * gw + sx0] = FREE; cells[sy0 * gw + sx0 + 1] = FREE;
        spots.sofa.push({ room: r.id, tile: [sx0, sy0 + 1], px: sx0 * T + 9, py: sy0 * T + 15, dir: 'down', sit: true });
        spots.sofa.push({ room: r.id, tile: [sx0 + 1, sy0 + 1], px: sx0 * T + 23, py: sy0 * T + 15, dir: 'down', sit: true });
        place('plant', 0, r.F - 1, 1, true); place('plant', 12, r.F - 1, 1, true);
        wallDecor('board', 10, 28);
      } else {
        // cérebro: estantes e mesa de leitura
        for (const lx of [1, 4, 7, 10]) {
          const [sx, sy] = place('shelf', lx, 0, 2, true);
          spots.shelf.push({ room: r.id, tile: [sx, sy + 1], dir: 'up' });
        }
        const [tx, ty] = place('table', 5, 4, 2, true);
        void tx; void ty;
        place('plant', 0, r.F - 1, 1, true); place('plant', 12, r.F - 1, 1, true);
      }
    }

    /* ---------- agentes ---------- */
    const rnd = (a, b2) => a + Math.random() * (b2 - a);
    const tileOf = (px, py) => [Math.max(0, Math.min(gw - 1, Math.floor(px / T))), Math.max(0, Math.min(gh - 1, Math.floor((py - 4) / T)))];
    const centerOf = (tx, ty) => [tx * T + 8, ty * T + 13];

    function modeOf(st) {
      if (st === 'working') return 'work';
      if (st === 'waiting') return 'wait';
      if (st === 'error') return 'sulk';
      if (st === 'ended') return 'away';
      return 'rest';
    }

    function seatFor(room, emp, existing) {
      const info = roomInfo.get(room);
      if (!info) return null;
      if (emp.isLeader) return info.leader;
      if (existing && existing.seat && existing.seat.room === room && info.seats[existing.seat.idx]) return info.seats[existing.seat.idx];
      return null;
    }

    function syncAgents(now) {
      const want = new Map();
      for (const rm of model.rooms) {
        if (rm.kind !== 'dept') continue;
        const info = roomInfo.get(rm.id);
        if (!info) continue;
        // ocupa os lugares pela ordem de chegada (estável)
        for (const s of info.seats) if (s.key && !rm.emps.find((e) => e.key === s.key)) s.key = null;
        info.leader.key = null;
        for (const e of rm.emps) {
          if (e.isLeader) { info.leader.key = e.key; want.set(e.key, { e, room: rm.id, seat: info.leader }); continue; }
          let seat = info.seats.find((s) => s.key === e.key);
          if (!seat) seat = info.seats.find((s) => !s.key);
          if (!seat) continue; // sem mesa livre
          seat.key = e.key;
          want.set(e.key, { e, room: rm.id, seat });
        }
      }
      for (const [key, a] of agents) {
        if (!want.has(key)) {
          if (a.seat) a.seat.agent = null;
          agents.delete(key);
          if (a.el) a.el.remove();
        }
      }
      for (const [key, w] of want) {
        let a = agents.get(key);
        const mode = modeOf(w.e.status);
        const seatPx = w.seat;
        if (!a) {
          a = { key, x: 0, y: 0, dir: 'down', pose: 'stand', seated: false, path: [], queue: [], cur: null, mode: null, nextOuting: now + rnd(5000, 14000), seed: Math.random() * 1000, present: false, cheerUntil: 0 };
          agents.set(key, a);
        }
        a.e = w.e; a.room = w.room; a.status = w.e.status; a.kind = w.e.kind; a.leader = !!w.e.isLeader;
        if (a.seat && a.seat !== seatPx) { a.seat.agent = null; a.path = []; a.queue = []; a.cur = null; a.seated = false; a.present = false; }
        a.seat = seatPx;
        seatPx.agent = a;
        if (mode === 'away') {
          if (a.present && a.mode !== 'away') {
            // sai pela entrada
            a.queue = [{ t: 'leave' }]; a.cur = null; a.seated = false; seatLeave(a);
          }
          if (!a.present) { a.mode = mode; continue; }
        } else if (!a.present) {
          if (firstFill || a.initial) {
            place(a, seatPx, true);
          } else {
            const [ex, ey] = centerOf(1, 2);
            a.x = ex; a.y = ey; a.dir = 'down'; a.present = true; a.seated = false;
            a.queue = [{ t: 'goto', tile: seatPx.tile }, { t: 'sit' }];
          }
        }
        if (mode !== a.mode) onMode(a, mode, now);
        a.mode = mode;
      }
      firstFill = false;
    }

    function place(a, seat, seated) {
      a.present = true;
      a.x = seat.px; a.y = seat.py; a.dir = seat.dir; a.seated = seated; a.queue = []; a.cur = null; a.path = [];
    }
    function seatLeave(a) {
      if (!a.seat) return;
      const [cx, cy] = centerOf(a.seat.tile[0], a.seat.tile[1]);
      if (a.seated) { a.x = cx; a.y = cy; a.seated = false; }
    }

    function onMode(a, mode, now) {
      if (!a.present) return;
      if (mode === 'away') return;
      a.restSince = mode === 'rest' ? now : 0;
      if (mode !== 'rest') {
        a.nextOuting = now + rnd(7000, 15000);
        // se estava passeando, volta já para a mesa
        if (!a.seated) { a.queue = [{ t: 'goto', tile: a.seat.tile }, { t: 'sit' }]; a.cur = null; }
      } else a.nextOuting = now + rnd(4000, 10000);
    }

    function poseOf(a, now) {
      if (a.cheerUntil > now) return 'cheer';
      if (a.cur && a.cur.t === 'pose') return a.cur.pose;
      if (a.cur && (a.cur.t === 'goto' || a.cur.t === 'leave') && a.path.length) return 'walk';
      if (!a.seated) return 'stand';
      switch (a.mode) {
        case 'work': return a.leader ? 'type' : 'type';
        case 'wait': return 'raise';
        case 'sulk': return 'sulk';
        default: return a.restSince && now - a.restSince > 50000 ? 'sleep' : 'stand';
      }
    }

    function startAction(a, act, now) {
      a.cur = act;
      switch (act.t) {
        case 'goto': {
          const [sx, sy] = tileOf(a.x, a.y);
          const p = findPath(cells, gw, gh, sx, sy, act.tile[0], act.tile[1]);
          if (!p) { a.cur = null; a.queue = []; fallbackSeat(a); return; }
          a.path = p;
          break;
        }
        case 'leave': {
          const [sx, sy] = tileOf(a.x, a.y);
          const p = findPath(cells, gw, gh, sx, sy, 1, 2);
          a.path = p || [];
          if (!p) { a.present = false; a.cur = null; }
          break;
        }
        case 'sit':
          a.x = a.seat.px; a.y = a.seat.py; a.dir = a.seat.dir; a.seated = true; a.cur = null;
          break;
        case 'sitAt':
          a.x = act.px; a.y = act.py; a.dir = act.dir; a.seated = true;
          act.until = now + act.ms;
          break;
        case 'pose':
          a.dir = act.dir || a.dir; act.until = now + act.ms;
          break;
        default:
      }
    }
    function fallbackSeat(a) { place(a, a.seat, true); }

    /* quem está consultando o vault (Cérebro) vai até a estante, lê um pouco e volta para a mesa */
    function brainVisits(now) {
      const ids = model.brainIds || [];
      if (!ids.length || !spots || !spots.shelf.length) return;
      for (const a of agents.values()) {
        if (!a.leader || !a.present || !a.seated || a.cur || a.queue.length || !ids.includes(a.room)) continue;
        if (a.brainNext && now < a.brainNext) continue;
        const spot = spots.shelf[Math.floor(Math.random() * spots.shelf.length)];
        seatLeave(a);
        a.queue = [{ t: 'goto', tile: spot.tile }, { t: 'pose', pose: 'read', dir: spot.dir, ms: rnd(5000, 8000) }, { t: 'goto', tile: a.seat.tile }, { t: 'sit' }];
        a.cur = null;
        a.brainNext = now + 30000;
      }
    }

    function pickOuting(a, now) {
      // escolhe um passeio possível
      const opts2 = [];
      const own = spots.cooler.find((s) => s.room === a.room);
      if (own) opts2.push({ w: 3, spot: own, pose: 'drink', ms: rnd(3500, 6000) });
      if (spots.coffee.length) opts2.push({ w: 4, spot: spots.coffee[Math.floor(Math.random() * spots.coffee.length)], pose: 'drink', ms: rnd(4000, 7000) });
      if (spots.sofa.length) opts2.push({ w: 2, spot: spots.sofa[Math.floor(Math.random() * spots.sofa.length)], sit: true, ms: rnd(6000, 11000) });
      if (spots.table.length) opts2.push({ w: 2, spot: spots.table[Math.floor(Math.random() * spots.table.length)], sit: true, ms: rnd(6000, 10000) });
      if (spots.shelf.length) opts2.push({ w: 2, spot: spots.shelf[Math.floor(Math.random() * spots.shelf.length)], pose: 'read', ms: rnd(5000, 9000) });
      if (!opts2.length) return;
      let tot = 0; for (const x of opts2) tot += x.w;
      let r = Math.random() * tot; let pick = opts2[0];
      for (const x of opts2) { r -= x.w; if (r <= 0) { pick = x; break; } }
      seatLeave(a);
      a.queue = [{ t: 'goto', tile: pick.spot.tile }];
      if (pick.sit) a.queue.push({ t: 'sitAt', px: pick.spot.px, py: pick.spot.py, dir: pick.spot.dir, ms: pick.ms });
      else a.queue.push({ t: 'pose', pose: pick.pose, dir: pick.spot.dir, ms: pick.ms });
      a.queue.push({ t: 'goto', tile: a.seat.tile }, { t: 'sit' });
      a.cur = null;
      a.nextOuting = now + rnd(14000, 30000);
    }

    function stepAgent(a, dt, now) {
      if (!a.present) return;
      // ação corrente
      if (!a.cur && a.queue.length) startAction(a, a.queue.shift(), now);
      const act = a.cur;
      if (act && (act.t === 'goto' || act.t === 'leave')) {
        if (!a.path.length) {
          if (act.t === 'leave') { a.present = false; a.cur = null; if (a.el) a.el.hidden = true; return; }
          a.cur = null;
        } else {
          const [nx, ny] = centerOf(a.path[0][0], a.path[0][1]);
          const dx = nx - a.x; const dy = ny - a.y;
          const dist = Math.hypot(dx, dy);
          const step = 46 * dt;
          if (dist <= step) { a.x = nx; a.y = ny; a.path.shift(); }
          else { a.x += (dx / dist) * step; a.y += (dy / dist) * step; }
          if (Math.abs(dx) > Math.abs(dy)) a.dir = dx > 0 ? 'right' : 'left'; else if (dist > 0.01) a.dir = dy > 0 ? 'down' : 'up';
        }
      } else if (act && (act.t === 'pose' || act.t === 'sitAt')) {
        if (now >= act.until) a.cur = null;
      }
      // mesa: passeio no tempo livre
      if (!a.cur && !a.queue.length && a.seated && a.mode === 'rest' && now >= a.nextOuting && a.cheerUntil < now) pickOuting(a, now);
      if (!a.cur && !a.queue.length && !a.seated && a.mode !== 'away' && !a.path.length) {
        // perdeu o destino: volta para a mesa
        a.queue = [{ t: 'goto', tile: a.seat.tile }, { t: 'sit' }];
      }
    }

    /* ---------- DOM dos funcionários ---------- */
    function ensureEl(a) {
      if (!a.el) {
        a.el = h('div', 'wseat');
        seatsLayer.append(a.el);
        a.inner = null;
      }
      const inner = o.seatEl ? o.seatEl(a.e) : null;
      if (inner && inner !== a.inner) {
        a.el.replaceChildren(inner);
        a.inner = inner;
      }
      a.el.hidden = !a.present;
    }
    function placeEl(a) {
      if (!a.el) return;
      const x = Math.round((a.x - 9) * Z);
      const y = Math.round((a.y - 32) * Z);
      const sig = x + ',' + y;
      if (a.sig !== sig) {
        a.sig = sig;
        a.el.style.setProperty('transform', `translate(${x}px, ${y}px)`);
        a.el.classList.toggle('flip', y < 250);
      }
    }

    /* ---------- desenho ---------- */
    function draw(now) {
      if (!bg) return;
      ctx.drawImage(bg, 0, 0);
      const list = statics.slice();
      for (const a of agents.values()) {
        if (!a.present) continue;
        const pose = poseOf(a, now);
        const [n, ms] = POSE[pose] || POSE.stand;
        let frame = Math.floor((now + a.seed * 100) / ms) % n;
        if (pose === 'walk' && !a.path.length) frame = 0;
        const mood = a.status === 'waiting' ? 'alert' : a.status === 'done' ? 'happy' : a.status === 'error' ? 'worried' : 'focus';
        const spr = Sprites.character({
          look: a.e.persona.look, shirt: a.e.persona.color, leader: a.leader, dir: a.dir, pose, frame, seated: a.seated, mood,
          pantsIdx: Pixel.hashStr(a.key), blink: ((now + a.seed * 977) % 3600) < 140, showLegs: false,
        });
        const sortY = a.seated && a.leader ? a.y - 1 : a.y + 0.2;
        list.push({ y: sortY, draw: (c) => {
          if (!a.seated) { c.fillStyle = 'rgba(0,0,0,.28)'; c.fillRect(Math.round(a.x) - 5, Math.round(a.y) - 1, 10, 3); c.fillStyle = 'rgba(0,0,0,.18)'; c.fillRect(Math.round(a.x) - 4, Math.round(a.y) - 2, 8, 1); }
          c.drawImage(spr.c, Math.round(a.x) - spr.ax, Math.round(a.y) - spr.ay);
        } });
      }
      list.sort((p, q) => p.y - q.y);
      for (const it of list) it.draw(ctx, now);
    }

    function loop(ts) {
      rafId = 0;
      if (!root.isConnected || document.hidden) return;
      rafId = requestAnimationFrame(loop);
      const now = performance.now();
      if (now - lastDraw < 62) return;
      const dt = Math.min(0.12, (now - (lastTick || now)) / 1000);
      lastTick = now;
      lastDraw = now;
      for (const a of agents.values()) {
        stepAgent(a, dt, now);
      }
      // cheers pedidos
      for (const [k, until] of pendingCheer) { const a = agents.get(k); if (a) a.cheerUntil = until; pendingCheer.delete(k); }
      draw(now);
      for (const a of agents.values()) { if (a.el) { a.el.hidden = !a.present; placeEl(a); } }
      void ts;
    }
    function ensureLoop() {
      if (!rafId && root.isConnected && !document.hidden) { lastTick = 0; rafId = requestAnimationFrame(loop); }
    }
    document.addEventListener('visibilitychange', ensureLoop);

    /* ---------- API ---------- */
    function update(m) {
      model = m;
      const avail = Math.max(320, m.width || 1000);
      const cols = Math.max(1, Math.min(3, Math.floor((avail / 32 - HALL) / ROOM_W)));
      const list = m.rooms.map((r) => ({ id: r.id, kind: r.kind, n: r.kind === 'dept' ? Math.min(r.emps.length, MAX_SEATS + 1) : 0 }));
      const sig = JSON.stringify([cols, list]);
      const wTiles = HALL + cols * ROOM_W;
      const z = Math.max(1, Math.min(3, Math.floor(avail / (wTiles * T))));
      if (sig !== layoutSig || z !== Z) {
        Z = z;
        layoutSig = sig;
        const layout = computeLayout(list, cols);
        const old = new Map([...agents].map(([k, a]) => [k, { seated: a.seated, present: a.present }]));
        build(layout);
        for (const a of agents.values()) { a.seat = null; a.path = []; a.queue = []; a.cur = null; a.seated = false; a.mode = null; a.present = false; }
        firstFill = true;
        void old;
        canvas.width = L.W * T;
        canvas.height = L.H * T;
        root.style.setProperty('width', L.W * T * Z + 'px');
        root.style.setProperty('height', L.H * T * Z + 'px');
        root.style.setProperty('--z', String(Z));
        canvas.style.setProperty('width', L.W * T * Z + 'px');
        canvas.style.setProperty('height', L.H * T * Z + 'px');
        // sala de cada overlay
        for (const pr of L.rooms) {
          const rm = m.rooms.find((x) => x.id === pr.id);
          if (!rm || !rm.el) continue;
          const el = rm.el;
          el.style.setProperty('left', pr.tx * T * Z + 'px');
          el.style.setProperty('top', pr.ty * T * Z + 'px');
          el.style.setProperty('width', pr.w * T * Z + 'px');
          el.style.setProperty('height', pr.outerH * T * Z + 'px');
        }
      }
      roomsLayer.replaceChildren(...m.rooms.map((r) => r.el).filter(Boolean));
      syncAgents(performance.now());
      for (const a of agents.values()) { if (a.present || a.mode !== 'away') ensureEl(a); }
      const wantEls = new Set([...agents.values()].map((a) => a.el).filter(Boolean));
      for (const el of [...seatsLayer.children]) if (!wantEls.has(el)) el.remove();
      brainVisits(performance.now());
      ensureLoop();
    }

    function cheer(key) {
      pendingCheer.set(key, performance.now() + 2800);
    }

    return { el: root, update, cheer, get zoom() { return Z; } };
  }

  window.World = { create, findPath };
})();
