'use strict';
/* Testa o Escritório: servidor MCP local, aprovação do usuário, regras anti-confusão e a pergunta de ponta a ponta. */
const assert = require('assert');
const http = require('http');
const { createOffice } = require('../src/office');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await sleep(15);
  }
  throw new Error('tempo esgotado: ' + fn.toString());
};

const SESS = [
  { id: 'aaaaaaaa-1111', project: 'indica-monorepo', title: 'Adicione indicação em dois níveis', status: 'working', lastMessage: 'Terminei o módulo de comissões.' },
  { id: 'bbbbbbbb-2222', project: 'painel-de-comando', title: '', status: 'idle' },
  { id: 'cccccccc-3333', project: 'api-pagamentos', title: 'Webhook', status: 'done' },
  { id: 'dddddddd-4444', project: 'api-pagamentos', title: 'Outro webhook', status: 'idle' },
];
const feed = [];
const collector = {
  snapshot: () => ({ sessions: SESS }),
  sessionInfo: (id) => SESS.find((s) => s.id === id) || null,
  note: (sid, text) => feed.push([sid, text]),
};
const approvals = []; // pedidos de aprovação que chegaram ao "chat"
const asked = []; // perguntas entregues
const prepared = []; // departamentos novos criados
let prepareFail = '';
let manager = 'aaaaaaaa-1111';
const PROJECTS = [{ cwd: '/home/u/projetos/indica-monorepo', project: 'indica-monorepo' }, { cwd: '/home/u/projetos/site-institucional', project: 'site-institucional' }, { cwd: '/home/u/projetos/site-blog', project: 'site-blog' }];
let blocked = {};
let answerWith = () => ({ text: 'A regra é 70/30.' });
const procs = new Set(['aaaaaaaa-1111', 'bbbbbbbb-2222', 'cccccccc-3333', 'dddddddd-4444']);
const chat = {
  hasProc: (sid) => procs.has(sid),
  canAsk: (sid) => blocked[sid] || null,
  requestApproval: (sid, info, extra) =>
    new Promise((resolve) => {
      const a = { sid, info, resolve, extra, dropped: false };
      approvals.push(a);
      const { signal, timeoutMs } = extra || {};
      if (signal) signal.addEventListener('abort', () => { a.dropped = true; resolve('abort'); });
      if (timeoutMs) setTimeout(() => { a.dropped = true; resolve('timeout'); }, timeoutMs).unref();
    }),
  prepare: (cwd) => {
    prepared.push(cwd);
    return prepareFail ? { error: prepareFail } : { id: `novo-${prepared.length}`, cwd, project: cwd.split('/').pop() };
  },
  ask: (sid, text) => {
    asked.push({ sid, text });
    return new Promise((resolve) => setTimeout(() => resolve(answerWith(sid, text)), 20));
  },
};

let cfg = {};
const changes = [];
const office = createOffice({ collector, chat, getConfig: () => cfg, onChange: () => changes.push(1), timeoutMs: 400, getManager: () => manager, listProjects: () => PROJECTS });
office.setNames({ sectors: { 'aaaaaaaa-1111': 'Mezanino', 'bbbbbbbb-2222': 'Redação', 'cccccccc-3333': 'Oficina de APIs', 'dddddddd-4444': 'Doca de Entregas' } });

