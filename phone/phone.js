'use strict';
/* Página do celular. Todo texto vindo do hub entra via textContent; o único innerHTML é o SVG
   dos avatares (persona.js), montado só com constantes. */

const TOKEN_KEY = 'claude-hub-phone-token';
const STATUS = { working: 'Trabalhando', waiting: 'Aguardando você', done: 'Concluído', error: 'Erro', idle: 'Ocioso', ended: 'Saiu' };
const TASK_STATUS = { running: 'Rodando', done: 'Concluída', error: 'Falhou', stopped: 'Interrompida' };
const $ = (id) => document.getElementById(id);

let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch { /* sem armazenamento */ }
let state = null;
let tab = 'permits';
let skew = 0;
let fatal = null;
let formDraft = { cwd: '', prompt: '', mode: 'plan' };
let formMsg = '';
const armed = new Map(); // id+behavior -> timeout
const seenPermits = new Set();
let polling = null;
let chatSid = null; // departamento aberto no chat
let chatUI = null;
let deliv = { list: null, err: '', loading: false, at: 0 };
let viewer = null; // arquivo aberto
// vibrar só depois do primeiro toque (o navegador bloqueia antes disso)
function buzz(pattern) {
  try { if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(pattern); } catch { /* ok */ }
}
const SEEN_KEY = 'claude-hub-phone-deliv-seen';
let seenDeliv = 0;
try { seenDeliv = Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { /* ok */ }
let lastLatest = null;

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'vars') for (const [n, val] of Object.entries(v)) el.style.setProperty(n, val);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const hm = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
function dur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}min` : `${Math.floor(m / 60)}h ${m % 60}min`;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Hub-Token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  let data = null;
  try { data = await res.json(); } catch { /* sem corpo */ }
  if (res.status === 401) throw Object.assign(new Error('auth'), { code: 401 });
  return { ok: res.ok, status: res.status, data };
}

async function apiRaw(path) {
  const res = await fetch(path, { headers: token ? { 'X-Hub-Token': token } : {}, cache: 'no-store' });
  if (res.status === 401) throw Object.assign(new Error('auth'), { code: 401 });
  return res;
}

/* ---------------------------------------------------------------- pareamento */
async function pairFromHash() {
  const m = location.hash.match(/[#&]p=([\w-]+)/);
  if (!m) return;
  history.replaceState(null, '', location.pathname);
  try {
    const r = await api('/api/pair', { code: m[1] });
    if (r.ok && r.data && r.data.token) {
      token = r.data.token;
      try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ok */ }
    } else fatal = 'Este QR já foi usado ou venceu. No hub, clique em "Novo QR" e escaneie de novo.';
  } catch {
    fatal = 'Não consegui parear. Confira se o celular está no mesmo Wi-Fi do computador.';
  }
}

/* -------------------------------------------------------------------- dados */
function decorate(st) {
  const all = [];
  Persona.preset(st.names && st.names.people);
  Sector.preset(st.names && st.names.sectors);
  for (const s of st.sessions) for (const e of s.employees) all.push(e);
  Persona.assign(all);
  Sector.assign(st.sessions);
  const index = new Map();
  for (const s of st.sessions) {
    for (const e of s.employees) {
      e.persona = Persona.get(e);
      e.mood = Persona.mood(e.status);
      e.say = Persona.say(e);
      e.sector = s.sector;
      index.set(`${s.id}:${e.empKey}`, e);
    }
  }
  st.empIndex = index;
}

async function poll() {
  if (!token || document.hidden) return;
  try {
    const r = await api('/api/state');
    if (!r.ok) throw new Error('http ' + r.status);
    state = r.data;
    skew = state.now - Date.now();
    decorate(state);
    $('conn').className = 'conn';
    $('conn').textContent = `ligado até ${hm(state.until)}`;
    for (const p of [...state.permits, ...(state.inbox || [])]) {
      if (!seenPermits.has(p.id)) {
        seenPermits.add(p.id);
        buzz([200, 100, 200]);
      }
    }
    const latest = (state.deliveries && state.deliveries.latest) || 0;
    if (lastLatest !== null && latest > lastLatest) buzz(120);
    lastLatest = latest;
  } catch (e) {
    if (e.code === 401) {
      token = null;
      try { localStorage.removeItem(TOKEN_KEY); } catch { /* ok */ }
      fatal = 'Acesso encerrado. Se o Modo celular ainda estiver ligado no hub, clique em "Novo QR" e escaneie de novo.';
    }
    $('conn').className = 'conn off';
    $('conn').textContent = 'sem conexão';
  }
  render();
}

/* --------------------------------------------------------------------- telas */
function arm(id, behavior, fn) {
  const key = id + behavior;
  if (armed.has(key)) {
    clearTimeout(armed.get(key));
    armed.delete(key);
    fn();
  } else {
    armed.set(key, setTimeout(() => { armed.delete(key); render(); }, 3000));
    render();
  }
}

function permitCard(p) {
  const emp = state.empIndex.get(`${p.sessionId}:${p.agentId || 'main'}`);
  const sess = state.sessions.find((s) => s.id === p.sessionId);
  const inp = p.input || {};
  const detail = inp.command || inp.file_path || inp.path || inp.url || inp.pattern || inp.query || inp.description || inp.prompt || JSON.stringify(inp);
  const left = Math.max(0, Math.round((p.expiresAt - (Date.now() + skew)) / 1000));
  const btn = (behavior, label, cls) => h('button', {
    type: 'button',
    class: `big ${cls}${armed.has(p.id + behavior) ? ' armed' : ''}`,
    text: armed.has(p.id + behavior) ? 'Toque de novo' : label,
    onclick: () => arm(p.id, behavior, async () => {
      try {
        await api('/api/permit', { id: p.id, behavior });
      } catch { /* o próximo ciclo mostra */ }
      poll();
    }),
  });
  return h('article', { class: 'card permit' },
    h('div', { class: 'who' },
      emp ? avatar(emp, 44) : null,
      h('div', null,
        h('b', { text: emp ? emp.persona.name : 'Um agente' }),
        h('span', { text: emp ? emp.sector : (sess ? sess.project : '') })
      )
    ),
    h('div', null, h('span', { class: 'tool', text: p.tool || 'Ferramenta' }), ' pede permissão'),
    h('pre', { text: detail }),
    h('div', { class: 'left', text: left > 0 ? `Responda em ${left}s; depois disso o pedido volta para o PC.` : 'Prazo acabando; o pedido volta para o PC.' }),
    h('div', { class: 'actions' }, btn('deny', 'Negar', 'deny'), btn('allow', 'Aprovar', 'allow'))
  );
}

function avatar(e, size) {
  const w = h('div', { class: 'avatar', 'aria-hidden': 'true' });
  w.innerHTML = Persona.avatar(e.persona, e.mood.id, size);
  return w;
}

function inboxCard(p) {
  const sess = state.sessions.find((x) => x.id === p.sid);
  const titles = { perm: 'pede permissão', plan: 'propõe um plano', office: 'quer perguntar a outro departamento' };
  const btn = (behavior, label, cls) => h('button', {
    type: 'button',
    class: `big ${cls}${armed.has(p.id + behavior) ? ' armed' : ''}`,
    text: armed.has(p.id + behavior) ? 'Toque de novo' : label,
    onclick: () => arm(p.id, behavior, async () => {
      try {
        await api('/api/chat/decide', { sid: p.sid, id: p.id, behavior });
      } catch { /* o próximo ciclo mostra */ }
      poll();
    }),
  });
  return h('article', { class: 'card permit' },
    h('div', { class: 'who' }, h('div', null, h('b', { text: sess ? sess.sector : 'Um departamento' }), h('span', { text: 'conversa pelo hub' }))),
    h('div', null, h('span', { class: 'tool', text: p.tool || 'Pedido' }), ` ${titles[p.kind] || 'pede sua resposta'}`),
    p.description ? h('div', { class: 'say', text: p.description }) : null,
    p.detail ? h('pre', { text: p.detail }) : null,
    h('div', { class: 'actions' }, btn('deny', 'Negar', 'deny'), btn('allow', 'Aprovar', 'allow'))
  );
}

function viewPermits() {
  const list = state.permits;
  const inbox = state.inbox || [];
  if (!list.length && !inbox.length) {
    return [h('div', { class: 'empty', text: 'Nenhum pedido agora. Quando um agente precisar de você, ele aparece aqui e o celular vibra.' })];
  }
  return [...inbox.map(inboxCard), ...list.map(permitCard), h('p', { class: 'note', text: 'Aprovar libera só essa ação, uma vez. Cada botão pede dois toques, para não aprovar sem querer.' })];
}

function viewTeam() {
  if (!state.sessions.length) return [h('div', { class: 'empty', text: 'O escritório está vazio.' })];
  return state.sessions.map((s) =>
    h('section', { class: 'card sector' },
      h('header', null,
        h('div', null, h('h3', { text: s.sector }), h('div', { class: 'path', text: s.title || `Projeto ${s.project}` })),
        h('div', { class: 'hdr-r' },
          h('span', { class: `pill s-${s.status}`, text: s.stale ? 'Sem sinal' : STATUS[s.status] || s.status }),
          state.canChat ? h('button', { type: 'button', class: 'small', text: 'Conversar', onclick: () => openChat(s.id) }) : null)
      ),
      s.employees.map((e) =>
        h('div', { class: 'emp', vars: { '--accent': e.persona.color } },
          h('div', { class: 'who' },
            avatar(e, 44),
            h('div', null, h('b', { text: e.persona.name }), h('span', { text: e.persona.cargo })),
            h('span', { class: `pill s-${e.status}`, text: STATUS[e.status] || e.status })
          ),
          h('div', { class: 'say', text: e.say.text })
        )
      )
    )
  );
}

function viewNew() {
  const sel = h('select', { id: 'f-cwd', 'aria-label': 'Projeto' },
    state.projects.length ? state.projects.map((p) => h('option', { value: p.cwd, text: p.project, ...(p.cwd === formDraft.cwd ? { selected: '' } : {}) })) : [h('option', { text: 'Nenhum projeto visto ainda' })]);
  sel.addEventListener('change', () => { formDraft.cwd = sel.value; });
  const ta = h('textarea', { id: 'f-prompt', maxlength: '4000', placeholder: 'O que o agente deve fazer?' });
  ta.value = formDraft.prompt;
  ta.addEventListener('input', () => { formDraft.prompt = ta.value; });
  const mode = (value, title, sub) => {
    const r = h('input', { type: 'radio', name: 'mode', value, ...(formDraft.mode === value ? { checked: '' } : {}) });
    r.addEventListener('change', () => { formDraft.mode = value; });
    return h('label', null, r, h('span', null, title, h('small', { text: sub })));
  };
  const send = h('button', { type: 'button', class: 'big primary', text: 'Enviar tarefa', onclick: async () => {
    formMsg = '';
    const cwd = formDraft.cwd || (state.projects[0] && state.projects[0].cwd);
    if (!formDraft.prompt.trim()) { formMsg = 'Escreva a tarefa.'; return render(); }
    send.disabled = true;
    try {
      const r = await api('/api/task', { cwd, prompt: formDraft.prompt, mode: formDraft.mode });
      if (r.ok) { formDraft.prompt = ''; tab = 'tasks'; } else formMsg = (r.data && r.data.error) || 'Não consegui enviar.';
    } catch { formMsg = 'Sem conexão com o hub.'; }
    poll();
  } });
  return [
    h('div', { class: 'card' }, h('label', { for: 'f-cwd', text: 'Projeto' }), sel),
    h('div', { class: 'card' }, h('label', { for: 'f-prompt', text: 'Tarefa' }), ta),
    h('div', { class: 'card mode' },
      mode('plan', 'Só ler e planejar', 'Mais seguro: o agente analisa o projeto e responde, sem alterar nada.'),
      mode('edit', 'Pode editar arquivos', 'Altera arquivos do projeto. Comandos livres continuam bloqueados.')
    ),
    formMsg ? h('div', { class: 'err', text: formMsg }) : null,
    send,
    h('p', { class: 'note', text: 'A tarefa roda no seu computador, sem tela. Ela aparece no escritório do hub como qualquer outra sessão.' }),
  ];
}

function viewTasks() {
  if (!state.tasks.length) return [h('div', { class: 'empty', text: 'Nenhuma tarefa enviada pelo celular neste Modo celular.' })];
  return state.tasks.map((t) =>
    h('article', { class: 'card' },
      h('div', { class: 'row' },
        h('b', { text: t.project }),
        h('span', { class: `pill s-${t.status === 'running' ? 'working' : t.status}`, text: TASK_STATUS[t.status] || t.status })
      ),
      h('p', { class: 'say', text: t.prompt }),
      h('div', { class: 'left', text: `${t.mode === 'edit' ? 'Pode editar' : 'Só ler e planejar'} · ${hm(t.startedAt)}${t.endedAt ? ' · ' + dur(t.endedAt - t.startedAt) : ''}` }),
      t.result ? h('div', { class: 'result', text: t.result }) : null,
      t.status === 'running' ? h('button', { type: 'button', class: 'big deny', text: 'Interromper', onclick: async () => { await api('/api/task/stop', { id: t.id }); poll(); } }) : null
    )
  );
}

/* ------------------------------------------------------------- chat do departamento */
const CHAT_MODES = [
  ['ask', 'Perguntar antes', 'Cada ferramenta pede sua aprovação aqui no celular.'],
  ['edit', 'Editar arquivos', 'Pode alterar arquivos do projeto sem perguntar; o resto pede aprovação.'],
  ['plan', 'Só planejar', 'Lê e propõe um plano, sem alterar nada.'],
];

function openChat(sid) {
  chatSid = sid;
  chatUI = null;
  render();
  pollChat();
}
function closeChat() {
  chatSid = null;
  chatUI = null;
  render();
}

function buildChatUI(sid) {
  const sess = state.sessions.find((x) => x.id === sid);
  const ui = {
    sid,
    rev: '',
    messages: [],
    st: null,
    mode: 'ask',
    modeSet: false,
    draft: '',
    msg: '',
    sending: false,
    stick: true,
  };
  ui.title = h('b', { text: sess ? sess.sector : 'Departamento' });
  ui.sub = h('span', { class: 'path', text: sess ? (sess.title || `Projeto ${sess.project}`) : '' });
  ui.pill = h('span', { class: 'pill s-idle', text: '' });
  ui.stop = h('button', { type: 'button', class: 'small deny', text: 'Parar', hidden: '', onclick: async () => { try { await api('/api/chat/stop', { sid }); } catch { /* ok */ } pollChat(); } });
  ui.msgs = h('div', { class: 'msgs', role: 'log', 'aria-live': 'polite' });
  ui.msgs.addEventListener('scroll', () => { ui.stick = ui.msgs.scrollHeight - ui.msgs.scrollTop - ui.msgs.clientHeight < 80; });
  ui.pend = h('div', { class: 'pend' });
  ui.note = h('div', { class: 'note chat-note' });
  ui.ta = h('textarea', { class: 'chat-ta', rows: '2', maxlength: '4000', placeholder: 'Escreva para este departamento…', 'aria-label': 'Mensagem' });
  ui.ta.addEventListener('input', () => { ui.draft = ui.ta.value; });
  ui.sel = h('select', { class: 'chat-mode', 'aria-label': 'Modo' }, CHAT_MODES.map(([v, t]) => h('option', { value: v, text: t })));
  ui.sel.addEventListener('change', () => { ui.mode = ui.sel.value; ui.modeSet = true; updateChatUI(); });
  ui.send = h('button', { type: 'button', class: 'big primary send', text: 'Enviar', onclick: () => sendChat() });
  ui.modeHelp = h('div', { class: 'note' });
  ui.root = h('section', { class: 'chat' },
    h('header', { class: 'chat-head' },
      h('button', { type: 'button', class: 'small', text: '← Voltar', onclick: closeChat }),
      h('div', { class: 'chat-title' }, ui.title, ui.sub),
      h('div', { class: 'hdr-r' }, ui.pill, ui.stop)),
    ui.pend, ui.msgs,
    h('div', { class: 'composer' }, ui.note, ui.ta, h('div', { class: 'composer-row' }, ui.sel, ui.send), ui.modeHelp));
  return ui;
}

function chatMsgEl(m) {
  if (m.kind === 'tool') return h('div', { class: 'cm tool', text: m.text });
  if (m.role === 'system' || m.kind === 'note') return h('div', { class: 'cm note', text: m.text });
  const cls = m.role === 'user' ? 'user' : m.kind === 'error' ? 'bad' : 'bot';
  return h('div', { class: `cm ${cls}` }, h('div', { class: 'cm-text', text: m.text }), h('time', { text: hm(m.ts) }));
}

function updateChatUI() {
  const ui = chatUI;
  if (!ui) return;
  const st = ui.st;
  const sess = state && state.sessions.find((x) => x.id === ui.sid);
  if (sess) { ui.title.textContent = sess.sector; ui.sub.textContent = sess.title || `Projeto ${sess.project}`; }
  if (st && !ui.modeSet) ui.mode = CHAT_MODES.some(([v]) => v === st.mode) ? st.mode : 'ask';
  ui.sel.value = ui.mode;
  ui.modeHelp.textContent = (CHAT_MODES.find(([v]) => v === ui.mode) || [])[2] || '';
  const busy = !!(st && st.busy);
  ui.pill.className = `pill s-${busy ? 'working' : 'idle'}`;
  ui.pill.textContent = busy ? 'Respondendo…' : 'Pronto';
  ui.stop.hidden = !busy;
  const blocked = st && st.blocked;
  ui.note.textContent = ui.msg || (st && st.error) || blocked || '';
  ui.note.className = `note chat-note${ui.msg || (st && st.error) ? ' err' : ''}`;
  ui.send.disabled = ui.sending || busy || !!blocked;
  ui.send.textContent = busy ? 'Respondendo…' : 'Enviar';
  // mensagens (só refaz quando mudaram)
  if (ui.shownMsgs !== ui.messages || ui.shownLoaded !== !!st) {
    ui.shownMsgs = ui.messages;
    ui.shownLoaded = !!st;
    const frag = ui.messages.length ? ui.messages.map(chatMsgEl) : [h('div', { class: 'empty', text: st ? 'Ainda não há mensagens nesta conversa.' : 'Carregando…' })];
    ui.msgs.replaceChildren(...frag);
    if (ui.stick) ui.msgs.scrollTop = ui.msgs.scrollHeight;
  }
  // pedidos desta conversa
  const pend = (st && st.pending) || [];
  ui.pend.replaceChildren(...pend.map((p) => inboxCard({ ...p, sid: ui.sid })));
}

async function sendChat() {
  const ui = chatUI;
  if (!ui || ui.sending) return;
  const text = ui.ta.value.trim();
  if (!text) { ui.msg = 'Escreva a mensagem.'; return updateChatUI(); }
  ui.sending = true;
  ui.msg = '';
  updateChatUI();
  try {
    const r = await api('/api/chat/send', { sid: ui.sid, text, mode: ui.mode });
    if (r.ok) { ui.ta.value = ''; ui.draft = ''; ui.stick = true; } else ui.msg = (r.data && r.data.error) || 'Não consegui enviar.';
  } catch { ui.msg = 'Sem conexão com o hub.'; }
  ui.sending = false;
  await pollChat();
}

let chatBusy = false;
async function pollChat() {
  if (!token || !chatSid || document.hidden || chatBusy) return;
  const ui = chatUI || (chatUI = buildChatUI(chatSid));
  chatBusy = true;
  try {
    const r = await api(`/api/chat?sid=${encodeURIComponent(chatSid)}&rev=${encodeURIComponent(ui.rev)}`);
    if (r.ok) {
      ui.rev = r.data.rev;
      if (r.data.messages) ui.messages = r.data.messages;
      ui.st = r.data.state;
      if (ui.st.pending.some((p) => !seenPermits.has(p.id))) {
        for (const p of ui.st.pending) seenPermits.add(p.id);
        buzz([200, 100, 200]);
      }
    } else if (r.status === 404) {
      ui.msg = 'Esse departamento não existe mais no hub.';
    }
  } catch (e) {
    if (e.code === 401) { chatBusy = false; return poll(); }
  }
  chatBusy = false;
  if (chatUI === ui) updateChatUI();
}

/* ------------------------------------------------------------------ entregas */
const KIND_LABEL = { text: 'texto', image: 'imagem', pdf: 'PDF', file: 'arquivo' };
const HOW_LABEL = { created: 'criado', edited: 'alterado' };
function kb(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`; }

