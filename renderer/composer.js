'use strict';
/* Compositor do chat: caixa de texto com as mesmas ferramentas do painel do VS Code.
   - "+" anexa arquivo ou imagem (também por arrastar e soltar ou colar imagem);
   - "/" abre o menu de comandos (também ao digitar "/" no começo); "@" menciona arquivo do projeto;
   - seletor de modelo com esforço e Ultracode; seletor de modo (Shift+Tab alterna).
   Todo texto entra via textContent. As funções h/store/save/clipText vêm do app.js, usadas só depois que ele carregou. */

const Composer = (() => {
  const MODES = [
    { id: 'ask', icon: '‖', label: 'Manual', desc: 'O Claude pede aprovação antes de fazer edições' },
    { id: 'edit', icon: '</>', label: 'Editar automaticamente', desc: 'O Claude edita os arquivos sozinho; outros comandos ainda pedem' },
    { id: 'plan', icon: '≡', label: 'Planejar', desc: 'O Claude explora o código e apresenta um plano antes de editar' },
    { id: 'auto', icon: '»', label: 'Automático', desc: 'Aprova o que passa numa checagem de segurança e pausa no que for arriscado. Depende do modelo e da conta; se indisponível, o Claude Code usa Manual' },
  ];
  const EFFORTS = [['', 'Padrão'], ['low', 'Baixo'], ['medium', 'Médio'], ['high', 'Alto'], ['xhigh', 'Extra'], ['max', 'Máx.']];
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const MAX_IMAGES = 5;
  const MAX_FILES = 8;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const FALLBACK_MODELS = [{ id: '', label: 'Padrão (recomendado)', desc: 'O modelo padrão da sua conta', effort: true }];

  const pick = (list, v, d) => (list.some((x) => x === v) ? v : d);

  function create(api) {
    // api: { id(), title(), submit(text, opts) -> Promise<{error?}>, stop(), error(msg), exportChat() }
    let mode = pick(MODES.map((m) => m.id), store('chat-mode', 'ask'), 'ask');
    let model = store('chat-model', '');
    let effort = pick(EFFORTS.map((e) => e[0]), store('chat-effort', ''), '');
    let ultra = store('chat-ultra', '0') === '1';
    let models = FALLBACK_MODELS;
    let atts = [];
    let seq = 0;
    let busy = false;
    let blocked = false;
    let pop = null; // { kind, typed, items, index, build }
    let popEl = null;
    let cmdCache = { id: '', at: 0, list: [], sources: [] };
    let flashTimer = null;
    let mentionTimer = null;
    let mentionSeq = 0;
    let restoring = false; // trocando de conversa: não conta como o usuário mexendo no rascunho
    let hIdx = -1; // posição no histórico (↑/↓); -1 = escrevendo algo novo
    let hStash = ''; // o que estava digitado antes de começar a navegar

    /* ----------------------------------------------------------- elementos */
    const msgEl = h('div', { class: 'cmp-msg', role: 'status', hidden: '' });
    const attsEl = h('div', { class: 'cmp-atts', hidden: '' });
    const input = h('textarea', { class: 'chat-text', rows: '2', placeholder: 'Escreva para este departamento…', 'aria-label': 'Mensagem' });
    const plusBtn = h('button', { type: 'button', class: 'cmp-ic', title: 'Anexar arquivo ou adicionar contexto', 'aria-label': 'Anexar ou adicionar contexto', text: '+' });
    const slashBtn = h('button', { type: 'button', class: 'cmp-ic', title: 'Menu de comandos (/)', 'aria-label': 'Menu de comandos', text: '/' });
    const modelBtn = h('button', { type: 'button', class: 'cmp-pill', title: 'Modelo e esforço', 'aria-haspopup': 'true' });
    const modeBtn = h('button', { type: 'button', class: 'cmp-pill', title: 'Modo de permissão (Shift+Tab alterna)', 'aria-haspopup': 'true' });
    const sendBtn = h('button', { type: 'button', class: 'cmp-send', title: 'Enviar (Enter)', 'aria-label': 'Enviar', text: '↑' });
    const stopBtn = h('button', { type: 'button', class: 'cmp-stop', title: 'Parar a resposta', 'aria-label': 'Parar', text: '■', hidden: '' });
    const bar = h('div', { class: 'cmp-bar' }, plusBtn, slashBtn, modelBtn, h('span', { class: 'cmp-grow' }), modeBtn, sendBtn, stopBtn);
    const box = h('div', { class: 'cmp' }, input, bar);
    const hint = h('div', { class: 'chat-hint', text: 'Enter envia · Shift+Tab troca o modo · / comandos · @ arquivos' });
    const el = h('footer', { class: 'chat-foot' }, msgEl, attsEl, box, hint);

    /* ------------------------------------------------------------- estado */
    const modelInfo = () => models.find((m) => m.id === model) || models[0] || FALLBACK_MODELS[0];
    const modeInfo = () => MODES.find((m) => m.id === mode) || MODES[0];
    const effortName = () => (EFFORTS.find((e) => e[0] === effort) || EFFORTS[0])[1];

    function drawPills() {
      const mi = modelInfo();
      const short = mi.id === '' ? 'Padrão' : mi.label;
      let eff = '';
      if (mi.effort !== false) eff = ultra ? ' · Ultracode' : effort ? ` · ${effortName()}` : '';
      modelBtn.textContent = short + eff;
      modeBtn.textContent = `${modeInfo().icon} ${modeInfo().label}`;
      modeBtn.dataset.mode = mode;
    }

    function setMode(id) {
      mode = id;
      save('chat-mode', mode);
      drawPills();
    }
    function setModel(id) {
      model = id;
      save('chat-model', model);
      drawPills();
    }
    function setEffort(v) {
      effort = v;
      if (v && ultra) {
        ultra = false;
        save('chat-ultra', '0');
      }
      save('chat-effort', effort);
      drawPills();
    }
    function setUltra(on) {
      ultra = on;
      save('chat-ultra', on ? '1' : '0');
      if (on) {
        effort = 'xhigh'; // o Ultracode roda em esforço Extra
        save('chat-effort', effort);
      }
      drawPills();
    }
    function cycleMode() {
      const i = MODES.findIndex((m) => m.id === mode);
      setMode(MODES[(i + 1) % MODES.length].id);
      flash(`Modo: ${modeInfo().label}`, 1800);
    }

    function applyState() {
      sendBtn.hidden = busy;
      stopBtn.hidden = !busy;
      sendBtn.disabled = busy || blocked;
    }

    function flash(text, ms = 5000) {
      clearTimeout(flashTimer);
      msgEl.hidden = !text;
      msgEl.textContent = text || '';
      if (text) flashTimer = setTimeout(() => (msgEl.hidden = true), ms);
    }

    /* ------------------------------------------------------------- anexos */
    /** Avisa o chat para guardar o rascunho desta conversa (texto + anexos). */
    function notifyDraft() {
      if (!restoring && api.onDraft) api.onDraft({ text: input.value, atts: atts.slice() });
    }

    function drawAtts() {
      notifyDraft();
      attsEl.hidden = atts.length === 0;
      attsEl.replaceChildren(...atts.map((a) =>
        h('div', { class: `att att-${a.kind}`, title: a.path || a.name },
          a.kind === 'image' ? h('img', { src: `data:${a.mediaType};base64,${a.data}`, alt: '' }) : h('span', { class: 'att-ic', text: '▤' }),
          h('span', { class: 'att-n', text: clipText(a.name, 28) }),
          h('button', { type: 'button', class: 'att-x', 'aria-label': `Remover ${a.name}`, text: '✕', onclick: () => { atts = atts.filter((x) => x.id !== a.id); drawAtts(); } })
        )));
    }

    function addAtt(a) {
      if (a.kind === 'image' && atts.filter((x) => x.kind === 'image').length >= MAX_IMAGES) return flash(`No máximo ${MAX_IMAGES} imagens por mensagem.`);
      if (a.kind === 'file' && atts.filter((x) => x.kind === 'file').length >= MAX_FILES) return flash(`No máximo ${MAX_FILES} arquivos por mensagem.`);
      if (a.kind === 'file' && atts.some((x) => x.path === a.path)) return undefined;
      atts.push({ ...a, id: ++seq });
      drawAtts();
      return undefined;
    }

    function readImage(file) {
      return new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => {
          const m = /^data:([^;]+);base64,(.*)$/.exec(String(fr.result));
          resolve(m ? { mediaType: m[1], data: m[2] } : null);
        };
        fr.onerror = () => resolve(null);
        fr.readAsDataURL(file);
      });
    }

    async function handleFiles(files) {
      for (const f of Array.from(files)) {
        if (f.type.startsWith('image/')) {
          if (!IMAGE_TYPES.includes(f.type)) {
            flash('Use imagem PNG, JPEG, GIF ou WebP.');
            continue;
          }
          if (f.size > MAX_IMAGE_BYTES) {
            flash(`${f.name || 'Imagem'} passa de 5 MB.`);
            continue;
          }
          const r = await readImage(f);
          if (r) addAtt({ kind: 'image', name: f.name || 'imagem-colada.png', mediaType: r.mediaType, data: r.data, size: f.size });
        } else {
          const p = window.hub.pathOf(f);
          if (p) addAtt({ kind: 'file', name: f.name || p.split('/').pop(), path: p, size: f.size });
          else flash('Não consegui ler esse arquivo.');
        }
      }
    }

    async function pickFiles() {
      let list = [];
      try {
        list = await window.hub.chatPick();
      } catch {
        flash('Não consegui abrir o seletor de arquivos.');
      }
      for (const f of list || []) {
        if (f.error) flash(`${f.name}: ${f.error}`);
        else if (f.kind === 'image') addAtt({ kind: 'image', name: f.name, mediaType: f.mediaType, data: f.data, size: f.size });
        else addAtt({ kind: 'file', name: f.name, path: f.path, size: f.size });
      }
      input.focus();
    }

    /* ------------------------------------------------------------ popovers */
    function closePop() {
      clearTimeout(mentionTimer);
      mentionSeq++;
      if (popEl) popEl.remove();
      popEl = null;
      pop = null;
      document.removeEventListener('pointerdown', outside, true);
    }

    function outside(e) {
      if (popEl && !popEl.contains(e.target) && !box.contains(e.target)) closePop();
      else if (popEl && !popEl.contains(e.target) && ![plusBtn, slashBtn, modelBtn, modeBtn].some((b) => b.contains(e.target))) closePop();
    }

    function activate(i) {
      if (!pop) return;
      const it = pop.items[i];
      if (!it) return;
      const typed = pop.typed;
      if (typed === 'cmd' && !it.insert) input.value = '';
      const keep = it.keep;
      it.run();
      if (keep) renderPop();
      else if (pop && pop.items[i] === it) closePop();
      if (!keep && document.activeElement !== input && !it.noFocus) input.focus();
    }

    function move(d) {
      if (!pop || !pop.items.length) return;
      pop.index = (pop.index + d + pop.items.length) % pop.items.length;
      renderPop();
    }

    function popKeys(e) {
      if (!pop) return false;
      if (e.key === 'Escape') {
        e.preventDefault();
        closePop();
        input.focus();
        return true;
      }
      if (!pop.items.length) return false;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        move(1);
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        move(-1);
        return true;
      }
      if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        activate(pop.index);
        return true;
      }
      return false;
    }

    function effortControls() {
      const mi = modelInfo();
      const supports = mi.effort !== false;
      const seg = h('div', { class: 'eff-seg', role: 'group', 'aria-label': 'Esforço' },
        EFFORTS.map(([k, t]) => h('button', {
          type: 'button',
          class: `eff${(ultra ? 'xhigh' : effort) === k ? ' on' : ''}`,
          text: t,
          disabled: !supports,
          'aria-pressed': String((ultra ? 'xhigh' : effort) === k),
          onclick: () => {
            setEffort(k);
            renderPop();
          },
        })));
      const sw = h('button', {
        type: 'button',
        class: `tgl${ultra ? ' on' : ''}`,
        role: 'switch',
        'aria-checked': String(ultra),
        'aria-label': 'Ultracode',
        disabled: !supports,
        onclick: () => {
          setUltra(!ultra);
          renderPop();
        },
      }, h('i'));
      return h('div', { class: 'pop-extra' },
        h('div', { class: 'eff-row' }, h('span', { text: supports ? `Esforço (${ultra ? 'Extra' : effortName()})` : 'Esforço (indisponível neste modelo)' }), seg),
        h('div', { class: 'eff-row' },
          h('span', { text: 'Ultracode' }),
          h('span', { class: 'ds', text: 'Fluxos de trabalho dinâmicos em tarefas grandes (usa esforço Extra)' }),
          sw));
    }

    function renderPop() {
      if (!pop) return;
      const list = h('div', { class: 'pop-list', role: 'listbox' });
      let lastSec = null;
      pop.items.forEach((it, i) => {
        if (it.section && it.section !== lastSec) {
          lastSec = it.section;
          list.append(h('div', { class: 'pop-sec', text: it.section }));
        }
        list.append(h('button', {
          type: 'button',
          class: `pop-item${i === pop.index ? ' on' : ''}`,
          role: 'option',
          'aria-selected': String(i === pop.index),
          onpointerdown: (e) => e.preventDefault(), // não tira o foco da caixa de texto
          onclick: () => activate(i),
        },
        h('span', { class: 'ic', text: it.icon || '' }),
        h('span', { class: 'tx' }, h('span', { text: it.label }), it.desc ? h('span', { class: 'ds', text: it.desc }) : null),
        it.hint ? h('span', { class: 'hint', text: it.hint }) : null,
        it.check ? h('span', { class: 'ck', text: '✓' }) : null));
      });
      if (!pop.items.length) list.append(h('div', { class: 'pop-empty', text: (pop.emptyFn ? pop.emptyFn() : pop.empty) || 'Nada encontrado.' }));
      const kids = [];
      if (pop.filter) {
        const prev = popEl && popEl.querySelector('.pop-filter');
        const f = h('input', {
          type: 'text',
          class: 'pop-filter',
          placeholder: pop.filter,
          'aria-label': pop.filter,
          value: pop.filterValue || '',
          oninput: (e) => {
            pop.filterValue = e.target.value;
            pop.items = pop.build(pop.filterValue);
            pop.index = 0;
            renderPop();
            const nf = popEl.querySelector('.pop-filter');
            nf.focus();
            nf.setSelectionRange(nf.value.length, nf.value.length);
          },
          onkeydown: (e) => {
            popKeys(e);
          },
        });
        kids.push(f);
        if (!prev) setTimeout(() => f.isConnected && f.focus(), 0);
      }
      kids.push(list);
      if (pop.extras) kids.push(effortControls());
      const fresh = h('div', { class: `pop ${pop.cls || ''}`, role: 'dialog' }, kids);
      if (popEl) popEl.replaceWith(fresh);
      else box.append(fresh);
      popEl = fresh;
      const on = fresh.querySelector('.pop-item.on');
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
      const nf = fresh.querySelector('.pop-filter');
      if (nf && document.activeElement !== nf && pop.focusFilter !== false) nf.focus();
    }

    function openPop(config) {
      const wasSame = pop && pop.kind === config.kind && !config.typed;
      closePop();
      if (wasSame) return; // clicar de novo no mesmo botão fecha
      pop = { index: 0, ...config };
      pop.items = pop.build(pop.filterValue || '');
      document.addEventListener('pointerdown', outside, true);
      renderPop();
    }

    /* ----------------------------------------------------------- os menus */
    function plusMenu() {
      openPop({
        kind: 'plus',
        cls: 'sm',
        build: () => [
          { icon: '⇪', label: 'Anexar arquivo ou imagem…', run: () => pickFiles(), noFocus: true },
          { icon: '@', label: 'Mencionar arquivo do projeto…', run: () => startMention() },
        ],
      });
    }

    function modelMenu() {
      openPop({
        kind: 'model',
        extras: true,
        build: () => [
          ...models.map((m, i) => ({
            section: i === 0 ? 'Escolha o modelo' : null,
            label: m.label,
            desc: m.desc,
            check: m.id === model,
            keep: true,
            run: () => setModel(m.id),
          })),
        ],
      });
      pop.index = Math.max(0, models.findIndex((m) => m.id === model));
      renderPop();
    }

    function modeMenu() {
      openPop({
        kind: 'mode',
        cls: 'mode',
        extras: true,
        build: () => MODES.map((m, i) => ({
          section: i === 0 ? 'Modos' : null,
          icon: m.icon,
          label: m.label,
          desc: m.desc,
          check: m.id === mode,
          run: () => setMode(m.id),
        })),
      });
      pop.index = Math.max(0, MODES.findIndex((m) => m.id === mode));
      renderPop();
    }

    async function loadCommands() {
      const id = api.id();
      if (cmdCache.id === id && Date.now() - cmdCache.at < 15000) return cmdCache.list;
      let info = null;
      try {
        info = await window.hub.chatCommands(id);
      } catch {
        /* sem lista */
      }
      cmdCache = { id, at: Date.now(), list: info && Array.isArray(info.list) ? info.list : [], sources: info && Array.isArray(info.sources) ? info.sources : [] };
      return cmdCache.list;
    }

    function cmdItems(filter) {
      const q = String(filter || '').replace(/^\//, '').toLowerCase();
      const insertText = (t) => {
        input.value = t;
        input.focus();
        input.setSelectionRange(t.length, t.length);
      };
      const actions = [
        { section: 'Contexto', icon: '⇪', label: 'Anexar arquivo ou imagem…', run: () => pickFiles(), noFocus: true },
        { section: 'Contexto', icon: '@', label: 'Mencionar arquivo deste projeto…', run: () => startMention() },
        { section: 'Modelo', icon: '◇', label: 'Trocar modelo…', hint: modelInfo().id === '' ? 'Padrão' : modelInfo().label, run: () => setTimeout(modelMenu, 0), noFocus: true },
        { section: 'Modelo', icon: '◇', label: `Esforço (${ultra ? 'Extra' : effortName()})`, run: () => setTimeout(modelMenu, 0), noFocus: true },
        { section: 'Modelo', icon: '◇', label: 'Ultracode', hint: ultra ? 'ligado' : 'desligado', run: () => setUltra(!ultra), keep: true },
        { section: 'Modo', icon: modeInfo().icon, label: 'Trocar modo…', hint: modeInfo().label, run: () => setTimeout(modeMenu, 0), noFocus: true },
        { section: 'Conversa', icon: '⇩', label: 'Exportar conversa…', run: () => api.exportChat(), noFocus: true },
        { section: 'Conversa', icon: '/', label: 'Compactar conversa (/compact)', run: () => insertText('/compact '), insert: true },
      ];
      const cmds = cmdCache.list
        .filter((c) => c.name !== 'compact')
        .map((c) => ({ section: 'Comandos e skills', icon: '/', label: `/${c.name}`, hint: c.description, run: () => insertText(`/${c.name} `), insert: true }));
      return [...actions, ...cmds].filter((it) => !q || `${it.label} ${it.hint || ''}`.toLowerCase().includes(q));
    }

    function cmdMenu(typedFilter) {
      const typed = typedFilter != null;
      if (pop && pop.kind === 'cmd' && typed) {
        pop.filterValue = typedFilter;
        pop.items = pop.build(typedFilter);
        pop.index = Math.min(pop.index, Math.max(0, pop.items.length - 1));
        renderPop();
        return;
      }
      openPop({
        kind: 'cmd',
        typed: typed ? 'cmd' : null,
        filter: typed ? null : 'Filtrar ações…',
        filterValue: typed ? typedFilter : '',
        focusFilter: !typed,
        build: cmdItems,
        empty: 'Nenhum comando encontrado.',
        emptyFn: () => {
          const where = cmdCache.sources.map((x) => `${x.label}: ${x.count}`).join(' · ');
          return where ? `Nenhum comando encontrado. Procurei em ${where}.` : 'Nenhum comando encontrado.';
        },
      });
      loadCommands().then(() => {
        if (pop && pop.kind === 'cmd') {
          pop.items = pop.build(pop.filterValue || '');
          pop.index = Math.min(pop.index, Math.max(0, pop.items.length - 1));
          renderPop();
        }
      });
    }

    /* @menção */
    function startMention() {
      input.focus();
      const v = input.value;
      const c = input.selectionStart;
      const needsSpace = c > 0 && !/\s/.test(v[c - 1]);
      input.setRangeText(`${needsSpace ? ' ' : ''}@`, c, input.selectionEnd, 'end');
      onText();
    }

    function mentionMenu(query) {
      const my = ++mentionSeq;
      const render = (files, first) => {
        if (my !== mentionSeq) return;
        const items = files.map((f) => ({
          icon: '▤',
          label: f.split('/').pop(),
          hint: f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '',
          insert: true,
          run: () => {
            const before = input.value.slice(0, input.selectionStart);
            const m = /(^|\s)@([^\s@]*)$/.exec(before);
            if (!m) return;
            const start = before.length - m[2].length - 1;
            input.setRangeText(`@${f} `, start, input.selectionStart, 'end');
          },
        }));
        if (!pop || pop.kind !== 'mention') {
          closePop();
          pop = { kind: 'mention', typed: 'mention', index: 0, items, build: () => items, empty: first ? 'Procurando arquivos…' : 'Nenhum arquivo encontrado.' };
          document.addEventListener('pointerdown', outside, true);
        } else {
          pop.items = items;
          pop.index = Math.min(pop.index, Math.max(0, items.length - 1));
          pop.empty = 'Nenhum arquivo encontrado.';
        }
        renderPop();
      };
      if (!pop || pop.kind !== 'mention') render([], true);
      clearTimeout(mentionTimer);
      mentionTimer = setTimeout(async () => {
        let files = [];
        try {
          files = await window.hub.chatFiles(api.id(), query);
        } catch {
          /* sem lista */
        }
        render(Array.isArray(files) ? files : [], false);
      }, 110);
    }

    /* ------------------------------------------------------- digitação */
    function onText() {
      const v = input.value;
      const caret = input.selectionStart;
      const before = v.slice(0, caret);
      const slash = /^\/([\w:.-]*)$/.exec(before);
      const at = /(^|\s)@([^\s@]*)$/.exec(before);
      if (slash && !v.slice(caret).trim() && atts.length === 0) cmdMenu(slash[1]);
      else if (at) mentionMenu(at[2]);
      else if (pop && pop.typed) closePop();
    }

    /** ↑ / ↓ como no VS Code: volta pelas mensagens já enviadas nesta conversa. */
    function recall(dir) {
      const list = ((api.history && api.history()) || []).filter((t, i, a) => i === 0 || t !== a[i - 1]);
      if (dir < 0) {
        if (hIdx + 1 >= list.length) return false;
        if (hIdx < 0) hStash = input.value;
        hIdx += 1;
      } else {
        if (hIdx < 0) return false;
        hIdx -= 1;
      }
      input.value = hIdx < 0 ? hStash : list[list.length - 1 - hIdx];
      const end = input.value.length;
      input.setSelectionRange(end, end);
      notifyDraft();
      return true;
    }

    async function doSend() {
      if (busy || blocked) return;
      const text = input.value.trim();
      if (!text && !atts.length) return;
      sendBtn.disabled = true;
      const supports = modelInfo().effort !== false;
      const opts = {
        mode,
        model,
        effort: supports && !ultra ? effort : '',
        ultracode: supports && ultra,
        attachments: atts.map((a) => (a.kind === 'image' ? { kind: 'image', mediaType: a.mediaType, data: a.data } : { kind: 'file', path: a.path })),
      };
      let r;
      try {
        r = await api.submit(text, opts);
      } catch {
        r = { error: 'Não consegui falar com o hub.' };
      }
      if (r && r.error) {
        api.error(r.error);
        applyState();
        return;
      }
      input.value = '';
      atts = [];
      hIdx = -1;
      drawAtts();
      closePop();
      busy = true; // o próximo ciclo do chat confirma
      applyState();
    }

    /* ------------------------------------------------------------ eventos */
    plusBtn.addEventListener('click', plusMenu);
    slashBtn.addEventListener('click', () => cmdMenu(null));
    modelBtn.addEventListener('click', modelMenu);
    modeBtn.addEventListener('click', modeMenu);
    sendBtn.addEventListener('click', doSend);
    stopBtn.addEventListener('click', () => api.stop());
    input.addEventListener('input', () => {
      hIdx = -1;
      onText();
      notifyDraft();
    });
    input.addEventListener('keyup', (e) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) onText();
    });
    input.addEventListener('keydown', (e) => {
      if (popKeys(e)) return;
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        cycleMode();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        doSend();
        return;
      }
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
        const v = input.value;
        const a = input.selectionStart;
        const b = input.selectionEnd;
        if (a !== b) return;
        if (e.key === 'ArrowUp' && !v.slice(0, a).includes('\n') && (v === '' || a === 0 || hIdx >= 0)) {
          if (recall(-1)) e.preventDefault();
        } else if (e.key === 'ArrowDown' && hIdx >= 0 && !v.slice(b).includes('\n')) {
          if (recall(1)) e.preventDefault();
        }
      }
    });
    input.addEventListener('paste', (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length) {
        e.preventDefault();
        handleFiles(files);
      }
    });
    const dragOn = (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
        e.preventDefault();
        el.classList.add('drop');
      }
    };
    el.addEventListener('dragenter', dragOn);
    el.addEventListener('dragover', dragOn);
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drop');
    });
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault();
        handleFiles(e.dataTransfer.files);
      }
    });

    (async () => {
      try {
        const m = await window.hub.chatModels();
        if (Array.isArray(m) && m.length) {
          models = m;
          if (!models.some((x) => x.id === model)) model = '';
          drawPills();
        }
      } catch {
        /* fica com o modelo padrão */
      }
    })();

    drawPills();
    applyState();

    return {
      el,
      focus: () => input.focus(),
      /** Envia um texto pronto (ex.: o pedido de plano ao gerente) sem mexer no rascunho que está na caixa. */
      async sendText(text) {
        if (busy || blocked) {
          api.error(blocked ? 'Esse chat não pode receber mensagens agora.' : 'Esse chat ainda está respondendo. Espere ou clique em Parar.');
          return false;
        }
        const prev = input.value;
        const prevAtts = atts;
        input.value = text;
        atts = [];
        await doSend();
        const ok = input.value !== text;
        input.value = prev;
        atts = prevAtts;
        drawAtts();
        notifyDraft();
        return ok;
      },
      setPlaceholder: (t) => input.setAttribute('placeholder', t),
      setState(s) {
        busy = !!s.busy;
        blocked = !!s.blocked;
        applyState();
      },
      /** Troca de conversa: limpa rascunho, anexos e menus. */
      reset() {
        restoring = true;
        closePop();
        input.value = '';
        atts = [];
        hIdx = -1;
        drawAtts();
        flash('');
        restoring = false;
      },
      /** Devolve o rascunho guardado desta conversa (texto e anexos). */
      setDraft(d) {
        restoring = true;
        input.value = d && typeof d.text === 'string' ? d.text : '';
        atts = d && Array.isArray(d.atts) ? d.atts.slice() : [];
        hIdx = -1;
        drawAtts();
        restoring = false;
      },
      flash,
    };
  }

  return { create, MODES };
})();
