'use strict';
/* "Encerrar o expediente": resumo do dia (quanto cada funcionário trabalhou, quanto esperou
   por você e as principais tarefas). Texto vindo dos hooks entra sempre via textContent. */

const Report = (() => {
  let overlay = null;
  let data = null;

  const oneLine = (t, n) => {
    const x = String(t || '').replace(/\s+/g, ' ').trim();
    return x.length > n ? x.slice(0, n - 1) + '…' : x;
  };
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const dateLong = (ts) => new Date(ts).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  const hm = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  /** Organiza os dados brutos do coletor em setores com funcionários e totais. */
  function organize(raw) {
    const sessions = raw.sessions.map((s) => ({ ...s, employees: s.employees.map((e) => ({ ...e })) }));
    const all = sessions.flatMap((s) => s.employees);
    Persona.assign(all);
    Sector.assign(sessions);
    const totals = { work: 0, wait: 0, done: 0, files: 0, commands: 0, errors: 0, people: all.length };
    let longest = null;
    for (const s of sessions) {
      s.work = 0;
      s.wait = 0;
      for (const e of s.employees) {
        e.persona = Persona.get(e);
        e.mood = Persona.mood(e.tasks.some((t) => t.status === 'error') ? 'error' : 'done');
        e.doneTasks = e.tasks.filter((t) => t.status === 'done').length;
        e.top = [...e.tasks].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 3);
        s.work += e.stats.activeMs;
        s.wait += e.stats.waitMs;
        totals.work += e.stats.activeMs;
        totals.wait += e.stats.waitMs;
        totals.done += e.doneTasks;
        totals.files += e.stats.edits;
        totals.commands += e.stats.commands;
        totals.errors += e.stats.errors;
        if (e.stats.waitMs > 0 && (!longest || e.stats.waitMs > longest.stats.waitMs)) longest = e;
      }
      s.employees.sort((a, b) => (b.isLeader ? 1 : 0) - (a.isLeader ? 1 : 0) || b.stats.activeMs - a.stats.activeMs);
    }
    sessions.sort((a, b) => b.work - a.work);
    return { from: raw.from, to: raw.to, sessions, totals, longest };
  }

  function taskLine(t) {
    return `${oneLine(t.title, 110)} (${dur(t.end - t.start)})`;
  }

  function markdown(d) {
    const t = d.totals;
    const L = [];
    L.push(`# Expediente de ${dateLong(d.to)}`, '');
    L.push(`Período: ${hm(d.from)} às ${hm(d.to)}`, '');
    L.push('## Resumo', '');
    L.push(`- Trabalho dos agentes: ${dur(t.work)} somados (${plural(t.people, 'funcionário', 'funcionários')})`);
    L.push(`- Esperando você: ${dur(t.wait)} somados`);
    L.push(`- Tarefas concluídas: ${t.done}`);
    L.push(`- Arquivos editados: ${t.files} · Comandos: ${t.commands} · Falhas: ${t.errors}`);
    if (d.longest) L.push(`- Quem mais esperou: ${d.longest.persona.name} (${d.longest.persona.cargo}), ${dur(d.longest.stats.waitMs)}`);
    L.push('');
    for (const s of d.sessions) {
      L.push(`## ${s.sector}`, '', `Projeto ${s.project} · ${s.cwd}`, '');
      for (const e of s.employees) {
        L.push(`### ${e.persona.name} — ${e.persona.cargo}`, '');
        L.push(`Trabalhou ${dur(e.stats.activeMs)} · esperou você ${dur(e.stats.waitMs)} · ${plural(e.doneTasks, 'tarefa concluída', 'tarefas concluídas')}`, '');
        if (e.description) L.push(`Missão: ${oneLine(e.description, 140)}`, '');
        if (e.top.length) {
          L.push('Principais tarefas:', '');
          for (const k of e.top) {
            L.push(`- ${taskLine(k)}`);
            if (k.result) L.push(`  - ${oneLine(k.result, 160)}`);
          }
          L.push('');
        }
      }
    }
    return L.join('\n');
  }

  function summary(d) {
    const t = d.totals;
    const L = [`Expediente de ${dateLong(d.to)} (${hm(d.from)}–${hm(d.to)})`];
    L.push(`Trabalho: ${dur(t.work)} · Esperando você: ${dur(t.wait)} · Tarefas concluídas: ${t.done}`);
    for (const s of d.sessions) {
      L.push('', `${s.sector} (${s.project})`);
      for (const e of s.employees) {
        const first = e.top[0];
        L.push(`- ${e.persona.name}: trabalhou ${dur(e.stats.activeMs)}, esperou ${dur(e.stats.waitMs)}${first ? `; principal: ${oneLine(first.title, 80)}` : ''}`);
      }
    }
    return L.join('\n');
  }

  /* ------------------------------------------------------------ interface */
  function kpi(value, label, cls) {
    return h('div', { class: 'kpi' + (cls ? ' ' + cls : '') }, h('b', { text: String(value) }), h('span', { text: label }));
  }

  function empBlock(e) {
    return h('div', { class: 'rp-emp', vars: { '--accent': e.persona.color } },
      h('div', { class: 'rp-emp-head' },
        avatarEl(e, 40),
        h('div', { class: 'rp-who' }, h('b', { text: e.persona.name }), h('span', { text: e.persona.cargo })),
        h('div', { class: 'rp-nums' },
          h('span', null, h('b', { text: dur(e.stats.activeMs) }), ' trabalhou'),
          h('span', { class: e.stats.waitMs > 60000 ? 'wait' : '' }, h('b', { text: dur(e.stats.waitMs) }), ' esperou você'),
          h('span', null, h('b', { text: String(e.doneTasks) }), e.doneTasks === 1 ? ' tarefa' : ' tarefas')
        )
      ),
      e.top.length
        ? h('ul', { class: 'rp-tasks' }, e.top.map((k) =>
            h('li', null,
              h('div', { class: 'rp-t' }, h('span', { text: oneLine(k.title, 120) }), h('em', { text: dur(k.end - k.start) })),
              k.result ? h('div', { class: 'rp-r', text: oneLine(k.result, 160) }) : null
            )
          ))
        : h('div', { class: 'rp-none', text: 'Sem tarefas registradas.' })
    );
  }

  function build(d, onClose) {
    const t = d.totals;
    const status = h('span', { class: 'rp-status', role: 'status' });
    const body = h('div', { class: 'rp-body' },
      h('div', { class: 'kpis' },
        kpi(dur(t.work), 'de trabalho (somado)'),
        kpi(dur(t.wait), 'esperando você', t.wait > 0 ? 'attn' : ''),
        kpi(t.done, 'tarefas concluídas'),
        kpi(t.files, 'arquivos editados'),
        kpi(t.commands, 'comandos'),
        kpi(t.errors, 'falhas')
      ),
      d.longest
        ? h('p', { class: 'rp-note' }, h('b', { text: d.longest.persona.name }), ` foi quem mais ficou esperando você: ${dur(d.longest.stats.waitMs)}.`)
        : null,
      d.sessions.length
        ? d.sessions.map((s) =>
            h('section', { class: 'rp-sector' },
              h('header', null,
                h('div', null, h('h3', { text: s.sector }), h('div', { class: 'path', text: `Projeto ${s.project} · ${s.cwd}` })),
                h('div', { class: 'rp-sum' }, h('span', null, h('b', { text: dur(s.work) }), ' trabalho'), h('span', null, h('b', { text: dur(s.wait) }), ' espera'))
              ),
              s.employees.map(empBlock)
            )
          )
        : h('div', { class: 'p-empty', text: 'Nada registrado neste período.' })
    );

    const btn = (text, cls, fn) => h('button', { type: 'button', class: 'btn ' + cls, text, onclick: fn });
    const foot = h('footer', { class: 'rp-foot' },
      status,
      btn('Salvar relatório', '', async () => {
        const file = await window.hub.saveReport(markdown(d));
        status.textContent = file ? `Salvo em ${file}` : 'Não foi possível salvar.';
      }),
      btn('Copiar resumo', '', async () => {
        await window.hub.copyText(summary(d));
        status.textContent = 'Resumo copiado.';
      }),
      btn('Encerrar e zerar o dia', 'primary', async () => {
        await window.hub.closeShift();
        onClose();
      }),
      btn('Fechar', 'ghost', onClose)
    );

    return h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Encerrar o expediente' },
      h('header', { class: 'rp-head' },
        h('div', null,
          h('h2', { text: 'Encerrar o expediente' }),
          h('div', { class: 'rp-period', text: `${dateLong(d.to).replace(/^./, (c) => c.toUpperCase())} · ${hm(d.from)} às ${hm(d.to)}` })
        ),
        h('button', { class: 'close', type: 'button', 'aria-label': 'Fechar', text: '✕', onclick: onClose })
      ),
      body,
      foot
    );
  }

  function close() {
    if (overlay) overlay.remove();
    overlay = null;
    data = null;
    document.removeEventListener('keydown', onEsc);
  }
  function onEsc(ev) {
    if (ev.key === 'Escape') close();
  }

  async function open() {
    if (overlay) return;
    overlay = h('div', { class: 'overlay' }, h('div', { class: 'modal loading', text: 'Montando o relatório…' }));
    overlay.addEventListener('mousedown', (ev) => {
      if (ev.target === overlay) close();
    });
    document.body.append(overlay);
    document.addEventListener('keydown', onEsc);
    try {
      const raw = await window.hub.getReport();
      if (!overlay) return;
      data = organize(raw);
      overlay.replaceChildren(build(data, close));
    } catch (err) {
      if (overlay) overlay.replaceChildren(h('div', { class: 'modal loading', text: 'Não consegui montar o relatório.' }));
    }
  }

  return { open, organize, markdown, summary };
})();
