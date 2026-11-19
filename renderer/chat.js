'use strict';
/* Chat do departamento: conversa com a sessão do Claude Code pelo hub.
   Todo texto entra via textContent (nunca innerHTML); o único innerHTML do app continua sendo o SVG dos avatares. */

const Chat = (() => {
  const NOTE_KEY = 'chat-note-ok';

  const drafts = new Map(); // conversa -> { text, atts }: o que foi digitado e ainda não enviado (compartilhado entre os painéis)

  /* ---------------------------------------------------------- texto rico */
  /** Botão "Copiar" que mostra "Copiado" por um instante. */
  function copyBtn(cls, label, getText) {
    const btn = h('button', { type: 'button', class: cls, text: label, title: 'Copiar para a área de transferência' });
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      try {
        await window.hub.copyText(getText());
        btn.textContent = 'Copiado ✓';
      } catch {
        btn.textContent = 'Não copiou';
      }
      clearTimeout(btn._t);
      btn._t = setTimeout(() => {
        btn.textContent = label;
      }, 1500);
    });
    return btn;
  }

  /** Texto corrido: `código`, **negrito**, *itálico* e [link](endereço) (o link só mostra o endereço ao passar o mouse). */
  function inline(parent, text) {
    const re = /(`[^`\n]+`|\*\*[^*\n]+?\*\*|\[[^\]\n]+\]\([^)\s]+\)|(?<![\w*])\*[^\s*][^*\n]*?[^\s*]\*(?![\w*])|(?<![\w*])\*[^\s*]\*(?![\w*]))/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith('`')) parent.append(h('code', { text: tok.slice(1, -1) }));
      else if (tok.startsWith('**')) {
        const b = h('strong');
        inline(b, tok.slice(2, -2));
        parent.append(b);
      } else if (tok.startsWith('[')) {
        const k = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
        parent.append(h('span', { class: 'lnk', title: k[2], text: k[1] }));
      } else parent.append(h('em', { text: tok.slice(1, -1) }));
      last = m.index + tok.length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  const LI = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/;
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  /** Markdown simples em blocos bem separados: títulos, listas (com subitens), tabelas, citações e código. */
  function rich(text) {
    const box = h('div', { class: 'rich' });
    const lines = String(text).replace(/\r/g, '').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }
      // bloco de código
      const fence = /^\s*```\s*([\w+#.-]*)/.exec(line);
      if (fence) {
        const body = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
        i += 1;
        const code = body.join('\n');
        box.append(h('div', { class: 'codeblock' },
          h('div', { class: 'code-head' }, h('span', { class: 'code-lang', text: fence[1] || 'código' }), copyBtn('code-copy', 'Copiar', () => code)),
          h('pre', { class: 'code', text: code })));
        continue;
      }
      // título
      const hd = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (hd) {
        const t = h('div', { class: `rh rh${Math.min(hd[1].length, 3)}`, role: 'heading', 'aria-level': String(hd[1].length) });
        inline(t, hd[2]);
        box.append(t);
        i += 1;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        box.append(h('hr'));
        i += 1;
        continue;
      }
      // linha só em negrito = título de seção (ex.: "**O que a saída mostra**")
      const sec = /^\s*\*\*([^*]+?)\*\*\s*:?\s*$/.exec(line);
      if (sec) {
        const t = h('div', { class: 'rsec' });
        t.textContent = sec[1].replace(/:\s*$/, '');
        box.append(t);
        i += 1;
        continue;
      }
      // tabela
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        const td = (tag, c) => {
          const e = h(tag);
          inline(e, c);
          return e;
        };
        box.append(h('div', { class: 'rtable' }, h('table', null,
          h('thead', null, h('tr', null, head.map((c) => td('th', c)))),
          h('tbody', null, rows.map((r) => h('tr', null, head.map((_, k) => td('td', r[k] || ''))))))));
        continue;
      }
      // citação
      if (/^\s*>/.test(line)) {
        const q = h('blockquote');
        let first = true;
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          if (!first) q.append(h('br'));
          first = false;
          inline(q, lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        box.append(q);
        continue;
      }
      // lista (itens seguidos, com subitens pela indentação)
      if (LI.test(line)) {
        const root = h('div', { class: 'rlist' });
        const stack = []; // { indent, el, ordered }
        let lastLi = null;
        while (i < lines.length && (LI.test(lines[i]) || (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && lastLi && !fenceStart(lines[i])))) {
          const m = LI.exec(lines[i]);
          if (!m) {
            // continuação do item anterior (linha recuada)
            lastLi.append(h('br'));
            inline(lastLi, lines[i].trim());
            i += 1;
            continue;
          }
          const indent = m[1].replace(/\t/g, '  ').length;
          const ordered = /\d/.test(m[2]);
          while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
          let top = stack[stack.length - 1];
          if (!top || indent > top.indent || top.ordered !== ordered) {
            if (top && indent === top.indent) stack.pop();
            const list = h(ordered ? 'ol' : 'ul');
            if (!stack.length) root.append(list);
            else (lastLi || stack[stack.length - 1].el).append(list);
            top = { indent, el: list, ordered };
            stack.push(top);
          }
          lastLi = h('li');
          inline(lastLi, m[3]);
          top.el.append(lastLi);
          i += 1;
        }
        box.append(root);
        continue;
      }
      // parágrafo: linhas seguidas até algo de outro tipo
      const p = h('p');
      let k = 0;
      while (i < lines.length && lines[i].trim() && !fenceStart(lines[i]) && !(k > 0 && (LI.test(lines[i]) || /^\s{0,3}#{1,6}\s/.test(lines[i]) || /^\s*>/.test(lines[i]) || /^\s*\*\*[^*]+?\*\*\s*:?\s*$/.test(lines[i])))) {
        if (k) p.append(h('br'));
        inline(p, lines[i].trim());
        i += 1;
        k += 1;
      }
      box.append(p);
    }
    return box;
  }
  const fenceStart = (l) => /^\s*```/.test(l);

  /* ------------------------------------------------- painel de chat (uma instância por coluna) */
  function createPane(popts = {}) {
    let ctx = null; // { id, sector, title, project, status, leader }
    let rev = undefined;
    let messages = [];
    let st = { busy: false, pending: [], blocked: null, error: null, running: false, mode: 'ask' };
    let timer = null;
    let polling = false;
    let wantPoll = false;
    let seenPending = new Set();
    let headSig = '';
    let lastId = null; // última conversa aberta (para limpar rascunho ao trocar)
    let pickMode = false;
    let pickEl = null;
    let localErr = ''; // erro de envio (ex.: arquivo inválido): fica até a próxima tentativa
    let onClose = () => {};
    let splitOn = false;

    /* -------------------------------------------------------------- elementos */
    // Montados na primeira abertura: app.js (que define h, avatarEl...) carrega depois deste arquivo.
    let headEl, noteEl, listEl, pendEl, blockEl, errEl, composer, el;

    function build() {
      if (el) return;
      headEl = h('header', { class: 'chat-head' });
      noteEl = h('div', { class: 'chat-note' });
      listEl = h('div', { class: 'chat-list', role: 'log', 'aria-live': 'polite' });
      pendEl = h('div', { class: 'chat-pending' });
      blockEl = h('div', { class: 'chat-block', hidden: '' });
      errEl = h('div', { class: 'chat-err', role: 'alert', hidden: '' });
      composer = Composer.create({
        id: () => (ctx ? ctx.id : ''),
        title: () => (ctx ? ctx.title : ''),
        submit: async (text, opts) => {
          if (!ctx) return { error: 'Nenhuma conversa aberta.' };
          const r = await window.hub.chatSend(ctx.id, text, opts);
          localErr = r && r.error ? r.error : '';
          if (!r || !r.error) {
            listEl.dataset.fresh = '1';
            poll();
          } else drawState();
          return r;
        },
        stop: () => ctx && window.hub.chatStop(ctx.id).then(poll),
        error: (msg) => {
          localErr = msg;
          drawState();
        },
        onDraft: (d) => {
          if (!ctx) return;
          if (d.text || d.atts.length) drafts.set(ctx.id, d);
          else drafts.delete(ctx.id);
          save(`draft:${ctx.id}`, d.text.length > 20000 ? '' : d.text); // o texto sobrevive a fechar o hub; anexos só enquanto aberto
        },
        history: () =>
          messages
            .filter((m) => m.role === 'user' && m.kind === 'text' && typeof m.text === 'string' && m.text.trim() && !/^\[(Pergunta do departamento|Tarefa delegada)/.test(m.text))
            .map((m) => m.text)
            .slice(-60),
        exportChat: async () => {
          if (!ctx) return;
          const f = await window.hub.chatExport(ctx.id, ctx.title);
          if (f) composer.flash(`Conversa salva em ${f}`, 8000);
        },
      });
      el = h('div', { class: 'chat' }, headEl, noteEl, listEl, pendEl, blockEl, errEl, composer.el);
    if (popts.onFocus) el.addEventListener('focusin', () => popts.onFocus());
    if (popts.onFocus) el.addEventListener('pointerdown', () => popts.onFocus(), true);
    }

    function drawNote() {
      if (store(NOTE_KEY, '0') === '1' || (ctx && ctx.draft)) {
        noteEl.hidden = true;
        return;
      }
      noteEl.hidden = false;
      noteEl.replaceChildren(
        h('span', { text: 'Converse com este departamento só por aqui ou só pelo VS Code, um de cada vez. Para voltar ao VS Code depois, reabra a conversa (/resume) para ela carregar o que foi dito aqui.' }),
        h('button', { type: 'button', class: 'btn', text: 'Entendi', onclick: () => { save(NOTE_KEY, '1'); drawNote(); } })
      );
    }

    function drawHead() {
      if (!ctx) return;
      const sig = JSON.stringify([ctx.draft, ctx.sector, ctx.title, ctx.project, ctx.status, ctx.leader && ctx.leader.persona.key, ctx.leader && ctx.leader.mood.id, st.vault || null, splitOn, !!popts.second, !!ctx.manager]);
      if (sig === headSig) return;
      headSig = sig;
      headEl.replaceChildren(...[
        ctx.leader ? avatarEl(ctx.leader, 44) : null,
        h('div', { class: 'ct' },
          h('h2', { text: ctx.sector, title: ctx.sector }),
          h('div', { class: 'cs', text: ctx.title, title: `${ctx.title} · Projeto ${ctx.project}` })
        ),
        st.vault ? h('button', { class: 'vault-chip', type: 'button', title: `Este chat enxerga o Cérebro (${st.vault}) e lê/escreve nas notas sem pedir aprovação. Clique para abrir as notas.`, text: 'Cérebro', onclick: () => openVault() }) : null,
        ctx.manager ? h('button', { class: 'mgr-chip', type: 'button', title: 'Este é o gerente do Escritório: decide sozinho o que delegar e monta o plano para você aprovar. Clique para pedir um plano agora.', text: 'Gerente · montar plano', onclick: () => popts.onPlan && popts.onPlan(ctx.id) }) : null,
        h('span', { class: `pill s-${ctx.status}`, text: ctx.draft ? 'Novo' : STATUS_LABEL[ctx.status] || ctx.status }),
        !splitOn && popts.onSplit ? h('button', { class: 'chat-split', type: 'button', title: 'Abrir outro departamento ao lado, em duas colunas', text: 'Dividir', onclick: () => popts.onSplit() }) : null,
        h('button', { class: 'close', type: 'button', 'aria-label': popts.second ? 'Fechar a coluna' : 'Fechar conversa', title: popts.second ? 'Fechar esta coluna' : 'Fechar conversa', text: '✕', onclick: close })
      ].filter(Boolean));
    }

    function drawMessages() {
      const near = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80;
      const leaderName = ctx && ctx.leader ? ctx.leader.persona.name : 'Agente';
      const rows = messages.map((m) => {
        if (m.kind === 'tool') return h('div', { class: 'cm tool' }, h('span', { text: m.text }));
        if (m.kind === 'note') return h('div', { class: 'cm note' }, h('span', { text: m.text }));
        if (m.role === 'user') return h('div', { class: 'cm user' }, h('div', { class: 'bubble-u' }, rich(m.text)), h('time', { text: clockShort(m.ts) }));
        return h('div', { class: `cm bot${m.kind === 'error' ? ' bad' : ''}` },
          h('div', { class: 'who', text: leaderName }),
          h('div', { class: 'bubble-a' }, rich(m.text)),
          h('div', { class: 'cm-meta' }, h('time', { text: clockShort(m.ts) }), copyBtn('cm-copy', 'Copiar resposta', () => m.text)));
      });
      if (st.busy && st.pending.length === 0) rows.push(h('div', { class: 'cm think' }, h('i'), h('i'), h('i'), h('span', { text: 'trabalhando…' })));
      if (!rows.length) rows.push(h('div', { class: 'chat-empty', text: ctx && ctx.draft ? `Novo departamento em ${ctx.project}. Escreva abaixo a primeira mensagem para abrir a sala.` : 'Ainda não há mensagens nesta conversa.' }));
      listEl.replaceChildren(...rows);
      if (near || listEl.dataset.fresh !== '0') {
        listEl.scrollTop = listEl.scrollHeight;
        listEl.dataset.fresh = '0';
      }
    }

    function drawState() {
      // permissões (só refaz quando a lista muda, para não perder a rolagem do texto que você está lendo)
      const pendSig = st.pending.map((p) => p.id).join(',');
      if (pendEl.dataset.drawn !== pendSig) pendEl.replaceChildren(...st.pending.map((p) =>
        h('div', { class: `perm${p.kind === 'plan' ? ' plan' : ''}` },
          h('div', { class: 'perm-t' }, h('b', { text: p.tool }), p.kind === 'plan' ? ' aguarda a sua aprovação' : p.kind === 'office' ? ' pede a sua aprovação' : ' pede permissão'),
          p.description ? h('div', { class: 'perm-d', text: p.description }) : null,
          h('pre', { class: 'code', text: p.detail }),
          h('div', { class: 'perm-a' },
            h('button', { type: 'button', class: 'btn danger', text: 'Negar', onclick: () => decide(p.id, 'deny') }),
            h('button', { type: 'button', class: 'btn primary', text: p.kind === 'plan' ? 'Aprovar plano' : 'Aprovar', onclick: () => decide(p.id, 'allow') }))
        )));
      pendEl.dataset.drawn = pendSig;
      for (const p of st.pending) {
        if (!seenPending.has(p.id)) {
          seenPending.add(p.id);
          if (config && config.sound) beep('waiting');
        }
      }
      blockEl.hidden = !st.blocked;
      blockEl.textContent = st.blocked || '';
      errEl.hidden = !(localErr || st.error);
      errEl.textContent = localErr || st.error || '';
      composer.setState({ busy: st.busy, blocked: !!st.blocked });
    }

    /* --------------------------------------------------------------- ações */
    async function decide(id, behavior) {
      if (!ctx) return;
      await window.hub.chatDecide(ctx.id, id, behavior);
      poll();
    }

    async function poll() {
      if (!ctx) return;
      if (polling) {
        wantPoll = true;
        return;
      }
      polling = true;
      const sid = ctx.id;
      try {
        const r = await window.hub.chatPoll(sid, rev);
        if (ctx && ctx.id === sid) {
          st = r.state;
          if (r.messages) {
            messages = r.messages;
            rev = r.rev;
          }
          if (r.messages || st.busy || st.pending.length) drawMessages();
          drawHead();
          drawState();
        }
      } catch {
        /* hub ocupado: tenta no próximo ciclo */
      }
      polling = false;
      if (wantPoll) {
        wantPoll = false;
        poll();
      }
    }


    /* ------------------------------------------------- novo departamento: escolher o projeto */
    function drawPick(projects, onChoose, closeCb) {
      const errBox = h('div', { class: 'chat-err', role: 'alert', hidden: '' });
      const choose = async (p) => {
        errBox.hidden = true;
        const msg = await onChoose(p);
        if (msg) {
          errBox.hidden = false;
          errBox.textContent = msg;
        }
      };
      const items = projects.map((p) => h('button', { type: 'button', class: 'pick-item', title: p.cwd, onclick: () => choose(p) },
        h('strong', { text: p.project || p.cwd.split('/').pop() }),
        h('span', { text: clipText(p.cwd, 64) })));
      const other = h('button', {
        type: 'button',
        class: 'pick-item other',
        onclick: async () => {
          const f = await window.hub.chatPickFolder();
          if (f) choose(f);
        },
      }, h('strong', { text: 'Escolher outra pasta…' }), h('span', { text: 'Qualquer pasta do seu computador' }));
      pickEl = h('div', { class: 'chat pick' },
        h('header', { class: 'chat-head' },
          h('div', { class: 'ct' }, h('h2', { text: 'Novo departamento' }), h('div', { class: 'cs', text: 'Em qual projeto ele vai trabalhar?' })),
          h('button', { class: 'close', type: 'button', 'aria-label': 'Fechar', text: '✕', onclick: () => { pickMode = false; closeCb(); } })),
        h('div', { class: 'pick-list' },
          projects.length ? h('div', { class: 'pick-sec', text: 'Projetos que o hub já viu' }) : h('div', { class: 'chat-empty', text: 'O hub ainda não viu nenhum projeto. Escolha uma pasta.' }),
          items, other),
        errBox);
    }

    /** Abre a escolha de projeto. `onChoose(projeto)` devolve uma mensagem de erro ou nada. */
    function openPick(projects, onChoose, closeCb) {
      build();
      clearInterval(timer);
      timer = null;
      ctx = null;
      rev = undefined;
      messages = [];
      headSig = '';
      pickMode = true;
      onClose = closeCb;
      drawPick(projects, onChoose, closeCb);
    }

    function start() {
      clearInterval(timer);
      timer = setInterval(poll, 1000);
    }

    function open(context, closeCb) {
      build();
      if (ctx && ctx.id !== context.id) {
        rev = undefined;
        messages = [];
        seenPending = new Set();
        headSig = '';
        localErr = '';
      }
      if (lastId !== context.id) {
        // cada conversa guarda o seu rascunho: ao voltar, o que estava digitado continua lá
        composer.setDraft(drafts.get(context.id) || { text: store(`draft:${context.id}`, ''), atts: [] });
        localErr = '';
      }
      lastId = context.id;
      pickMode = false;
      ctx = context;
      composer.setPlaceholder(context.draft ? 'Primeira mensagem do departamento…' : 'Escreva para este departamento…');
      if (closeCb) onClose = closeCb;
      listEl.dataset.fresh = '1';
      drawNote();
      drawHead();
      drawMessages();
      start();
      poll();
      setTimeout(() => composer.focus(), 50);
    }

    /** Fecha o painel (a conversa continua viva em segundo plano até ficar parada). */
    function close() {
      pickMode = false;
      clearInterval(timer);
      timer = null;
      ctx = null;
      rev = undefined;
      messages = [];
      headSig = '';
      onClose();
    }

    /** Atualiza título/nome/status quando o hub renderiza de novo. Retorna false se a sessão sumiu. */
    function update(context) {
      if (!ctx) return true;
      if (!context) {
        close();
        return false;
      }
      const wasDraft = ctx.draft;
      ctx = context;
      if (wasDraft && !ctx.draft) {
        composer.setPlaceholder('Escreva para este departamento…');
        drawNote();
      }
      drawHead();
      return true;
    }


    if (window.hub && window.hub.onChatChanged) window.hub.onChatChanged(() => poll());

    return {
      get el() {
        build();
        return pickMode ? pickEl : el;
      },
      open,
      openPick,
      close,
      update,
      isOpen: () => !!ctx || pickMode,
      currentId: () => (ctx ? ctx.id : null),
      focus: () => composer && composer.focus(),
      sendText: (t) => (composer ? composer.sendText(t) : false),
      setSplit(v) {
        splitOn = !!v;
        headSig = '';
        drawHead();
      },
    };
  }

  const mainOpts = {};
  const main = createPane(mainOpts);
  main.opts = mainOpts; // app.js liga aqui o que depende do resto da tela (dividir, foco)
  main.create = createPane;
  return main;
})();
