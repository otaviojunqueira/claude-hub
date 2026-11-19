'use strict';
/**
 * Escritório: agentes (departamentos) conversando entre si.
 *
 * Como funciona:
 *  - o hub abre um servidor MCP local (só 127.0.0.1, com um segredo no caminho) e entrega aos chats que
 *    ele abre (`claude --mcp-config`) duas ferramentas: listar_departamentos e perguntar_departamento;
 *  - perguntar_departamento NUNCA vai direto: o hub mostra "Aprovar/Negar" no chat de quem perguntou
 *    e só depois entrega a pergunta ao chat do outro departamento (como uma mensagem, `claude --resume`)
 *    e devolve a resposta final dele para quem perguntou;
 *  - delegar_tarefas (só o GERENTE, escolhido pelo usuário no menu ⋯ da sala): o gerente decide sozinho o que
 *    delegar, monta um plano de etapas, o usuário aprova o plano UMA vez no hub e o hub entrega cada etapa, em
 *    ordem, ao chat do departamento escolhido (que trabalha de verdade, com as permissões normais dele, que
 *    aparecem na caixa de entrada). Uma etapa pode pedir um NOVO departamento (num projeto que o hub já conhece):
 *    ele só é criado depois da aprovação, quando a etapa começa. O resultado de cada etapa segue para a próxima e o
 *    relatório final volta para o gerente. Delegados não delegam adiante;
 *  - limites contra confusão e custo: uma pergunta por vez por departamento, nada de perguntar a quem
 *    está esperando resposta de outro (sem deadlock), no máximo 3 perguntas ao mesmo tempo e 8 por
 *    10 minutos por departamento.
 */
const crypto = require('crypto');
const http = require('http');

const SERVER = 'escritorio';
const TOOL_LIST = 'listar_departamentos';
const TOOL_ASK = 'perguntar_departamento';
const TOOL_DELEGATE = 'delegar_tarefas';
const MAX_STEPS = 6;
const MAX_NEW = 2; // departamentos novos por plano
const MAX_TASK = 4000;
const PLAN_MAX = 3; // planos por departamento a cada 10 min
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 256 * 1024;
const MAX_QUESTION = 6000;
const MAX_ACTIVE = 3;
const RATE_MAX = 8;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const KEEP = 30;

const STATUS_PT = { working: 'trabalhando', waiting: 'esperando o usuário', done: 'concluído', idle: 'ocioso', error: 'com erro', ended: 'encerrado' };

