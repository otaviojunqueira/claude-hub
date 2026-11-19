'use strict';
/* Interface do Claude Hub. Todo texto vindo dos hooks entra via textContent (nunca innerHTML).
   Único innerHTML: o SVG dos avatares, montado só com constantes e cores locais (persona.js). */

const STATUS_LABEL = {
  working: 'Trabalhando',
  waiting: 'Aguardando você',
  done: 'Concluído',
  error: 'Erro',
  idle: 'Ocioso',
  ended: 'Saiu',
};
const TASK_LABEL = { running: 'Em andamento', done: 'Concluída', error: 'Com erro', interrupted: 'Interrompida' };

const $ = (id) => document.getElementById(id);

function store(key, fallback) {
  try {
    const v = localStorage.getItem('claude-hub:' + key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem('claude-hub:' + key, String(value));
  } catch {
    /* sem armazenamento: segue sem lembrar */
  }
}

let state = { now: Date.now(), sessions: [], feed: [], totals: {} };
let config = {};
let view = store('view', 'office') === 'team' ? 'team' : 'office';
let winSel = store('win', 'auto') === 'auto' ? 'auto' : Number(store('win', 'auto'));
if (!Timeline.WINDOWS.includes(winSel)) winSel = 'auto';
let dockOpen = store('dock', '1') === '1';
let selectedKey = null;
let skew = 0;
let empIndex = new Map();
const seen = new Set();

/* ------------------------------------------------------------- utilitários */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'vars') for (const [n, val] of Object.entries(v)) el.style.setProperty(n, val);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function compact(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace('.', ',') + 'k';
  return String(n);
}

function dur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min`;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${hh}h ${mm}min` : `${hh}h`;
}