function post(urlPath, body, { host, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: office._port(), path: urlPath, method, headers: { 'Content-Type': 'application/json', Host: host || `127.0.0.1:${office._port()}`, 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => resolve({ status: res.statusCode, json: t ? JSON.parse(t) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}
const rpc = (sid, method, params, id = 1) => post(`/mcp/${office._token}/${sid}`, { jsonrpc: '2.0', id, method, params });
const callTool = (sid, name, args) => rpc(sid, 'tools/call', { name, arguments: args });

(async () => {
  assert.strictEqual(office.mcpConfig('aaaaaaaa-1111'), null, 'sem servidor, sem configuração');
  assert.strictEqual(await office.start(), true);
  const conf = JSON.parse(office.mcpConfig('aaaaaaaa-1111'));
  const url = new URL(conf.mcpServers.escritorio.url);
  assert.strictEqual(conf.mcpServers.escritorio.type, 'http');
  assert.strictEqual(url.hostname, '127.0.0.1', 'só no loopback');
  assert.strictEqual(office.mcpConfig('x y; rm'), null, 'id suspeito');
  cfg = { officeOn: false };
  assert.strictEqual(office.mcpConfig('aaaaaaaa-1111'), null, 'desligado');
  assert.strictEqual((await rpc('aaaaaaaa-1111', 'ping')).status, 404, 'desligado: servidor recusa');
  cfg = {};

  // protocolo
  let r = await rpc('aaaaaaaa-1111', 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.result.protocolVersion, '2025-03-26');
  assert.strictEqual(r.json.result.serverInfo.name, 'escritorio');
  assert.strictEqual((await rpc('aaaaaaaa-1111', 'initialize', { protocolVersion: '1999-01-01' })).json.result.protocolVersion, '2025-06-18', 'versão desconhecida: oferece a mais nova');
  r = await post(`/mcp/${office._token}/aaaaaaaa-1111`, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.strictEqual(r.status, 202, 'notificação não tem resposta');
  r = await rpc('aaaaaaaa-1111', 'tools/list');
  assert.deepStrictEqual(r.json.result.tools.map((t) => t.name), ['listar_departamentos', 'perguntar_departamento', 'delegar_tarefas']);
  const dsch = r.json.result.tools[2].inputSchema;
  assert.deepStrictEqual(dsch.required, ['objetivo', 'etapas']);
  assert.strictEqual(dsch.properties.etapas.maxItems, 6);
  assert.deepStrictEqual(dsch.properties.etapas.items.required, ['tarefa']);
  assert.deepStrictEqual(Object.keys(dsch.properties.etapas.items.properties), ['departamento', 'novo_departamento', 'tarefa']);
  assert.deepStrictEqual(r.json.result.tools[1].inputSchema.required, ['departamento', 'pergunta']);
  assert.strictEqual((await rpc('aaaaaaaa-1111', 'ping')).json.result && 1, 1);
  assert.strictEqual((await rpc('aaaaaaaa-1111', 'coisa/estranha')).json.error.code, -32601);
  r = await post(`/mcp/${office._token}/aaaaaaaa-1111`, [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  assert(Array.isArray(r.json) && r.json.length === 2, 'lote');
  assert.strictEqual((await post(`/mcp/${office._token}/aaaaaaaa-1111`, '{quebrado')).status, 400);

  // segurança do endpoint
  assert.strictEqual((await post(`/mcp/${'0'.repeat(office._token.length)}/aaaaaaaa-1111`, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 404, 'segredo errado');
  assert.strictEqual((await post('/mcp/curto/aaaaaaaa-1111', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 404);
  assert.strictEqual((await post(`/mcp/${office._token}/aaaaaaaa-1111`, { jsonrpc: '2.0', id: 1, method: 'ping' }, { host: 'evil.example:80' })).status, 403, 'Host de fora (DNS rebinding)');
  assert.strictEqual((await post(`/mcp/${office._token}/sessao-sem-chat`, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 404, 'só chats abertos pelo hub');
  assert.strictEqual((await post(`/mcp/${office._token}/aaaaaaaa-1111`, null, { method: 'GET' })).status, 405);
  assert.strictEqual((await post(`/mcp/${office._token}/aaaaaaaa-1111`, 'x'.repeat(300 * 1024)).catch(() => ({ status: 413 }))).status, 413, 'corpo grande demais');

  // listar
  r = await callTool('aaaaaaaa-1111', 'listar_departamentos', {});
  const list = r.json.result.content[0].text;
  assert(!r.json.result.isError);
  assert(list.includes('Redação · projeto painel-de-comando') && list.includes('Oficina de APIs') && !list.includes('Mezanino'), 'não lista a si mesmo');
  assert(list.includes('(id bbbbbbbb)'));
  assert(/Projetos para departamentos novos/.test(list) && list.includes('- site-institucional'), 'o gerente vê os projetos disponíveis');
  const listB = (await callTool('bbbbbbbb-2222', 'listar_departamentos', {})).json.result.content[0].text;
  assert(!/Projetos para departamentos novos/.test(listB), 'os outros não');
  assert(listB.includes('último recado: Terminei o módulo de comissões.'), 'a lista traz o último recado de cada departamento');

  // resolver destino
  assert.strictEqual(office._resolve('aaaaaaaa-1111', 'redacao').sid, 'bbbbbbbb-2222', 'sem acento e sem maiúscula');
  assert.strictEqual(office._resolve('aaaaaaaa-1111', 'bbbbbbbb').sid, 'bbbbbbbb-2222', 'id curto');
  assert.strictEqual(office._resolve('aaaaaaaa-1111', 'painel').sid, 'bbbbbbbb-2222', 'parte do projeto');
  assert(/Mais de um/.test(office._resolve('aaaaaaaa-1111', 'api-pagamentos').error), 'ambíguo');
  assert(/Não achei/.test(office._resolve('aaaaaaaa-1111', 'financeiro').error));
  assert(/Não achei/.test(office._resolve('aaaaaaaa-1111', 'mezanino').error), 'a si mesmo não conta');

  // perguntas inválidas / bloqueadas
  const err = async (sid, args) => {
    const x = (await callTool(sid, 'perguntar_departamento', args)).json.result;
    assert.strictEqual(x.isError, true, JSON.stringify(x));
    return x.content[0].text;
  };
  assert(/Escreva a pergunta/.test(await err('aaaaaaaa-1111', { departamento: 'Redação', pergunta: ' ' })));
  assert(/Não achei/.test(await err('aaaaaaaa-1111', { departamento: 'nada', pergunta: 'oi' })));
  blocked = { 'bbbbbbbb-2222': 'Essa conversa está trabalhando agora.' };
  assert(/trabalhando agora/.test(await err('aaaaaaaa-1111', { departamento: 'Redação', pergunta: 'oi' })));
  blocked = {};
  assert.strictEqual(approvals.length, 0, 'nada disso pediu aprovação ao usuário');

  // negada
  let p = callTool('aaaaaaaa-1111', 'perguntar_departamento', { departamento: 'Redação', pergunta: 'Qual é a regra de repasse?' });
  await until(() => approvals.length === 1);
  assert.strictEqual(approvals[0].sid, 'aaaaaaaa-1111', 'a aprovação aparece no chat de quem pergunta');
  assert.strictEqual(approvals[0].info.tool, 'Perguntar a outro departamento');
  assert(approvals[0].info.detail.startsWith('Redação: Qual é a regra'));
  assert.strictEqual(asked.length, 0, 'sem aprovação, nada é entregue');
  assert.strictEqual(office.state().asks[0].status, 'approval');
  approvals[0].resolve('deny');
  r = await p;
  assert.strictEqual(r.json.result.isError, true);
  assert(/não autorizou/.test(r.json.result.content[0].text));
  assert.strictEqual(asked.length, 0);
  assert.strictEqual(office.state().asks[0].status, 'denied');

  // aprovada: pergunta entregue, resposta devolvida
  p = callTool('aaaaaaaa-1111', 'perguntar_departamento', { departamento: 'Redação', pergunta: 'Qual é a regra de repasse?' });
  await until(() => approvals.length === 2);
  approvals[1].resolve('allow');
  r = await p;
  assert(!r.json.result.isError, JSON.stringify(r.json));
  assert.strictEqual(r.json.result.content[0].text, 'Resposta do departamento Redação:\n\nA regra é 70/30.');
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(asked[0].sid, 'bbbbbbbb-2222');
  assert(asked[0].text.startsWith('[Pergunta do departamento "Mezanino" (outro agente)') && asked[0].text.includes('Qual é a regra de repasse?') && /não edite arquivos/.test(asked[0].text), 'a pergunta chega identificada como vinda de outro agente');
  const a = office.state().asks.at(-1);
  assert.deepStrictEqual([a.status, a.fromName, a.toName, a.answer], ['answered', 'Mezanino', 'Redação', 'A regra é 70/30.']);
  assert(feed.some(([sid, t]) => sid === 'aaaaaaaa-1111' && /Perguntou a Redação/.test(t)) && feed.some(([sid, t]) => sid === 'bbbbbbbb-2222' && /Pergunta de Mezanino/.test(t)) && feed.some(([, t]) => /Redação respondeu/.test(t)), 'linhas no feed dos dois lados');

  // resposta com erro
  answerWith = () => ({ error: 'Authentication error' });
  p = callTool('aaaaaaaa-1111', 'perguntar_departamento', { departamento: 'Redação', pergunta: 'de novo' });
  await until(() => approvals.length === 3);
  approvals[2].resolve('allow');
  r = await p;
  assert(r.json.result.isError && /Authentication error/.test(r.json.result.content[0].text));
  assert.strictEqual(office.state().asks.at(-1).status, 'failed');

  // demora: devolve aviso e depois registra a resposta tardia
  const slow = { ...chat };
  chat.ask = (sid, text) => new Promise((resolve) => setTimeout(() => resolve({ text: 'resposta tardia' }), 900));
  p = callTool('aaaaaaaa-1111', 'perguntar_departamento', { departamento: 'Redação', pergunta: 'demora' });
  await until(() => approvals.length === 4);
  approvals[3].resolve('allow');
  r = await p;
  assert(r.json.result.isError && /demorou demais/.test(r.json.result.content[0].text));
  assert.strictEqual(office.state().asks.at(-1).status, 'timeout');
  await until(() => office.state().asks.at(-1).status === 'answered', 2000);
  assert.strictEqual(office.state().asks.at(-1).answer, 'resposta tardia');
  chat.ask = slow.ask;
  answerWith = () => ({ text: 'ok' });

  // regras anti-confusão (com uma pergunta ainda esperando aprovação)
  const n0 = approvals.length;
  p = callTool('aaaaaaaa-1111', 'perguntar_departamento', { departamento: 'Redação', pergunta: 'primeira' });
  await until(() => approvals.length === n0 + 1);
  assert(/já tem uma pergunta em andamento/.test(await err('aaaaaaaa-1111', { departamento: 'Oficina de APIs', pergunta: 'segunda' })), 'uma por vez por departamento');
  // Oficina perguntando a Mezanino, que está esperando a resposta da Redação
  assert(/esperando a resposta de outro departamento/.test(await err('cccccccc-3333', { departamento: 'Mezanino', pergunta: 'a mim?' })), 'não pergunta a quem está esperando resposta de outro (sem deadlock)');
  approvals[n0].resolve('abort');
  r = await p;
  assert(r.json.result.isError && /cancelada/.test(r.json.result.content[0].text));
  assert.strictEqual(office.state().asks.at(-1).status, 'failed');

  // limite global de perguntas simultâneas
  const hold = [];
  for (const [from, to, name] of [['aaaaaaaa-1111', 'Redação'], ['bbbbbbbb-2222', 'Oficina de APIs'], ['cccccccc-3333', 'Doca de Entregas']]) {
    const k = approvals.length;
    hold.push(callTool(from, 'perguntar_departamento', { departamento: to, pergunta: 'x ' + name }));
    await until(() => approvals.length === k + 1);
  }
  assert(/perguntas demais em andamento/.test(await err('dddddddd-4444', { departamento: 'Mezanino', pergunta: 'quarta' })), 'no máximo 3 ao mesmo tempo');
  for (const a2 of approvals.slice(-3)) a2.resolve('deny');
  await Promise.all(hold);

  // limite por tempo
  const spam = 'dddddddd-4444';
  let blockedAt = 0;
  for (let i = 0; i < 12; i++) {
    const k = approvals.length;
    const pr = callTool(spam, 'perguntar_departamento', { departamento: 'Redação', pergunta: 'spam ' + i });
    await Promise.race([until(() => approvals.length === k + 1, 300).catch(() => null), pr]);
    if (approvals.length === k + 1) approvals[k].resolve('deny');
    const res = await pr;
    if (/Perguntas demais em pouco tempo/.test(res.json.result.content[0].text)) {
      blockedAt = i;
      break;
    }
  }
  assert.strictEqual(blockedAt, 8, 'a 9ª pergunta em 10 minutos é barrada');


  // ------------------------------------------------ delegação encadeada (plano aprovado de uma vez)
  const dtool = async (sid, args) => (await callTool(sid, 'delegar_tarefas', args)).json.result;
  const derr = async (sid, args) => {
    const x = await dtool(sid, args);
    assert.strictEqual(x.isError, true, JSON.stringify(x));
    return x.content[0].text;
  };
  const nAp = approvals.length;
  const nAsked = asked.length;
  assert(/objetivo/i.test(await derr('aaaaaaaa-1111', { objetivo: ' ', etapas: [{ departamento: 'Redação', tarefa: 'x' }] })));
  assert(/ao menos uma etapa/.test(await derr('aaaaaaaa-1111', { objetivo: 'o', etapas: [] })));
  assert(/No máximo 6 etapas/.test(await derr('aaaaaaaa-1111', { objetivo: 'o', etapas: Array.from({ length: 7 }, () => ({ departamento: 'Redação', tarefa: 'x' })) })));
  assert(/Etapa 1: Não achei/.test(await derr('aaaaaaaa-1111', { objetivo: 'o', etapas: [{ departamento: 'financeiro', tarefa: 'x' }] })));
  assert(/Etapa 2: .*Mais de um/.test(await derr('aaaaaaaa-1111', { objetivo: 'o', etapas: [{ departamento: 'Redação', tarefa: 'x' }, { departamento: 'api-pagamentos', tarefa: 'y' }] })));
  assert(/está sem tarefa/.test(await derr('aaaaaaaa-1111', { objetivo: 'o', etapas: [{ departamento: 'Redação', tarefa: '  ' }] })));
  blocked = { 'bbbbbbbb-2222': 'ele está respondendo outra coisa agora.' };
  assert(/Não deu para começar.*Redação.*respondendo outra coisa/.test(await derr('aaaaaaaa-1111', { objetivo: 'o', etapas: [{ departamento: 'Redação', tarefa: 'x' }] })));
  blocked = {};
  assert.strictEqual(approvals.length, nAp, 'planos inválidos não incomodam o usuário');

  // negado: nada é entregue
  const plan1 = [{ departamento: 'Redação', tarefa: 'Escreva o texto da tela de login' }, { departamento: 'Oficina de APIs', tarefa: 'Crie o endpoint de login' }];
  p = dtool('aaaaaaaa-1111', { objetivo: 'Tela de login', etapas: plan1 });
  await until(() => approvals.length === nAp + 1);
  const pa = approvals[nAp];
  assert.strictEqual(pa.sid, 'aaaaaaaa-1111', 'o plano é aprovado no chat do gerente');
  assert.strictEqual(pa.info.kind, 'plan');
  assert(pa.info.detail.includes('Objetivo: Tela de login') && pa.info.detail.includes('1. Redação: Escreva o texto') && pa.info.detail.includes('2. Oficina de APIs: Crie o endpoint'), pa.info.detail);
  assert(/2 etapas/.test(pa.info.description));
  assert.strictEqual(asked.length, nAsked, 'sem aprovação nada é entregue');
  const gate = office.state().asks.at(-1);
  assert.deepStrictEqual([gate.kind, gate.status, gate.fromName], ['plan', 'approval', 'Mezanino'], 'a sala do gerente mostra o plano esperando');
  assert(/já tem um plano em andamento/.test(await derr('aaaaaaaa-1111', { objetivo: 'o', etapas: plan1 })), 'um plano por vez');
  pa.resolve('deny');
  let x = await p;
  assert(x.isError && /não aprovou o plano/.test(x.content[0].text));
  assert.strictEqual(asked.length, nAsked);
  assert.strictEqual(office.state().plans.at(-1).status, 'denied');

  // aprovado: etapas em ordem, resultado de uma segue para a próxima
  let step = 0;
  answerWith = (sid) => ({ text: step++ === 0 ? 'Texto pronto: "Entre com seu e-mail".' : 'Endpoint POST /login criado em auth.ts.' });
  let guest = null;
  const slowAsk = chat.ask;
  chat.ask = (sid, text) => {
    asked.push({ sid, text });
    return new Promise((resolve) =>
      setTimeout(async () => {
        if (sid === 'bbbbbbbb-2222') guest = await derr('bbbbbbbb-2222', { objetivo: 'o', etapas: [{ departamento: 'Doca de Entregas', tarefa: 'z' }] });
        resolve(answerWith(sid, text));
      }, 40)
    );
  };
  p = dtool('aaaaaaaa-1111', { objetivo: 'Tela de login', etapas: plan1 });
  await until(() => approvals.length === nAp + 2);
  assert.strictEqual(approvals[nAp + 1].info.kind, 'plan');
  approvals[nAp + 1].resolve('allow');
  x = await p;
  assert(!x.isError, JSON.stringify(x));
  assert(x.content[0].text.startsWith('Plano concluído'));
  assert(x.content[0].text.includes('Etapa 1 · Redação (done)') && x.content[0].text.includes('Texto pronto') && x.content[0].text.includes('Endpoint POST /login'));
  assert.deepStrictEqual(asked.slice(nAsked).map((q) => q.sid), ['bbbbbbbb-2222', 'cccccccc-3333'], 'ordem das etapas');
  const [m1, m2] = asked.slice(nAsked).map((q) => q.text);
  assert(m1.startsWith('[Tarefa delegada pelo departamento "Mezanino" (outro agente)') && m1.includes('Objetivo geral: Tela de login') && m1.includes('etapa 1 de 2') && m1.includes('Escreva o texto da tela de login') && !m1.includes('etapas anteriores'));
  assert(m2.includes('etapa 2 de 2') && m2.includes('Resultado das etapas anteriores') && m2.includes('Etapa 1 (Redação): Texto pronto') && m2.includes('Crie o endpoint de login'), 'o resultado da etapa 1 segue para a 2');
  assert(/Não delegue a outros departamentos/.test(m1), 'delegado é avisado para não delegar adiante');
  assert(/Só o gerente do Escritório pode delegar/.test(guest), 'quem recebe tarefa não delega adiante (só o gerente delega)');
  const pl = office.state().plans.at(-1);
  assert.deepStrictEqual([pl.status, ...pl.steps.map((q) => q.status)], ['done', 'done', 'done']);
  const tasks = office.state().asks.filter((q) => q.kind === 'task').slice(-2);
  assert.deepStrictEqual(tasks.map((q) => [q.fromName, q.toName, q.status]), [['Mezanino', 'Redação', 'answered'], ['Mezanino', 'Oficina de APIs', 'answered']], 'cada etapa vira um envelope entre as salas');
  assert(feed.some(([sid, t]) => sid === 'aaaaaaaa-1111' && /Plano aprovado: 2 etapas/.test(t)) && feed.some(([sid, t]) => sid === 'cccccccc-3333' && /Tarefa de Mezanino/.test(t)));
  chat.ask = slowAsk;

  // uma etapa falha: o plano para e o resto fica "não executada"
  const nA2 = asked.length;
  answerWith = (sid) => (sid === 'bbbbbbbb-2222' ? { error: 'Authentication error' } : { text: 'não devia rodar' });
  p = dtool('aaaaaaaa-1111', { objetivo: 'Falha', etapas: plan1 });
  await until(() => approvals.length === nAp + 3);
  approvals[nAp + 2].resolve('allow');
  x = await p;
  assert(x.isError && /Plano interrompido\. A etapa 1 \(Redação\) falhou: Authentication error/.test(x.content[0].text), x.content[0].text);
  assert.strictEqual(asked.length, nA2 + 1, 'a etapa 2 nem começou');
  const pf = office.state().plans.at(-1);
  assert.deepStrictEqual([pf.status, pf.steps[0].status, pf.steps[1].status], ['failed', 'failed', 'skipped']);
  assert(/\(não executada\)/.test(x.content[0].text));

  // limite de planos por departamento (3 em 10 min)
  assert(/Planos demais em pouco tempo/.test(await derr('aaaaaaaa-1111', { objetivo: 'o', etapas: plan1 })));
  answerWith = () => ({ text: 'ok' });

  // só o gerente delega
  assert(/Só o gerente do Escritório pode delegar/.test(await derr('bbbbbbbb-2222', { objetivo: 'o', etapas: [{ departamento: 'Mezanino', tarefa: 'x' }] })), 'quem não é gerente não delega');
  assert.strictEqual(approvals.length, nAp + 3, 'e isso não incomoda o usuário');
  assert.strictEqual(office.isManager('aaaaaaaa-1111'), true);
  assert(/GERENTE/.test(office.systemNote('aaaaaaaa-1111')) && /novo_departamento/.test(office.systemNote('aaaaaaaa-1111')) && /sem depender de ele explicar/.test(office.systemNote('aaaaaaaa-1111')), 'o gerente recebe a instrução de decidir sozinho');
  assert(!/GERENTE/.test(office.systemNote('bbbbbbbb-2222')) && /\[Tarefa delegada/.test(office.systemNote('bbbbbbbb-2222')), 'os outros só sabem receber tarefas');

  // aprovação cancelada pelo usuário (ex.: ele parou o chat). Outro gerente: o limite de planos é por departamento
  manager = 'bbbbbbbb-2222';
  p = dtool('bbbbbbbb-2222', { objetivo: 'o', etapas: [{ departamento: 'Mezanino', tarefa: 'x' }] });
  await until(() => approvals.length === nAp + 4);
  approvals[nAp + 3].resolve('abort');
  x = await p;
  assert(x.isError && /cancelado/.test(x.content[0].text));

  // departamento novo: validações (nada disso cria nem incomoda o usuário)
  manager = 'cccccccc-3333';
  const nPrep = prepared.length;
  const nAp2 = approvals.length;
  assert(/Etapa 1: O hub não conhece o projeto "financeiro"/.test(await derr('cccccccc-3333', { objetivo: 'o', etapas: [{ novo_departamento: { projeto: 'financeiro' }, tarefa: 'x' }] })));
  assert(/Etapa 1: Mais de um projeto combina com "site"/.test(await derr('cccccccc-3333', { objetivo: 'o', etapas: [{ novo_departamento: { projeto: 'site' }, tarefa: 'x' }] })));
  assert(/Etapa 1: Diga em qual projeto/.test(await derr('cccccccc-3333', { objetivo: 'o', etapas: [{ novo_departamento: {}, tarefa: 'x' }] })));
  assert(/use departamento OU novo_departamento/.test(await derr('cccccccc-3333', { objetivo: 'o', etapas: [{ departamento: 'Redação', novo_departamento: { projeto: 'indica-monorepo' }, tarefa: 'x' }] })));
  assert(/No máximo 2 departamentos novos/.test(await derr('cccccccc-3333', { objetivo: 'o', etapas: Array.from({ length: 3 }, () => ({ novo_departamento: { projeto: 'indica-monorepo' }, tarefa: 'x' })) })));
  assert.strictEqual(prepared.length, nPrep);
  assert.strictEqual(approvals.length, nAp2);

  // departamento novo: só nasce DEPOIS da aprovação, quando a etapa chega, e o plano avisa
  const nAsk3 = asked.length;
  step = 0;
  answerWith = (sid) => ({ text: sid.startsWith('novo-') ? 'Página criada.' : 'Texto pronto.' });
  p = dtool('cccccccc-3333', { objetivo: 'Landing page', etapas: [{ departamento: 'Redação', tarefa: 'Escreva o texto da landing' }, { novo_departamento: { projeto: 'indica-monorepo' }, tarefa: 'Monte a página com o texto' }] });
  await until(() => approvals.length === nAp2 + 1);
  const pn = approvals[nAp2];
  assert(pn.info.detail.includes('2. [NOVO departamento em indica-monorepo]: Monte a página') && /cria 1 departamento novo/.test(pn.info.description), pn.info.detail + pn.info.description);
  assert.strictEqual(prepared.length, nPrep, 'antes da aprovação nada é criado');
  pn.resolve('allow');
  x = await p;
  assert(!x.isError, JSON.stringify(x));
  assert.strictEqual(prepared.length, nPrep + 1);
  assert.strictEqual(prepared.at(-1), '/home/u/projetos/indica-monorepo');
  assert.deepStrictEqual(asked.slice(nAsk3).map((q) => q.sid), ['bbbbbbbb-2222', `novo-${prepared.length}`], 'a tarefa vai para o chat recém-criado');
  const mNew = asked.at(-1).text;
  assert(mNew.includes('Você é um departamento novo, criado pelo gerente') && mNew.includes('Monte a página com o texto') && mNew.includes('Etapa 1 (Redação): Texto pronto.'));
  assert(x.content[0].text.includes('Novo departamento (indica-monorepo) (done)') && x.content[0].text.includes('Página criada.'));
  assert(feed.some(([sid, t]) => sid === 'cccccccc-3333' && /Criou um novo departamento em indica-monorepo/.test(t)));
  const pnl = office.state().plans.at(-1);
  assert.strictEqual(pnl.steps[1].toName, 'Novo departamento (indica-monorepo)');

  // falha ao criar o departamento: plano para
  prepareFail = 'Essa pasta não existe.';
  manager = 'dddddddd-4444';
  p = dtool('dddddddd-4444', { objetivo: 'x', etapas: [{ novo_departamento: { projeto: 'site-blog' }, tarefa: 'Faça' }] });
  await until(() => approvals.length === nAp2 + 2);
  approvals[nAp2 + 1].resolve('allow');
  x = await p;
  assert(x.isError && /Não deu para criar o departamento: Essa pasta não existe/.test(x.content[0].text), x.content[0].text);
  prepareFail = '';

  // o Claude Code desistiu da chamada (tempo ou Parar) e fechou a conexão: o plano pendente some e não roda mais
  {
    manager = 'dddddddd-4444';
    const nAp = approvals.length;
    const nPrepB = prepared.length;
    const nAskB = asked.length;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'delegar_tarefas', arguments: { objetivo: 'x', etapas: [{ novo_departamento: { projeto: 'site-blog' }, tarefa: 'Faça' }] } } });
    const hreq = http.request({ host: '127.0.0.1', port: office._port(), path: `/mcp/${office._token}/dddddddd-4444`, method: 'POST', headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${office._port()}` } });
    hreq.on('error', () => {});
    hreq.end(body);
    await until(() => approvals.length === nAp + 1);
    assert.strictEqual(approvals[nAp].extra.timeoutMs, 15 * 60 * 1000, 'o hub também tem prazo para a aprovação');
    hreq.destroy(); // o cliente desistiu
    await until(() => approvals[nAp].dropped);
    await sleep(80);
    assert.strictEqual(office.state().plans.at(-1).status, 'failed', 'plano cancelado');
    assert.strictEqual(prepared.length, nPrepB, 'nenhum departamento foi criado');
    assert.strictEqual(asked.length, nAskB, 'nada foi delegado');
  }

  // sem resposta do usuário dentro do prazo: cancela e diz isso ao gerente
  {
    const office2 = createOffice({ collector, chat, getConfig: () => cfg, onChange: () => {}, timeoutMs: 400, approvalTimeoutMs: 150, getManager: () => 'dddddddd-4444', listProjects: () => PROJECTS });
    assert.strictEqual(await office2.start(), true);
    const nPrepC = prepared.length;
    const res = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delegar_tarefas', arguments: { objetivo: 'x', etapas: [{ novo_departamento: { projeto: 'site-blog' }, tarefa: 'Faça' }] } } });
      const q = http.request({ host: '127.0.0.1', port: office2._port(), path: `/mcp/${office2._token}/dddddddd-4444`, method: 'POST', headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${office2._port()}` } }, (rs) => {
        let t = '';
        rs.on('data', (d) => (t += d));
        rs.on('end', () => resolve(JSON.parse(t)));
      });
      q.on('error', reject);
      q.end(data);
    });
    assert(res.result.isError && /a tempo/.test(res.result.content[0].text) && /nenhum departamento foi criado/.test(res.result.content[0].text), res.result.content[0].text);
    assert.strictEqual(prepared.length, nPrepC);
    office2.stop();
  }

  office.stop();
  assert.strictEqual(office.mcpConfig('aaaaaaaa-1111'), null);
  assert(changes.length > 5);
  console.log('OK: testes do Escritório passaram');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