async function loadDeliveries(force) {
  if (!token || deliv.loading || document.hidden) return;
  if (!force && deliv.list && Date.now() - deliv.at < 5000) return;
  deliv.loading = true;
  try {
    const r = await api('/api/deliveries');
    if (r.ok) { deliv.list = r.data.deliveries; deliv.err = ''; deliv.at = Date.now(); } else deliv.err = 'Não consegui carregar as entregas.';
  } catch (e) { deliv.err = e.code === 401 ? 'Acesso encerrado.' : 'Sem conexão com o hub.'; }
  deliv.loading = false;
  if (tab === 'deliveries' && !chatSid) render();
}

function markDeliveriesSeen() {
  const latest = (state && state.deliveries && state.deliveries.latest) || 0;
  if (latest > seenDeliv) {
    seenDeliv = latest;
    try { localStorage.setItem(SEEN_KEY, String(seenDeliv)); } catch { /* ok */ }
  }
}

async function openFile(f) {
  viewer = { name: f.name, kind: f.kind, state: 'loading' };
  render();
  try {
    const res = await apiRaw(`/api/delivery/file?id=${encodeURIComponent(f.id)}`);
    if (!res.ok) throw new Error('indisponível');
    if (f.kind === 'text') viewer = { name: f.name, kind: 'text', text: await res.text() };
    else {
      const blob = await res.blob();
      if (f.kind === 'image') {
        const url = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = no; fr.readAsDataURL(blob); });
        viewer = { name: f.name, kind: 'image', url };
      } else viewer = { name: f.name, kind: f.kind, blob };
    }
  } catch { viewer = { name: f.name, kind: f.kind, error: 'Esse arquivo não está mais disponível.' }; }
  render();
}