function clock(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function clockShort(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
const nowMs = () => Date.now() + skew;

/** Largura da janela de tempo em ms. "auto" encolhe/cresce conforme o que já aconteceu. */
function winMs() {
  if (winSel !== 'auto') return winSel * 60000;
  const t = nowMs();
  let first = t;
  for (const e of empIndex.values()) if (e.segments.length && e.segments[0].start < first) first = e.segments[0].start;
  return Math.min(60 * 60000, Math.max(120000, (t - first) * 1.08));
}
const clipText = (t, n) => (t && t.length > n ? t.slice(0, n - 1) + '…' : t || '');
const onKey = (fn) => (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fn();
  }
};

function avatarEl(e, size) {
  const wrap = h('div', { class: 'avatar', 'aria-hidden': 'true' });
  wrap.append(Pixel.avatar(e.persona, e.mood.id, size));
  return wrap;
}

/** Balão curto com a ação atual: "✏️ Editando Profile.tsx". */
const KIND_ICON = { think: '💭', read: '📖', edit: '✏️', run: '⚙️', delegate: '📨', wait: '✋', other: '🔧' };
function actionBubble(e, max) {
  const say = e.say.text || '';
  switch (e.status) {
    case 'working': {
      let t = say.replace(/^([^:]+): /, '$1 ');
      t = t.replace(/(?:…\/)?(?:[\w.-]+\/)+([\w.-]+)/g, '$1');
      return `${KIND_ICON[e.kind || 'think'] || '🔧'} ${clipText(t, max)}`;
    }
    case 'waiting': return `✋ ${clipText(e.say.short, max)}`;
    case 'done': return `✓ ${clipText(say.split('\n')[0], max)}`;
    case 'error': return `⚠ ${clipText(e.say.short, max)}`;
    case 'ended': return '👋 Saiu';
    default: return `💤 ${clipText(e.say.short, max)}`;
  }
}

function activeNow(e) {
  const extra = e.live && e.kind && e.kind !== 'wait' ? Math.max(0, nowMs() - state.now) : 0;
  return e.stats.activeMs + extra;
}
function waitNow(e) {
  const extra = e.live && e.kind === 'wait' ? Math.max(0, nowMs() - state.now) : 0;
  return e.stats.waitMs + extra;
}

/* ---------------------------------------------------- personas e índices */
let teamSize = (() => {
  const n = Number(store('teamSize', 4));
  return Number.isInteger(n) && n >= 0 && n <= 8 ? n : 4;
})();
function decorate(st) {
  empIndex = new Map();
  const all = [];
  for (const s of st.sessions) for (const e of s.employees) all.push(e);
  Persona.assign(all);
  Sector.assign(st.sessions);
  // O departamento é identificado pelo PROJETO (pasta). O nome-fantasia do setor só entra para
  // desempatar quando há mais de um departamento no mesmo projeto.
  const perProject = new Map();
  for (const s of st.sessions) perProject.set(s.project, (perProject.get(s.project) || 0) + 1);
  for (const s of st.sessions) {
    s.flavor = s.sector;
    s.sector = perProject.get(s.project) > 1 ? `${s.project} · ${s.flavor}` : s.project;
  }
  for (const s of st.sessions) {
    for (const e of s.employees) {
      e.persona = Persona.get(e);
      e.displayName = e.persona.name;
      e.sector = s.sector;
      e.mood = Persona.mood(e.status);
      e.say = Persona.say(e);
      e.doneTasks = e.tasks.filter((t) => t.status === 'done').length;
      empIndex.set(e.key, e);
    }
    // equipe fixa do departamento (só no escritório; não entra em chat, linha do tempo nem celular)
    const taken = new Set(s.employees.map((e) => e.persona.name));
    s.residents = Array.from({ length: teamSize }, (_, i) => Persona.resident(s.id, i, taken));
  }
  shareNames(st);
}

/* O celular e o Escritório usam os mesmos nomes e setores que o hub mostra aqui. */
let namesSig = '';
window.addEventListener('phone-on', () => {
  namesSig = '';
  render();
});
function shareNames(st) {
  // sempre: o celular e o Escritório (agentes perguntando uns aos outros) usam os mesmos nomes de setor
  const names = { sectors: {}, people: {} };
  for (const s of st.sessions) {
    names.sectors[s.id] = s.sector;
    for (const e of s.employees) names.people[e.key] = { name: e.persona.name, g: e.persona.g };
  }
  const sig = JSON.stringify(names);
  if (sig === namesSig) return;
  namesSig = sig;
  window.hub.phoneNames(names);
}

/* ---------------------------------------------------------------- chat */
/** Nome do chat como no VS Code; sem ele, o primeiro pedido e, por último, o projeto. */
function chatTitle(s) {
  if (s.title) return s.title;
  const leader = s.employees.find((e) => e.isLeader);
  if (leader && leader.tasks.length) {
    let first = leader.tasks[0];
    for (const t of leader.tasks) if (t.start < first.start) first = t;
    if (first.title) return clipText(first.title, 80);
  }
  return s.project;
}

/* ------------------------------------------- Escritório: perguntas entre departamentos */
let officeAsks = [];
const mailSeen = new Map(); // id da pergunta -> último estado visto (para animar só as mudanças)

/** Etiqueta da sala: "perguntando a…", "respondendo a…" enquanto há uma pergunta em andamento. */
function mailTagOf(sid) {
  for (let i = officeAsks.length - 1; i >= 0; i--) {
    const a = officeAsks[i];
    if (a.status !== 'approval' && a.status !== 'waiting') continue;
    const task = a.kind === 'task';
    if (a.from === sid) {
      if (a.kind === 'plan') return { kind: 'approval', text: `⇢ quer delegar a ${a.toName}` };
      return { kind: a.status, text: task ? `⇢ delegando a ${a.toName}` : a.status === 'approval' ? `✉ quer perguntar a ${a.toName}` : `✉ perguntando a ${a.toName}` };
    }
    if (a.to === sid && a.status === 'waiting') return { kind: 'waiting', text: task ? `⇢ tarefa de ${a.fromName}` : `✉ respondendo a ${a.fromName}` };
  }
  return null;
}

function mailBadge() {
  return h('div', { class: 'o-mail', hidden: '' });
}
function paintMail(r, sid) {
  r.el.dataset.sid = sid;
  const mt = mailTagOf(sid);
  r.mail.hidden = !mt;
  if (mt) {
    r.mail.className = `o-mail ${mt.kind}`;
    r.mail.textContent = mt.text;
  }
}

/** Envelope que voa de um departamento para o outro (pergunta indo, resposta voltando). */
function flyMail(fromSid, toSid, kind) {
  const point = (sid) => {
    const sess = state.sessions.find((x) => x.id === sid);
    const lead = sess && sess.employees.find((e) => e.isLeader);
    const p = bridge && view === 'office' && lead ? bridge.screenPositionOf(lead.key) : null;
    if (p) return [p.x, p.y];
    const el = document.querySelector(`[data-sid="${CSS.escape(sid)}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.min(Math.max(r.left + r.width / 2, 24), window.innerWidth - 24), Math.min(Math.max(r.top + Math.min(r.height / 2, 90), 70), window.innerHeight - 70)];
  };
  const a = point(fromSid);
  const b = point(toSid);
  if (!a || !b) return;
  const [x0, y0] = a;
  const [x1, y1] = b;
  const env = h('i', { class: `mail-fly ${kind}`, 'aria-hidden': 'true' });
  env.style.setProperty('--x0', `${x0 - 17}px`);
  env.style.setProperty('--y0', `${y0 - 12}px`);
  env.style.setProperty('--x1', `${x1 - 17}px`);
  env.style.setProperty('--y1', `${y1 - 12}px`);
  document.body.append(env);
  void env.offsetWidth;
  env.classList.add('go');
  setTimeout(() => env.remove(), 1500);
}

function onOffice(o, silent) {
  const asks = (o && Array.isArray(o.asks) && o.asks) || [];
  for (const a of asks) {
    const prev = mailSeen.get(a.id);
    if (prev === a.status) continue;
    mailSeen.set(a.id, a.status);
    if (silent) continue;
    if (a.status === 'waiting') flyMail(a.from, a.to, 'ask');
    else if (a.status === 'answered' && (prev === 'waiting' || prev === 'timeout')) flyMail(a.to, a.from, 'answer');
  }
  officeAsks = asks;
  if (!holding) render();
}

/* ------------------------------------------------------- painel dividido (2 chats) */
const Chat2 = Chat.create({ second: true, onFocus: () => { focusedPane = 2; paintFocus(); }, onPlan: (sid) => askPlan(sid) });
let splitOn = false;
let focusedPane = 1;
let splitPickEl = null;
let sideCtl = null; // { get(), apply(w, persist) } do redimensionador do painel lateral
let preSplitW = 0;
Chat.opts.onFocus = () => {
  focusedPane = 1;
  paintFocus();
};
Chat.opts.onSplit = () => setSplit(true);
Chat.opts.onPlan = (sid) => askPlan(sid);

function paintFocus() {
  for (const col of document.querySelectorAll('.split-col')) col.classList.toggle('focus', Number(col.dataset.pane) === focusedPane);
}

function setSplit(on) {
  if (splitOn === on) return;
  splitOn = on;
  Chat.setSplit(on);
  Chat2.setSplit(on);
  if (sideCtl) {
    if (on) {
      preSplitW = sideCtl.get();
      sideCtl.apply(Math.max(preSplitW, 900), false);
    } else if (preSplitW) sideCtl.apply(preSplitW, true);
  }
  focusedPane = on ? 2 : 1;
  if (!on && Chat2.isOpen()) Chat2.close();
  sideMode = null;
  render();
}

/** Fecha os chats do painel lateral (inclusive a divisão), sem promover nada. */
function closeChatPanes() {
  if (splitOn) setSplit(false);
  if (Chat.isOpen()) Chat.close();
}

/** Lista de departamentos para a coluna da direita escolher o que abrir. */
function buildSplitPicker() {
  const mine = Chat.currentId();
  const list = state.sessions.filter((s) => s.id !== mine);
  const pickRow = (s) => {
    const lead = s.employees.find((e) => e.isLeader) || null;
    return h('button', { type: 'button', class: 'pick-item', onclick: () => openChat(s.id, 2) },
      h('strong', { text: s.sector }),
      h('span', { text: `${STATUS_LABEL[s.status] || s.status} · ${chatTitle(s)}` }));
  };
  return h('div', { class: 'chat pick' },
    h('header', { class: 'chat-head' },
      h('div', { class: 'ct' }, h('h2', { text: 'Segunda coluna' }), h('div', { class: 'cs', text: 'Escolha o departamento para ver ao lado' })),
      h('button', { class: 'close', type: 'button', 'aria-label': 'Fechar a divisão', title: 'Fechar a divisão', text: '✕', onclick: () => setSplit(false) })),
    h('div', { class: 'pick-list' },
      list.length ? list.map(pickRow) : h('div', { class: 'chat-empty', text: 'Não há outro departamento para abrir ao lado.' })));
}

/* ------------------------------------------------------------ Cérebro */
let vaultInfo = null;
Vault.onInfo = (i) => {
  vaultInfo = i;
  if (!holding) render();
};
async function loadVault() {
  try {
    vaultInfo = await window.hub.vaultInfo();
    render();
  } catch {
    /* sem Cérebro: a sala mostra o estado vazio */
  }
}

/** Abre o navegador de notas no painel lateral (com `path`, já numa nota). */
function openVault(path) {
  closeChatPanes();
  selectedKey = null;
  profSig = null;
  sideMode = null;
  Vault.open(() => {
    sideMode = null;
    render();
  }, path);
  render();
}

/** Departamentos criados pelo hub que ainda não apareceram no escritório (a sala surge com a primeira mensagem). */
const drafts = new Map();

function chatContext(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) {
    const d = drafts.get(id);
    if (!d) return null;
    return { id, draft: true, sector: 'Novo departamento', title: 'Escreva a primeira mensagem', project: d.project, status: 'idle', leader: null };
  }
  drafts.delete(id);
  return { id: s.id, sector: s.sector, title: chatTitle(s), project: s.project, status: s.status, manager: s.id === managerSid, leader: s.employees.find((e) => e.isLeader) || null };
}

function openChat(id, pane) {
  const c = chatContext(id);
  if (!c) return;
  selectedKey = null;
  profSig = null;
  if (Vault.isOpen()) Vault.close();
  if (splitOn) {
    // já aberto em uma das colunas: só dá foco; senão abre na coluna em foco (ou na pedida)
    if (Chat.currentId() === id) return Chat.focus();
    if (Chat2.currentId() === id) return Chat2.focus();
    if ((pane || focusedPane) === 2) {
      Chat2.open(c, () => setSplit(false));
      focusedPane = 2;
      sideMode = null;
      render();
      return;
    }
  }
  Chat.open(c, onPrimaryClose);
  focusedPane = 1;
  sideMode = null;
  render();
}

/** ✕ da coluna principal: se havia outra coluna, ela vira a principal. */
function onPrimaryClose() {
  if (splitOn) {
    const keep = Chat2.currentId();
    setSplit(false); // fecha a segunda coluna
    if (keep) {
      openChat(keep);
      return;
    }
  }
  sideMode = null;
  render();
}

/** Botão "Novo departamento": escolhe o projeto e abre um chat vazio no painel lateral. */
async function newDepartment() {
  let projects = [];
  try {
    projects = await window.hub.chatProjects();
  } catch {
    /* sem lista: só a escolha de pasta */
  }
  selectedKey = null;
  profSig = null;
  if (splitOn) setSplit(false);
  if (Vault.isOpen()) Vault.close();
  Chat.openPick(
    Array.isArray(projects) ? projects : [],
    async (p) => {
      const r = await window.hub.chatPrepare(p.cwd);
      if (!r || r.error) return (r && r.error) || 'Não consegui criar o departamento.';
      drafts.set(r.id, { cwd: r.cwd, project: r.project });
      Chat.open(chatContext(r.id), onPrimaryClose);
      sideMode = null; // força o painel a trocar da escolha para o chat
      render();
      return '';
    },
    () => {
      sideMode = null;
      render();
    }
  );
  sideMode = null;
  render();
}

/* ------------------------------------------------ gerente do Escritório e menu ⋯ da sala */
let managerSid = null;
const PLAN_KICK = 'Olhe os departamentos do Escritório (listar_departamentos) e decida você mesmo o que vale delegar agora, com base no que cada um está fazendo, no que já conversamos aqui e nos projetos disponíveis. Monte o plano e chame delegar_tarefas para eu aprovar. Se for preciso, peça um departamento novo. Se nada precisar ser delegado, diga isso em uma frase.';

/** Aviso curto no rodapé, com ação opcional (ex.: Desfazer). */
let toastEl = null;
let toastTimer = 0;
function toast(msg, action) {
  if (toastEl) toastEl.remove();
  clearTimeout(toastTimer);
  const close = () => {
    if (toastEl) toastEl.remove();
    toastEl = null;
  };
  toastEl = h('div', { class: 'toast', role: 'status' },
    h('span', { text: msg }),
    action ? h('button', { type: 'button', text: action.label, onclick: () => { close(); action.fn(); } }) : null);
  document.body.append(toastEl);
  toastTimer = setTimeout(close, 9000);
}

/** Tira um departamento da planta (volta sozinho se ele tiver nova atividade). */
async function removeRoom(s) {
  if (s.id === managerSid) await setManager(null);
  if (Chat.isOpen() && Chat.currentId() === s.id) closeChatPanes();
  try {
    await window.hub.dismiss(s.id);
  } catch {
    return;
  }
  toast(`"${s.sector}" removido.`, { label: 'Desfazer', fn: () => window.hub.undismiss([s.id]) });
}

async function setManager(sid) {
  try {
    managerSid = await window.hub.managerSet(sid);
  } catch {
    return;
  }
  Inbox.refresh();
  render();
}

/** "Gerente · montar plano": abre o chat do gerente e pede que ele decida e proponha o plano. */
async function askPlan(sid) {
  openChat(sid);
  const pane = Chat2.currentId() === sid ? Chat2 : Chat;
  await pane.sendText(PLAN_KICK);
}

let roomMenu = null;
function closeRoomMenu() {
  if (!roomMenu) return;
  roomMenu.el.remove();
  document.removeEventListener('pointerdown', roomMenu.out, true);
  document.removeEventListener('keydown', roomMenu.key, true);
  roomMenu = null;
}
function openRoomMenu(s, anchor) {
  const reopen = roomMenu && roomMenu.sid === s.id;
  closeRoomMenu();
  if (reopen) return;
  const isMgr = s.id === managerSid;
  const item = (label, hint, fn, cls) =>
    h('button', { type: 'button', class: `rm-item${cls ? ' ' + cls : ''}`, role: 'menuitem', onclick: () => { closeRoomMenu(); fn(); } },
      h('b', { text: label }), hint ? h('span', { text: hint }) : null);
  const other = managerSid && !isMgr ? state.sessions.find((x) => x.id === managerSid) : null;
  const el = h('div', { class: 'room-menu', role: 'menu', 'aria-label': `Opções de ${s.sector}` },
    item('Conversar', 'Abre o chat deste departamento', () => openChat(s.id)),
    isMgr
      ? [item('Montar um plano agora', 'O gerente decide o que delegar e você aprova', () => askPlan(s.id), 'main'),
         item('Deixar de ser gerente', 'Volta a ser um departamento comum', () => setManager(null))]
      : item('Tornar gerente do Escritório', other ? `Troca o gerente atual (${other.sector}). Decide sozinho o que delegar; você aprova o plano` : 'Decide sozinho o que delegar aos outros; você aprova o plano', () => setManager(s.id), 'main'),
    item('Remover departamento', 'Tira só este da planta e encerra o chat. Volta se tiver nova atividade', () => removeRoom(s), 'danger'));
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  el.style.setProperty('left', `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`);
  el.style.setProperty('top', `${Math.min(window.innerHeight - el.offsetHeight - 8, r.bottom + 6)}px`);
  const out = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) closeRoomMenu();
  };
  const key = (e) => {
    if (e.key === 'Escape') {
      closeRoomMenu();
      anchor.focus();
    }
  };
  document.addEventListener('pointerdown', out, true);
  document.addEventListener('keydown', key, true);
  roomMenu = { el, out, key, sid: s.id };
  const first = el.querySelector('.rm-item');
  if (first) first.focus();
}

/** Os três pontinhos no canto da sala. */
function moreBtn(s) {
  const b = h('button', { type: 'button', class: 'more-btn', title: 'Mais opções (gerente, remover)', 'aria-label': `Mais opções de ${s.sector}`, 'aria-haspopup': 'menu', text: '⋯' });
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openRoomMenu(s, b);
  });
  b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  return b;
}

function chatBtn(s) {
  return h('button', {
    type: 'button',
    class: 'chat-btn',
    title: 'Conversar com este departamento aqui no hub',
    text: 'Conversar',
    onclick: (ev) => {
      ev.stopPropagation();
      openChat(s.id);
    },
  });
}

/* ----------------------------------------------------------- cache de DOM */
function cached(map, key, sig, build) {
  const hit = map.get(key);
  if (hit && hit.sig === sig) return hit.el;
  const el = build();
  map.set(key, { sig, el });
  return el;
}
function prune(map, keys) {
  for (const k of [...map.keys()]) if (!keys.has(k)) map.delete(k);
}
function reconcile(parent, els) {
  const cur = [...parent.children];
  if (cur.length === els.length && cur.every((c, i) => c === els[i])) return;
  parent.replaceChildren(...els);
}

const cacheDesk = new Map();
const cacheLane = new Map();
const rooms = new Map();

const empSig = (e) =>
  JSON.stringify([e.persona.key, e.displayName, e.status, e.kind, e.say.text, e.type, e.description, e.live, e.doneTasks,
    e.stats.tools, e.stats.edits, e.stats.commands, selectedKey === e.key]);

function chipLabel(e) {
  if (e.status === 'working') return Timeline.KINDS[e.kind || 'think'].label;
  return STATUS_LABEL[e.status];
}

/* ------------------------------------------------------------------ topo */
function renderStats() {
  const t = state.totals || {};
  const box = $('stats');
  box.replaceChildren(
    stat(t.workers || 0, 'ativos'),
    stat(t.waiting || 0, 'esperando', (t.waiting || 0) > 0)
  );
  document.title = t.waiting ? `(${t.waiting}) Claude Hub` : 'Claude Hub';
}
function stat(value, label, attn) {
  return h('div', { class: 'stat' + (attn ? ' attn' : '') }, h('b', { text: String(value) }), h('span', { text: label }));
}

/* ------------------------------------------------------------- escritório */
function deskEl(e) {
  return cached(cacheDesk, e.key, empSig(e), () => {
    const isNew = !seen.has(e.key);
    seen.add(e.key);
    const p = e.persona;
    const bubbleText = actionBubble(e, 70);
    return h('div', {
      class: `desk s-${e.status} k-${e.kind || 'think'}${e.isLeader ? ' leader' : ''}${isNew ? ' enter' : ''}${selectedKey === e.key ? ' selected' : ''}`,
      vars: { '--skin': p.look.skin, '--accent': p.color },
      tabindex: '0',
      role: 'button',
      'aria-label': `${e.displayName}, ${p.cargo}: ${STATUS_LABEL[e.status]}. Abrir ficha.`,
      onclick: () => selectEmp(e.key),
      onkeydown: onKey(() => selectEmp(e.key)),
    },
      h('div', { class: `bubble px-bubble b-${e.status}`, title: e.say.text }, h('span', { text: bubbleText })),
      h('div', { class: 'px-stage' }, Pixel.sprite('front', p, e.status, e.kind, 3)),
      h('div', { class: 'plate' }, h('b', { text: e.displayName }), h('span', { text: p.cargo })),
      h('span', { class: `kchip k-${e.kind || 'think'}`, text: chipLabel(e) })
    );
  });
}

function roomHeadSig(s) {
  return JSON.stringify([s.id === managerSid, s.sector, chatTitle(s), s.project, s.cwd, s.status, s.model, s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite, s.workingAgents, s.source, s.stale]);
}

/* ---- lugar das salas: a ordem é fixa (nada se embaralha sozinho) e você arrasta para remanejar */
let roomOrder = [];
try {
  const saved = JSON.parse(store('roomOrder', '[]'));
  if (Array.isArray(saved)) roomOrder = saved.filter((x) => typeof x === 'string').slice(0, 400);
} catch {
  roomOrder = [];
}
let dragId = null;

/** Salas já conhecidas ficam onde você as deixou; as novas entram no fim. */
function orderSessions(list) {
  let changed = false;
  for (const s of list) {
    if (!roomOrder.includes(s.id)) {
      roomOrder.push(s.id);
      changed = true;
    }
  }
  if (roomOrder.length > 300) {
    const here = new Set(list.map((s) => s.id));
    roomOrder = roomOrder.filter((id) => here.has(id));
    changed = true;
  }
  if (changed) save('roomOrder', JSON.stringify(roomOrder));
  const idx = new Map(roomOrder.map((id, i) => [id, i]));
  return list.slice().sort((a, b) => idx.get(a.id) - idx.get(b.id));
}

/** A sala `id` assume o lugar da sala `targetId`. */
function moveRoom(id, targetId) {
  const from = roomOrder.indexOf(id);
  const to = roomOrder.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return;
  roomOrder.splice(from, 1);
  roomOrder.splice(to, 0, id);
  save('roomOrder', JSON.stringify(roomOrder));
  state.sessions = orderSessions(state.sessions);
  render();
}

function nudgeRoom(id, dir) {
  const ids = state.sessions.map((s) => s.id);
  const i = ids.indexOf(id);
  const n = ids[i + dir];
  if (i < 0 || !n) return;
  moveRoom(id, n);
  requestAnimationFrame(() => {
    const g = document.querySelector(`[data-sid="${CSS.escape(id)}"] .grip`);
    if (g) g.focus();
  });
}

/** Alça de arrastar: funciona por ponteiro (mouse/toque), com rolagem automática perto das bordas do palco. */
function gripEl(s) {
  const g = h('button', { type: 'button', class: 'grip', title: 'Arraste para mudar o lugar desta sala (ou use as setas do teclado)', 'aria-label': `Mover a sala ${s.sector}`, text: '⠿' });
  let scroller = null;
  let lastY = 0;
  let target = null;
  const clear = () => {
    for (const el of document.querySelectorAll('.dragging, .drop-target')) el.classList.remove('dragging', 'drop-target');
    document.body.classList.remove('room-dragging');
    clearInterval(scroller);
    scroller = null;
  };
  const over = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const room = el && el.closest ? el.closest('[data-sid]') : null;
    const next = room && room.dataset.sid !== s.id ? room : null;
    if (next !== target) {
      if (target) target.classList.remove('drop-target');
      if (next) next.classList.add('drop-target');
      target = next;
    }
  };
  const finish = (ok) => {
    g.removeEventListener('pointermove', onMove);
    g.removeEventListener('pointerup', onUp);
    g.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onEsc, true);
    const to = ok && target ? target.dataset.sid : null;
    clear();
    target = null;
    dragId = null;
    holding = false;
    if (to) moveRoom(s.id, to);
    else if (pendingRender) {
      pendingRender = false;
      render();
    }
  };
  const onMove = (e) => {
    lastY = e.clientY;
    over(e.clientX, e.clientY);
  };
  const onUp = (e) => {
    try {
      g.releasePointerCapture(e.pointerId);
    } catch {
      /* já solto */
    }
    over(e.clientX, e.clientY);
    finish(true);
  };
  const onCancel = () => finish(false);
  const onEsc = (e) => {
    if (e.key === 'Escape') finish(false);
  };
  g.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragId = s.id;
    holding = true;
    lastY = e.clientY;
    const room = g.closest('[data-sid]');
    if (room) room.classList.add('dragging');
    document.body.classList.add('room-dragging');
    try {
      g.setPointerCapture(e.pointerId);
    } catch {
      /* sem captura */
    }
    g.addEventListener('pointermove', onMove);
    g.addEventListener('pointerup', onUp);
    g.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onEsc, true);
    scroller = setInterval(() => {
      const st = g.closest('.rail-list') || $('stage');
      const r = st.getBoundingClientRect();
      const edge = 80;
      if (lastY < r.top + edge) st.scrollTop -= Math.ceil((r.top + edge - lastY) / 4);
      else if (lastY > r.bottom - edge) st.scrollTop += Math.ceil((lastY - (r.bottom - edge)) / 4);
    }, 30);
  });
  g.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      nudgeRoom(s.id, -1);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      nudgeRoom(s.id, 1);
    }
  });
  return g;
}

function fillHead(head, s) {
  const tk = s.tokens;
  const total = tk.input + tk.output + tk.cacheRead + tk.cacheWrite;
  head.replaceChildren(
    gripEl(s),
    h('div', { class: 'rh-title' },
      h('h2', { text: s.sector, title: s.id === managerSid ? `${s.sector} · Gerente do Escritório` : s.sector, class: s.id === managerSid ? 'is-mgr' : null }),
      h('div', { class: 'path', text: chatTitle(s), title: `${chatTitle(s)} · Projeto ${s.project} · ${s.cwd}` })
    ),
    h('div', { class: 'rh-meta' },
      s.model ? h('span', null, h('span', { class: 'k', text: 'modelo ' }), s.model) : null,
      h('span', null, h('span', { class: 'k', text: 'tokens ' }), compact(total)),
      s.source === 'transcript' ? h('span', { class: 'k', text: 'sem hooks (aproximado)' }) : null
    ),
    chatBtn(s),
    h('span', { class: `pill s-${s.status}`, text: s.stale ? 'Sem sinal' : STATUS_LABEL[s.status] }),
    moreBtn(s)
  );
}

const MAX_DESKS = 10;

function roomEl(s) {
  let r = rooms.get(s.id);
  if (!r) {
    r = { el: h('article', { class: 'room' }), head: h('header', { class: 'room-head' }), floor: h('div', { class: 'floor' }), mail: mailBadge(), sig: null };
    r.el.append(r.head, r.floor, r.mail);
    rooms.set(s.id, r);
  }
  const sig = roomHeadSig(s);
  if (r.sig !== sig) {
    r.sig = sig;
    fillHead(r.head, s);
  }
  r.el.className = `room s-${s.status}`;
  paintMail(r, s.id);
  const shown = s.employees.slice(0, MAX_DESKS);
  const els = shown.map(deskEl);
  const hidden = s.employees.length - shown.length;
  if (hidden > 0) els.push(h('div', { class: 'more-desks', text: `+${hidden} na equipe` }));
  reconcile(r.floor, els);
  return r.el;
}

/* ------------------------------------------------------------------ palco */
function emptyEl() {
  return h('div', { class: 'empty glass' },
    h('div', { class: 'empty-art', 'aria-hidden': 'true' }),
    h('h2', { text: 'O escritório está vazio' }),
    h('p', { text: 'Assim que uma sessão do Claude Code (no VS Code ou no terminal) ficar ativa, o líder do projeto senta na mesa e a equipe aparece aqui.' }),
    h('ol', null,
      h('li', null, 'Na pasta do hub, rode ', h('code', { text: 'npm run install-hooks' }), '.'),
      h('li', null, 'Abra uma sessão nova do Claude Code, ou reinicie a que já está aberta, para ela carregar os hooks.'),
      h('li', null, 'Para ver o time trabalhando agora: ', h('code', { text: 'npm run demo' }), '.')
    )
  );
}

/** Quantos agentes da sala estão mexendo em algo (ou esperando você) agora. */
function activeCount(s) {
  return s.employees.filter((e) => e.status === 'working' || e.status === 'waiting').length;
}

/* O escritório (canvas do Habblaud) fica atrás de tudo; a ponte entrega o estado do hub e traz de volta os cliques. */
let bridge = null;
let focusFromUi = false;

function renderStage() {
  const stage = $('stage');
  document.body.classList.toggle('v-office', view === 'office');
  document.body.classList.toggle('v-team', view === 'team');
  document.body.classList.toggle('no-depts', !state.sessions.length);
  stage.className = 'stage view-' + view;
  const keys = new Set();
  const ids = new Set(state.sessions.map((s) => s.id));
  for (const s of state.sessions) for (const e of s.employees) keys.add(e.key);
  prune(cacheDesk, keys);
  prune(rooms, ids);
  prune(railRows, ids);
  if (bridge) {
    bridge.update(state, nowMs());
    bridge.suspend(view !== 'office');
  }
  if (!state.sessions.length) stage.replaceChildren(emptyEl());
  else if (view === 'office') stage.replaceChildren();
  else reconcile(stage, state.sessions.map(roomEl));
}

/** Clique no personagem do escritório: abre a ficha dele (sem alternar, como a lista faz). */
function pickFromWorld(key) {
  if (key && key.startsWith('res:')) {
    // equipe fixa não tem ficha: clicar leva ao líder do departamento
    const sess = state && state.sessions.find((x) => x.id === key.split(':')[1]);
    const lead = sess && sess.employees.find((e) => e.isLeader);
    key = lead ? lead.key : null;
  }
  if ((key || null) === (selectedKey || null)) return;
  if (key) {
    closeChatPanes();
    if (Vault.isOpen()) Vault.close();
  }
  selectedKey = key || null;
  profSig = null;
  render();
}

/** Câmera até o departamento (lista lateral, Pendências) e um "pisca" na linha dele. */
function focusDept(sid) {
  if (view === 'office' && bridge) bridge.focusRoom(sid);
  const el = document.querySelector(`.rrow[data-sid="${CSS.escape(sid)}"], .room[data-sid="${CSS.escape(sid)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  el.classList.add('ping');
  setTimeout(() => el.classList.remove('ping'), 1800);
}

/* -------------------------------------------- lista de departamentos (esquerda) */
const railRows = new Map();
function railRowEl(s) {
  let r = railRows.get(s.id);
  if (!r) {
    r = { el: h('article', { class: 'rrow' }), mail: mailBadge(), sig: null };
    railRows.set(s.id, r);
  }
  const sig = JSON.stringify([s.id === managerSid, s.sector, chatTitle(s), s.project, s.status, s.stale, activeCount(s), s.employees.map((e) => [e.key, e.status, e.displayName, e.persona.color, selectedKey === e.key])]);
  if (r.sig !== sig) {
    r.sig = sig;
    const isMgr = s.id === managerSid;
    const people = s.employees.slice(0, 8).map((e) =>
      h('button', {
        type: 'button',
        class: `rp s-${e.status}${selectedKey === e.key ? ' sel' : ''}`,
        vars: { '--accent': e.persona.color },
        title: `${e.displayName} · ${e.persona.cargo} · ${STATUS_LABEL[e.status]}`,
        onclick: (ev) => {
          ev.stopPropagation();
          focusFromUi = true;
          selectEmp(e.key);
        },
      }, h('i', { class: 'dot', 'aria-hidden': 'true' }), h('span', { text: e.displayName })));
    if (s.employees.length > 8) people.push(h('span', { class: 'rp-more', text: `+${s.employees.length - 8}` }));
    r.el.replaceChildren(
      h('div', { class: 'rr-head' },
        gripEl(s),
        h('i', { class: `dot s-${s.status}`, 'aria-hidden': 'true' }),
        h('div', { class: 'rr-title', title: `${isMgr ? 'Gerente do Escritório\n' : ''}Projeto ${s.project}\n${s.cwd}\n${chatTitle(s)}\nSetor: ${s.flavor}` },
          h('b', { text: s.sector, class: isMgr ? 'is-mgr' : null }),
          h('span', { text: chatTitle(s) })),
        h('span', { class: `rr-act s-${s.status}`, title: `${activeCount(s)} agente(s) ativo(s) agora`, text: s.stale ? 'sem sinal' : String(activeCount(s)) }),
        moreBtn(s)),
      h('div', { class: 'rr-people' }, ...people, chatBtn(s)),
      r.mail);
  }
  r.el.className = `rrow s-${s.status}${s.id === managerSid ? ' mgr' : ''}`;
  r.el.onclick = () => focusDept(s.id);
  paintMail(r, s.id);
  return r.el;
}

let brainSig = '';
const OPS = { read: 'lendo', write: 'escrevendo', search: 'procurando em', other: 'mexendo em' };
function renderBrain() {
  const info = vaultInfo;
  const live = state.vault && state.vault.live ? state.vault.live : [];
  const ok = !!(info && info.on && info.exists);
  const sig = JSON.stringify([live.map((x) => [x.sessionId, x.who, x.note, x.op]), info && [info.on, info.exists, info.name, info.overview && info.overview.total], state.sessions.map((x) => [x.id, x.sector])]);
  if (sig === brainSig) return;
  brainSig = sig;
  let top = 'Cérebro';
  let sub = '';
  if (info && !info.exists) { top = 'Vault não encontrado'; sub = 'Clique para escolher a pasta do vault'; }
  else if (info && !info.on) { top = 'Cérebro desligado'; sub = 'Clique para ligar para os chats do hub'; }
  else if (info) {
    top = live.length ? `${live.length === 1 ? 'Alguém está' : 'Pessoas estão'} consultando` : `${info.overview ? info.overview.total : 0} notas`;
    const f = info.overview && info.overview.folders.find((x) => x.name);
    sub = live.length ? info.name : f ? `${info.name} · mais notas em ${f.name}` : info.name || 'Clique para ver as notas';
  }
  const lis = ok ? live.slice(0, 3).map((x) => {
    const s = state.sessions.find((y) => y.id === x.sessionId);
    const who = (s ? s.sector : x.project) + (x.who ? ` · ${x.who}` : '');
    const base = x.note ? x.note.split('/').pop().replace(/\.(md|markdown)$/i, '') : 'o vault';
    return h('li', { class: `op-${x.op}` }, h('i', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'bl-who', text: who }), h('span', { class: 'bl-op', text: ` ${OPS[x.op] || OPS.other} ` }), h('b', { text: base, title: x.note }));
  }) : [];
  $('rail-brain').replaceChildren(h('button', { type: 'button', class: `brain${ok ? '' : ' off'}${ok && live.length ? ' live' : ''}`, title: 'Abrir as notas do Cérebro', onclick: () => openVault() },
    h('span', { class: 'brain-ic', 'aria-hidden': 'true', text: '🧠' }), h('b', { text: top }), h('span', { class: 'brain-sub', text: sub }), lis.length ? h('ul', { class: 'brain-live' }, ...lis) : null));
}

function renderRail() {
  const list = $('rail-list');
  reconcile(list, state.sessions.map(railRowEl));
  const n = state.sessions.length;
  $('rail-count').textContent = n ? `${n} ${n === 1 ? 'departamento' : 'departamentos'}` : '';
  renderBrain();
}

/* ------------------------------------------------------ mostrador de uso (topo) */
let usage = null;
const lvOf = (p) => (p >= 90 ? 'crit' : p >= 70 ? 'warn' : 'ok');
function resetIn(ms) {
  const d = ms - nowMs();
  if (d <= 0) return 'renovada';
  const m = Math.max(1, Math.round(d / 60000));
  if (m < 60) return `${m}min`;
  const hh = Math.floor(m / 60);
  if (hh < 24) return `${hh}h${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(hh / 24)}d${hh % 24}h`;
}
function meterEl(label, w, title) {
  if (!w) {
    return h('div', { class: 'um empty', title: `${title}: sem dado agora (a janela renovou; volta quando o Claude Code mandar números novos)` },
      h('span', { class: 'um-l', text: label }), h('i', { class: 'um-bar', 'aria-hidden': 'true' }), h('b', { class: 'um-p', text: '—' }));
  }
  const pct = Math.round(w.pct);
  return h('div', { class: `um lv-${lvOf(w.pct)}`, title: `${title}: ${pct}% usado${w.resetsAt ? ` · renova em ${resetIn(w.resetsAt)}` : ''}` },
    h('span', { class: 'um-l', text: label }),
    h('i', { class: 'um-bar', 'aria-hidden': 'true', vars: { '--pct': String(Math.min(100, Math.max(0, w.pct))) } }),
    h('b', { class: 'um-p', text: `${pct}%` }),
    w.resetsAt ? h('span', { class: 'um-r', text: `↻${resetIn(w.resetsAt)}` }) : null);
}
let usagePop = null;
function closeUsagePop() {
  if (!usagePop) return;
  usagePop.el.remove();
  document.removeEventListener('pointerdown', usagePop.out, true);
  usagePop = null;
}
function openUsageHelp(anchor) {
  if (usagePop) return closeUsagePop();
  const cmd = 'npm run install-hooks';
  const el = h('div', { class: 'usage-pop glass', role: 'dialog', 'aria-label': 'Como ativar o mostrador de uso' },
    h('b', { text: 'Como ativar o mostrador de uso' }),
    h('p', { text: 'O Claude Code manda o uso do plano (5 h e semana) ao statusline. O hub fica na frente do seu statusline, anota só esses números e repassa tudo ao comando original (nada de rede, nada de senha).' }),
    h('ol', null,
      h('li', null, 'Na pasta do hub: ', h('code', { text: cmd }), ' (faz backup do settings.json antes).'),
      h('li', null, 'Reinicie as sessões do Claude Code que já estavam abertas.')),
    h('p', { class: 'dim', text: 'Sem isso, o hub usa o último número guardado pelo próprio Claude Code (atualiza quando alguém roda /usage). Para desfazer: npm run uninstall-hooks.' }),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', text: 'Copiar comando', onclick: () => { window.hub.copyText(cmd); toast('Comando copiado.'); } }),
      h('button', { type: 'button', class: 'btn', text: 'Fechar', onclick: closeUsagePop })));
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  el.style.setProperty('left', `${Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, r.right - el.offsetWidth))}px`);
  el.style.setProperty('top', `${r.bottom + 8}px`);
  const out = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) closeUsagePop();
  };
  document.addEventListener('pointerdown', out, true);
  usagePop = { el, out };
}
let usageSig = '';
function renderUsage() {
  const box = $('usage');
  if (!box) return;
  const u = usage;
  const sig = JSON.stringify([u, u && u.fiveHour && resetIn(u.fiveHour.resetsAt || 0), u && u.sevenDay && resetIn(u.sevenDay.resetsAt || 0)]);
  if (sig === usageSig) return;
  usageSig = sig;
  if (!u || u.state === 'empty' || (!u.fiveHour && !u.sevenDay && u.state !== 'stale')) {
    const b = h('button', { type: 'button', class: 'usage-help', text: 'Como ativar', title: 'Como ligar o mostrador de uso' });
    b.addEventListener('click', () => openUsageHelp(b));
    box.className = 'usage is-empty';
    box.replaceChildren(h('span', { class: 'usage-none', text: 'sem dados de uso' }), b);
    return;
  }
  const src = u.source === 'statusline' ? 'ao vivo, pelo statusline' : 'último valor guardado pelo Claude Code (/usage)';
  box.className = `usage${u.state === 'stale' ? ' is-stale' : ''}`;
  box.title = `${u.account}: números ${u.state === 'stale' ? 'desatualizados' : 'recentes'} (${src}).${u.tapInstalled ? '' : ' Para ficar ao vivo: npm run install-hooks.'}`;
  box.replaceChildren(
    ...(u.account && u.account !== 'Conta' ? [h('span', { class: 'usage-acc', text: u.account })] : []),
    meterEl('5h', u.fiveHour, 'Sessão de 5 horas'),
    meterEl('Semana', u.sevenDay, 'Limite semanal'),
    ...(u.state === 'stale' ? [h('span', { class: 'usage-old', text: 'desatualizado' })] : []));
}

