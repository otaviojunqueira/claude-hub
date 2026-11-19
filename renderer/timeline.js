'use strict';
/** Faixas de tempo (estilo Gantt) por funcionário, legenda, eixo e tooltip. */
(function () {
  const KINDS = {
    think: { label: 'Pensando' },
    read: { label: 'Lendo e buscando' },
    edit: { label: 'Editando' },
    run: { label: 'Executando' },
    delegate: { label: 'Delegando' },
    wait: { label: 'Esperando você' },
    other: { label: 'Outras ferramentas' },
  };
  const ORDER = ['think', 'read', 'edit', 'run', 'delegate', 'wait', 'other'];
  const WINDOWS = ['auto', 5, 15, 60]; // 'auto' ajusta ao que existe; os demais são minutos
  const TICKS = { 5: [5, 4, 3, 2, 1, 0], 15: [15, 10, 5, 0], 60: [60, 45, 30, 15, 0] };

  function fmt(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}min ${s % 60 ? (s % 60) + 's' : ''}`.trim();
    return `${Math.floor(m / 60)}h ${m % 60}min`;
  }

  /** Atualiza a faixa reaproveitando os elementos (tooltip e hover não "piscam"). */
  function renderStrip(el, emp, windowMs, now) {
    const from = now - windowMs;
    let n = 0;
    for (const g of emp.segments) {
      const end = g.end == null ? now : g.end;
      if (end <= from) continue;
      const start = Math.max(g.start, from);
      let node = el.children[n];
      if (!node) {
        node = document.createElement('i');
        el.appendChild(node);
      }
      node.className = 'seg k-' + g.kind + (g.end == null ? ' live' : '');
      node.style.left = (((start - from) / windowMs) * 100).toFixed(3) + '%';
      node.style.width = Math.max(((end - start) / windowMs) * 100, 0.3).toFixed(3) + '%';
      node.dataset.tip = `${KINDS[g.kind] ? KINDS[g.kind].label : g.kind}: ${g.label} (${fmt(end - g.start)})`;
      n += 1;
    }
    while (el.children.length > n) el.lastChild.remove();
  }

  function ago(ms) {
    const sec = Math.round(ms / 1000);
    if (sec < 120) return `${sec}s`;
    const m = Math.round(sec / 60);
    if (m < 90) return `${m}min`;
    return `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'min' : ''}`;
  }

  /** ms = largura da janela. Janelas fixas usam marcas "redondas"; a automática, frações. */
  function renderAxis(el, ms) {
    const fixed = TICKS[ms / 60000];
    const marks = fixed
      ? fixed.map((m) => ({ f: 1 - m / (ms / 60000), label: m === 0 ? 'agora' : `-${m}min` }))
      : [1, 2 / 3, 1 / 3, 0].map((r) => ({ f: 1 - r, label: r === 0 ? 'agora' : `-${ago(ms * r)}` }));
    const sig = marks.map((m) => m.label).join('|');
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.replaceChildren(
      ...marks.map((m) => {
        const s = document.createElement('span');
        s.style.left = (m.f * 100).toFixed(2) + '%';
        s.textContent = m.label;
        if (m.label === 'agora') s.className = 'ax-now';
        return s;
      })
    );
  }

  function legend() {
    const box = document.createElement('div');
    box.className = 'legend';
    for (const k of ORDER) {
      const it = document.createElement('span');
      it.className = 'lg';
      const sw = document.createElement('i');
      sw.className = 'sw k-' + k;
      it.append(sw, KINDS[k].label);
      box.append(it);
    }
    return box;
  }

  // Tooltip único para todos os segmentos.
  let tip = null;
  function ensureTip() {
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'tip';
      tip.hidden = true;
      document.body.appendChild(tip);
    }
    return tip;
  }
  document.addEventListener('mouseover', (e) => {
    const seg = e.target.closest && e.target.closest('.seg');
    if (!seg) return;
    const t = ensureTip();
    t.textContent = seg.dataset.tip || '';
    t.hidden = false;
  });
  document.addEventListener('mousemove', (e) => {
    if (!tip || tip.hidden) return;
    const w = tip.offsetWidth;
    tip.style.left = Math.min(e.clientX + 12, window.innerWidth - w - 8) + 'px';
    tip.style.top = e.clientY + 16 + 'px';
  });
  document.addEventListener('mouseout', (e) => {
    if (tip && e.target.closest && e.target.closest('.seg')) tip.hidden = true;
  });

  window.Timeline = { KINDS, ORDER, WINDOWS, fmt, renderStrip, renderAxis, legend };
})();
