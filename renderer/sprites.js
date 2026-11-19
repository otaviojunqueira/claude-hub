'use strict';
/**
 * Sprites do prédio animado: personagens de corpo inteiro (4 direções, várias poses) e móveis.
 * Tudo procedural, em pixels lógicos (1 tile = 16px), com contorno escuro. O Escritório amplia com CSS (pixelated).
 * Os desenhos são guardados em cache por aparência+pose+quadro.
 */
(function () {
  const { mkCanvas, ctx2, pen, outline, memo, shade, INK } = Pixel;
  const TILE = 16;

  /* ----------------------------------------------------------------- personagem */
  const PANTS = ['#35405f', '#3d3d4a', '#4b3b3b', '#2f4a45', '#4a4a5c'];
  const SHOE = '#2a2230';
  const CW = 24; // largura da folha do personagem
  const CH = 36;
  const AX = 12; // âncora: centro dos pés
  const AY = 32;

  function hairFront(P, st, hair, shirt, b) {
    const hL = shade(hair, 30);
    const cap = shade(shirt, 45);
    switch (st) {
      case 1:
        P(-4, -23 + b, 8, 3, hair); P(-5, -21 + b, 2, 9, hair); P(3, -21 + b, 2, 9, hair); P(-2, -23 + b, 3, 1, hL);
        break;
      case 2:
        P(-4, -23 + b, 8, 3, hair); P(-4, -20 + b, 1, 2, hair); P(3, -20 + b, 1, 2, hair);
        P(-2, -26 + b, 4, 3, hair); P(-1, -26 + b, 2, 1, hL);
        break;
      case 3:
        P(-5, -24 + b, 10, 5, hair); P(-6, -22 + b, 1, 3, hair); P(5, -22 + b, 1, 3, hair); P(-4, -19 + b, 1, 2, hair); P(3, -19 + b, 1, 2, hair);
        P(-3, -24 + b, 2, 1, hL); P(1, -23 + b, 2, 1, hL);
        break;
      case 4:
        P(-4, -24 + b, 8, 4, cap); P(-5, -20 + b, 10, 1, shade(cap, -35)); P(-4, -19 + b, 1, 2, hair); P(3, -19 + b, 1, 2, hair); P(-1, -24 + b, 2, 1, shade(cap, 25));
        break;
      case 5:
        P(-4, -23 + b, 8, 2, hair); P(-4, -21 + b, 5, 2, hair); P(3, -21 + b, 1, 3, hair); P(-1, -23 + b, 3, 1, hL);
        break;
      default:
        P(-4, -23 + b, 8, 3, hair); P(-4, -20 + b, 1, 2, hair); P(3, -20 + b, 1, 2, hair); P(-2, -23 + b, 3, 1, hL);
    }
  }
  function hairBack(P, st, hair, shirt, b) {
    const hL = shade(hair, 30);
    const cap = shade(shirt, 45);
    switch (st) {
      case 1: P(-5, -23 + b, 10, 12, hair); P(-1, -14 + b, 2, 3, shade(hair, -20)); P(-2, -23 + b, 3, 1, hL); break;
      case 2: P(-4, -23 + b, 8, 8, hair); P(-2, -26 + b, 4, 3, hair); P(-1, -26 + b, 2, 1, hL); break;
      case 3: P(-5, -24 + b, 10, 9, hair); P(-3, -24 + b, 2, 1, hL); break;
      case 4: P(-4, -24 + b, 8, 5, cap); P(-4, -19 + b, 8, 4, hair); P(-1, -24 + b, 2, 1, shade(cap, 25)); break;
      default: P(-4, -23 + b, 8, 8, hair); P(-2, -23 + b, 3, 1, hL);
    }
  }
  function hairSide(P, st, hair, shirt, b) {
    const hL = shade(hair, 30);
    const cap = shade(shirt, 45);
    switch (st) {
      case 1: P(-5, -23 + b, 7, 3, hair); P(-5, -20 + b, 4, 10, hair); P(1, -23 + b, 3, 2, hair); P(-3, -23 + b, 3, 1, hL); break;
      case 2: P(-4, -23 + b, 8, 3, hair); P(-4, -20 + b, 3, 4, hair); P(-4, -27 + b, 4, 4, hair); P(-3, -27 + b, 2, 1, hL); break;
      case 3: P(-5, -24 + b, 10, 5, hair); P(-5, -19 + b, 4, 4, hair); P(-3, -24 + b, 2, 1, hL); break;
      case 4: P(-4, -24 + b, 8, 4, cap); P(2, -20 + b, 4, 1, shade(cap, -35)); P(-4, -20 + b, 3, 5, hair); break;
      case 5: P(-4, -23 + b, 8, 2, hair); P(-4, -21 + b, 4, 5, hair); P(0, -21 + b, 4, 2, hair); break;
      default: P(-4, -23 + b, 8, 3, hair); P(-4, -20 + b, 4, 5, hair); P(-2, -23 + b, 3, 1, hL);
    }
  }

  /** Desenha o corpo em coordenadas relativas aos pés (x: centro, y: negativo para cima). */
  function drawBody(P, o) {
    const { skin, hair, style, glasses } = o.look;
    const sh = o.shirt;
    const skinD = shade(skin, -28);
    const shD = shade(sh, -32);
    const shL = shade(sh, 30);
    const pants = o.leader ? '#252b45' : PANTS[o.pantsIdx % PANTS.length];
    const f = o.frame;
    const pose = o.pose;
    const dir = o.dir;
    const side = dir === 'left' || dir === 'right';
    const seated = o.seated;
    let b = seated ? 4 : 0; // corpo desce quando sentado
    if (pose === 'stand' && f % 2) b -= 0; // respiração sutil fica no cabelo/ombro
    let jump = 0;
    let lLift = 0;
    let rLift = 0;
    let aL = 0;
    let aR = 0;
    let sx = 0; // afastamento lateral das pernas (de lado)
    if (pose === 'walk') {
      const ph = f % 4;
      b -= ph === 1 || ph === 3 ? 1 : 0;
      if (side) sx = ph === 1 ? 2 : ph === 3 ? -2 : 0;
      else {
        lLift = ph === 1 ? 2 : 0;
        rLift = ph === 3 ? 2 : 0;
        aL = ph === 3 ? -1 : ph === 1 ? 1 : 0;
        aR = -aL;
      }
    }
    if (pose === 'cheer') jump = f % 2 ? -2 : 0;
    const B = b + jump;

    // sombra de contato fica por conta de quem desenha (não entra no contorno)
    if (!seated) {
      if (side) {
        P(-3 + sx, -8, 3, 6 - (sx < 0 ? 1 : 0), pants); P(0 - sx, -8, 3, 6 - (sx > 0 ? 1 : 0), shade(pants, -14));
        P(-3 + sx, -2, 4, 2, SHOE); P(0 - sx, -2, 4, 2, SHOE);
      } else {
        P(-3, -8 - 0, 3, 6 - lLift, pants); P(0, -8, 3, 6 - rLift, pants);
        P(-3, -2 - lLift, 3, 2, SHOE); P(0, -2 - rLift, 3, 2, SHOE);
      }
    } else if (dir === 'down' || dir === 'up') {
      // joelhos aparecem pouco: só a ponta dos sapatos
      if (o.showLegs) { P(-3, -4, 3, 3, pants); P(0, -4, 3, 3, pants); P(-3, -2, 3, 2, SHOE); P(0, -2, 3, 2, SHOE); }
    }

    // ---- tronco
    const tx = side ? -3 : -4;
    const tw = side ? 6 : 8;
    P(tx, -15 + B, tw, 7, sh);
    P(tx, -9 + B, tw, 1, shD);
    if (dir === 'down') {
      if (o.leader) {
        P(-2, -15 + B, 1, 2, '#ffffff'); P(1, -15 + B, 1, 2, '#ffffff'); P(-1, -14 + B, 2, 5, '#d1493b'); P(-1, -14 + B, 2, 1, '#f08070');
      } else {
        P(-1, -15 + B, 2, 1, skinD); P(-3, -15 + B, 6, 1, shL);
      }
    } else if (dir === 'up') {
      P(-3, -15 + B, 6, 1, shL);
    }

    // ---- braços
    const armsDown = () => {
      if (side) { P(-1, -14 + B + (f % 2 && pose === 'walk' ? 1 : 0), 2, 6, shD); P(-1, -8 + B, 2, 1, skin); }
      else {
        P(-6, -14 + B + aL, 2, 6, sh); P(4, -14 + B + aR, 2, 6, sh); P(-6, -8 + B + aL, 2, 1, skin); P(4, -8 + B + aR, 2, 1, skin);
      }
    };
    switch (pose) {
      case 'type': {
        // braços para a frente (para cima, vistos de costas), mãos alternando
        const up = dir === 'up';
        if (up) {
          P(-6, -14 + B, 2, 5, sh); P(4, -14 + B, 2, 5, sh);
          P(-6, -17 + B - (f % 2), 2, 3, shL); P(4, -17 + B - ((f + 1) % 2), 2, 3, shL);
          P(-6, -18 + B - (f % 2), 2, 1, skin); P(4, -18 + B - ((f + 1) % 2), 2, 1, skin);
        } else if (side) {
          P(0, -13 + B, 4, 2, sh); P(4, -13 + B - (f % 2), 1, 2, skin);
        } else {
          P(-6, -14 + B, 2, 5, sh); P(4, -14 + B, 2, 5, sh);
          P(-5, -9 + B + (f % 2), 2, 1, skin); P(3, -9 + B + ((f + 1) % 2), 2, 1, skin);
        }
        break;
      }
      case 'raise': {
        const w = f % 2 ? 1 : 0;
        if (side) { P(-1, -14 + B, 2, 6, shD); P(0 + w, -26 + B, 2, 12, sh); P(0 + w, -28 + B, 2, 2, skin); }
        else {
          P(-6, -14 + B, 2, 6, sh); P(-6, -8 + B, 2, 1, skin);
          P(4 + w, -27 + B, 2, 13, sh); P(4 + w, -29 + B, 2, 3, skin);
        }
        break;
      }
      case 'cheer': {
        P(-6, -27 + B, 2, 13, sh); P(4, -27 + B, 2, 13, sh); P(-6, -29 + B, 2, 3, skin); P(4, -29 + B, 2, 3, skin);
        break;
      }
      case 'drink': {
        const hi = f % 2 ? 0 : 3;
        if (side) { P(0, -14 + B, 2, 3, sh); P(1, -17 + B + hi * 0, 2, 4, sh); P(2, -19 + B + hi, 3, 3, '#f4f1e8'); }
        else {
          P(-6, -14 + B, 2, 6, sh); P(-6, -8 + B, 2, 1, skin);
          P(4, -14 + B, 2, 3, sh); P(3, -18 + B + (hi ? 2 : 0), 3, 4, sh); P(2, -21 + B + hi, 3, 3, '#f4f1e8'); P(2, -21 + B + hi, 3, 1, '#7a4a2a');
        }
        break;
      }
      case 'read': {
        armsDown();
        P(-3, -13 + B, 6, 4, '#e7e2d3'); P(-3, -13 + B, 6, 1, '#b5483e'); P(0, -13 + B, 1, 4, '#9c9788');
        break;
      }
      case 'sulk': {
        armsDown();
        break;
      }
      default:
        armsDown();
    }

    // ---- cabeça
    let hb = B;
    if (pose === 'sleep' || pose === 'sulk') hb += 2;
    if (pose === 'stand' && f % 2) hb += 0;
    if (dir === 'up') {
      P(-4, -22 + hb, 8, 7, skin); P(-3, -23 + hb, 6, 1, skin);
      hairBack(P, style, hair, sh, hb);
      P(-5, -20 + hb, 1, 2, skin); P(4, -20 + hb, 1, 2, skin);
    } else if (side) {
      P(-4, -22 + hb, 8, 7, skin); P(-3, -23 + hb, 6, 1, skin); P(4, -19 + hb, 1, 2, skin); // nariz
      hairSide(P, style, hair, sh, hb);
      const closed = pose === 'sleep' || o.blink;
      P(1, closed ? -18 + hb : -19 + hb, 1, closed ? 1 : 2, closed ? skinD : INK);
      if (glasses) { P(0, -20 + hb, 3, 1, '#5b6072'); P(0, -17 + hb, 3, 1, '#5b6072'); P(3, -19 + hb, 1, 2, '#5b6072'); }
      P(2, -16 + hb, 2, 1, skinD);
    } else {
      P(-4, -22 + hb, 8, 6, skin); P(-3, -23 + hb, 6, 1, skin); P(-3, -16 + hb, 6, 1, skin);
      hairFront(P, style, hair, sh, hb);
      const closed = pose === 'sleep' || o.blink;
      if (glasses) {
        const g = '#5b6072';
        for (const x of [-4, 0]) { P(x, -20 + hb, 4, 1, g); P(x, -17 + hb, 4, 1, g); P(x, -19 + hb, 1, 2, g); P(x + 3, -19 + hb, 1, 2, g); }
      }
      if (closed) { P(-3, -18 + hb, 2, 1, skinD); P(1, -18 + hb, 2, 1, skinD); }
      else if (o.mood === 'alert' || pose === 'cheer') { P(-2, -19 + hb, 1, 2, INK); P(1, -19 + hb, 1, 2, INK); }
      else { P(-2, -19 + hb, 1, 2, INK); P(1, -19 + hb, 1, 2, INK); }
      if (pose === 'cheer' || pose === 'raise') P(-1, -16 + hb, 2, 1, '#8a3b3b');
      else if (pose === 'sulk') { P(-1, -16 + hb, 2, 1, '#6b3a3a'); P(-2, -15 + hb, 1, 1, '#6b3a3a'); P(1, -15 + hb, 1, 1, '#6b3a3a'); P(3, -21 + hb, 1, 2, '#7cc7ff'); }
      else P(-1, -16 + hb, 2, 1, skinD);
      if (pose !== 'sleep' && o.mood === 'happy') { P(-4, -17 + hb, 1, 1, '#f08a7a'); P(3, -17 + hb, 1, 1, '#f08a7a'); }
    }
    if (pose === 'sleep') {
      const zy = -28 - (f % 2) * 2;
      P(5, zy, 3, 1, '#cfe3ff'); P(6, zy + 1, 1, 1, '#cfe3ff'); P(5, zy + 2, 3, 1, '#cfe3ff');
    }
  }

  /** Sprite do personagem: { c, ax, ay } (cache). */
  function character(o) {
    const key = ['ch', o.look.skin, o.look.hair, o.look.style, o.look.glasses ? 1 : 0, o.shirt, o.leader ? 1 : 0, o.dir, o.pose, o.frame, o.seated ? 1 : 0, o.showLegs ? 1 : 0, o.mood || '', o.blink ? 1 : 0, o.pantsIdx % 5].join('|');
    return memo(key, () => {
      const flip = o.dir === 'left';
      const c = mkCanvas(CW, CH);
      const ctx = ctx2(c);
      const P = pen(ctx, AX, AY);
      drawBody(P, { ...o, dir: flip ? 'right' : o.dir });
      outline(ctx, CW, CH);
      if (!flip) return { c, ax: AX, ay: AY };
      const c2 = mkCanvas(CW, CH);
      const x2 = c2.getContext('2d');
      x2.translate(CW, 0);
      x2.scale(-1, 1);
      x2.drawImage(c, 0, 0);
      return { c: c2, ax: AX, ay: AY };
    });
  }

  /* ----------------------------------------------------------------- móveis */
  function sheetOf(w, h, ax, ay, draw, noOutline) {
    const c = mkCanvas(w, h);
    const ctx = ctx2(c);
    draw(pen(ctx), ctx);
    if (!noOutline) outline(ctx, w, h);
    return { c, ax, ay };
  }

  /** Mesa de 2 tiles. screenAt: posição do monitor (x,y no sprite) para o mundo desenhar a tela viva. */
  function desk(variant) {
    return memo('desk|' + variant, () => {
      const W = 38;
      const H = 36;
      const leader = variant === 'leader';
      const s = sheetOf(W, H, 3, 34, (P) => {
        const wood = leader ? '#a9744a' : '#b8865a';
        const woodL = leader ? '#c99565' : '#d4a574';
        const woodD = leader ? '#7a4f30' : '#8a6140';
        // tampo
        P(3, 14, 32, 9, wood); P(3, 14, 32, 1, woodL); P(3, 22, 32, 1, woodD);
        // frente e gaveteiros
        P(3, 23, 32, 9, woodD); P(4, 24, 14, 7, shade(woodD, 12)); P(20, 24, 14, 7, shade(woodD, 12));
        P(9, 27, 3, 1, '#e0c28a'); P(25, 27, 3, 1, '#e0c28a');
        P(3, 32, 2, 2, '#4a3322'); P(33, 32, 2, 2, '#4a3322');
        if (leader) P(3, 23, 32, 1, '#e0b341');
        // papéis, caneca
        P(5, 16, 5, 5, '#f4f1e8'); P(6, 17, 3, 1, '#b8b3c4'); P(6, 19, 3, 1, '#b8b3c4');
        P(29, 17, 3, 3, '#f4f1e8'); P(29, 17, 3, 1, '#6b3b24'); P(32, 18, 1, 1, '#f4f1e8');
        // teclado
        const kx = leader ? 18 : 13;
        P(kx, 19, 10, 2, '#d7dbe6'); P(kx + 1, 19, 1, 1, '#8a90a3'); P(kx + 4, 19, 1, 1, '#8a90a3'); P(kx + 7, 19, 1, 1, '#8a90a3');
        // monitor (moldura + base); a tela viva é pintada por cima
        const mx = leader ? 22 : 12;
        P(mx - 1, 4, 16, 11, '#2a2d38'); P(mx + 5, 15, 4, 2, '#4a4f5e');
      });
      s.screen = { x: (leader ? 22 : 12) + 0, y: 5, w: 14, h: 9 };
      s.screen.x = (leader ? 22 : 12);
      return s;
    });
  }

  function chair(back) {
    // back: 'south' (encosto perto de quem olha) | 'north' (encosto atrás da pessoa)
    return memo('chair|' + back, () => sheetOf(18, 20, 9, 18, (P) => {
      const c1 = '#4a5268';
      const c2 = '#5f6a86';
      if (back === 'north') {
        P(2, 0, 14, 8, c1); P(3, 1, 12, 1, c2); P(2, 8, 14, 7, c2); P(2, 14, 14, 1, '#343a49'); P(8, 15, 2, 3, '#2a2f3d'); P(4, 17, 10, 1, '#2a2f3d');
      } else {
        P(2, 2, 14, 7, c2); P(2, 8, 14, 1, '#343a49'); P(2, 9, 14, 6, c1); P(3, 14, 12, 1, c2); P(8, 15, 2, 2, '#2a2f3d'); P(4, 17, 10, 1, '#2a2f3d');
      }
    }));
  }

  const furn = {
    plant: () => memo('f|plant', () => ({ c: Pixel.propCanvas('plant'), ax: 8, ay: 20 })),
    cooler: () => memo('f|cooler', () => ({ c: Pixel.propCanvas('cooler'), ax: 6, ay: 21 })),
    shelf: () => memo('f|shelf', () => ({ c: Pixel.propCanvas('shelf'), ax: 14, ay: 23 })),
    coffee: () => memo('f|coffee', () => ({ c: Pixel.propCanvas('coffee'), ax: 8, ay: 19 })),
    sofa: () => memo('f|sofa', () => ({ c: Pixel.propCanvas('sofa'), ax: 17, ay: 15 })),
    board: () => memo('f|board', () => ({ c: Pixel.propCanvas('board'), ax: 12, ay: 16 })),
    window: () => memo('f|window', () => ({ c: Pixel.propCanvas('window'), ax: 11, ay: 16 })),
    table: () => memo('f|table', () => sheetOf(26, 24, 13, 22, (P) => {
      P(3, 4, 20, 10, '#e9dcc0'); P(3, 4, 20, 1, '#fff4d8'); P(4, 14, 18, 1, '#a79a7c'); P(12, 15, 2, 6, '#6d5f4a'); P(7, 20, 12, 2, '#6d5f4a');
      P(8, 7, 3, 3, '#f4f1e8'); P(8, 7, 3, 1, '#6b3b24'); P(16, 8, 5, 2, '#ffd23f');
    })),
    stool: () => memo('f|stool', () => sheetOf(12, 12, 6, 11, (P) => { P(1, 1, 10, 5, '#b5483e'); P(1, 1, 10, 1, '#d56a5e'); P(5, 6, 2, 4, '#2a2f3d'); P(2, 10, 8, 1, '#2a2f3d'); })),
    counter: () => memo('f|counter', () => sheetOf(52, 30, 4, 28, (P) => {
      P(2, 8, 48, 10, '#d8c9a6'); P(2, 8, 48, 1, '#f1e6c8'); P(2, 18, 48, 9, '#7a5535'); P(4, 20, 20, 6, '#8d6340'); P(28, 20, 20, 6, '#8d6340');
      P(12, 3, 4, 5, '#e8d9a0'); P(11, 2, 6, 2, '#d1bb6a'); P(34, 4, 12, 4, '#2a2f3d'); P(36, 5, 8, 2, '#46e08e');
    })),
    bench: () => memo('f|bench', () => sheetOf(34, 16, 17, 15, (P) => { P(1, 2, 32, 5, '#8a6140'); P(1, 2, 32, 1, '#c99565'); P(1, 7, 32, 3, '#6b4a30'); P(3, 10, 3, 4, '#3b2a1c'); P(28, 10, 3, 4, '#3b2a1c'); })),
    tv: () => memo('f|tv', () => sheetOf(26, 20, 13, 19, (P) => { P(1, 1, 24, 15, '#1b1d26'); P(3, 3, 20, 11, '#3a6fb0'); P(5, 5, 8, 2, '#8fc2ff'); P(14, 9, 6, 2, '#ffd23f'); P(11, 16, 4, 2, '#2a2f3d'); })),
    fridge: () => memo('f|fridge', () => sheetOf(16, 30, 8, 29, (P) => { P(1, 1, 14, 27, '#d8dde8'); P(1, 1, 14, 1, '#f1f4fa'); P(1, 12, 14, 1, '#9aa3b6'); P(12, 5, 1, 4, '#6b7287'); P(12, 16, 1, 6, '#6b7287'); })),
    rug: (w, h, c1, c2) => memo(`f|rug|${w}|${h}|${c1}`, () => sheetOf(w, h, 0, h, (P) => { P(0, 0, w, h, c1); P(2, 2, w - 4, h - 4, c2); P(4, 4, w - 8, h - 8, c1); }, true)),
  };

  /** Tela viva do monitor: desenha direto no ctx principal em (x,y) de 14x9. */
  function screen(ctx, x, y, st, kind, t) {
    const f = Math.floor(t / 220) % 4;
    const col = Pixel.KIND_COL[kind] || Pixel.KIND_COL.think;
    const R = (dx, dy, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x + dx, y + dy, w, h); };
    const W = 14;
    const H = 9;
    if (st === 'ended') { R(0, 0, W, H, '#0c0d11'); return; }
    if (st === 'waiting' || kind === 'wait') { R(0, 0, W, H, f % 2 ? '#3a2a0c' : '#5a3f10'); R(6, 2, 2, 4, '#ffcb52'); R(6, 7, 2, 1, '#ffcb52'); return; }
    if (st === 'done') { R(0, 0, W, H, '#123a22'); [[4, 4], [5, 5], [6, 6], [7, 5], [8, 4], [9, 3], [10, 2]].forEach(([a, b]) => R(a, b, 1, 1, '#46e08e')); return; }
    if (st === 'error') { R(0, 0, W, H, f % 2 ? '#4a1519' : '#32101a'); for (let i = 0; i < 5; i++) { R(4 + i, 2 + i, 1, 1, '#ff6b6b'); R(8 - i, 2 + i, 1, 1, '#ff6b6b'); } return; }
    if (st === 'idle') { R(0, 0, W, H, '#171a24'); R(2 + f * 3, 2 + (f % 2) * 4, 2, 2, '#4a5372'); return; }
    switch (kind) {
      case 'edit':
        R(0, 0, W, H, '#0f1a17');
        for (let r = 0; r < 4; r++) { const ind = (r + f) % 3; const len = 3 + ((r * 3 + f * 2) % 7); R(1 + ind, 1 + r * 2, len, 1, col); R(2 + ind + len, 1 + r * 2, 2, 1, '#9ae6c6'); }
        break;
      case 'run':
        R(0, 0, W, H, '#0a0f0c');
        for (let r = 0; r < 4; r++) { R(1, 1 + r * 2, 1, 1, col); R(3, 1 + r * 2, 3 + ((r * 5 + f * 3) % 8), 1, '#8de0a8'); }
        if (f % 2) R(3 + 3 + ((3 * 5 + f * 3) % 8), 7, 1, 1, '#ffffff');
        break;
      case 'read':
        R(0, 0, W, H, '#0e1626'); R(1, 1 + ((f * 2) % 7), 12, 1, '#2f4f86');
        for (let r = 0; r < 4; r++) R(1, 1 + r * 2, 5 + ((r * 4) % 8), 1, col);
        break;
      case 'delegate':
        R(0, 0, W, H, '#1f1226'); R(1, 3, 3, 3, col); R(10, 3, 3, 3, '#ffd0ec'); R(4 + ((f * 2) % 6), 4, 1, 1, '#ffffff');
        break;
      case 'other':
        R(0, 0, W, H, '#141922');
        for (let i = 0; i < 4; i++) R(2 + i * 3, 2 + ((i + f) % 2) * 3, 2, 2, (i + f) % 2 ? col : '#3d4659');
        break;
      default:
        R(0, 0, W, H, '#171227');
        for (let i = 0; i < 3; i++) R(4 + i * 3, 3, 2, 3, i === f % 3 ? col : '#4c3f78');
    }
  }

  /* ----------------------------------------------------------------- pisos e paredes */
  function floorTile(kind, themeIdx) {
    const t = Pixel.theme(themeIdx);
    return memo(`floor|${kind}|${kind === 'wood' || kind === 'tile' || kind === 'marble' ? 0 : themeIdx}`, () => {
      const c = mkCanvas(TILE, TILE);
      const ctx = ctx2(c);
      const P = pen(ctx);
      if (kind === 'wood') {
        P(0, 0, 16, 16, '#c79a62');
        for (let r = 0; r < 4; r++) {
          P(0, r * 4, 16, 3, r % 2 ? '#cfa26a' : '#c79a62'); P(0, r * 4 + 3, 16, 1, '#8f6a3a');
          P((r * 7) % 16, r * 4, 1, 3, '#8f6a3a'); P((r * 5 + 4) % 16, r * 4 + 1, 3, 1, '#d8ad76');
        }
      } else if (kind === 'carpet') {
        P(0, 0, 16, 16, t.carpet); P(0, 0, 8, 8, t.carpet2); P(8, 8, 8, 8, t.carpet2); P(3, 3, 1, 1, shade(t.carpet, 16)); P(11, 11, 1, 1, shade(t.carpet, 16));
      } else if (kind === 'tile') {
        P(0, 0, 16, 16, '#dfe6ee'); P(0, 0, 8, 8, '#cdd7e3'); P(8, 8, 8, 8, '#cdd7e3'); P(0, 15, 16, 1, '#b4c0d0'); P(15, 0, 1, 16, '#b4c0d0');
      } else {
        P(0, 0, 16, 16, '#d9d4cb'); P(0, 15, 16, 1, '#bdb7ab'); P(15, 0, 1, 16, '#bdb7ab'); P(4, 4, 1, 1, '#c8c2b6'); P(11, 9, 1, 1, '#c8c2b6'); P(7, 12, 1, 1, '#e6e1d8');
      }
      return c;
    });
  }
  function wallTile(themeIdx) {
    const t = Pixel.theme(themeIdx);
    return memo('wall|' + themeIdx, () => {
      const c = mkCanvas(TILE, TILE);
      const P = pen(ctx2(c));
      P(0, 0, 16, 16, t.wall);
      for (let x = 0; x < 16; x += 4) P(x, 0, 2, 16, t.wall2);
      P(1, 5, 1, 1, t.dot); P(9, 5, 1, 1, t.dot); P(5, 11, 1, 1, t.dot); P(13, 11, 1, 1, t.dot);
      return c;
    });
  }

  window.Sprites = { TILE, character, desk, chair, furn, screen, floorTile, wallTile, CW, CH, AX, AY };
})();