/* ------------------------------------------------------ posição da câmera x painéis */
let insetsRaf = 0;
function applyInsets() {
  if (insetsRaf) return;
  insetsRaf = requestAnimationFrame(() => {
    insetsRaf = 0;
    if (!bridge) return;
    const box = (id) => {
      const el = $(id);
      if (!el || el.hidden) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none' ? r : null;
    };
    const G = 12;
    const top = box('topbar-box');
    const rail = box('rail');
    const side = box('side');
    const dock = box('dock');
    bridge.setInsets({
      top: top ? top.bottom + G : G,
      left: rail ? rail.right + G : G,
      right: side ? window.innerWidth - side.left + G : G,
      bottom: dock ? window.innerHeight - dock.top + G : G,
    });
  });
}

/* ------------------------------------------------------- linha do tempo */
function laneEl(e) {
  return cached(cacheLane, e.key, JSON.stringify([e.displayName, e.persona.cargo, e.status, selectedKey === e.key]), () => {
    const strip = h('div', { class: 'strip', 'data-key': e.key });
    Timeline.renderStrip(strip, e, winMs(), nowMs());
    return h('div', {
      class: `lane s-${e.status}${selectedKey === e.key ? ' selected' : ''}`,
      vars: { '--accent': e.persona.color },
      tabindex: '0',
      role: 'button',
      onclick: () => selectEmp(e.key),
      onkeydown: onKey(() => selectEmp(e.key)),
    },
      h('div', { class: 'lane-label' }, avatarEl(e, 28), h('div', { class: 'ln' }, h('b', { text: e.displayName }), h('span', { text: e.persona.cargo }))),
      strip
    );
  });
}

