'use strict';
/* Caixa de entrada: tudo que espera o usuário, de todos os departamentos, num lugar só.
   - pedidos de permissão, perguntas entre departamentos e planos de delegação dos chats abertos pelo hub
     podem ser aprovados ou negados daqui, sem abrir o chat;
   - agentes que esperam você no VS Code aparecem como aviso (o hub não consegue responder por lá).
   Todo texto entra via textContent. */

const Inbox = (() => {
  const SVG = 'http://www.w3.org/2000/svg';
  let deps = null; // { sectorOf(sid), openChat(sid), focusRoom(sid), waitingElsewhere(hubSids), isOpen(sid), sound() }
  let btn = null;
  let badge = null;
  let panel = null;
  let shown = false;
  let items = [];
  let outside = [];
  let seen = new Set();
  let first = true;
  let busy = false;
  let sig = '';

  function bellIcon() {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', 'M12 3a6 6 0 0 0-6 6v3.5L4.5 15v1.5h15V15L18 12.5V9a6 6 0 0 0-6-6zm-2 15a2 2 0 0 0 4 0');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.7');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }

  const ago = (ts) => {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'agora';
    if (s < 3600) return `há ${Math.round(s / 60)} min`;
    return `há ${Math.round(s / 3600)} h`;
  };

  const TITLES = { perm: 'pede permissão', office: 'quer perguntar a outro departamento', plan: 'propõe um plano para vários departamentos' };

  async function decide(it, behavior) {
    if (busy) return;
    busy = true;
    try {
      await window.hub.chatDecide(it.sid, it.id, behavior);
    } finally {
      busy = false;
    }
    refresh();
  }

  function card(it) {
    const kind = it.kind || 'perm';
    return h('div', { class: `ib-item k-${kind}` },
      h('div', { class: 'ib-top' },
        h('b', { text: deps.sectorOf(it.sid) }),
        h('span', { class: 'ib-kind', text: kind === 'plan' ? 'Plano' : kind === 'office' ? 'Pergunta' : 'Permissão' }),
        h('time', { text: ago(it.ts) })),
      h('div', { class: 'ib-what' }, h('b', { text: kind === 'perm' ? it.tool : '' }), kind === 'perm' ? ` ${TITLES.perm}` : TITLES[kind] || ''),
      it.description ? h('div', { class: 'ib-desc', text: it.description }) : null,
      it.detail ? h('pre', { class: 'code ib-detail', text: it.detail }) : null,
      h('div', { class: 'ib-act' },
        h('button', { type: 'button', class: 'chip-btn', text: 'Abrir chat', onclick: () => { hide(); deps.openChat(it.sid); } }),
        h('span', { class: 'cmp-grow' }),
        h('button', { type: 'button', class: 'btn danger', text: 'Negar', onclick: () => decide(it, 'deny') }),
        h('button', { type: 'button', class: 'btn primary', text: kind === 'plan' ? 'Aprovar plano' : 'Aprovar', onclick: () => decide(it, 'allow') })));
  }

  function waitCard(w) {
    return h('div', { class: 'ib-item k-wait' },
      h('div', { class: 'ib-top' }, h('b', { text: w.sector }), h('span', { class: 'ib-kind', text: 'No VS Code' })),
      h('div', { class: 'ib-what', text: 'está esperando você no VS Code. Responda por lá.' }),
      h('div', { class: 'ib-act' }, h('button', { type: 'button', class: 'chip-btn', text: 'Ir para a sala', onclick: () => { hide(); deps.focusRoom(w.id); } })));
  }

  function draw() {
    if (!btn) return;
    const total = items.length;
    badge.textContent = String(total + outside.length);
    badge.hidden = total + outside.length === 0;
    btn.classList.toggle('has', total > 0);
    btn.setAttribute('aria-label', total + outside.length ? `Pendências: ${total + outside.length}` : 'Pendências: nada esperando');
    if (!shown) return;
    const s = JSON.stringify([items.map((i) => i.id), outside.map((o) => o.id)]);
    if (s === sig) return; // não refaz o DOM (e não atrapalha cliques) se nada mudou
    sig = s;
    panel.replaceChildren(
      h('div', { class: 'ib-head' }, h('h2', { text: 'Pendências' }), h('button', { type: 'button', class: 'close', 'aria-label': 'Fechar', text: '✕', onclick: hide })),
      ...(total || outside.length
        ? [...items.map(card), ...outside.map(waitCard)]
        : [h('div', { class: 'chat-empty', text: 'Nada esperando você.' })]));
  }

  async function refresh() {
    if (!btn) return;
    try {
      const list = await window.hub.chatInbox();
      items = Array.isArray(list) ? list : [];
    } catch {
      return;
    }
    const hubSids = new Set(items.map((i) => i.sid));
    outside = deps.waitingElsewhere(hubSids);
    // aviso sonoro para pedidos novos de chats que não estão abertos na tela
    const now = new Set(items.map((i) => i.id));
    if (!first && deps.sound() && items.some((i) => !seen.has(i.id) && !deps.isOpen(i.sid))) deps.beep();
    seen = now;
    first = false;
    draw();
  }

  function show() {
    shown = true;
    sig = '';
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    draw();
  }
  function hide() {
    shown = false;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
  const toggle = () => (shown ? hide() : (refresh(), show()));

  function init(d) {
    deps = d;
    btn = document.getElementById('btn-inbox');
    if (!btn) return;
    badge = h('span', { class: 'bell-n', hidden: '' });
    btn.replaceChildren(bellIcon(), badge);
    panel = h('div', { id: 'inbox', class: 'inbox', role: 'dialog', 'aria-label': 'Pendências', hidden: '' });
    document.body.append(panel);
    btn.onclick = toggle;
    document.addEventListener('pointerdown', (e) => {
      if (shown && !panel.contains(e.target) && !btn.contains(e.target)) hide();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && shown) hide();
      else if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        toggle();
      }
    });
    if (window.hub.onChatChanged) window.hub.onChatChanged(() => refresh());
    setInterval(refresh, 2500);
    refresh();
  }

  return { init, refresh, open: () => { refresh(); show(); }, count: () => items.length + outside.length };
})();