function viewerEl() {
  const v = viewer;
  const close = () => { if (v.url) URL.revokeObjectURL(v.url); viewer = null; render(); };
  let body;
  if (v.state === 'loading') body = h('div', { class: 'empty', text: 'Abrindo…' });
  else if (v.error) body = h('div', { class: 'err', text: v.error });
  else if (v.kind === 'text') body = h('pre', { class: 'file-text', text: v.text });
  else if (v.kind === 'image') body = h('img', { class: 'file-img', src: v.url, alt: v.name });
  else {
    const url = URL.createObjectURL(v.blob);
    v.url = url;
    body = h('div', { class: 'empty' }, h('p', { text: 'PDF pronto.' }), h('a', { class: 'big primary dl', href: url, download: v.name.split('/').pop(), text: 'Baixar PDF' }));
  }
  return h('div', { class: 'overlay', role: 'dialog', 'aria-label': v.name },
    h('div', { class: 'overlay-head' }, h('b', { text: v.name }), h('button', { type: 'button', class: 'small', text: 'Fechar', onclick: close })),
    h('div', { class: 'overlay-body' }, body));
}

function deliveryCard(d) {
  const sess = state.sessions.find((x) => x.id === d.sessionId);
  const fresh = d.finishedAt > seenDeliv;
  return h('article', { class: `card deliv${fresh ? ' fresh' : ''}` },
    h('div', { class: 'row' },
      h('b', { text: sess ? sess.sector : d.project }),
      h('span', { class: 'left', text: `${hm(d.finishedAt)}${d.startedAt ? ' · ' + dur(d.finishedAt - d.startedAt) : ''}` })),
    h('div', { class: 'path', text: `Pedido: ${d.request}` }),
    h('p', { class: 'headline', text: d.headline || 'Terminei.' }),
    d.summary ? h('p', { class: 'say', text: d.summary }) : null,
    h('div', { class: 'left', text: `${d.tools} ${d.tools === 1 ? 'ferramenta' : 'ferramentas'} · ${d.edited} ${d.edited === 1 ? 'arquivo mexido' : 'arquivos mexidos'}` }),
    d.files.length ? h('div', { class: 'files' }, d.files.map((f) =>
      h('button', {
        type: 'button', class: `file${f.open ? '' : ' off'}`, disabled: f.open ? null : '',
        title: f.open ? '' : 'Esse arquivo só abre no computador.',
        onclick: () => f.open && openFile(f),
      }, h('span', { class: 'fn', text: f.name }), h('span', { class: 'fm', text: f.open ? `${HOW_LABEL[f.how]} · ${KIND_LABEL[f.kind]} · ${kb(f.size)}` : `${HOW_LABEL[f.how]} · só no PC` })))) : null,
    d.text && d.text !== d.headline ? h('details', null, h('summary', { text: 'Ver resposta completa' }), h('div', { class: 'result', text: d.text })) : null,
    h('button', { type: 'button', class: 'small', text: 'Conversar', onclick: () => openChat(d.sessionId) })
  );
}

