'use strict';
/* Cérebro: navegador do vault do Obsidian no painel lateral.
   Todo texto entra via textContent (nunca innerHTML). Só leitura aqui; abrir/editar é no Obsidian. */

const Vault = (() => {
  let el = null;
  let bodyEl = null;
  let titleEl = null;
  let subEl = null;
  let searchEl = null;
  let crumbEl = null;
  let footEl = null;
  let opened = false;
  let onClose = () => {};
  let info = null; // { on, exists, dir, name, overview }
  let mode = 'browse'; // browse | note | search
  let folder = '';
  let note = null; // nota aberta
  let backTo = 'browse';
  let searchTimer = null;
  let token = 0; // descarta respostas atrasadas

  const hub = () => window.hub;
  const ago = (ms) => {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return 'agora há pouco';
    if (s < 3600) return `${Math.round(s / 60)} min`;
    if (s < 86400) return `${Math.round(s / 3600)} h`;
    return `${Math.round(s / 86400)} d`;
  };

  /* ------------------------------------------------------ markdown simples */
  function inline(parent, text) {
    const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[\[[^\]\n]+\]\]|#[\p{L}][\p{L}\p{N}_/-]*)/gu;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith('`')) parent.append(h('code', { text: tok.slice(1, -1) }));
      else if (tok.startsWith('**')) parent.append(h('strong', { text: tok.slice(2, -2) }));
      else if (tok.startsWith('[[')) {
        const inner = tok.slice(2, -2);
        const [target, alias] = inner.split('|');
        const name = target.split('#')[0].trim();
        parent.append(h('a', { class: 'wl', href: '#', title: `Abrir ${name}`, text: (alias || target).trim(), onclick: (ev) => { ev.preventDefault(); gotoLink(name); } }));
      } else parent.append(h('span', { class: 'tag', text: tok }));
      last = m.index + tok.length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function renderMd(text) {
    const box = h('div', { class: 'rich note-text' });
    let body = text;
    const fm = body.match(/^---\n([\s\S]*?)\n---\n?/);
    if (fm) {
      box.append(h('pre', { class: 'code fm', text: fm[1] }));
      body = body.slice(fm[0].length);
    }
    const parts = body.split(/```[^\n]*\n?/);
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        box.append(h('pre', { class: 'code', text: part.replace(/\n$/, '') }));
        return;
      }
      let list = null;
      let listOrdered = false;
      const flush = () => {
        list = null;
      };
      for (const line of part.split('\n')) {
        const hd = line.match(/^(#{1,4})\s+(.*)$/);
        const li = line.match(/^\s*([-*]|\d+\.)\s+(?:\[( |x)\]\s+)?(.*)$/i);
        const bq = line.match(/^>\s?(.*)$/);
        if (!line.trim()) {
          flush();
        } else if (hd) {
          flush();
          const hx = h(`h${Math.min(hd[1].length + 2, 6)}`);
          inline(hx, hd[2]);
          box.append(hx);
        } else if (li) {
          const ordered = /\d/.test(li[1]);
          if (!list || ordered !== listOrdered) {
            list = h(ordered ? 'ol' : 'ul');
            listOrdered = ordered;
            box.append(list);
          }
          const item = h('li');
          if (li[2] !== undefined) item.append(h('span', { class: 'chk', text: li[2].toLowerCase() === 'x' ? '☑ ' : '☐ ' }));
          inline(item, li[3]);
          list.append(item);
        } else if (bq) {
          flush();
          const q = h('blockquote');
          inline(q, bq[1]);
          box.append(q);
        } else if (/^---+$/.test(line.trim())) {
          flush();
          box.append(h('hr'));
        } else {
          flush();
          const p = h('p');
          inline(p, line);
          box.append(p);
        }
      }
    });
    return box;
  }

  /* ------------------------------------------------------------- estrutura */
  function build() {
    if (el) return;
    titleEl = h('h2', { text: 'Cérebro' });
    subEl = h('div', { class: 'cs', text: '' });
    searchEl = h('input', { class: 'vault-search', type: 'search', placeholder: 'Buscar nas notas…', 'aria-label': 'Buscar nas notas', oninput: onSearch, spellcheck: 'false' });
    crumbEl = h('div', { class: 'vault-crumb' });
    bodyEl = h('div', { class: 'vault-body' });
    footEl = h('div', { class: 'vault-foot' });
    el = h('div', { class: 'chat vault' },
      h('div', { class: 'chat-head' },
        h('i', { class: 'brain-ico', 'aria-hidden': 'true' }),
        h('div', { class: 'ct' }, titleEl, subEl),
        h('button', { class: 'close', type: 'button', 'aria-label': 'Fechar Cérebro', text: '✕', onclick: close })),
      h('div', { class: 'vault-tools' }, searchEl, crumbEl),
      bodyEl,
      footEl);
  }

  function msg(text, ...extra) {
    return h('div', { class: 'vault-empty' }, h('p', { text }), ...extra);
  }

  function drawFoot() {
    const on = !!(info && info.on);
    footEl.replaceChildren(
      h('label', { class: 'vault-tgl', title: 'Quando ligado, os chats abertos por aqui enxergam o vault e leem/escrevem nele sem pedir aprovação (Bash e pastas com ponto continuam pedindo).' },
        h('input', { type: 'checkbox', checked: on, onchange: async (ev) => { await hub().setConfig({ vaultOn: ev.target.checked }); await refresh(); } }),
        h('span', { text: ' Chats do hub usam o Cérebro' })),
      h('button', { class: 'btn', type: 'button', text: 'Trocar pasta', onclick: async () => { const r = await hub().vaultPick(); if (r) { folder = ''; mode = 'browse'; await refresh(); } } }),
      h('div', { class: 'vault-hint', text: 'Vale para conversas iniciadas depois da mudança.' }));
  }

  async function refresh() {
    try {
      info = await hub().vaultInfo();
    } catch {
      info = null;
    }
    if (typeof Vault.onInfo === 'function') Vault.onInfo(info);
    draw();
  }

  function draw() {
    build();
    drawFoot();
    const ok = info && info.on && info.exists;
    subEl.textContent = info ? (info.exists ? `${info.name} · ${info.overview ? info.overview.total + ' notas' : info.dir}` : info.dir) : '';
    searchEl.disabled = !ok;
    if (!info) return bodyEl.replaceChildren(msg('Não consegui falar com o hub.'));
    if (!info.exists) {
      crumbEl.replaceChildren();
      return bodyEl.replaceChildren(msg(`Não achei o vault em ${info.dir}.`, h('button', { class: 'btn primary', type: 'button', text: 'Escolher a pasta do vault', onclick: async () => { if (await hub().vaultPick()) refresh(); } })));
    }
    if (!info.on) {
      crumbEl.replaceChildren();
      return bodyEl.replaceChildren(msg('O Cérebro está desligado para os chats do hub. Ligue abaixo para os agentes consultarem e escreverem nas notas.'));
    }
    if (mode === 'note' && note) return drawNote();
    if (mode === 'search') return;
    drawFolder();
  }

  function drawCrumb() {
    const parts = folder ? folder.split('/') : [];
    const items = [h('button', { class: 'crumb', type: 'button', text: info.name || 'Cérebro', onclick: () => go('') })];
    let acc = '';
    parts.forEach((p) => {
      acc = acc ? `${acc}/${p}` : p;
      const target = acc;
      items.push(h('span', { class: 'sep', text: '›' }), h('button', { class: 'crumb', type: 'button', text: p, onclick: () => go(target) }));
    });
    crumbEl.replaceChildren(...items);
  }

  async function drawFolder() {
    drawCrumb();
    const mine = ++token;
    const r = await hub().vaultList(folder);
    if (mine !== token || mode !== 'browse') return;
    if (!r || r.error) return bodyEl.replaceChildren(msg((r && r.error) || 'Não consegui abrir a pasta.'));
    if (!r.entries.length) return bodyEl.replaceChildren(msg('Pasta vazia.'));
    bodyEl.replaceChildren(h('ul', { class: 'vault-list' }, r.entries.map((e) => entryRow(e))));
  }

  function entryRow(e) {
    if (e.type === 'dir') {
      return h('li', null, h('button', { class: 'v-row dir', type: 'button', onclick: () => go(e.path) }, h('i', { class: 'v-ico dir', 'aria-hidden': 'true' }), h('span', { class: 'v-name', text: e.name })));
    }
    return h('li', null, h('button', { class: 'v-row', type: 'button', onclick: () => openNote(e.path, 'browse') }, h('i', { class: 'v-ico', 'aria-hidden': 'true' }), h('span', { class: 'v-name', text: e.name }), h('span', { class: 'v-time', text: ago(e.mtime) })));
  }

  function go(p) {
    folder = p;
    mode = 'browse';
    note = null;
    searchEl.value = '';
    draw();
  }

  async function openNote(p, from) {
    backTo = from || 'browse';
    const mine = ++token;
    const r = await hub().vaultRead(p);
    if (mine !== token) return;
    if (!r || r.error) {
      mode = 'browse';
      return bodyEl.replaceChildren(msg((r && r.error) || 'Não consegui abrir a nota.'));
    }
    note = r;
    mode = 'note';
    if (!opened) opened = true;
    draw();
  }

  function drawNote() {
    const dir = note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : '';
    crumbEl.replaceChildren(
      h('button', { class: 'crumb', type: 'button', text: '‹ Voltar', onclick: () => { if (backTo === 'search' && searchEl.value.trim().length >= 2) { mode = 'search'; runSearch(); } else go(dir); } }),
      h('span', { class: 'sep', text: dir || info.name }),
      h('span', { class: 'v-time', text: `mexida ${ago(note.mtime)}` }),
      h('button', { class: 'btn', type: 'button', text: 'Abrir no Obsidian', onclick: () => hub().vaultOpen(note.path) }));
    bodyEl.replaceChildren(
      h('div', { class: 'note-view' }, h('h3', { class: 'note-title', text: note.title }), renderMd(note.text), note.truncated ? h('p', { class: 'vault-hint', text: 'Nota muito grande: mostrando só o começo. Abra no Obsidian para ver tudo.' }) : null));
    bodyEl.scrollTop = 0;
  }

  /* ----------------------------------------------------------------- busca */
  function onSearch() {
    clearTimeout(searchTimer);
    const q = searchEl.value.trim();
    if (q.length < 2) {
      if (mode === 'search') go(folder);
      return;
    }
    searchTimer = setTimeout(() => {
      mode = 'search';
      runSearch();
    }, 220);
  }

  async function runSearch() {
    const q = searchEl.value.trim();
    crumbEl.replaceChildren(h('span', { class: 'sep', text: `Resultados para “${q}”` }));
    const mine = ++token;
    const r = await hub().vaultSearch(q);
    if (mine !== token || mode !== 'search') return;
    if (!r || r.error) return bodyEl.replaceChildren(msg((r && r.error) || 'A busca falhou.'));
    if (!r.results.length) return bodyEl.replaceChildren(msg('Nada encontrado.'));
    bodyEl.replaceChildren(h('ul', { class: 'vault-list' }, r.results.map((x) =>
      h('li', null, h('button', { class: 'v-row res', type: 'button', onclick: () => openNote(x.path, 'search') },
        h('i', { class: 'v-ico', 'aria-hidden': 'true' }),
        h('span', { class: 'v-main' }, h('span', { class: 'v-name', text: x.name }), h('span', { class: 'v-path', text: x.path }), x.snippet ? h('span', { class: 'v-snip', text: x.snippet }) : null))))));
  }

  /** [[link]] de uma nota: abre a nota de mesmo nome; se não achar, busca. */
  async function gotoLink(name) {
    const r = await hub().vaultSearch(name);
    const exact = r && r.results && r.results.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (exact) return openNote(exact.path, 'browse');
    searchEl.value = name;
    mode = 'search';
    runSearch();
  }

  /* ------------------------------------------------------------------- API */
  /** Abre o painel; com `path`, já mostra essa nota. */
  async function open(closeCb, path) {
    build();
    if (closeCb) onClose = closeCb;
    opened = true;
    await refresh();
    if (path) await openNote(path, 'browse');
    setTimeout(() => searchEl.focus(), 50);
  }

  function close() {
    opened = false;
    mode = 'browse';
    note = null;
    onClose();
  }

  return { get el() { build(); return el; }, open, close, refresh, isOpen: () => opened, onInfo: null };
})();