let dockWinShown = null;
let dockTab = store('dockTab', 'feed') === 'time' ? 'time' : 'feed';
function setDockTab(t) {
  dockTab = t;
  save('dockTab', t);
  if (!dockOpen) {
    dockOpen = true;
    save('dock', '1');
  }
  renderDock();
}
function renderDock() {
  const dock = $('dock');
  dock.classList.toggle('collapsed', !dockOpen);
  dock.classList.toggle('tab-time', dockTab === 'time');
  $('dock-toggle').textContent = dockOpen ? 'Recolher' : 'Expandir';
  $('dock-toggle').setAttribute('aria-expanded', String(dockOpen));
  for (const [id, name] of [['tab-feed', 'feed'], ['tab-time', 'time']]) $(id).setAttribute('aria-selected', String(dockTab === name));
  $('pane-feed').hidden = dockTab !== 'feed';
  $('pane-time').hidden = dockTab !== 'time';
  applyInsets();
  if (!dockOpen) return;
  if (dockTab === 'feed') return renderFeedPanel();
  if (dockWinShown !== winSel) {
    dockWinShown = winSel;
    $('dock-win').replaceChildren(...winButtons());
  }
  Timeline.renderAxis($('dock-axis'), winMs());

  const keys = new Set();
  const rows = [];
  for (const s of state.sessions) {
    rows.push(cached(cacheLane, 'g:' + s.id, s.sector + s.project, () => h('div', { class: 'lane-group', text: s.sector, title: `Projeto ${s.project}` })));
    keys.add('g:' + s.id);
    for (const e of s.employees) {
      keys.add(e.key);
      rows.push(laneEl(e));
    }
  }
  prune(cacheLane, keys);
  reconcile($('lanes'), rows);
}

