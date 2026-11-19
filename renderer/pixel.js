'use strict';
/**
 * Motor de pixel art do Claude Hub.
 * Tudo é desenhado em grades minúsculas num <canvas>, ampliado sem suavização e entregue como data-URL
 * (a CSP só permite img-src 'self' data:). Animação = folha de quadros (sprite sheet) rodada por CSS com steps(),
 * então não existe laço de JavaScript rodando e o custo de CPU é quase zero.
 */
(function () {
  const INK = '#1a1626';
  const KIND_COL = { think: '#b18cff', read: '#5aa2ff', edit: '#3ccf91', run: '#ffb340', delegate: '#ff7ac8', wait: '#ffd23f', other: '#8fa0b8' };
  const FRAMES = 4;
  const cache = new Map();

  const mkCanvas = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  };
  const ctx2 = (c) => c.getContext('2d', { willReadFrequently: true });

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.max(0, Math.min(255, v + amt));
    return '#' + ((1 << 24) | (f((n >> 16) & 255) << 16) | (f((n >> 8) & 255) << 8) | f(n & 255)).toString(16).slice(1);
  }
  function hashStr(str) {
    let x = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      x ^= str.charCodeAt(i);
      x = Math.imul(x, 0x01000193) >>> 0;
    }
    return x >>> 0;
  }
  const pen = (ctx, ox = 0, oy = 0) => (x, y, w, h, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(ox + x, oy + y, w, h);
  };

  /** Contorno escuro de 1px em volta de tudo que foi desenhado (dá o visual "sprite"). */
  function outline(ctx, w, h, color = INK) {
    const d = ctx.getImageData(0, 0, w, h).data;
    const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 20;
    ctx.fillStyle = color;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!solid(x, y) && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  /** Junta quadros (canvases w×h) numa folha ampliada k vezes e devolve o data-URL. */
  function sheet(frames, w, h, k) {
    const out = mkCanvas(w * k * frames.length, h * k);
    const o = out.getContext('2d');
    o.imageSmoothingEnabled = false;
    frames.forEach((f, i) => o.drawImage(f, 0, 0, w, h, i * w * k, 0, w * k, h * k));
    return out.toDataURL('image/png');
  }
  function frameCanvas(w, h, draw) {
    const c = mkCanvas(w, h);
    const ctx = ctx2(c);
    draw(ctx, pen(ctx));
    outline(ctx, w, h);
    return c;
  }
  const memo = (key, make) => {
    let v = cache.get(key);
    if (v === undefined) {
      v = make();
      cache.set(key, v);
    }
    return v;
  };

  /* ------------------------------------------------------------ pessoa (busto) */
  const MOOD_OF = { working: 'focus', waiting: 'alert', done: 'happy', error: 'worried', idle: 'sleepy', ended: 'sleepy' };

  /** Busto 16×16 de frente. o: {skin,hair,style,glasses,shirt,leader,mood,blink,wave} */
  function bust(ctx, ox, oy, o) {
    const P = pen(ctx, ox, oy);
    const { skin, hair, style, shirt } = o;
    const skinD = shade(skin, -28);
    const hairL = shade(hair, 30);
    const hairD = shade(hair, -22);
    const shirtL = shade(shirt, 34);
    const shirtD = shade(shirt, -30);
    const cap = shade(shirt, 45);
    const capD = shade(shirt, 15);

    // cabelo que fica atrás da cabeça
    if (style === 1) P(3, 3, 10, 9, hair);
    if (style === 3) {
      P(3, 2, 10, 7, hair);
      P(2, 4, 1, 3, hair);
      P(13, 4, 1, 3, hair);
    }
    // braço levantado (acenando por socorro)
    if (o.mood === 'alert') {
      const wx = o.wave ? 14 : 13;
      P(wx, 11, 2, 5, shirt);
      P(wx, 7, 2, 4, skin);
      P(wx, 6, 2, 1, skinD);
    }
    // ombros / camisa
    P(3, 11, 10, 5, shirt);
    P(2, 12, 12, 4, shirt);
    P(2, 15, 12, 1, shirtD);
    P(5, 11, 6, 1, shirtL);
    if (o.leader) {
      P(5, 11, 2, 1, '#ffffff');
      P(9, 11, 2, 1, '#ffffff');
      P(7, 12, 2, 4, '#d1493b');
      P(7, 12, 2, 1, '#f08070');
    }
    // pescoço e cabeça
    P(7, 10, 2, 2, skinD);
    P(5, 3, 6, 8, skin);
    P(4, 4, 8, 6, skin);
    P(3, 6, 1, 2, skin);
    P(12, 6, 1, 2, skin);
    P(4, 9, 8, 1, shade(skin, -8));

    // cabelo por cima
    switch (style) {
      case 0:
        P(4, 2, 8, 2, hair);
        P(4, 4, 1, 2, hair);
        P(11, 4, 1, 2, hair);
        P(6, 2, 3, 1, hairL);
        break;
      case 1:
        P(4, 2, 8, 2, hair);
        P(4, 4, 1, 6, hair);
        P(11, 4, 1, 6, hair);
        P(5, 4, 3, 1, hair);
        P(6, 2, 3, 1, hairL);
        P(3, 10, 2, 2, hairD);
        P(11, 10, 2, 2, hairD);
        break;
      case 2:
        P(4, 2, 8, 2, hair);
        P(4, 4, 1, 2, hair);
        P(11, 4, 1, 2, hair);
        P(6, 0, 4, 2, hair);
        P(7, 0, 2, 1, hairL);
        break;
      case 3:
        P(3, 1, 10, 3, hair);
        P(4, 0, 8, 1, hair);
        P(3, 4, 2, 3, hair);
        P(11, 4, 2, 3, hair);
        P(5, 1, 2, 1, hairL);
        P(9, 2, 2, 1, hairL);
        break;
      case 4:
        P(4, 2, 8, 2, cap);
        P(5, 1, 6, 1, cap);
        P(3, 4, 10, 1, capD);
        P(7, 1, 2, 1, shade(cap, 25));
        P(4, 5, 1, 2, hair);
        P(11, 5, 1, 2, hair);
        break;
      default:
        P(4, 2, 8, 2, hair);
        P(4, 4, 3, 1, hair);
        P(10, 4, 2, 2, hair);
        P(11, 6, 1, 1, hair);
        P(7, 2, 3, 1, hairL);
    }

    // rosto
    const closed = o.mood === 'sleepy' || o.blink;
    if (style !== 4 && style !== 1 && style !== 3) {
      P(5, 5, 2, 1, hairD);
      P(9, 5, 2, 1, hairD);
    }
    if (o.glasses) {
      const g = '#5b6072';
      for (const x of [5, 8]) {
        P(x, 5, 3, 1, g);
        P(x, 7, 3, 1, g);
        P(x, 6, 1, 1, g);
        P(x + 2, 6, 1, 1, g);
      }
    }
    if (closed) {
      P(6, 6, 1, 1, skinD);
      P(9, 6, 1, 1, skinD);
    } else if (o.mood === 'alert') {
      P(6, 6, 1, 2, INK);
      P(9, 6, 1, 2, INK);
    } else {
      P(6, 6, 1, 1, INK);
      P(9, 6, 1, 1, INK);
    }
    switch (o.mood) {
      case 'happy':
        P(6, 9, 4, 1, '#8a3b3b');
        P(5, 8, 1, 1, '#8a3b3b');
        P(10, 8, 1, 1, '#8a3b3b');
        P(4, 7, 1, 1, '#f08a7a');
        P(11, 7, 1, 1, '#f08a7a');
        break;
      case 'alert':
        P(7, 9, 2, 2, '#7a3030');
        break;
      case 'worried':
        P(7, 9, 2, 1, '#6b3a3a');
        P(6, 10, 1, 1, '#6b3a3a');
        P(9, 10, 1, 1, '#6b3a3a');
        P(12, 3, 1, 2, '#7cc7ff');
        break;
      case 'sleepy':
        P(7, 9, 2, 1, skinD);
        P(12, 0, 3, 1, '#cfe3ff');
        P(13, 1, 1, 1, '#cfe3ff');
        P(12, 2, 3, 1, '#cfe3ff');
        break;
      default:
        P(7, 9, 2, 1, skinD);
    }
  }

  const lookOf = (p) => ({ skin: p.look.skin, hair: p.look.hair, style: p.look.style, glasses: p.look.glasses, shirt: p.color, leader: !!p.leader });

  /** Busto como <img>; size escolhe a escala inteira mais próxima (18px por escala). */
  function avatar(p, moodId, size) {
    const k = Math.max(1, Math.round(size / 18));
    const l = lookOf(p);
    const key = ['av', l.skin, l.hair, l.style, l.glasses, l.shirt, l.leader, moodId, k].join('|');
    const url = memo(key, () => {
      const c = frameCanvas(18, 18, (ctx) => bust(ctx, 1, 1, { ...l, mood: moodId, wave: false }));
      return sheet([c], 18, 18, k);
    });
    const img = document.createElement('img');
    img.className = 'px-avatar';
    img.alt = '';
    img.draggable = false;
    img.src = url;
    img.width = img.height = 18 * k;
    img.setAttribute('aria-hidden', 'true');
    return img;
  }

  /* ---------------------------------------------------------- telas do monitor */
  function screenArt(P, x0, y0, st, kind, f) {
    const col = KIND_COL[kind] || KIND_COL.think;
    const W = 14;
    const H = 7;
    const bg = (c) => P(x0, y0, W, H, c);
    if (st === 'ended') return bg('#0c0d11');
    if (st === 'waiting' || kind === 'wait') {
      bg(f % 2 ? '#3a2a0c' : '#5a3f10');
      P(x0 + 6, y0 + 1, 2, 3, '#ffcb52');
      P(x0 + 6, y0 + 5, 2, 1, '#ffcb52');
      return;
    }
    if (st === 'done') {
      bg('#123a22');
      [[4, 3], [5, 4], [6, 5], [7, 4], [8, 3], [9, 2], [10, 1]].forEach(([x, y]) => P(x0 + x, y0 + y, 1, 1, '#46e08e'));
      return;
    }
    if (st === 'error') {
      bg(f % 2 ? '#4a1519' : '#32101a');
      for (let i = 0; i < 5; i++) {
        P(x0 + 4 + i, y0 + 1 + i, 1, 1, '#ff6b6b');
        P(x0 + 8 - i, y0 + 1 + i, 1, 1, '#ff6b6b');
      }
      return;
    }
    if (st === 'idle') {
      bg('#171a24');
      P(x0 + 2 + f * 3, y0 + 1 + (f % 2) * 3, 2, 2, '#4a5372');
      return;
    }
    switch (kind) {
      case 'edit':
        bg('#0f1a17');
        for (let r = 0; r < 3; r++) {
          const y = y0 + 1 + r * 2;
          const ind = (r + f) % 3;
          const len = 4 + ((r * 3 + f * 2) % 7);
          P(x0 + 1 + ind, y, len, 1, col);
          P(x0 + 2 + ind + len, y, 2, 1, '#9ae6c6');
        }
        if (f % 2) P(x0 + 12, y0 + 5, 1, 1, '#ffffff');
        break;
      case 'run': {
        bg('#0a0f0c');
        const n = 3;
        for (let r = 0; r < n; r++) {
          const y = y0 + 1 + r * 2;
          P(x0 + 1, y, 1, 1, col);
          const len = 3 + ((r * 5 + f * 3) % 7);
          P(x0 + 3, y, len, 1, '#8de0a8');
        }
        if (f % 2) P(x0 + 3 + 3 + ((2 * 5 + f * 3) % 7), y0 + 5, 1, 1, '#ffffff');
        break;
      }
      case 'read':
        bg('#0e1626');
        P(x0 + 1, y0 + 1 + ((f * 2) % 6), 12, 1, '#2f4f86');
        for (let r = 0; r < 3; r++) P(x0 + 1, y0 + 1 + r * 2, 5 + ((r * 4) % 7), 1, col);
        break;
      case 'delegate':
        bg('#1f1226');
        P(x0 + 1, y0 + 2, 3, 3, col);
        P(x0 + 10, y0 + 2, 3, 3, '#ffd0ec');
        P(x0 + 4 + ((f * 2) % 6), y0 + 3, 1, 1, '#ffffff');
        break;
      case 'other':
        bg('#141922');
        for (let i = 0; i < 4; i++) P(x0 + 2 + i * 3, y0 + 2 + ((i + f) % 2) * 2, 2, 2, (i + f) % 2 ? col : '#3d4659');
        break;
      default:
        bg('#171227');
        for (let i = 0; i < 3; i++) P(x0 + 4 + i * 3, y0 + 3, 2, 2, i === f % 3 ? col : '#4c3f78');
    }
  }

  /* ------------------------------------------------------- planta (de cima) */
  const PW = 34;
  const PH = 30;

  function drawPlanFrame(ctx, P, o, f) {
    const st = o.status;
    const away = st === 'done' || st === 'ended';
    const sleepy = st === 'idle';
    const wood = '#b8865a';
    // mesa
    P(1, 1, 32, 14, wood);
    P(1, 1, 32, 1, '#d4a574');
    P(1, 13, 32, 2, '#8a6140');
    P(1, 15, 32, 1, '#6b4a30');
    if (o.leader) P(1, 14, 32, 1, '#e0b341');
    // papéis
    P(3, 4, 5, 6, '#f4f1e8');
    P(4, 5, 3, 1, '#b8b3c4');
    P(4, 7, 3, 1, '#b8b3c4');
    // monitor
    P(9, 2, 16, 9, '#2a2d38');
    screenArt(P, 10, 3, st, o.kind, f);
    P(15, 11, 4, 1, '#4a4f5e');
    // teclado
    P(10, 12, 14, 2, '#d7dbe6');
    P(11, 12, 1, 1, '#8a90a3');
    P(14, 12, 1, 1, '#8a90a3');
    P(17, 12, 1, 1, '#8a90a3');
    P(20, 12, 1, 1, '#8a90a3');
    // caneca
    P(27, 8, 3, 3, '#f4f1e8');
    P(27, 8, 3, 1, '#6b3b24');
    P(30, 9, 1, 1, '#f4f1e8');
    if (away || o.kind === 'run') {
      const sy = 6 - (f % 3);
      P(28, sy, 1, 1, '#ffffffaa');
    }
    // cadeira
    P(8, 17, 18, 12, '#434a5c');
    P(9, 17, 16, 1, '#5a6378');
    P(9, 28, 16, 1, '#343a49');
    if (away) {
      // cadeira vazia com o casaco pendurado
      P(10, 18, 14, 4, o.shirt);
      P(10, 18, 14, 1, shade(o.shirt, 34));
      P(11, 23, 12, 4, '#505a70');
      return;
    }
    const sk = o.skin;
    const skD = shade(sk, -28);
    const hair = o.hair;
    const hL = shade(hair, 30);
    const hD = shade(hair, -22);
    const shirt = o.shirt;
    const dy = sleepy ? -3 : 0;
    // ombros
    P(9, 20, 16, 8, shirt);
    P(10, 19, 14, 1, shirt);
    P(9, 27, 16, 1, shade(shirt, -30));
    P(11, 20, 12, 1, shade(shirt, 28));
    // braços e mãos
    const typing = st === 'working';
    if (st === 'waiting') {
      P(10, 14, 3, 6, shirt);
      P(11, 12, 2, 2, sk);
      const wx = 25 + (f % 2);
      P(wx, 8, 2, 12, shirt);
      P(wx, 5, 2, 3, sk);
      P(wx + (f % 2 ? 0 : 1), 4, 1, 1, sk);
    } else if (sleepy) {
      P(10, 14, 4, 6, shirt);
      P(20, 14, 4, 6, shirt);
      P(12, 13, 10, 2, sk);
    } else {
      P(10, 14, 4, 6, shirt);
      P(20, 14, 4, 6, shirt);
      const ly = typing && f % 2 ? 12 : 13;
      const ry = typing && f % 2 ? 13 : 12;
      P(11, ly, 2, 2, sk);
      P(21, ry, 2, 2, sk);
    }
    // cabeça vista de cima
    const hx = 12;
    const hy = 18 + dy;
    switch (o.style) {
      case 1:
        P(hx - 1, hy + 1, 12, 10, hair);
        P(hx, hy, 10, 1, hair);
        P(hx + 5, hy + 6, 1, 5, hD);
        break;
      case 2:
        P(hx + 1, hy, 8, 9, hair);
        P(hx, hy + 1, 10, 7, hair);
        P(hx + 3, hy + 8, 4, 3, hair);
        P(hx + 4, hy + 8, 2, 1, hL);
        break;
      case 3:
        P(hx - 1, hy + 1, 12, 9, hair);
        P(hx, hy, 10, 1, hair);
        P(hx + 1, hy - 1, 3, 1, hair);
        P(hx + 6, hy - 1, 3, 1, hair);
        P(hx + 2, hy + 2, 2, 1, hL);
        P(hx + 6, hy + 4, 2, 1, hL);
        break;
      case 4: {
        const cap = shade(shirt, 45);
        P(hx + 1, hy, 8, 9, cap);
        P(hx, hy + 1, 10, 7, cap);
        P(hx + 2, hy - 2, 6, 2, shade(shirt, 15));
        P(hx + 4, hy + 4, 2, 2, shade(cap, 25));
        break;
      }
      default:
        P(hx + 1, hy, 8, 9, hair);
        P(hx, hy + 1, 10, 7, hair);
        P(hx + 2, hy + 1, 3, 1, hL);
        P(hx + 5, hy + 1, 1, 3, hD);
    }
    P(hx - 1, hy + 4, 1, 2, sk);
    P(hx + 10, hy + 4, 1, 2, sk);
    if (sleepy) {
      const zy = 22 - f * 2;
      P(27, zy, 3, 1, '#cfe3ff');
      P(28, zy + 1, 1, 1, '#cfe3ff');
      P(27, zy + 2, 3, 1, '#cfe3ff');
    }
  }

  /** Folha de 4 quadros da mesa vista de cima. o: {look…, status, kind, k}. */
  function planSheet(o) {
    const key = ['plan', o.skin, o.hair, o.style, o.shirt, o.leader, o.status, o.kind, o.k].join('|');
    return memo(key, () => {
      const frames = [];
      for (let f = 0; f < FRAMES; f++) frames.push(frameCanvas(PW, PH, (ctx, P) => drawPlanFrame(ctx, P, o, f)));
      return sheet(frames, PW, PH, o.k);
    });
  }

  /* ------------------------------------------------- close-up (de frente) */
  const FW = 40;
  const FH = 36;

  function drawFrontFrame(ctx, P, o, f) {
    const st = o.status;
    const away = st === 'done' || st === 'ended';
    const col = KIND_COL[o.kind] || KIND_COL.think;
    const g1 = '#3f9f5e';
    const g2 = '#58c97a';
    // planta
    P(5, 14, 3, 6, g1);
    P(7, 12, 3, 9, g2);
    P(3, 16, 3, 5, g2);
    P(9, 15, 3, 5, g1);
    P(3, 22, 7, 4, '#a8643c');
    P(3, 22, 7, 1, '#c98355');
    // cadeira
    P(11, 8, 18, 18, '#3f4658');
    P(12, 7, 16, 1, '#3f4658');
    P(12, 8, 16, 1, '#5a6378');
    if (away) {
      P(13, 10, 14, 9, o.shirt);
      P(13, 10, 14, 1, shade(o.shirt, 34));
      P(13, 18, 14, 1, shade(o.shirt, -30));
    } else {
      // tronco e cabeça
      P(14, 21, 12, 5, o.shirt);
      const blink = f === 3 && st !== 'idle';
      bust(ctx, 12, 5, { ...o, mood: MOOD_OF[st] || 'focus', blink, wave: f % 2 === 1 });
      // braço levantado do lado direito já vem no busto (alert); mãos ficam no teclado
      P(9, 18, 4, 7, o.shirt);
      P(28, 18, 4, 7, o.shirt);
    }
    // monitor (de costas)
    P(12, 19, 16, 6, '#3a3f4c');
    P(12, 19, 16, 1, '#565c6e');
    P(19, 21, 2, 2, '#7a8196');
    const note = ['#ffd23f', '#ff9ec7', '#8fe0ff'][o.noteIdx % 3];
    P(24, 20, 3, 3, note);
    const lit = st === 'working' ? f < 2 || f === 3 : st === 'waiting' ? f % 2 === 0 : st === 'done' ? true : false;
    P(26, 24, 1, 1, lit ? (st === 'done' ? '#46e08e' : st === 'waiting' ? '#ffcb52' : col) : '#2a2d38');
    // brilho que vaza pelas bordas do monitor quando trabalha
    if (st === 'working') {
      P(11, 19, 1, 6, shade(col, -60));
      P(28, 19, 1, 6, shade(col, -60));
    }
    // mesa
    P(1, 25, 38, 3, '#d4a574');
    P(1, 25, 38, 1, '#e8c08c');
    P(2, 28, 36, 7, '#a8774a');
    P(2, 28, 36, 1, '#7a5535');
    P(24, 30, 12, 4, '#8d6340');
    P(29, 32, 2, 1, '#e0c28a');
    P(4, 30, 12, 4, '#8d6340');
    P(9, 32, 2, 1, '#e0c28a');
    if (o.leader) P(2, 29, 36, 1, '#e0b341');
    // mãos no teclado
    if (!away) {
      if (st === 'waiting') {
        P(10, 24, 3, 2, o.skin);
        const wx = 30 + (f % 2);
        P(wx, 9, 3, 11, o.shirt);
        P(wx, 6, 3, 3, o.skin);
      } else if (st === 'working') {
        P(10, f % 2 ? 23 : 24, 3, 2, o.skin);
        P(27, f % 2 ? 24 : 23, 3, 2, o.skin);
      } else {
        P(10, 24, 3, 2, o.skin);
        P(27, 24, 3, 2, o.skin);
      }
    }
    // caneca
    P(32, 22, 4, 3, '#f4f1e8');
    P(32, 22, 4, 1, '#6b3b24');
    P(36, 23, 1, 1, '#f4f1e8');
    if (away || o.kind === 'run') P(33, 20 - (f % 3), 1, 1, '#ffffffaa');
  }

  function frontSheet(o) {
    const key = ['front', o.skin, o.hair, o.style, o.glasses, o.shirt, o.leader, o.status, o.kind, o.noteIdx, o.k].join('|');
    return memo(key, () => {
      const frames = [];
      for (let f = 0; f < FRAMES; f++) frames.push(frameCanvas(FW, FH, (ctx, P) => drawFrontFrame(ctx, P, o, f)));
      return sheet(frames, FW, FH, o.k);
    });
  }

  /**
   * Elemento animado (clip + folha). type: 'plan' | 'front'.
   * A animação é CSS puro (steps): .px-anim > img.
   */
  function sprite(type, p, status, kind, k) {
    const l = lookOf(p);
    const o = { ...l, status, kind: kind || 'think', k, noteIdx: hashStr(p.key || p.name || '') };
    const url = type === 'plan' ? planSheet(o) : frontSheet(o);
    const w = (type === 'plan' ? PW : FW) * k;
    const hh = (type === 'plan' ? PH : FH) * k;
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.draggable = false;
    img.width = w * FRAMES;
    img.height = hh;
    const box = document.createElement('div');
    box.className = `px-anim px-${type} px-st-${status}`;
    box.setAttribute('aria-hidden', 'true');
    box.style.setProperty('--w', w + 'px');
    box.style.setProperty('--h', hh + 'px');
    box.style.setProperty('--n', String(FRAMES));
    const dur = status === 'working' ? 0.7 : status === 'waiting' ? 0.6 : status === 'idle' ? 1.6 : status === 'error' ? 0.8 : 1.1;
    box.style.setProperty('--dur', dur + 's');
    box.append(img);
    return box;
  }

  /* ---------------------------------------------------------------- móveis */
  const PROPS = {
    plant: { w: 14, h: 20, draw: (P) => {
      P(3, 3, 4, 8, '#2f8f55'); P(6, 1, 4, 10, '#46b26e'); P(8, 4, 4, 7, '#2f8f55'); P(1, 6, 4, 5, '#46b26e');
      P(7, 3, 1, 5, '#7bdc9c');
      P(3, 11, 8, 7, '#a8643c'); P(3, 11, 8, 1, '#c98355'); P(3, 17, 8, 1, '#7a4526');
    } },
    cooler: { w: 10, h: 20, draw: (P) => {
      P(1, 1, 8, 6, '#9ed3ff'); P(2, 2, 2, 3, '#d8efff'); P(1, 7, 8, 11, '#d8dde8'); P(1, 7, 8, 1, '#f1f4fa');
      P(3, 10, 4, 2, '#5aa2ff'); P(3, 14, 4, 2, '#ff7a7a'); P(1, 17, 8, 1, '#9aa3b6');
    } },
    shelf: { w: 26, h: 22, draw: (P) => {
      P(0, 0, 26, 22, '#7a5535'); P(1, 1, 24, 20, '#4a3322');
      const cols = ['#e35d5d', '#5aa2ff', '#f2c14e', '#46b26e', '#b18cff', '#ff9ec7'];
      for (let r = 0; r < 3; r++) {
        let x = 2;
        for (let i = 0; i < 6; i++) {
          const w = 2 + ((i + r) % 2);
          P(x, 2 + r * 6, w, 4, cols[(i + r * 2) % cols.length]);
          x += w + 1;
        }
        P(1, 6 + r * 6, 24, 1, '#7a5535');
      }
    } },
    sofa: { w: 32, h: 14, draw: (P) => {
      P(1, 1, 30, 7, '#8a5a90'); P(1, 1, 30, 1, '#a877ae'); P(0, 5, 4, 8, '#6d4572'); P(28, 5, 4, 8, '#6d4572');
      P(4, 7, 24, 5, '#9d6aa4'); P(4, 7, 24, 1, '#b585bb'); P(15, 7, 1, 5, '#7f4f86'); P(2, 12, 2, 2, '#3b2540'); P(28, 12, 2, 2, '#3b2540');
    } },
    coffee: { w: 14, h: 18, draw: (P) => {
      P(1, 1, 12, 15, '#4a5268'); P(1, 1, 12, 1, '#6a7490'); P(3, 3, 8, 4, '#2a2f3d'); P(4, 4, 2, 2, '#46e08e');
      P(5, 10, 4, 5, '#f4f1e8'); P(5, 10, 4, 1, '#6b3b24'); P(1, 15, 12, 1, '#2f3444');
    } },
    window: { w: 20, h: 15, draw: (P) => {
      P(0, 0, 20, 15, '#f4f1e8'); P(2, 2, 16, 11, '#7fb8ff'); P(2, 2, 16, 4, '#a8d2ff');
      P(4, 4, 5, 2, '#ffffff'); P(5, 3, 4, 1, '#ffffff'); P(12, 7, 4, 2, '#ffffff'); P(9, 2, 2, 11, '#f4f1e8'); P(2, 7, 16, 1, '#f4f1e8');
      P(0, 14, 20, 1, '#cfc9b8');
    } },
    board: { w: 22, h: 15, draw: (P) => {
      P(0, 0, 22, 15, '#8a6140'); P(1, 1, 20, 13, '#f4f1e8');
      P(3, 3, 12, 1, '#5aa2ff'); P(3, 6, 8, 1, '#9aa3b6'); P(3, 9, 14, 1, '#3ccf91'); P(17, 5, 3, 3, '#ffd23f'); P(1, 13, 20, 1, '#cfc9b8');
    } },
    rug: { w: 40, h: 16, draw: (P) => {
      P(1, 1, 38, 14, '#00000022'); P(0, 0, 38, 14, '#d8c9a6'); P(2, 2, 34, 10, '#b5483e'); P(4, 4, 30, 6, '#d8c9a6'); P(6, 5, 26, 4, '#b5483e');
    } },
  };
  function prop(name, k) {
    const d = PROPS[name];
    const key = 'prop|' + name + '|' + k;
    const url = memo(key, () => {
      const c = frameCanvas(d.w + 2, d.h + 2, (ctx) => d.draw(pen(ctx, 1, 1)));
      return sheet([c], d.w + 2, d.h + 2, k);
    });
    return { url, w: (d.w + 2) * k, h: (d.h + 2) * k };
  }

  /* ---------------------------------------------------- temas das salas */
  const THEMES = [
    { wall: '#5d7cc2', wall2: '#5372b4', dot: '#7a96d8', carpet: '#44557f', carpet2: '#3d4d74', trim: '#2c3f73' }, // azul
    { wall: '#4fa59b', wall2: '#479a90', dot: '#6dbdb2', carpet: '#3a6b68', carpet2: '#346360', trim: '#246058' }, // verde-água
    { wall: '#c4a06a', wall2: '#b8945c', dot: '#d9b983', carpet: '#7c6644', carpet2: '#725d3d', trim: '#7a5a2b' }, // areia
    { wall: '#8a6fc0', wall2: '#7d62b3', dot: '#a58bd6', carpet: '#5b4885', carpet2: '#53417a', trim: '#4c3a85' }, // lilás
    { wall: '#7da96c', wall2: '#719d60', dot: '#98c387', carpet: '#52703f', carpet2: '#4a6639', trim: '#3f6234' }, // sálvia
    { wall: '#c9788a', wall2: '#bd6c7e', dot: '#dd93a3', carpet: '#85495a', carpet2: '#7a4152', trim: '#84384c' }, // rosé
  ];
  const theme = (i) => THEMES[((i % THEMES.length) + THEMES.length) % THEMES.length];

  /** Ladrilho repetível: {url,size}. kind: wall | wood | carpet. */
  function tile(kind, idx) {
    const t = theme(idx);
    const K = 4;
    return memo(`tile|${kind}|${kind === 'wood' ? 0 : idx}`, () => {
      const w = kind === 'carpet' ? 8 : 16;
      const c = mkCanvas(w, w);
      const ctx = ctx2(c);
      const P = pen(ctx);
      if (kind === 'wood') {
        P(0, 0, 16, 16, '#b98a55');
        for (let r = 0; r < 4; r++) {
          const y = r * 4;
          P(0, y, 16, 3, r % 2 ? '#c09060' : '#b98a55');
          P(0, y + 3, 16, 1, '#7d5731');
          P(((r * 7) % 16), y, 1, 3, '#7d5731');
          P(((r * 5 + 4) % 16), y + 1, 3, 1, '#c99a66');
        }
      } else if (kind === 'carpet') {
        P(0, 0, 8, 8, t.carpet);
        P(0, 0, 4, 4, t.carpet2);
        P(4, 4, 4, 4, t.carpet2);
        P(2, 2, 1, 1, shade(t.carpet, 18));
        P(6, 6, 1, 1, shade(t.carpet, 18));
      } else {
        P(0, 0, 16, 16, t.wall);
        for (let x = 0; x < 16; x += 4) P(x, 0, 2, 16, t.wall2);
        P(1, 4, 1, 1, t.dot);
        P(5, 11, 1, 1, t.dot);
        P(9, 4, 1, 1, t.dot);
        P(13, 11, 1, 1, t.dot);
      }
      return { url: sheet([c], w, w, K), size: w * K };
    });
  }

  /** Canvas lógico (sem ampliar) de um móvel pronto, para o prédio animado. */
function propCanvas(name) {
  const d = PROPS[name];
  return memo('propc|' + name, () => frameCanvas(d.w + 2, d.h + 2, (ctx) => d.draw(pen(ctx, 1, 1))));
}

window.Pixel = { avatar, sprite, prop, propCanvas, tile, theme, THEMES, KIND_COL, FRAMES, shade, hashStr, mkCanvas, ctx2, pen, outline, memo, INK };
})();
