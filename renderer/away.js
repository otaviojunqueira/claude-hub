'use strict';
/* Resumo ao voltar: ao reabrir o hub depois de um tempo fora, mostra o que cada departamento fez
   enquanto você não olhava. Feito só com os dados que o hub já registra (sem gastar o Claude).
   Todo texto vindo dos hooks entra via textContent. */

const Away = (() => {
  let overlay = null;

  const oneLine = (t, n) => {
    const x = String(t || '').replace(/\s+/g, ' ').trim();
    return x.length > n ? x.slice(0, n - 1) + '…' : x;
  };
  const hm = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

  /** Junta os funcionários de cada sessão num resumo por departamento. */
  function summarize(raw, sectorOf) {
    const rows = [];
    const totals = { done: 0, files: 0, errors: 0, commands: 0, wait: 0, work: 0 };
    for (const s of raw.sessions) {
      const r = { id: s.id, sector: sectorOf(s.id) || s.project, project: s.project, done: 0, errors: 0, files: 0, commands: 0, wait: 0, work: 0, running: 0, items: [], last: 0 };
      for (const e of s.employees) {
        r.files += e.stats.edits;
        r.commands += e.stats.commands;
        r.errors += e.stats.errors;
        r.wait += e.stats.waitMs;
        r.work += e.stats.activeMs;
        r.last = Math.max(r.last, e.lastTs || 0);
        for (const t of e.tasks) {
          if (t.status === 'done') r.done += 1;
          else if (t.status === 'running') r.running += 1;
          if (t.status === 'done' || t.status === 'error') r.items.push({ ok: t.status === 'done', title: t.title, result: t.result, end: t.end });
        }
      }
      r.items.sort((a, b) => b.end - a.end);
      for (const k of ['done', 'files', 'errors', 'commands', 'wait', 'work']) totals[k] += r[k];
      rows.push(r);
    }
    rows.sort((a, b) => b.last - a.last);
    return { rows, totals };
  }

  const kpi = (n, label, cls) => h('div', { class: `kpi${cls ? ' ' + cls : ''}` }, h('b', { text: String(n) }), h('span', { text: label }));

  function section(r, onOpen) {
    const facts = [
      r.done ? plural(r.done, 'tarefa concluída', 'tarefas concluídas') : null,
      r.files ? plural(r.files, 'arquivo editado', 'arquivos editados') : null,
      r.commands ? plural(r.commands, 'comando', 'comandos') : null,
      r.errors ? plural(r.errors, 'falha', 'falhas') : null,
      r.wait > 60000 ? `esperou você ${dur(r.wait)}` : null,
    ].filter(Boolean);
    return h('section', { class: 'aw-sec' },
      h('header', null,
        h('div', null, h('h3', { text: r.sector }), h('div', { class: 'path', text: `Projeto ${r.project}` })),
        r.running ? h('span', { class: 'aw-run', text: 'ainda trabalhando' }) : null,
        h('button', { type: 'button', class: 'chip-btn', text: 'Abrir chat', onclick: () => onOpen(r.id) })),
      facts.length ? h('div', { class: 'aw-facts', text: facts.join(' · ') }) : null,
      r.items.length
        ? h('ul', { class: 'aw-list' }, r.items.slice(0, 4).map((it) =>
            h('li', { class: it.ok ? 'ok' : 'bad' },
              h('span', { class: 'aw-mark', text: it.ok ? '✓' : '✕' }),
              h('div', null,
                h('div', { class: 'aw-t', text: oneLine(it.title, 120) }),
                it.result ? h('div', { class: 'aw-r', text: oneLine(it.result, 160) }) : null),
              h('time', { text: hm(it.end) }))))
        : null,
      r.items.length > 4 ? h('div', { class: 'aw-more', text: `e mais ${r.items.length - 4} no relatório do expediente` }) : null);
  }

  function close(mark = true) {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.removeEventListener('keydown', onEsc);
    if (mark) window.hub.seenNow();
  }
  function onEsc(ev) {
    if (ev.key === 'Escape') close();
  }

  /** deps: { sectorOf(sid), openChat(sid), pending() -> número, openInbox() } */
  function show(raw, deps) {
    if (overlay || !raw || !raw.sessions || !raw.sessions.length) return false;
    const sum = summarize(raw, deps.sectorOf);
    const t = sum.totals;
    const pend = deps.pending();
    const away = raw.to - raw.from;
    overlay = h('div', { class: 'overlay' });
    overlay.addEventListener('mousedown', (ev) => {
      if (ev.target === overlay) close();
    });
    overlay.append(h('div', { class: 'modal away', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'O que aconteceu enquanto você estava fora' },
      h('header', { class: 'rp-head' },
        h('div', null,
          h('h2', { text: 'Bem-vindo de volta' }),
          h('div', { class: 'rp-period', text: `Você ficou fora ${dur(away)} (desde as ${hm(raw.from)}). Veja o que aconteceu.` })),
        h('button', { class: 'close', type: 'button', 'aria-label': 'Fechar', text: '✕', onclick: () => close() })),
      h('div', { class: 'rp-body' },
        h('div', { class: 'kpis' },
          kpi(t.done, 'tarefas concluídas'),
          kpi(t.files, 'arquivos editados'),
          kpi(t.errors, 'falhas', t.errors ? 'attn' : ''),
          kpi(t.wait > 60000 ? dur(t.wait) : '0', 'esperando você', t.wait > 60000 ? 'attn' : '')),
        pend
          ? h('div', { class: 'aw-pend' },
              h('span', { text: `${plural(pend, 'pedido espera', 'pedidos esperam')} a sua resposta agora.` }),
              h('button', { type: 'button', class: 'btn primary', text: 'Ver pendências', onclick: () => { close(); deps.openInbox(); } }))
          : null,
        sum.rows.map((r) => section(r, (sid) => { close(); deps.openChat(sid); }))),
      h('footer', { class: 'rp-foot' },
        h('span', { class: 'cmp-grow' }),
        h('button', { type: 'button', class: 'btn ghost', text: 'Ver relatório do expediente', onclick: () => { close(); Report.open(); } }),
        h('button', { type: 'button', class: 'btn primary', text: 'Entendi', onclick: () => close() }))));
    document.body.append(overlay);
    document.addEventListener('keydown', onEsc);
    return true;
  }

  async function check(deps) {
    if (overlay) return;
    try {
      const raw = await window.hub.awaySummary();
      if (raw) show(raw, deps);
    } catch {
      /* sem resumo */
    }
  }

  return { check, show, summarize, isOpen: () => !!overlay };
})();