function winButtons() {
  return Timeline.WINDOWS.map((m) =>
    h('button', {
      type: 'button',
      class: 'chip-btn' + (m === winSel ? ' active' : ''),
      'aria-pressed': String(m === winSel),
      title: m === 'auto' ? 'Ajusta a janela ao tempo que a equipe já trabalhou' : null,
      text: m === 'auto' ? 'Auto' : m === 60 ? '1 h' : `${m} min`,
      onclick: () => setWin(m),
    })
  );
}
function setWin(m) {
  winSel = m;
  save('win', m);
  profSig = null;
  render();
}

/* -------------------------------------------------------------- painel lateral */
let sideMode = null;
let splitEl = null;
let splitSig = '';
let profSig = null;
let profileEl = null;
const profStrip = h('div', { class: 'strip big' });
const profAxis = h('div', { class: 'axis' });

/* O painel da direita só aparece quando há o que mostrar (ficha, chat ou Cérebro); a Atividade ao vivo mora embaixo. */
function paintSideOff() {
  document.body.classList.toggle('side-off', sideMode === 'none' || sideMode === null);
  applyInsets();
}

function selectEmp(key) {
  if (key) closeChatPanes();
  if (key && key !== selectedKey) focusFromUi = true;
  if (Vault.isOpen() && key) Vault.close();
  selectedKey = key && key === selectedKey ? null : key;
  profSig = null;
  render();
}