const TOOLS = [
  {
    name: TOOL_LIST,
    description: 'Lista os outros departamentos (chats do Claude Code) do Escritório, com setor, projeto, título e estado. Use o nome do setor em perguntar_departamento.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: TOOL_ASK,
    description: 'Faz uma pergunta a outro departamento e devolve a resposta dele. Cada pergunta precisa da aprovação do usuário no hub. Escreva a pergunta completa e autocontida (o outro departamento não vê esta conversa).',
    inputSchema: {
      type: 'object',
      properties: {
        departamento: { type: 'string', description: 'Nome do setor (ex.: Mezanino) ou o id, como mostrado por listar_departamentos.' },
        pergunta: { type: 'string', description: 'A pergunta, com todo o contexto necessário.' },
      },
      required: ['departamento', 'pergunta'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_DELEGATE,
    description: `Só o gerente do Escritório usa esta ferramenta. Delega um plano de tarefas a outros departamentos; o usuário aprova o plano inteiro uma vez no hub, depois as etapas rodam em ordem (os departamentos trabalham de verdade, com as permissões deles) e você recebe o relatório de cada uma. No máximo ${MAX_STEPS} etapas. Cada tarefa precisa ser completa e autocontida. Se faltar um departamento para uma etapa, peça um novo (novo_departamento) num dos projetos listados por listar_departamentos (no máximo ${MAX_NEW} por plano).`,
    inputSchema: {
      type: 'object',
      properties: {
        objetivo: { type: 'string', description: 'O objetivo geral, em uma ou duas frases.' },
        etapas: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_STEPS,
          description: 'Etapas em ordem de execução. O resultado de cada uma é entregue à seguinte.',
          items: {
            type: 'object',
            properties: {
              departamento: { type: 'string', description: 'Nome do setor ou id de um departamento que já existe, como mostrado por listar_departamentos.' },
              novo_departamento: {
                type: 'object',
                description: 'Em vez de departamento: cria um departamento novo (um chat novo) num projeto que o hub já conhece. Ele só é criado depois que o usuário aprovar o plano.',
                properties: { projeto: { type: 'string', description: 'Nome do projeto, como mostrado em "Projetos para departamentos novos" de listar_departamentos.' } },
                required: ['projeto'],
                additionalProperties: false,
              },
              tarefa: { type: 'string', description: 'O que o departamento deve fazer, com todo o contexto necessário e o que entregar.' },
            },
            required: ['tarefa'],
            additionalProperties: false,
          },
        },
      },
      required: ['objetivo', 'etapas'],
      additionalProperties: false,
    },
  },
];

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function createOffice({ collector, chat, getConfig, onChange, getManager, listProjects, timeoutMs = 4 * 60 * 1000, taskTimeoutMs = 25 * 60 * 1000, approvalTimeoutMs = 15 * 60 * 1000 }) {
  const cfg = () => (typeof getConfig === 'function' && getConfig()) || {};
  const enabled = () => cfg().officeOn !== false;
  let names = { sectors: {} };
  let server = null;
  let port = 0;
  const token = crypto.randomBytes(18).toString('hex');
  const asks = [];
  const plans = [];
  const history = new Map(); // sid -> instantes das perguntas recentes
  let seq = 0;
  const changed = () => onChange && onChange();

  const live = (a) => a.status === 'approval' || a.status === 'waiting';
  const isManager = (sid) => {
    try {
      return !!(typeof getManager === 'function' && getManager() && getManager() === sid);
    } catch {
      return false;
    }
  };
  const knownProjects = () => {
    try {
      const l = typeof listProjects === 'function' ? listProjects() : [];
      return (Array.isArray(l) ? l : []).filter((p) => p && typeof p.cwd === 'string' && p.project).slice(0, 40);
    } catch {
      return [];
    }
  };
  function resolveProject(query) {
    const list = knownProjects();
    const q = norm(typeof query === 'string' ? query : query && query.projeto);
    if (!q) return { error: 'Diga em qual projeto o novo departamento vai trabalhar.' };
    let hit = list.filter((p) => norm(p.project) === q || norm(p.cwd) === q);
    if (!hit.length) hit = list.filter((p) => norm(p.project).includes(q) || norm(p.cwd).includes(q));
    const uniq = [...new Map(hit.map((p) => [p.cwd, p])).values()];
    if (uniq.length === 1) return { cwd: uniq[0].cwd, project: uniq[0].project };
    const names = [...new Set((uniq.length ? uniq : list).map((p) => p.project))].join(', ') || 'nenhum';
    return { error: uniq.length ? `Mais de um projeto combina com "${clip(q, 40)}": ${names}.` : `O hub não conhece o projeto "${clip(q, 40)}". Projetos: ${names}.` };
  }
  const nameOf = (sid) => {
    const n = names.sectors && names.sectors[sid];
    if (n) return n;
    const i = collector.sessionInfo(sid);
    return i && i.project ? i.project : 'outro departamento';
  };
  const note = (sid, text) => {
    try {
      if (collector.note) collector.note(sid, text);
    } catch {
      /* feed é só enfeite */
    }
  };

  /* --------------------------------------------------------------- consulta */
  function departments(callerSid) {
    const snap = collector.snapshot();
    return snap.sessions
      .filter((s) => s.id !== callerSid)
      .map((s) => ({ id: s.id, nome: nameOf(s.id), projeto: s.project, titulo: s.title || '', estado: STATUS_PT[s.status] || s.status, ultimo: s.lastMessage || '' }));
  }

  function listText(callerSid) {
    const list = departments(callerSid);
    const lines = list.length
      ? ['Departamentos disponíveis (use o nome do setor em perguntar_departamento):', ...list.map((d) => `- ${d.nome} · projeto ${d.projeto}${d.titulo ? ` · "${clip(d.titulo, 70)}"` : ''} · ${d.estado}${d.ultimo ? ` · último recado: ${clip(d.ultimo, 140)}` : ''} (id ${d.id.slice(0, 8)})`)]
      : ['Não há outros departamentos no Escritório agora.'];
    if (isManager(callerSid)) {
      const projs = knownProjects();
      if (projs.length) lines.push('', 'Projetos para departamentos novos (use em novo_departamento de delegar_tarefas):', ...projs.map((p) => `- ${p.project}`));
    }
    return lines.join('\n');
  }

  function resolveTarget(callerSid, query) {
    const list = departments(callerSid);
    const q = norm(query);
    if (!q) return { error: 'Diga a qual departamento é a pergunta (use listar_departamentos).' };
    const pick = (fn) => list.filter(fn);
    let hit = pick((d) => norm(d.nome) === q);
    if (!hit.length && q.length >= 4) hit = pick((d) => d.id.toLowerCase().startsWith(q));
    if (!hit.length) hit = pick((d) => norm(d.projeto) === q);
    if (!hit.length) hit = pick((d) => norm(d.nome).includes(q) || norm(d.projeto).includes(q) || norm(d.titulo).includes(q));
    if (hit.length === 1) return { sid: hit[0].id, name: hit[0].nome };
    const lista = (hit.length ? hit : list).map((d) => d.nome).join(', ') || 'nenhum';
    return { error: hit.length ? `Mais de um departamento combina com "${clip(query, 40)}": ${lista}. Use o nome exato ou o id.` : `Não achei o departamento "${clip(query, 40)}". Departamentos: ${lista}.` };
  }

  /* -------------------------------------------------------------- perguntar */
  const fail = (text) => ({ text, isError: true });

  async function ask(callerSid, targetQuery, question, signal) {
    if (typeof question !== 'string' || !question.trim()) return fail('Escreva a pergunta.');
    if (question.length > MAX_QUESTION) return fail(`A pergunta passa de ${MAX_QUESTION} caracteres. Resuma.`);
    const target = resolveTarget(callerSid, targetQuery);
    if (target.error) return fail(target.error);
    const toSid = target.sid;
    const now = Date.now();
    const recent = (history.get(callerSid) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX) return fail('Perguntas demais em pouco tempo. Tente resolver com o que você já tem ou peça ao usuário.');
    if (asks.some((a) => live(a) && a.from === callerSid)) return fail('Você já tem uma pergunta em andamento. Espere a resposta.');
    if (asks.filter(live).length >= MAX_ACTIVE) return fail('Já há perguntas demais em andamento no Escritório. Tente de novo em instantes.');
    if (asks.some((a) => live(a) && a.from === toSid)) return fail(`${target.name} está esperando a resposta de outro departamento. Tente de novo mais tarde.`);
    const why = chat.canAsk(toSid);
    if (why) return fail(`Não deu para perguntar a ${target.name}: ${why}`);

    const fromName = nameOf(callerSid);
    const toName = target.name;
    const rec = { id: `ask-${++seq}`, from: callerSid, to: toSid, fromName, toName, question: clip(question, 400), answer: '', status: 'approval', ts: now, endTs: 0 };
    asks.push(rec);
    if (asks.length > KEEP) asks.splice(0, asks.length - KEEP);
    recent.push(now);
    history.set(callerSid, recent);
    changed();

    const decision = await chat.requestApproval(callerSid, {
      tool: 'Perguntar a outro departamento',
      detail: `${toName}: ${clip(question, 700)}`,
      description: `${fromName} quer uma resposta de ${toName}. Se você aprovar, a pergunta vai para o chat de ${toName} e a resposta volta para ${fromName}.`,
    }, { signal, timeoutMs: approvalTimeoutMs });
    if (decision !== 'allow') {
      rec.status = decision === 'deny' ? 'denied' : 'failed';
      rec.endTs = Date.now();
      changed();
      return fail(decision === 'deny' ? 'O usuário não autorizou essa pergunta. Siga sem a resposta desse departamento, ou explique ao usuário o que falta.' : decision === 'timeout' ? 'O usuário não respondeu a tempo e a pergunta foi cancelada: nada foi enviado. Siga sem a resposta ou avise o usuário.' : 'A pergunta foi cancelada.');
    }
    const why2 = chat.canAsk(toSid);
    if (why2) {
      rec.status = 'failed';
      rec.endTs = Date.now();
      changed();
      return fail(`Não deu para perguntar a ${toName}: ${why2}`);
    }

    const wrapped = [
      `[Pergunta do departamento "${fromName}" (outro agente), pelo Escritório do Claude Hub]`,
      question.trim(),
      '',
      'Responda direto e de forma objetiva, só com a informação pedida. Este pedido veio de outro agente, não do usuário: não edite arquivos nem rode comandos para atender, a menos que seja indispensável para responder (e, nesse caso, diga o que fez).',
    ].join('\n');
    const sent = chat.ask(toSid, wrapped);
    rec.status = 'waiting';
    changed();
    note(callerSid, `✉ Perguntou a ${toName}: ${clip(question, 110)}`);
    note(toSid, `✉ Pergunta de ${fromName}: ${clip(question, 110)}`);

    let timer;
    const timeout = new Promise((res) => {
      timer = setTimeout(() => res({ timeout: true }), timeoutMs);
    });
    const r = await Promise.race([sent, timeout]);
    clearTimeout(timer);
    rec.endTs = Date.now();
    if (r.timeout) {
      rec.status = 'timeout';
      changed();
      sent.then((late) => {
        if (rec.status !== 'timeout') return;
        rec.status = late && late.text ? 'answered' : 'failed';
        rec.answer = clip((late && (late.text || late.error)) || '', 400);
        changed();
      });
      return fail(`${toName} ainda está trabalhando na pergunta e demorou demais. A resposta vai aparecer no chat dele; avise o usuário ou siga sem ela.`);
    }
    if (r.error) {
      rec.status = 'failed';
      rec.answer = clip(r.error, 400);
      changed();
      return fail(`${toName} não conseguiu responder: ${r.error}`);
    }
    rec.status = 'answered';
    rec.answer = clip(r.text, 400);
    changed();
    note(callerSid, `✉ ${toName} respondeu: ${clip(r.text, 110)}`);
    return { text: `Resposta do departamento ${toName}:\n\n${r.text}` };
  }

  /* ------------------------------------------------------------- delegação */
  const mark = { done: '✓', failed: '✕', timeout: '…', denied: '✕', skipped: '–', pending: '·', running: '▶' };

  function planText(steps) {
    return steps.map((st) => `${st.n}. ${st.isNew ? `[NOVO departamento em ${st.project}]` : st.toName}: ${clip(st.task, 360)}`).join('\n');
  }

  async function delegate(callerSid, objective, rawSteps, signal) {
    if (!isManager(callerSid)) return fail('Só o gerente do Escritório pode delegar. O usuário escolhe o gerente no menu ⋯ da sala do departamento.');
    if (typeof objective !== 'string' || !objective.trim()) return fail('Diga o objetivo geral do plano.');
    if (!Array.isArray(rawSteps) || !rawSteps.length) return fail('Inclua ao menos uma etapa.');
    if (rawSteps.length > MAX_STEPS) return fail(`No máximo ${MAX_STEPS} etapas por plano. Agrupe ou divida em planos menores.`);
    if (asks.some((a) => live(a) && a.kind === 'task' && a.to === callerSid)) return fail('Você está executando uma tarefa delegada por outro departamento. Faça a sua parte e responda; não delegue adiante.');
    if (plans.some((p) => p.from === callerSid && (p.status === 'approval' || p.status === 'running'))) return fail('Você já tem um plano em andamento. Espere o relatório dele.');
    const now = Date.now();
    const recent = (history.get(`plan:${callerSid}`) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= PLAN_MAX) return fail('Planos demais em pouco tempo. Termine o que está em andamento ou peça ao usuário.');

    const steps = [];
    for (let i = 0; i < rawSteps.length; i++) {
      const r = rawSteps[i] && typeof rawSteps[i] === 'object' ? rawSteps[i] : {};
      if (typeof r.tarefa !== 'string' || !r.tarefa.trim()) return fail(`A etapa ${i + 1} está sem tarefa.`);
      if (r.tarefa.length > MAX_TASK) return fail(`A tarefa da etapa ${i + 1} passa de ${MAX_TASK} caracteres. Resuma.`);
      if (r.novo_departamento != null && r.departamento) return fail(`Etapa ${i + 1}: use departamento OU novo_departamento, não os dois.`);
      if (r.novo_departamento != null) {
        if (steps.filter((x) => x.isNew).length >= MAX_NEW) return fail(`No máximo ${MAX_NEW} departamentos novos por plano.`);
        const pj = resolveProject(r.novo_departamento);
        if (pj.error) return fail(`Etapa ${i + 1}: ${pj.error}`);
        steps.push({ n: i + 1, to: '', isNew: true, cwd: pj.cwd, project: pj.project, toName: `novo departamento em ${pj.project}`, task: r.tarefa.trim(), status: 'pending', result: '' });
        continue;
      }
      const t = resolveTarget(callerSid, r.departamento);
      if (t.error) return fail(`Etapa ${i + 1}: ${t.error}`);
      steps.push({ n: i + 1, to: t.sid, toName: t.name, task: r.tarefa.trim(), status: 'pending', result: '' });
    }
    const first = steps[0].isNew ? null : chat.canAsk(steps[0].to);
    if (first) return fail(`Não deu para começar: a primeira etapa vai para ${steps[0].toName}, mas ${first}`);

    const fromName = nameOf(callerSid);
    const plan = { id: `plan-${++seq}`, from: callerSid, fromName, objective: clip(objective, 300), steps, status: 'approval', ts: now, endTs: 0 };
    plans.push(plan);
    if (plans.length > 10) plans.splice(0, plans.length - 10);
    recent.push(now);
    history.set(`plan:${callerSid}`, recent);
    const targets = [...new Set(steps.map((x) => x.toName))].join(', ');
    const nNew = steps.filter((x) => x.isNew).length;
    // a sala do gerente mostra "quer delegar…" enquanto o plano espera o usuário
    const gate = { id: `ask-${++seq}`, kind: 'plan', from: callerSid, to: '', fromName, toName: targets, question: clip(objective, 400), answer: '', status: 'approval', ts: now, endTs: 0 };
    asks.push(gate);
    changed();

    const decision = await chat.requestApproval(callerSid, {
      kind: 'plan',
      tool: 'Plano de delegação',
      detail: `Objetivo: ${clip(objective, 300)}\n\n${planText(steps)}`,
      description: `${fromName} propõe distribuir ${steps.length === 1 ? 'uma tarefa' : `${steps.length} etapas`} para ${targets}${nNew ? ` (${nNew === 1 ? 'cria 1 departamento novo' : `cria ${nNew} departamentos novos`})` : ''}. Aprovando, elas rodam em ordem e cada departamento trabalha de verdade, com as permissões normais do chat dele (os pedidos aparecem nas Pendências).`,
    }, { signal, timeoutMs: approvalTimeoutMs });
    gate.status = decision === 'allow' ? 'answered' : decision === 'deny' ? 'denied' : 'failed';
    gate.endTs = Date.now();
    if (decision !== 'allow') {
      plan.status = decision === 'deny' ? 'denied' : 'failed';
      plan.endTs = Date.now();
      changed();
      return fail(decision === 'deny' ? 'O usuário não aprovou o plano. Pergunte o que ele quer mudar, ou siga sem delegar.' : decision === 'timeout' ? 'O usuário não respondeu ao plano a tempo e ele foi cancelado: nenhum departamento foi criado e nada foi delegado. Avise o usuário e proponha de novo quando ele estiver por perto.' : 'O plano foi cancelado.');
    }

    plan.status = 'running';
    changed();
    note(callerSid, `⇢ Plano aprovado: ${steps.length} ${steps.length === 1 ? 'etapa' : 'etapas'} (${targets})`);
    const report = [];
    let stopped = '';
    for (const st of steps) {
      if (signal && signal.aborted) {
        stopped = `A chamada do gerente foi interrompida antes da etapa ${st.n}; ela e as seguintes não foram iniciadas.`;
        break;
      }
      const prev = steps.filter((x) => x.status === 'done').map((x) => `Etapa ${x.n} (${x.toName}): ${clip(x.result, 600)}`).join('\n');
      if (st.isNew) {
        // departamento novo: só nasce agora, depois da aprovação do plano
        const prep = chat.prepare(st.cwd);
        if (!prep || prep.error) {
          st.status = 'failed';
          st.result = `Não deu para criar o departamento: ${(prep && prep.error) || 'erro desconhecido'}`;
          stopped = `A etapa ${st.n} não pôde começar: ${st.result}`;
          break;
        }
        st.to = prep.id;
        st.toName = `Novo departamento (${st.project})`;
        note(callerSid, `⇢ Criou um novo departamento em ${st.project}`);
        changed();
      }
      const why = chat.canAsk(st.to);
      if (why) {
        st.status = 'failed';
        st.result = `Não deu para entregar a tarefa: ${why}`;
        stopped = `A etapa ${st.n} não pôde começar: ${st.toName} ${why}`;
        break;
      }
      const wrapped = [
        `[Tarefa delegada pelo departamento "${fromName}" (outro agente), pelo Escritório do Claude Hub]`,
        `Objetivo geral: ${clip(objective, 300)}`,
        prev ? `\nResultado das etapas anteriores:\n${prev}` : '',
        st.isNew ? `Você é um departamento novo, criado pelo gerente para esta tarefa (projeto ${st.project}).` : '',
        `\nSua tarefa (etapa ${st.n} de ${steps.length}):`,
        st.task,
        '',
        'Execute a tarefa normalmente, com as suas permissões de sempre (o usuário aprova o que for preciso neste chat). Ao terminar, responda com um resumo curto: o que você fez, quais arquivos mudou e o que ficou pendente. Não delegue a outros departamentos.',
      ].filter((x) => x !== '').join('\n');
      const rec = { id: `ask-${++seq}`, kind: 'task', from: callerSid, to: st.to, fromName, toName: st.toName, question: clip(st.task, 400), answer: '', status: 'waiting', ts: Date.now(), endTs: 0 };
      asks.push(rec);
      st.status = 'running';
      changed();
      note(callerSid, `⇢ Delegou a ${st.toName}: ${clip(st.task, 110)}`);
      note(st.to, `⇢ Tarefa de ${fromName}: ${clip(st.task, 110)}`);
      const sent = chat.ask(st.to, wrapped);
      let timer;
      const timeout = new Promise((res) => {
        timer = setTimeout(() => res({ timeout: true }), taskTimeoutMs);
      });
      const gaveUp = new Promise((res) => {
        if (signal) signal.addEventListener('abort', () => res({ aborted: true }), { once: true });
      });
      const r = await Promise.race([sent, timeout, gaveUp]);
      clearTimeout(timer);
      rec.endTs = Date.now();
      if (r.timeout || r.aborted) {
        rec.status = 'timeout';
        st.status = 'timeout';
        st.result = 'Ainda em andamento no chat desse departamento.';
        stopped = r.aborted
          ? `A chamada do gerente foi interrompida durante a etapa ${st.n} (${st.toName}); ela segue no chat dele e as etapas seguintes não foram iniciadas.`
          : `A etapa ${st.n} (${st.toName}) demorou demais e ainda está rodando no chat dele; as etapas seguintes não foram iniciadas.`;
        sent.then((late) => {
          if (rec.status !== 'timeout') return;
          rec.status = late && late.text ? 'answered' : 'failed';
          rec.answer = clip((late && (late.text || late.error)) || '', 400);
          changed();
        });
        break;
      }
      if (r.error) {
        rec.status = 'failed';
        st.status = 'failed';
        st.result = clip(r.error, 600);
        rec.answer = st.result;
        stopped = `A etapa ${st.n} (${st.toName}) falhou: ${st.result}`;
        break;
      }
      rec.status = 'answered';
      rec.answer = clip(r.text, 400);
      st.status = 'done';
      st.result = clip(r.text, 1600);
      note(callerSid, `⇢ ${st.toName} concluiu a etapa ${st.n}: ${clip(r.text, 100)}`);
      changed();
    }
    for (const st of steps) if (st.status === 'pending') st.status = 'skipped';
    plan.status = stopped ? 'failed' : 'done';
    plan.endTs = Date.now();
    changed();
    for (const st of steps) report.push(`${mark[st.status] || '·'} Etapa ${st.n} · ${st.toName} (${st.status}):\n${st.result || '(não executada)'}`);
    const head = stopped ? `Plano interrompido. ${stopped}` : 'Plano concluído: todas as etapas foram executadas.';
    return { text: `${head}\n\n${report.join('\n\n')}`, isError: !!stopped };
  }

  /* -------------------------------------------------------------- MCP / HTTP */
  async function callTool(callerSid, name, args, signal) {
    const a = args && typeof args === 'object' ? args : {};
    if (name === TOOL_LIST) return { text: listText(callerSid) };
    if (name === TOOL_ASK) return ask(callerSid, a.departamento, a.pergunta, signal);
    if (name === TOOL_DELEGATE) return delegate(callerSid, a.objetivo, a.etapas, signal);
    return fail(`Ferramenta desconhecida: ${name}`);
  }

  async function rpc(callerSid, msg, signal) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { jsonrpc: '2.0', id: msg && msg.id != null ? msg.id : null, error: { code: -32600, message: 'Requisição inválida' } };
    const hasId = msg.id !== undefined && msg.id !== null;
    const ok = (result) => (hasId ? { jsonrpc: '2.0', id: msg.id, result } : null);
    switch (msg.method) {
      case 'initialize': {
        const want = msg.params && msg.params.protocolVersion;
        return ok({
          protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER, version: '1.0.0' },
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call': {
        const p = msg.params || {};
        let r;
        try {
          r = await callTool(callerSid, p.name, p.arguments, signal);
        } catch (e) {
          r = fail(`Erro no Escritório: ${e.message}`);
        }
        return ok({ content: [{ type: 'text', text: r.text }], isError: !!r.isError });
      }
      default:
        return hasId ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Método não suportado: ${msg.method}` } } : null;
    }
  }

  function handle(req, res) {
    const send = (code, body, headers) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(headers || {}) });
      res.end(body == null ? '' : JSON.stringify(body));
    };
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, { error: 'host' });
    const m = /^\/mcp\/([0-9a-f]+)\/([\w-]{1,80})$/.exec((req.url || '').split('?')[0]);
    if (!m || m[1].length !== token.length || !crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(token)) || !enabled() || !chat.hasProc(m[2])) return send(404, { error: 'não encontrado' });
    if (req.method !== 'POST') return send(405, { error: 'use POST' }, { Allow: 'POST' });
    let size = 0;
    const parts = [];
    let dead = false;
    req.on('data', (d) => {
      size += d.length;
      if (size > MAX_BODY) {
        dead = true;
        send(413, { error: 'grande demais' });
        req.destroy();
      } else parts.push(d);
    });
    req.on('end', async () => {
      if (dead) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      } catch {
        return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } });
      }
      const batch = Array.isArray(body);
      // se o Claude Code desistir da chamada (tempo, Parar) e fechar a conexão, o que estava esperando é cancelado
      const ac = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) ac.abort();
      });
      const out = (await Promise.all((batch ? body : [body]).map((x) => rpc(m[2], x, ac.signal)))).filter(Boolean);
      if (ac.signal.aborted) return;
      if (!out.length) return send(202, null);
      send(200, batch ? out : out[0]);
    });
  }

  function start() {
    return new Promise((resolve) => {
      server = http.createServer(handle);
      server.on('error', () => {
        server = null;
        port = 0;
        resolve(false);
      });
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve(true);
      });
    });
  }

  function stop() {
    if (server) server.close();
    server = null;
    port = 0;
  }

  /** Configuração `--mcp-config` para o chat `sid`, ou null (desligado ou servidor fora do ar). */
  function mcpConfig(sid) {
    if (!server || !port || !enabled() || !/^[\w-]{1,80}$/.test(String(sid))) return null;
    return JSON.stringify({ mcpServers: { [SERVER]: { type: 'http', url: `http://127.0.0.1:${port}/mcp/${token}/${sid}` } } });
  }

  function systemNote(sid) {
    const base = [
      'Você trabalha no "Escritório" do Claude Hub: cada chat do Claude Code é um departamento, com seu próprio projeto e contexto.',
      `Quando precisar de uma informação ou decisão que outro departamento tem, use as ferramentas ${`mcp__${SERVER}__${TOOL_LIST}`} (ver quem existe) e ${`mcp__${SERVER}__${TOOL_ASK}`} (fazer uma pergunta e receber a resposta).`,
      'Cada pergunta passa pela aprovação do usuário, então pergunte só quando valer a pena e não para o que você consegue descobrir lendo arquivos. Escreva a pergunta completa: o outro departamento não vê esta conversa.',
      'Se um pedido chegar começando com "[Pergunta do departamento", ele veio de outro agente: responda direto e objetivo, sem editar arquivos nem rodar comandos, a menos que seja indispensável.',
    ];
    if (isManager(sid)) {
      base.push(
        `VOCÊ É O GERENTE do Escritório (o usuário escolheu este departamento). Seu trabalho é decidir, sozinho, o que vale delegar aos outros departamentos e montar o plano para o usuário aprovar, sem depender de ele explicar o objetivo: use ${`mcp__${SERVER}__${TOOL_LIST}`} (estado, título e último recado de cada departamento, e os projetos disponíveis) e o que já foi dito nesta conversa para deduzir o que precisa ser feito. Quando houver trabalho para outros departamentos, chame ${`mcp__${SERVER}__${TOOL_DELEGATE}`} uma única vez com um plano curto de etapas em ordem, cada tarefa completa e autocontida; o usuário aprova o plano inteiro no hub e você recebe o relatório de cada etapa. Se faltar um departamento, peça um novo (novo_departamento) num dos projetos listados. Só pergunte ao usuário se for impossível deduzir; se nada precisar ser delegado, responda direto, em poucas palavras. Ao receber o relatório, resuma o que foi feito e o que ficou pendente.`
      );
    } else {
      base.push('Se um pedido chegar começando com "[Tarefa delegada", ele veio do gerente: execute a tarefa com as suas permissões normais e responda com um resumo curto do que fez. Você não delega a outros departamentos.');
    }
    return base.join(' ');
  }

  return {
    start,
    stop,
    mcpConfig,
    systemNote,
    isManager,
    enabled,
    setNames(n) {
      if (n && typeof n === 'object' && n.sectors && typeof n.sectors === 'object') names = { sectors: { ...n.sectors } };
    },
    state: () => ({ asks: asks.slice(-30).map((a) => ({ ...a })), plans: plans.slice(-5).map((p) => ({ ...p, steps: p.steps.map((x) => ({ ...x })) })) }),
    // para testes
    _ask: ask,
    _delegate: delegate,
    _resolve: resolveTarget,
    _list: listText,
    _port: () => port,
    _token: token,
  };
}

const ASK_TOOL = `mcp__${SERVER}__${TOOL_ASK}`;
const DELEGATE_TOOL = `mcp__${SERVER}__${TOOL_DELEGATE}`;
const LIST_TOOL = `mcp__${SERVER}__${TOOL_LIST}`;
module.exports = { createOffice, ASK_TOOL, LIST_TOOL, DELEGATE_TOOL };
