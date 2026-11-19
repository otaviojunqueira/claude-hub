'use strict';
// Teste do coletor com eventos e transcripts simulados (sem Electron, sem Claude Code).
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCollector } = require('../src/collector');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-test-'));
const hubDir = path.join(tmp, '.claude-hub');
const claudeDir = path.join(tmp, '.claude');
const projDir = path.join(claudeDir, 'projects', '-tmp-meu-projeto');
fs.mkdirSync(hubDir, { recursive: true });
fs.mkdirSync(projDir, { recursive: true });

let clock = Date.now();
const alerts = [];
const collector = createCollector({
  home: tmp,
  hubDir,
  claudeDir,
  now: () => clock,
  onAlert: (a) => alerts.push(a),
});

const eventsFile = path.join(hubDir, 'events.jsonl');
const emit = (ev) => {
  clock += 1000;
  fs.appendFileSync(eventsFile, JSON.stringify({ ts: clock, ...ev }) + '\n');
};
const transcript = path.join(projDir, 'sess-1.jsonl');
const writeT = (obj) => fs.appendFileSync(transcript, JSON.stringify(obj) + '\n');
const base = { session_id: 'sess-1', cwd: '/tmp/meu-projeto', transcript_path: transcript };

// 1) Evento antigo presente antes de abrir o hub: não pode gerar alerta (replay).
emit({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
emit({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'refatore o login' });
collector.pollOnce();
assert.equal(alerts.length, 0, 'replay não deve alertar');
let snap = collector.snapshot();
assert.equal(snap.sessions.length, 1);
assert.equal(snap.sessions[0].project, 'meu-projeto');
assert.equal(snap.sessions[0].status, 'working');

// 2) Fluxo ao vivo: ferramenta, subagente, permissão, fim.
emit({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test\nsegunda linha' } });
emit({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash' });
emit({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'Explore', description: 'Achar usos do login' } });
emit({ ...base, hook_event_name: 'SubagentStart', agent_id: 'ag-1', agent_type: 'Explore' });
emit({ ...base, hook_event_name: 'PreToolUse', agent_id: 'ag-1', agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'login' } });
collector.pollOnce();
snap = collector.snapshot();
let s = snap.sessions[0];
const leader = s.employees[0];
assert.ok(leader.isLeader);
assert.equal(leader.currentTool, 'Task');
assert.equal(leader.kind, 'delegate');
assert.equal(leader.stats.commands, 1);
assert.equal(leader.stats.delegations, 1);
assert.equal(s.employees.length, 2);
const sub = s.employees[1];
assert.equal(sub.type, 'Explore');
assert.equal(sub.currentAction, 'Grep: login');
assert.equal(sub.kind, 'read');
assert.equal(sub.status, 'working');
assert.equal(sub.description, 'Achar usos do login');
assert.equal(sub.tasks[0].title, 'Achar usos do login');
assert.equal(sub.tasks[0].status, 'running');
assert.equal(s.workingAgents, 1);

emit({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
collector.pollOnce();
assert.equal(collector.snapshot().sessions[0].status, 'waiting');
assert.equal(alerts.filter((a) => a.kind === 'waiting').length, 1);

emit({ ...base, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
emit({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/tmp/meu-projeto/a.js' } });
emit({ ...base, hook_event_name: 'SubagentStop', agent_id: 'ag-1', agent_type: 'Explore', last_assistant_message: 'achei 3 usos' });
collector.pollOnce();
assert.equal(alerts.filter((a) => a.kind === 'waiting').length, 1, 'notificação duplicada não gera segundo alerta');
assert.equal(collector.snapshot().sessions[0].status, 'working');
assert.equal(collector.snapshot().sessions[0].workingAgents, 0);

emit({ ...base, hook_event_name: 'Stop', last_assistant_message: 'Pronto, login refatorado.' });
collector.pollOnce();
s = collector.snapshot().sessions[0];
assert.equal(s.status, 'done');
const done = alerts.find((a) => a.kind === 'done');
assert.ok(done && done.durationMs > 0, 'alerta de término com duração');
const L = s.employees[0];
assert.equal(L.tasks.length, 1);
assert.equal(L.tasks[0].status, 'done');
assert.equal(L.tasks[0].title, 'refatore o login');
assert.equal(L.tasks[0].result, 'Pronto, login refatorado.');
assert.equal(L.tasks[0].files, 1);
assert.deepEqual(L.tasks[0].fileNames, ['a.js']);
assert.equal(L.stats.edits, 1);
assert.ok(L.segments.every((g) => g.end !== null), 'tudo fechado após o Stop');
const kinds = new Set(L.segments.map((g) => g.kind));
for (const k of ['think', 'run', 'delegate', 'edit', 'wait']) assert.ok(kinds.has(k), 'segmento ' + k);
assert.ok(L.stats.waitMs > 0 && L.stats.activeMs > 0);
const E = s.employees.find((x) => x.type === 'Explore');
assert.equal(E.status, 'done');
assert.equal(E.tasks[0].status, 'done');
assert.equal(E.tasks[0].result, 'achei 3 usos');

// 3) Tokens: mensagem repetida (streaming) conta uma vez; sidechain entra em "sub".
const A = (id, usage, extra = {}) => ({
  type: 'assistant',
  timestamp: new Date(clock).toISOString(),
  cwd: '/tmp/meu-projeto',
  message: { id, model: 'claude-sonnet-5-5', usage, content: [], ...extra },
});
writeT(A('m1', { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }));
writeT(A('m1', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 })); // versão final
writeT({ ...A('m2', { input_tokens: 10, output_tokens: 20 }), isSidechain: true });
fs.writeFileSync(path.join(projDir, 'sess-1.jsonl.tmp'), '');
collector.pollOnce();
s = collector.snapshot().sessions[0];
assert.equal(s.tokens.input, 110);
assert.equal(s.tokens.output, 70);
assert.equal(s.tokens.cacheRead, 1000);
assert.equal(s.tokens.cacheWrite, 200);
assert.equal(s.tokens.sub.output, 20);
assert.equal(s.model, 'sonnet-5-5');

// 4) Sessão sem hooks, descoberta só pelo transcript.
const t2 = path.join(projDir, 'sess-2.jsonl');
fs.writeFileSync(
  t2,
  [
    { type: 'user', timestamp: new Date(clock).toISOString(), cwd: '/tmp/outro', message: { role: 'user', content: 'oi' } },
    { ...A('x1', { input_tokens: 1, output_tokens: 2 }), cwd: '/tmp/outro', message: { id: 'x1', model: 'claude-haiku-4-5', usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/outro/x.txt' } }] } },
  ]
    .map((o) => JSON.stringify(o))
    .join('\n') + '\n'
);
clock += 4000; // passa o intervalo de descoberta
collector.pollOnce();
collector.pollOnce();
snap = collector.snapshot();
const s2 = snap.sessions.find((x) => x.id === 'sess-2');
assert.ok(s2, 'sessão sem hooks deve aparecer');
assert.equal(s2.source, 'transcript');
assert.equal(s2.project, 'outro');
assert.equal(s2.status, 'working');
assert.equal(s2.employees[0].currentAction, 'Read: /tmp/outro/x.txt');
assert.equal(s2.employees[0].tasks[0].title, 'oi');
clock += 130000; // sem atividade -> ocioso
collector.pollOnce();
assert.equal(collector.snapshot().sessions.find((x) => x.id === 'sess-2').status, 'idle');

// 4b) Nome do chat: renomeado > automático > resumo; só o título do líder conta.
fs.appendFileSync(t2, JSON.stringify({ type: 'ai-title', aiTitle: 'Ajustar edital', sessionId: 'sess-2' }) + '\n');
clock += 1000;
collector.pollOnce();
assert.equal(collector.snapshot().sessions.find((x) => x.id === 'sess-2').title, 'Ajustar edital');
fs.appendFileSync(t2, JSON.stringify({ type: 'custom-title', customTitle: 'Prorrogar edital', sessionId: 'sess-2' }) + '\n');
clock += 1000;
collector.pollOnce();
assert.equal(collector.snapshot().sessions.find((x) => x.id === 'sess-2').title, 'Prorrogar edital');
fs.appendFileSync(t2, JSON.stringify({ type: 'ai-title', aiTitle: 'Outro automático', sessionId: 'sess-2' }) + '\n');
clock += 1000;
collector.pollOnce();
assert.equal(collector.snapshot().sessions.find((x) => x.id === 'sess-2').title, 'Prorrogar edital', 'o nome dado por você vence o automático');
assert.equal(collector.sessionInfo('sess-2').transcriptPath, t2);
assert.equal(collector.sessionInfo('nao-existe'), null);

// 5) Dismiss some até haver nova atividade.
collector.dismiss('sess-1');
assert.ok(!collector.snapshot().sessions.find((x) => x.id === 'sess-1'));
emit({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'mais uma' });
collector.pollOnce();
assert.ok(collector.snapshot().sessions.find((x) => x.id === 'sess-1'), 'volta com nova atividade');

// 6) O script de hook real: grava linha válida, corta texto longo e sai com 0 mesmo com entrada inválida.
const hook = path.join(__dirname, '..', 'hook', 'claude-hub-hook.py');
const env = { ...process.env, CLAUDE_HUB_DIR: path.join(tmp, 'hook-out') };
let r = spawnSync('python3', [hook], {
  input: JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: 'h1',
    tool_name: 'Bash',
    tool_input: { command: 'x'.repeat(1000) },
    tool_response: { stdout: 'SEGREDO'.repeat(1000) },
  }),
  env,
});
assert.equal(r.status, 0);
assert.equal(r.stdout.length, 0, 'hook não pode escrever no stdout');
const line = JSON.parse(fs.readFileSync(path.join(tmp, 'hook-out', 'events.jsonl'), 'utf8').trim());
assert.equal(line.session_id, 'h1');
assert.ok(line.tool_input.command.length <= 301);
assert.ok(!('tool_response' in line), 'resposta da ferramenta não é guardada');
r = spawnSync('python3', [hook], { input: 'isto não é json', env });
assert.equal(r.status, 0, 'hook nunca falha');

// 7) "Limpar inativos" também esconde sessão 'trabalhando' sem sinal há muito tempo, mas mantém a viva.
emit({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' } });
emit({ session_id: 'sess-viva', cwd: '/tmp/viva', hook_event_name: 'UserPromptSubmit', prompt: 'oi' });
collector.pollOnce();
clock += 6 * 60e3; // sess-1 fica 6 min sem sinal
emit({ session_id: 'sess-viva', cwd: '/tmp/viva', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/y' } });
collector.pollOnce();
assert.ok(collector.snapshot().sessions.find((x) => x.id === 'sess-1').stale, 'sess-1 sem sinal');
collector.dismissInactive();
const ids = collector.snapshot().sessions.map((x) => x.id);
assert.ok(!ids.includes('sess-1'), 'sessão sem sinal some');
assert.ok(ids.includes('sess-viva'), 'sessão viva fica');

// 7b) "Limpar inativos" poupa o gerente e devolve quem saiu; undismiss traz de volta.
const keepRes = createCollector({ home: tmp, hubDir: path.join(tmp, 'keep'), claudeDir, now: () => clock, noTranscripts: true });
fs.mkdirSync(path.join(tmp, 'keep'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'keep', 'events.jsonl'), ['k-a', 'k-b'].map((id) => JSON.stringify({ ts: clock, session_id: id, cwd: '/tmp/' + id, hook_event_name: 'Stop' })).join('\n') + '\n');
keepRes.pollOnce();
assert.equal(keepRes.snapshot().sessions.length, 2);
const gone = keepRes.dismissInactive(['k-a']);
assert.deepEqual(gone, ['k-b'], 'o gerente (k-a) fica, o outro sai');
assert.deepEqual(keepRes.snapshot().sessions.map((x) => x.id), ['k-a']);
keepRes.undismiss(['k-b']);
assert.equal(keepRes.snapshot().sessions.length, 2, 'desfazer traz de volta');

// 7c) Fim de expediente: os departamentos ficam, só os funcionários vão embora; nova atividade traz de volta.
keepRes.endShift();
let after = keepRes.snapshot().sessions;
assert.equal(after.length, 2, 'departamentos continuam na planta');
assert.ok(after.every((x) => x.status === 'ended' && x.employees.every((e) => e.status === 'ended')), 'equipe foi embora');
fs.appendFileSync(path.join(tmp, 'keep', 'events.jsonl'), JSON.stringify({ ts: clock + 5000, session_id: 'k-a', cwd: '/tmp/k-a', hook_event_name: 'UserPromptSubmit', prompt: 'volta' }) + '\n');
clock += 6000;
keepRes.pollOnce();
after = keepRes.snapshot().sessions;
assert.equal(after.find((x) => x.id === 'k-a').status, 'working', 'nova atividade traz a equipe de volta');
assert.equal(after.find((x) => x.id === 'k-b').status, 'ended', 'o outro continua vazio');

// 8) Relatório de expediente: relê todo o arquivo de eventos a partir de um instante.
const rc = createCollector({ home: tmp, hubDir, claudeDir, now: () => clock, replayAll: true, readOnly: true, noTranscripts: true, taskMax: 500, from: 1 });
rc.pollOnce();
const rep = rc.reportData();
const rs = rep.find((x) => x.id === 'sess-1');
assert.ok(rs, 'sessão no relatório');
const rl = rs.employees.find((x) => x.isLeader);
assert.ok(rl.tasks.length >= 1 && rl.stats.edits === 1 && rl.stats.waitMs > 0 && rl.stats.activeMs > 0);
assert.ok(rs.employees.some((x) => x.type === 'Explore' && x.tasks[0].result === 'achei 3 usos'));
assert.ok(!('cost' in rl.stats), 'sem custo');
const rc2 = createCollector({ home: tmp, hubDir, claudeDir, now: () => clock, replayAll: true, readOnly: true, noTranscripts: true, from: clock + 1000 });
rc2.pollOnce();
assert.equal(rc2.reportData().length, 0, 'nada depois de `from`');

// 9) Cérebro: quem mexeu em notas do vault aparece no snapshot (só com o vault ligado).
const vaultDir = path.join(tmp, 'cerebro');
fs.mkdirSync(path.join(vaultDir, 'Projetos'), { recursive: true });
assert.equal(collector.snapshot().vault, null, 'sem vault, sem campo');
collector.setVault(fs.realpathSync(vaultDir));
const vs = { session_id: 'sess-viva', cwd: '/tmp/viva' };
emit({ ...vs, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(fs.realpathSync(vaultDir), 'Projetos', 'Plano.md') } });
emit({ ...vs, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(fs.realpathSync(vaultDir), 'Projetos', 'Plano.md') } });
emit({ ...vs, hook_event_name: 'PreToolUse', agent_id: 'ag-v', agent_type: 'Explore', tool_name: 'Write', tool_input: { file_path: path.join(fs.realpathSync(vaultDir), 'Nova.md') } });
emit({ ...vs, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/viva/fora.js' } });
collector.pollOnce();
let vsnap = collector.snapshot().vault;
assert.equal(vsnap.name, 'cerebro');
assert.deepEqual(vsnap.live.map((x) => [x.note, x.op, x.who]), [['Nova.md', 'write', 'Explore'], ['Projetos/Plano.md', 'read', null]], 'repetição junta; arquivo fora do vault não conta');
assert.equal(vsnap.live[1].project, 'viva');
clock += 60e3;
vsnap = collector.snapshot().vault;
assert.equal(vsnap.live.length, 0, 'depois de 30 s deixa de estar ao vivo');
assert.equal(vsnap.recent.length, 2, 'mas fica nos recentes');
collector.setVault(null);
assert.equal(collector.snapshot().vault, null);

// 10) Escritório: linha avulsa no feed e resumo amigável da ferramenta de perguntar.
collector.note('sess-viva', '✉ Perguntou a Redação: qual a regra?');
collector.note('sessao-que-nao-existe', 'ignorada');
collector.pollOnce();
const asked = collector.snapshot().feed.filter((f) => f.kind === 'ask');
assert.equal(asked.length, 1);
assert.equal(asked[0].text, '✉ Perguntou a Redação: qual a regra?');
assert.equal(asked[0].sessionId, 'sess-viva');
const { summarizeTool } = require('../src/collector');
assert.equal(summarizeTool('mcp__escritorio__delegar_tarefas', { objetivo: 'Criar a tela de login' }), 'Delegando: Criar a tela de login');
assert.equal(summarizeTool('mcp__escritorio__perguntar_departamento', { departamento: 'Redação', pergunta: 'Qual a regra?' }), 'Perguntando a Redação: Qual a regra?');
assert.equal(summarizeTool('mcp__escritorio__listar_departamentos', {}), 'Vendo quem são os outros departamentos');

// 11) Parar pelo hub: o hook "Stop" não dispara numa interrupção; a sala volta a Ocioso e a tarefa fica "Interrompida".
const sp = { session_id: 'sess-parar', cwd: '/tmp/parar' };
emit({ ...sp, hook_event_name: 'UserPromptSubmit', prompt: 'faça algo longo' });
emit({ ...sp, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sleep 999' } });
collector.pollOnce();
assert.equal(collector.snapshot().sessions.find((x) => x.id === 'sess-parar').status, 'working');
collector.settle('sess-parar', 'Interrompido pelo usuário');
collector.settle('sessao-que-nao-existe', 'x');
let ps = collector.snapshot().sessions.find((x) => x.id === 'sess-parar');
assert.equal(ps.status, 'idle');
assert.equal(ps.employees[0].currentAction, null);
assert.equal(ps.employees[0].tasks[0].status, 'interrupted');
assert.ok(collector.snapshot().feed.some((f) => f.sessionId === 'sess-parar' && f.text === 'Interrompido pelo usuário'));
collector.settle('sess-parar', 'de novo'); // já ocioso: nada muda
assert.equal(collector.snapshot().feed.filter((f) => f.sessionId === 'sess-parar' && f.kind === 'stop').length, 1);

collector.stop();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('OK: todos os testes do coletor e do hook passaram');