function feedItem(f, withPerson) {
  const emp = empIndex.get(`${f.sessionId}:${f.emp}`);
  const name = emp ? emp.displayName : f.project;
  const place = emp ? emp.sector : f.project;
  return h('li', { class: f.kind, vars: emp ? { '--accent': emp.persona.color } : {} },
    h('span', { class: 'time', text: clock(f.ts) }),
    h('div', null,
      withPerson ? h('div', { class: 'who' }, h('i', { class: 'who-dot' }), h('b', { text: name }), ` · ${place}`) : null,
      h('div', { class: 'txt', text: f.text })
    )
  );
}

function renderFeedPanel() {
  const list = $('feed');
  const items = state.feed.slice(-200);
  const sig = items.length ? `${items.length}:${items[items.length - 1].ts}:${items[items.length - 1].text}` : '0';
  if (sig === feedSig) return;
  feedSig = sig;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.replaceChildren(...items.map((f) => feedItem(f, true)));
  if (nearBottom) list.scrollTop = list.scrollHeight;
}
let feedSig = '';

function tile(label, value, extra) {
  return h('div', { class: 'tile' }, h('b', null, value), h('span', { text: label }), extra || null);
}

function buildProfile(e) {
  const p = e.persona;
  Timeline.renderAxis(profAxis, winMs());
  profStrip.dataset.key = e.key;
  Timeline.renderStrip(profStrip, e, winMs(), nowMs());

  const stats = h('div', { class: 'tiles' },
    tile('ferramentas usadas', String(e.stats.tools)),
    tile('arquivos editados', String(e.stats.edits), e.stats.editsTotal > e.stats.edits ? h('em', { text: `${e.stats.editsTotal} edições` }) : null),
    tile('comandos rodados', String(e.stats.commands)),
    tile('leituras e buscas', String(e.stats.reads)),
    tile('delegações', String(e.stats.delegations)),
    tile('falhas', String(e.stats.errors)),
    tile('tempo ativo', h('span', { 'data-bind': 'active', 'data-key': e.key, text: dur(activeNow(e)) })),
    tile('esperando você', h('span', { 'data-bind': 'wait', 'data-key': e.key, text: dur(waitNow(e)) }))
  );
  if (e.isLeader && e.tokens) {
    const tk = e.tokens;
    stats.append(
      tile('tokens da sessão', compact(tk.input + tk.output + tk.cacheRead + tk.cacheWrite),
        tk.sub.input + tk.sub.output + tk.sub.cacheRead + tk.sub.cacheWrite ? h('em', { text: `${compact(tk.sub.input + tk.sub.output + tk.sub.cacheRead + tk.sub.cacheWrite)} em subagentes` }) : null)
    );
  }

  const tasks = e.tasks.length
    ? h('div', { class: 'tasks' }, e.tasks.map((t) =>
        h('div', { class: `task st-${t.status}` },
          h('div', { class: 't-head' },
            h('span', { class: 't-state', text: TASK_LABEL[t.status] || t.status }),
            h('span', { class: 't-time' },
              `${clockShort(t.start)}${t.end ? ' → ' + clockShort(t.end) : ''} · `,
              t.end ? dur(t.end - t.start) : h('span', { 'data-since': t.start, text: dur(nowMs() - t.start) })
            )
          ),
          h('div', { class: 't-title', text: t.title }),
          h('div', { class: 't-nums', text: `${t.tools} ferramentas · ${t.files} ${t.files === 1 ? 'arquivo' : 'arquivos'} · ${t.commands} ${t.commands === 1 ? 'comando' : 'comandos'}` }),
          t.fileNames.length ? h('div', { class: 't-files' }, t.fileNames.map((n) => h('code', { text: n }))) : null,
          t.result ? h('div', { class: 't-result', text: t.result }) : null
        )
      ))
    : h('div', { class: 'p-empty', text: 'Nenhuma tarefa registrada ainda.' });

  const mine = state.feed.filter((f) => `${f.sessionId}:${f.emp}` === e.key).slice(-40).reverse();

  const scroll = h('div', { class: 'profile-scroll' },
    h('div', { class: 'p-head' },
      avatarEl(e, 112),
      h('div', { class: 'p-id' },
        h('h2', { text: e.displayName }),
        h('div', { class: 'cargo', text: p.cargo }),
        h('div', { class: 'proj', text: `${e.isLeader ? 'Líder do projeto' : 'Subagente do projeto'} ${e.sector}` }),
        h('div', { class: 'p-badges' },
          h('span', { class: `pill s-${e.status}`, text: STATUS_LABEL[e.status] }),
          h('span', { class: 'mood' }, h('span', { class: 'k', text: 'Humor ' }), e.mood.label)
        )
      )
    ),
    e.description ? h('div', { class: 'mission big', text: 'Missão: ' + e.description }) : null,
    h('div', { class: `p-now b-${e.status}` }, h('span', { text: e.say.text })),
    h('section', { class: 'p-sec' },
      h('div', { class: 'sec-head' }, h('h3', { text: 'Linha do tempo' }), h('div', { class: 'win-switch' }, winButtons())),
      profAxis,
      profStrip,
      Timeline.legend()
    ),
    h('section', { class: 'p-sec' }, h('h3', { text: 'Ficha de desempenho' }), stats),
    h('section', { class: 'p-sec' }, h('h3', { text: `Tarefas (${e.tasks.length})` }), tasks),
    h('section', { class: 'p-sec' }, h('h3', { text: 'Atividade recente' }),
      mine.length ? h('ol', { class: 'feed compact' }, mine.map((f) => feedItem(f, false))) : h('div', { class: 'p-empty', text: 'Sem atividade registrada.' }))
  );

  return h('div', { class: `profile s-${e.status}`, vars: { '--accent': p.color } },
    h('button', { class: 'close', type: 'button', 'aria-label': 'Fechar ficha', text: '✕', onclick: () => selectEmp(null) }),
    scroll
  );
}

