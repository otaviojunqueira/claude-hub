'use strict';
/**
 * Personas dos agentes: nome, cargo, aparência e humor.
 * Tudo é determinístico: o mesmo tipo de agente (ou o mesmo projeto, no caso do líder)
 * sempre vira a mesma "pessoa". Nada aqui depende de dados externos.
 */
(function () {
  const FEM = ['Bia', 'Carla', 'Duda', 'Fernanda', 'Gabi', 'Helena', 'Isabela', 'Júlia', 'Larissa', 'Marina', 'Natália', 'Paula', 'Rafaela', 'Sofia', 'Tainá', 'Vera', 'Luana', 'Camila', 'Alice', 'Joana', 'Bianca', 'Clara', 'Débora', 'Elisa', 'Flávia', 'Graça', 'Irene', 'Jéssica', 'Kátia', 'Lívia', 'Mônica', 'Nina', 'Olívia', 'Patrícia', 'Renata', 'Sabrina', 'Talita', 'Úrsula', 'Valéria', 'Yasmin'];
  const MAS = ['Caio', 'Davi', 'Enzo', 'Felipe', 'Gustavo', 'Heitor', 'Igor', 'João', 'Léo', 'Mateus', 'Nando', 'Otto', 'Pedro', 'Rui', 'Tiago', 'Vitor', 'Bruno', 'André', 'Diego', 'Renato', 'Artur', 'Beto', 'Cauã', 'Danilo', 'Eduardo', 'Fábio', 'Guilherme', 'Hugo', 'Ícaro', 'Júnior', 'Kauê', 'Lucas', 'Murilo', 'Nelson', 'Orlando', 'Paulo', 'Rafael', 'Samuel', 'Theo', 'Wagner'];

  const SKIN = ['#f6d2b5', '#e8b48f', '#c98d63', '#a56a43', '#7b4a2e', '#5c3a24'];
  const HAIR = ['#1d1a1a', '#3a2418', '#6b4226', '#b07a3a', '#d9b25f', '#8a8f98', '#b4412f'];

  // Cargos conhecidos por tipo de agente: [feminino, masculino]. A primeira regra que casar vence.
  const ROLES = [
    { re: /^explore$|explor|search|scout/i, cargo: ['Batedora', 'Batedor'], color: '#3b82f6' },
    { re: /^plan$|plan|architect/i, cargo: ['Arquiteta', 'Arquiteto'], color: '#8b5cf6' },
    { re: /^general-purpose$|general/i, cargo: ['Faz-tudo', 'Faz-tudo'], color: '#f97316' },
    { re: /secur/i, cargo: ['Segurança', 'Segurança'], color: '#ef4444' },
    { re: /review/i, cargo: ['Revisora', 'Revisor'], color: '#14b8a6' },
    { re: /test|qa/i, cargo: ['QA', 'QA'], color: '#22c55e' },
    { re: /debug|bug|fix/i, cargo: ['Detetive de bugs', 'Detetive de bugs'], color: '#a16207' },
    { re: /doc|writ|redat/i, cargo: ['Redatora', 'Redator'], color: '#ec4899' },
    { re: /deploy|devops|infra/i, cargo: ['DevOps', 'DevOps'], color: '#64748b' },
    { re: /design|ui|ux/i, cargo: ['Designer', 'Designer'], color: '#d946ef' },
    { re: /statusline|config|setup/i, cargo: ['Configuradora', 'Configurador'], color: '#78716c' },
  ];
  const PALETTE = ['#0ea5e9', '#84cc16', '#e11d48', '#f59e0b', '#06b6d4', '#a855f7', '#10b981', '#f43f5e'];
  const LEADER_COLOR = '#1e3a8a';

  const MOODS = {
    working: { id: 'focus', label: 'Concentrado' },
    waiting: { id: 'alert', label: 'Precisa de você' },
    done: { id: 'happy', label: 'Missão cumprida' },
    error: { id: 'worried', label: 'Preocupado' },
    idle: { id: 'sleepy', label: 'Esperando ordens' },
    ended: { id: 'sleepy', label: 'Saiu do expediente' },
  };

  const TOOL_VERB = {
    Read: 'Lendo', Glob: 'Procurando arquivos', Grep: 'Buscando', LS: 'Listando',
    Edit: 'Editando', MultiEdit: 'Editando', Write: 'Escrevendo', NotebookEdit: 'Editando notebook',
    Bash: 'Rodando', BashOutput: 'Lendo saída', KillShell: 'Encerrando processo',
    WebFetch: 'Abrindo', WebSearch: 'Pesquisando na web', Task: 'Delegando', Agent: 'Delegando',
    TodoWrite: 'Organizando tarefas', ToolSearch: 'Procurando ferramenta', Skill: 'Usando skill',
  };

  const THINK_AFTER = {
    Read: 'Analisando o que leu…', Glob: 'Analisando o que encontrou…', Grep: 'Analisando o que encontrou…', LS: 'Analisando o que encontrou…',
    WebFetch: 'Analisando a página…', WebSearch: 'Analisando a pesquisa…', Edit: 'Conferindo a edição…', MultiEdit: 'Conferindo a edição…',
    Write: 'Conferindo o arquivo…', Bash: 'Lendo o resultado…', Task: 'Avaliando o que a equipe trouxe…', Agent: 'Avaliando o que a equipe trouxe…',
  };

  function hash(str) {
    let x = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      x ^= str.charCodeAt(i);
      x = Math.imul(x, 0x01000193) >>> 0;
    }
    return x >>> 0;
  }
  const pick = (arr, n) => arr[n % arr.length];

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.max(0, Math.min(255, v + amt));
    const r = f((n >> 16) & 255), g = f((n >> 8) & 255), b = f(n & 255);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  function humanize(type) {
    const t = String(type || 'agente').replace(/[-_]+/g, ' ').trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  // Nome e gênero são sorteados UMA vez por funcionário (chave = sessão + agente) e guardados.
  // Assim cada sessão nova traz gente nova, e ninguém troca de nome no meio do expediente.
  const names = new Map(); // key -> { name, g }
  const looks = new Map();

  function assign(list) {
    const used = new Set();
    for (const e of list) {
      const c = names.get(e.key);
      if (c) used.add(c.name);
    }
    for (const e of [...list].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0) || (a.key < b.key ? -1 : 1))) {
      if (names.has(e.key)) continue;
      const h = hash('n:' + e.key);
      const g = h % 2 ? 'f' : 'm';
      const pool = g === 'f' ? FEM : MAS;
      let name = null;
      for (let i = 0; i < pool.length; i++) {
        const cand = pool[(h >>> 3) + i < 0 ? 0 : ((h >>> 3) + i) % pool.length];
        if (!used.has(cand)) {
          name = cand;
          break;
        }
      }
      if (!name) name = `${pool[(h >>> 3) % pool.length]} ${String.fromCharCode(65 + ((h >>> 9) % 26))}.`; // acabaram os nomes livres
      used.add(name);
      names.set(e.key, { name, g });
    }
  }

  /** Fixa nomes já sorteados em outra tela (o celular usa os mesmos nomes do hub). */
  function preset(people) {
    for (const [key, v] of Object.entries(people || {})) {
      if (!names.has(key) && v && typeof v.name === 'string' && (v.g === 'f' || v.g === 'm')) names.set(key, { name: v.name.slice(0, 40), g: v.g });
    }
  }

  /** Persona de um funcionário. Chame assign() antes, com a lista de todos os visíveis. */
  function get(emp) {
    let p = looks.get(emp.key);
    if (p && p.type === emp.type) return p;
    const n = names.get(emp.key) || { name: 'Alguém', g: 'm' };
    const idx = n.g === 'f' ? 0 : 1;
    const h = hash('l:' + emp.key);
    let cargo, color;
    if (emp.isLeader) {
      cargo = 'Líder do setor';
      color = LEADER_COLOR;
    } else {
      const role = ROLES.find((r) => r.re.test(emp.type));
      cargo = role ? role.cargo[idx] : humanize(emp.type);
      color = role ? role.color : pick(PALETTE, h >>> 5);
    }
    const look = {
      skin: pick(SKIN, h >>> 7),
      hair: pick(HAIR, h >>> 11),
      style: n.g === 'f' ? pick([1, 1, 2, 3, 0], h >>> 13) : pick([0, 0, 4, 5, 3], h >>> 13),
      glasses: (h >>> 17) % 10 < 3,
    };
    p = { key: emp.key, type: emp.type, name: n.name, g: n.g, cargo, color, look, leader: !!emp.isLeader };
    looks.set(emp.key, p);
    return p;
  }

  function mood(status) {
    return MOODS[status] || MOODS.idle;
  }

  function shortPath(p) {
    const parts = String(p).split('/').filter(Boolean);
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : String(p);
  }

  /** O que a pessoa "diz" no balão, em português e em linguagem de gente. */
  function say(emp) {
    switch (emp.status) {
      case 'waiting': {
        let t = emp.currentAction || 'Preciso de uma permissão sua';
        const m = /needs your permission to use (\S+)/i.exec(t);
        if (m) t = `Preciso da sua permissão para usar ${m[1].replace(/\.$/, '')}`;
        return { text: t, short: 'Preciso de você!' };
      }
      case 'working': {
        if (!emp.kind || emp.kind === 'think') return { text: THINK_AFTER[emp.currentTool] || 'Pensando…', short: 'Pensando…' };
        const tool = emp.currentTool || '';
        let verb = TOOL_VERB[tool];
        if (!verb && tool.startsWith('mcp__')) verb = 'Usando ' + tool.split('__').pop();
        verb = verb || tool || 'Trabalhando';
        let detail = emp.currentDetail || '';
        if (detail && (emp.kind === 'read' || emp.kind === 'edit') && detail.includes('/')) detail = shortPath(detail);
        return { text: detail ? `${verb}: ${detail}` : `${verb}…`, short: verb };
      }
      case 'done':
        return { text: emp.lastMessage || 'Terminei!', short: 'Terminei!' };
      case 'error':
        return { text: emp.lastMessage || 'Algo deu errado.', short: 'Deu ruim' };
      case 'ended':
        return { text: 'Saiu do expediente.', short: 'Saiu' };
      default:
        return { text: emp.lastMessage || 'Aguardando a próxima tarefa.', short: 'Livre' };
    }
  }

  /** Avatar em SVG (viewBox 100x100). Trusted: só usa cores/constantes locais. */
  function avatar(p, moodId, size) {
    const { skin, hair, style, glasses } = p.look;
    const skinD = shade(skin, -18);
    const shirt = p.color;
    const ink = '#1b1b1f';
    const out = [];

    if (moodId === 'alert') {
      out.push(
        `<g class="hand-wave"><path d="M80 92 L87 66" stroke="${shirt}" stroke-width="12" stroke-linecap="round"/>` +
        `<path d="M87 66 L90 46" stroke="${skin}" stroke-width="8" stroke-linecap="round"/>` +
        `<circle cx="90" cy="40" r="8" fill="${skin}"/></g>`
      );
    }
    if (style === 1) out.push(`<path d="M26 40 C20 68 24 86 34 90 L66 90 C76 86 80 68 74 40Z" fill="${hair}"/>`);

    out.push(`<path d="M8 100 Q10 70 50 68 Q90 70 92 100Z" fill="${shirt}"/>`);
    out.push(`<path d="M8 100 Q10 70 50 68 Q90 70 92 100Z" fill="none" stroke="${shade(shirt, -30)}" stroke-width="1.5"/>`);
    if (p.leader) {
      out.push(`<path d="M38 68 L50 82 L62 68Z" fill="#f2f2f2"/><path d="M47 74 L53 74 L55 96 L50 100 L45 96Z" fill="#b3261e"/>`);
    } else {
      out.push(`<rect x="60" y="82" width="15" height="11" rx="2" fill="#fff"/><rect x="62" y="84" width="6" height="3" fill="${shade(shirt, -25)}"/>`);
    }
    out.push(`<rect x="43" y="56" width="14" height="16" rx="5" fill="${skinD}"/>`);
    out.push(`<circle cx="29" cy="44" r="4.2" fill="${skin}"/><circle cx="71" cy="44" r="4.2" fill="${skin}"/>`);
    out.push(`<ellipse cx="50" cy="42" rx="21" ry="24" fill="${skin}"/>`);

    // cabelo (frente)
    const top = `<path d="M28 42 C26 20 40 13 50 13 C62 13 76 20 72 42 C68 32 62 27 50 27 C38 27 32 32 28 42Z" fill="${hair}"/>`;
    if (style === 3) {
      out.push(
        [[32, 26, 9], [41, 19, 9], [50, 16, 9.5], [59, 19, 9], [68, 26, 9], [28, 37, 7], [72, 37, 7]]
          .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${hair}"/>`).join('')
      );
    } else if (style === 5) {
      out.push(`<path d="M29 38 C30 22 42 18 50 18 C58 18 70 22 71 38 C66 28 60 24 50 24 C40 24 34 28 29 38Z" fill="${hair}" opacity=".6"/>`);
    } else {
      out.push(top);
      if (style === 2) out.push(`<circle cx="50" cy="11" r="9" fill="${hair}"/>`);
      if (style === 4) {
        const cap = shade(shirt, -10);
        out.push(`<path d="M27 33 C28 12 72 12 73 33Z" fill="${cap}"/><path d="M46 32 L84 32 Q87 38 80 39 L46 39Z" fill="${shade(cap, -25)}"/>`);
      }
    }

    // rosto
    const eyeL = 41, eyeR = 59, eyeY = 45;
    const stroke = (d, w = 2.4) => `<path d="${d}" stroke="${ink}" stroke-width="${w}" stroke-linecap="round" fill="none"/>`;
    switch (moodId) {
      case 'alert':
        out.push(
          [eyeL, eyeR].map((x) => `<circle cx="${x}" cy="${eyeY}" r="4.4" fill="#fff"/><circle class="eye" cx="${x}" cy="${eyeY}" r="2.2" fill="${ink}"/>`).join('') +
          stroke('M35 35 Q41 31 46 34') + stroke('M65 35 Q59 31 54 34') +
          `<ellipse cx="50" cy="59" rx="3.6" ry="4.6" fill="#5b1d1d"/>`
        );
        break;
      case 'happy':
        out.push(stroke('M36 47 Q41 40 46 47', 2.6) + stroke('M54 47 Q59 40 64 47', 2.6) + `<path d="M40 54 Q50 68 60 54Z" fill="#7a2a2a"/>`);
        break;
      case 'worried':
        out.push(
          [eyeL, eyeR].map((x) => `<circle class="eye" cx="${x}" cy="${eyeY}" r="2.6" fill="${ink}"/>`).join('') +
          stroke('M35 41 L46 36') + stroke('M65 41 L54 36') + stroke('M42 61 Q50 54 58 61') +
          `<path class="sweat" d="M75 26 q-5 9 0 12 q5 -3 0 -12z" fill="#7cc4ff"/>`
        );
        break;
      case 'sleepy':
        out.push(
          stroke('M36 46 Q41 50 46 46') + stroke('M54 46 Q59 50 64 46') + stroke('M45 59 Q50 61 55 59', 2) +
          `<text class="zzz z1" x="70" y="26" font-size="13" font-weight="700" fill="#9aa4b8">z</text>` +
          `<text class="zzz z2" x="79" y="15" font-size="10" font-weight="700" fill="#9aa4b8">z</text>`
        );
        break;
      default: // focus
        out.push(
          [eyeL, eyeR].map((x) => `<circle class="eye" cx="${x}" cy="${eyeY}" r="2.6" fill="${ink}"/>`).join('') +
          stroke('M36 38.5 Q41 37 46 38.5') + stroke('M54 38.5 Q59 37 64 38.5') + stroke('M45 58 Q50 59.5 55 58', 2.2)
        );
    }
    if (glasses) {
      out.push(`<g fill="none" stroke="#222" stroke-width="2"><circle cx="${eyeL}" cy="${eyeY}" r="7.6"/><circle cx="${eyeR}" cy="${eyeY}" r="7.6"/><path d="M48.6 45 H51.4"/></g>`);
    }

    return `<svg class="avsvg mood-${moodId}" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-hidden="true">${out.join('')}</svg>`;
  }

  // Equipe fixa: gente que mora no departamento e fica passeando enquanto ninguém trabalha.
  const RES_ROLES = [['Analista', 'Analista'], ['Estagiária', 'Estagiário'], ['Dev', 'Dev'], ['Designer', 'Designer'], ['Suporte', 'Suporte'], ['QA', 'QA'], ['Revisora', 'Revisor'], ['Redatora', 'Redator']];

  /**
   * Residente `i` do departamento `sid`. Determinístico (mesmo departamento, mesma equipe).
   * `taken`: Set de nomes já usados no departamento; o nome escolhido é acrescentado a ele.
   */
  function resident(sid, i, taken) {
    const h = hash(`r:${sid}:${i}`);
    const g = h % 2 ? 'f' : 'm';
    const pool = g === 'f' ? FEM : MAS;
    let name = null;
    for (let k = 0; k < pool.length; k++) {
      const cand = pool[((h >>> 3) + k) % pool.length];
      if (!taken.has(cand)) {
        name = cand;
        break;
      }
    }
    if (!name) name = `${pool[(h >>> 3) % pool.length]} ${String.fromCharCode(65 + ((h >>> 9) % 26))}.`;
    taken.add(name);
    const role = RES_ROLES[(h >>> 12) % RES_ROLES.length][g === 'f' ? 0 : 1];
    return {
      key: `res:${sid}:${i}`,
      name,
      g,
      cargo: role,
      look: { skin: pick(SKIN, h >>> 7), hair: pick(HAIR, h >>> 11), glasses: (h >>> 17) % 10 < 3 },
    };
  }

  window.Persona = { assign, preset, get, mood, say, avatar, resident };
})();
