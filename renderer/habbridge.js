'use strict';
/**
 * Ponte entre o hub e o escritório em canvas do Habblaud (renderer/habblaud-world.js, MIT, © Márcio Junior).
 *
 * O motor do Habblaud desenha o prédio inteiro (salas, móveis, personagens andando, balões, câmera com zoom e arrasto)
 * a partir de um "snapshot" com salas e agentes. Aqui o estado do hub (departamentos = salas, funcionários = agentes)
 * vira esse snapshot, e o que o motor emite (clique num personagem, botão direito numa sala) volta para o hub.
 *
 * Funções puras (toSnapshot e afins) ficam separadas para teste: test/bridge.test.js.
 */
(function () {
  const RESIDENT_AWAKE_MS = 7 * 24 * 3600e3;
  const PARTY_MS = 12000;

  function hashStr(str) {
    let x = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      x ^= str.charCodeAt(i);
      x = Math.imul(x, 0x01000193) >>> 0;
    }
    return x >>> 0;
  }

  const STATUS = { working: 'working', waiting: 'waiting', idle: 'idle', done: 'done', error: 'idle', ended: 'offline' };
  const KIND = { think: 'think', read: 'read', edit: 'edit', run: 'run', delegate: 'delegate', wait: 'wait', other: 'other' };
  const ICON = { think: '💭', read: '📖', edit: '✏️', run: '⚙️', delegate: '📨', wait: '✋', other: '🔧' };
  const clip = (t, n) => (String(t).length > n ? String(t).slice(0, n - 1) + '…' : String(t));

  /** Atividade que o motor mostra no balão do personagem. */
  function activityOf(e, text, at) {
    const kind = e.status === 'waiting' ? 'ask' : e.status === 'done' ? 'done' : KIND[e.kind] || 'other';
    return { id: `${e.key}:${e.statusSince || 0}:${text}`, kind, icon: ICON[e.kind] || '💬', text: clip(text, 46), at };
  }

  /**
   * Estado do hub -> snapshot do Habblaud.
   * `effects`: Map(sessionId -> { text, at, until, agentId }) com as festas (quem acabou de concluir).
   */
  function toSnapshot(st, effects, now) {
    const rooms = [];
    const agents = [];
    st.sessions.forEach((s, i) => {
      const room = { id: s.id, name: s.sector || s.project, path: s.cwd || '', slot: i, seed: hashStr(s.id), createdAt: s.startedAt || now };
      const fx = effects && effects.get(s.id);
      if (fx && fx.until > now) room.effect = { kind: 'party', text: fx.text, at: fx.at, until: fx.until, ...(fx.agentId ? { agentId: fx.agentId } : {}) };
      rooms.push(room);
      const leader = s.employees.find((e) => e.isLeader);
      for (const e of s.employees) {
        const p = e.persona || { name: 'Alguém', g: 'm', cargo: '', look: {} };
        const text = (e.say && (e.status === 'working' ? e.say.text : e.say.short)) || '';
        const last = e.statusSince || s.lastActivity || now;
        const a = {
          id: e.key,
          kind: e.isLeader ? 'main' : 'sub',
          roomId: s.id,
          name: p.name,
          look: p.g === 'f' ? 'f' : 'm',
          role: e.isLeader ? 'Líder do setor' : p.cargo || 'Subagente',
          title: e.isLeader ? s.title || s.project : e.description || undefined,
          sessionId: s.id,
          account: '.claude',
          status: STATUS[e.status] || 'idle',
          activity: activityOf(e, text, e.status === 'working' ? now : last),
          recent: [],
          tasks: [],
          startedAt: e.startedAt || s.startedAt || now,
          lastEventAt: last,
          statusSince: last,
          stats: { toolCalls: (e.stats && e.stats.tools) || 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
          seed: hashStr(e.key),
        };
        if (!e.isLeader && leader) a.parentId = leader.key;
        if (a.status === 'waiting') a.waitingFor = 'precisa de você';
        const look = p.look || {};
        const parts = {};
        if (/^#[0-9a-f]{6}$/i.test(look.skin || '')) parts.skin = look.skin.toLowerCase();
        if (/^#[0-9a-f]{6}$/i.test(look.hair || '')) parts.hair = look.hair.toLowerCase();
        if (look.glasses) parts.accessory = 'glasses';
        if (Object.keys(parts).length) a.parts = parts;
        agents.push(a);
      }
      // equipe fixa: fica à vista, parada ou passeando (café, sofá, pingue-pongue...), sem mexer na equipe real
      for (const r of s.residents || []) {
        const parts = {};
        if (/^#[0-9a-f]{6}$/i.test(r.look.skin || '')) parts.skin = r.look.skin.toLowerCase();
        if (/^#[0-9a-f]{6}$/i.test(r.look.hair || '')) parts.hair = r.look.hair.toLowerCase();
        if (r.look.glasses) parts.accessory = 'glasses';
        agents.push({
          id: r.key,
          kind: 'main',
          roomId: s.id,
          name: r.name,
          look: r.g === 'f' ? 'f' : 'm',
          role: r.cargo,
          sessionId: s.id,
          account: '.claude',
          status: 'idle',
          activity: { id: `${r.key}:0`, kind: 'other', icon: '💬', text: '', at: s.startedAt || now },
          recent: [],
          tasks: [],
          startedAt: s.startedAt || now,
          lastEventAt: s.startedAt || now,
          // no futuro de propósito: para o motor, ocioso há mais de 10 min cochila e para de passear
          statusSince: now + RESIDENT_AWAKE_MS,
          stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
          seed: hashStr(r.key),
          ...(Object.keys(parts).length ? { parts } : {}),
        });
      }
    });
    return { rev: 0, serverTime: now, rooms, agents, accounts: [], meta: { demo: false, sources: [], startedAt: now, version: 'hub' } };
  }

  /** Quem acabou de concluir (working/waiting -> done) vira uma festa de PARTY_MS na sala. */
  function trackParties(st, lastStatus, effects, now) {
    for (const s of st.sessions) {
      for (const e of s.employees) {
        const before = lastStatus.get(e.key);
        lastStatus.set(e.key, e.status);
        if (before && before !== 'done' && e.status === 'done') {
          const name = (e.persona && e.persona.name) || 'Alguém';
          effects.set(s.id, { text: `${name} concluiu!`, at: now, until: now + PARTY_MS, agentId: e.key });
        }
      }
    }
    for (const [id, fx] of effects) if (fx.until <= now) effects.delete(id);
  }

  /**
   * Monta o escritório num <canvas>. `cb`: { onAgent(key|null), onRoomMenu(sessionId, {x, y}) }.
   * Devolve null se o motor não carregou (o hub continua funcionando na visão Equipe).
   */
  function create(canvas, cb) {
    if (typeof HabblaudWorld === 'undefined') return null;
    const subs = new Set();
    const store = {
      snapshot: null,
      on(ev, fn) {
        if (ev === 'snapshot') subs.add(fn);
        return () => subs.delete(fn);
      },
      agent(id) {
        return this.snapshot && this.snapshot.agents.find((a) => a.id === id);
      },
      room(id) {
        return this.snapshot && this.snapshot.rooms.find((r) => r.id === id);
      },
    };
    const lastStatus = new Map();
    const effects = new Map();
    let rev = 0;
    let sig = '';
    let selected = null;
    let quiet = false; // seleção feita pelo hub: não devolve o evento ao hub
    const world = HabblaudWorld.createWorld(canvas, store);
    const savedTheme = (() => {
      try {
        return localStorage.getItem('officeTheme') || 'auto';
      } catch {
        return 'auto';
      }
    })();
    world.setOptions({ showNames: true, bubbles: 'important', liveliness: 'normal', followSelected: false, dayNight: true, theme: savedTheme });

    world.onSelect((sel) => {
      if (quiet) return;
      const key = sel && sel.type === 'agent' ? sel.id : null;
      if (sel && sel.type === 'room') return; // clicar no chão da sala só enquadra a câmera (duplo clique)
      selected = key;
      cb.onAgent(key);
    });
    if (world.onRoomContextMenu) world.onRoomContextMenu((id, at) => cb.onRoomMenu(id, at));

    return {
      world,
      update(st, now) {
        trackParties(st, lastStatus, effects, now);
        const snap = toSnapshot(st, effects, now);
        const s = JSON.stringify([snap.rooms, snap.agents.map((a) => [a.id, a.status, a.activity.text, a.name, a.roomId, a.parts])]);
        if (s === sig) return;
        sig = s;
        snap.rev = ++rev;
        store.snapshot = snap;
        subs.forEach((fn) => fn(snap));
      },
      /** Seleção feita fora do canvas (lista, feed, linha do tempo): destaca e leva a câmera. */
      select(key, focus) {
        if (key === selected) return;
        selected = key;
        quiet = true;
        try {
          world.select(key ? { type: 'agent', id: key } : null, { focus: !!(key && focus) });
        } finally {
          quiet = false;
        }
      },
      focusRoom: (id) => world.focusRoom(id),
      overview: () => world.overview(),
      zoomBy: (f) => world.zoomBy(f),
      setInsets: (i) => world.setViewInsets && world.setViewInsets(i),
      setTheme(t) {
        world.setOptions({ theme: t });
        try {
          localStorage.setItem('officeTheme', t);
        } catch {
          /* sem armazenamento */
        }
      },
      screenPositionOf: (key) => world.screenPositionOf(key),
      suspend: (v) => world.setSuspended && world.setSuspended(v),
    };
  }

  const api = { create, toSnapshot, trackParties, hashStr, PARTY_MS };
  if (typeof window !== 'undefined') window.HabBridge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