function profileSig(e) {
  return JSON.stringify([e.persona.key, e.displayName, e.status, e.kind, e.say.text, e.description, e.stats.tools, e.stats.edits,
    e.stats.commands, e.stats.reads, e.stats.errors, e.stats.delegations, e.tasks.map((t) => [t.id, t.status, t.tools, t.files, t.result]),
    e.sector, e.isLeader ? e.tokens.input + e.tokens.output : null,
    state.feed.length ? state.feed[state.feed.length - 1].ts : 0, winSel]);
}

function renderSide() {
  renderSideInner();
  paintSideOff();
}

function renderSideInner() {
  const side = $('side');
  if (Vault.isOpen() && !Chat.isOpen()) {
    if (sideMode !== 'vault' || side.firstChild !== Vault.el) {
      side.replaceChildren(Vault.el);
      sideMode = 'vault';
      profileEl = null;
    }
    return;
  }
  if (Chat.isOpen() && splitOn) {
    const second = Chat2.isOpen();
    const sig = `split:${second ? 'chat' : 'pick:' + state.sessions.map((s) => s.id + s.status).join(',')}`;
    if (sideMode !== 'split' || splitSig !== sig || !splitEl) {
      if (!second) splitPickEl = buildSplitPicker();
      const c1 = h('div', { class: 'split-col', 'data-pane': '1' }, Chat.el);
      const c2 = h('div', { class: 'split-col', 'data-pane': '2' }, second ? Chat2.el : splitPickEl);
      splitEl = h('div', { class: 'split' }, c1, c2);
      side.replaceChildren(splitEl);
      splitSig = sig;
      sideMode = 'split';
      profileEl = null;
      paintFocus();
    }
    return;
  }
  if (Chat.isOpen()) {
    if (sideMode !== 'chat' || side.firstChild !== Chat.el) {
      side.replaceChildren(Chat.el);
      sideMode = 'chat';
      profileEl = null;
    }
    return;
  }
  const e = selectedKey ? empIndex.get(selectedKey) : null;
  if (selectedKey && !e) selectedKey = null;

  if (!e) {
    if (sideMode !== 'none') side.replaceChildren();
    sideMode = 'none';
    profileEl = null;
    return;
  }
  const sig = profileSig(e);
  if (sideMode !== 'profile' || sig !== profSig) {
    const prevScroll = profileEl && profileEl.querySelector('.profile-scroll') ? profileEl.querySelector('.profile-scroll').scrollTop : 0;
    profSig = sig;
    profileEl = buildProfile(e);
    side.replaceChildren(profileEl);
    const sc = profileEl.querySelector('.profile-scroll');
    if (sc && sideMode === 'profile') sc.scrollTop = prevScroll;
    sideMode = 'profile';
  }
}

/* ------------------------------------------------------------------ laço */
let holding = false;
let pendingRender = false;

function render() {
  if (holding) {
    pendingRender = true;
    return;
  }
  decorate(state);
  renderStats();
  renderStage();
  renderRail();
  renderUsage();
  renderDock();
  if (Chat.isOpen()) Chat.update(chatContext(Chat.currentId()));
  if (Chat2.isOpen()) Chat2.update(chatContext(Chat2.currentId()));
  renderSide();
  if (bridge) {
    bridge.select(selectedKey, focusFromUi);
    focusFromUi = false;
  }
  updateSwitches();
  tick();
}

function tick() {
  const t = nowMs();
  for (const el of document.querySelectorAll('[data-since]')) {
    el.textContent = dur(t - Number(el.dataset.since));
  }
  for (const el of document.querySelectorAll('[data-bind]')) {
    const e = empIndex.get(el.dataset.key);
    if (!e) continue;
    if (el.dataset.bind === 'active') el.textContent = dur(activeNow(e));
    else if (el.dataset.bind === 'wait') el.textContent = dur(waitNow(e));
  }
  const win = winMs();
  if (dockOpen && dockTab === 'time') Timeline.renderAxis($('dock-axis'), win);
  if (sideMode === 'profile') Timeline.renderAxis(profAxis, win);
  renderUsage();
  for (const el of document.querySelectorAll('.strip[data-key]')) {
    const e = empIndex.get(el.dataset.key);
    if (e) Timeline.renderStrip(el, e, win, t);
  }
}

function updateSwitches() {
  $('v-office').setAttribute('aria-selected', String(view === 'office'));
  $('v-team').setAttribute('aria-selected', String(view === 'team'));
}

function applyState(s) {
  state = s;
  state.sessions = orderSessions(s.sessions);
  skew = s.now - Date.now();
  render();
}