function viewDeliveries() {
  loadDeliveries(false);
  if (!deliv.list) return [h('div', { class: deliv.err ? 'err' : 'empty', text: deliv.err || 'Carregando entregas…' })];
  if (!deliv.list.length) return [h('div', { class: 'empty', text: 'Ainda não há entregas. Quando um agente terminar um pedido em que trabalhou, o resumo e os arquivos aparecem aqui.' })];
  return [...deliv.list.map(deliveryCard), h('p', { class: 'note', text: 'Só abrem arquivos de texto, imagens e PDFs que o agente criou ou alterou dentro da pasta do projeto. Arquivos ocultos e que parecem segredo (.env, chaves) nunca saem do computador.' })];
}

const TABS = [['permits', 'Pedidos'], ['team', 'Equipe'], ['deliveries', 'Entregas'], ['new', 'Nova'], ['tasks', 'Remotas']];

function render() {
  const view = $('view');
  const nav = $('nav');
  const banner = $('banner');
  if (!token || !state) {
    banner.hidden = true;
    nav.replaceChildren();
    view.replaceChildren(h('div', { class: 'empty' }, h('p', { text: fatal || (token ? 'Conectando ao hub…' : 'Escaneie o QR code que aparece no Claude Hub, no computador.') })));
    return;
  }
  banner.hidden = !fatal;
  banner.textContent = fatal || '';
  const n = state.permits.length + (state.inbox || []).length;
  const latest = (state.deliveries && state.deliveries.latest) || 0;
  const hasNew = latest > seenDeliv;
  nav.replaceChildren(...TABS.map(([id, label]) =>
    h('button', { type: 'button', role: 'tab', 'aria-selected': String(!chatSid && tab === id), onclick: () => { chatSid = null; chatUI = null; tab = id; if (id === 'deliveries') { markDeliveriesSeen(); loadDeliveries(true); } render(); } },
      label,
      id === 'permits' && n ? h('span', { class: 'count', text: String(n) }) : null,
      id === 'deliveries' && hasNew && tab !== 'deliveries' ? h('span', { class: 'count dot', text: '•' }) : null)));
  document.title = n ? `(${n}) Claude Hub` : 'Claude Hub';
  document.body.classList.toggle('in-chat', !!chatSid);
  if (viewer) {
    if (!viewer.el) viewer.el = viewerEl();
    if (view.firstChild !== viewer.el || view.childNodes.length !== 1) view.replaceChildren(viewer.el);
    return;
  }
  if (chatSid) {
    if (!chatUI) chatUI = buildChatUI(chatSid);
    if (view.firstChild !== chatUI.root || view.childNodes.length !== 1) view.replaceChildren(chatUI.root);
    updateChatUI();
    return;
  }
  // Não recria o formulário enquanto a pessoa digita.
  if (tab === 'new' && document.activeElement && ['TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && view.contains(document.activeElement)) return;
  if (tab === 'deliveries') markDeliveriesSeen();
  const body = tab === 'permits' ? viewPermits() : tab === 'team' ? viewTeam() : tab === 'deliveries' ? viewDeliveries() : tab === 'new' ? viewNew() : viewTasks();
  view.replaceChildren(...body);
}

async function init() {
  await pairFromHash();
  render();
  await poll();
  polling = setInterval(poll, 2000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  setInterval(() => { if (state && !chatSid && !viewer && tab === 'permits' && state.permits.length) render(); }, 1000);
  setInterval(pollChat, 1500);
  setInterval(() => { if (tab === 'deliveries' && !chatSid && !viewer) loadDeliveries(false); }, 5000);
}
init();