function setView(v) {
  view = v;
  save('view', v);
  render();
}

function bindControls() {
  const sound = $('opt-sound');
  const waiting = $('opt-waiting');
  const done = $('opt-done');
  sound.checked = !!config.sound;
  waiting.checked = !!config.notifyWaiting;
  done.checked = !!config.notifyDone;
  sound.onchange = () => window.hub.setConfig({ sound: sound.checked });
  waiting.onchange = () => window.hub.setConfig({ notifyWaiting: waiting.checked });
  done.onchange = () => window.hub.setConfig({ notifyDone: done.checked });
  $('btn-newdept').onclick = () => newDepartment();
  const theme = $('opt-theme');
  try {
    theme.value = localStorage.getItem('officeTheme') || 'auto';
  } catch {
    theme.value = 'auto';
  }
  theme.onchange = () => bridge && bridge.setTheme(theme.value);
  const team = $('opt-team');
  team.value = String(teamSize);
  team.onchange = () => {
    teamSize = Number(team.value);
    save('teamSize', teamSize);
    render();
  };
  {
    const pop = $('settings-pop');
    const btn = $('btn-settings');
    const close = () => {
      pop.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    };
    btn.onclick = () => {
      pop.hidden = !pop.hidden;
      btn.setAttribute('aria-expanded', String(!pop.hidden));
    };
    document.addEventListener('pointerdown', (e) => {
      if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) close();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !pop.hidden) close();
    });
  }
  $('tab-feed').onclick = () => setDockTab('feed');
  $('tab-time').onclick = () => setDockTab('time');
  $('cam-in').onclick = () => bridge && bridge.zoomBy(1.25);
  $('cam-out').onclick = () => bridge && bridge.zoomBy(1 / 1.25);
  $('cam-fit').onclick = () => bridge && bridge.overview();
  // os painéis flutuantes mudam de tamanho (chat aberto, aba do dock...): o escritório se enquadra na área livre
  {
    const ro = new ResizeObserver(() => {
      const root = document.documentElement.style;
      root.setProperty('--topbar-h', `${$('topbar-box').offsetHeight}px`);
      root.setProperty('--dock-h', `${$('dock').offsetHeight}px`);
      applyInsets();
    });
    for (const id of ['topbar-box', 'rail', 'side', 'dock']) ro.observe($(id));
    window.addEventListener('resize', applyInsets);
  }
  $('btn-clear').onclick = async () => {
    const ids = (await window.hub.dismissInactive()) || [];
    if (!ids.length) return toast('Nada para limpar: todos os departamentos estão ativos.');
    toast(`${ids.length} departamento${ids.length > 1 ? 's' : ''} parado${ids.length > 1 ? 's' : ''} removido${ids.length > 1 ? 's' : ''} (o gerente fica).`, { label: 'Desfazer', fn: () => window.hub.undismiss(ids) });
  };
  $('btn-shift').onclick = () => Report.open();
  $('btn-phone').onclick = () => PhonePanel.open();
  $('v-office').onclick = () => setView('office');
  $('v-team').onclick = () => setView('team');
  $('dock-toggle').onclick = () => {
    dockOpen = !dockOpen;
    save('dock', dockOpen ? '1' : '0');
    renderDock();
  };
  $('dock-legend').replaceChildren(Timeline.legend());
}

/* ------------------------------------------------------------- som/avisos */
let audioCtx = null;
function beep(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = kind === 'waiting' ? [880, 660, 880] : kind === 'error' ? [330, 330] : [523, 784];
    let at = audioCtx.currentTime;
    for (const f of notes) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(at);
      osc.stop(at + 0.2);
      at += 0.2;
    }
  } catch {
    /* sem áudio disponível */
  }
}

/** Botão direito numa sala do escritório: o mesmo menu do ⋯ da lista, no ponto do clique. */
function roomMenuAt(sid, at) {
  const sess = state.sessions.find((x) => x.id === sid);
  if (!sess) return;
  const anchor = {
    getBoundingClientRect: () => ({ left: at.x, right: at.x, top: at.y, bottom: at.y, width: 0, height: 0 }),
    contains: () => false,
    focus() {},
  };
  openRoomMenu(sess, anchor);
}

async function init() {
  config = await window.hub.getConfig();
  bindControls();
  try {
    bridge = HabBridge.create($('world'), { onAgent: pickFromWorld, onRoomMenu: roomMenuAt });
  } catch (err) {
    console.error('[escritório] não carregou; segue só a visão Equipe', err);
    bridge = null;
  }
  if (!bridge) view = 'team';
  try {
    usage = await window.hub.getUsage();
  } catch {
    usage = null;
  }
  window.hub.onUsage((u) => {
    usage = u;
    renderUsage();
  });
  applyState(await window.hub.getState());
  PhonePanel.init();
  Inbox.init({
    sectorOf: (sid) => {
      const x = state.sessions.find((q) => q.id === sid);
      return x ? x.sector : 'Departamento';
    },
    openChat: (sid) => openChat(sid),
    focusRoom: (sid) => focusDept(sid),
    waitingElsewhere: (hubSids) => state.sessions.filter((x) => x.status === 'waiting' && !hubSids.has(x.id)).map((x) => ({ id: x.id, sector: x.sector })),
    isOpen: (sid) => Chat.currentId() === sid || Chat2.currentId() === sid,
    sound: () => !!(config && config.sound),
    beep: () => beep('waiting'),
  });
  const awayDeps = {
    sectorOf: (sid) => {
      const x = state.sessions.find((q) => q.id === sid);
      return x ? x.sector : '';
    },
    openChat: (sid) => openChat(sid),
    pending: () => Inbox.count(),
    openInbox: () => Inbox.open(),
  };
  try {
    managerSid = await window.hub.managerGet();
  } catch {
    /* sem gerente */
  }
  window.hub.onManager((sid) => {
    managerSid = sid;
    if (!holding) render();
  });
  window.hub.onWelcomeBack(() => Away.check(awayDeps));
  setTimeout(() => Away.check(awayDeps), 1500);
  loadVault();
  setInterval(loadVault, 60000);
  try {
    onOffice(await window.hub.officeState(), true);
  } catch {
    /* sem Escritório */
  }
  window.hub.onOffice((o) => onOffice(o, false));
  window.hub.onState(applyState);
  window.hub.onAlert((a) => {
    if (a.sound) beep(a.kind);
  });
  window.hub.onFocusSession((id) => {
    selectedKey = `${id}:main`;
    profSig = null;
    render();
  });

  setInterval(tick, 1000);
  document.addEventListener('pointerdown', () => {
    holding = true;
  });
  const release = () => {
    holding = false;
    if (pendingRender) {
      pendingRender = false;
      render();
    }
  };
  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);
  window.addEventListener('blur', release);
}

/* ------------------------------------------------- largura do painel lateral */
function initSideResizer() {
  const handle = $('side-resizer');
  const side = $('side');
  if (!handle || !side) return;
  const MIN = 300;
  const DEFAULT = 420;
  const maxW = () => Math.max(MIN, Math.floor(window.innerWidth * 0.7));
  const clamp = (w) => Math.min(maxW(), Math.max(MIN, Math.round(w)));
  let width = clamp(Number(store('sideW', DEFAULT)) || DEFAULT);
  const apply = (w, persist) => {
    width = clamp(w);
    document.documentElement.style.setProperty('--side-w', width + 'px');
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuemin', String(MIN));
    handle.setAttribute('aria-valuemax', String(maxW()));
    if (persist) save('sideW', width);
  };
  apply(width, false);
  sideCtl = { get: () => width, apply };

  let startX = 0;
  let startW = 0;
  const move = (e) => apply(startW + (startX - e.clientX), false);
  const stop = (e) => {
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing');
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', stop);
    handle.removeEventListener('pointercancel', stop);
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {
      /* já solto */
    }
    save('sideW', width);
  };
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX;
    startW = side.getBoundingClientRect().width;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  });
  handle.addEventListener('dblclick', () => apply(DEFAULT, true));
  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 80 : 24;
    if (e.key === 'ArrowLeft') apply(width + step, true);
    else if (e.key === 'ArrowRight') apply(width - step, true);
    else if (e.key === 'Home') apply(MIN, true);
    else if (e.key === 'End') apply(maxW(), true);
    else return;
    e.preventDefault();
  });
  window.addEventListener('resize', () => apply(width, false));
}

init();
initSideResizer();
