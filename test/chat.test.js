'use strict';
/* Testa o chat do departamento com um "claude" de mentira que fala o protocolo stream-json. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChat, parseHistory } = require('../src/chat');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-chat-'));
const project = path.join(tmp, 'proj');
fs.mkdirSync(project, { recursive: true });
const transcript = path.join(tmp, 'sess-A.jsonl');
const argsFile = path.join(tmp, 'args.json');
const lastFile = path.join(tmp, 'last.json');

const vaultDir = path.join(tmp, 'cerebro');
const vaultLog = path.join(tmp, 'vault-log.json');
fs.mkdirSync(path.join(vaultDir, '.bot'), { recursive: true });
fs.mkdirSync(path.join(vaultDir, 'Projetos'), { recursive: true });
fs.writeFileSync(path.join(vaultDir, 'Projetos', 'Plano.md'), 'plano');

const fake = path.join(tmp, 'claude');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');
const T0 = ${JSON.stringify(transcript)};
require('fs').mkdirSync(${JSON.stringify(path.join(tmp, 'projects', 'p1'))}, { recursive: true });
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
const A = process.argv;
const sid = A[(A.indexOf('--resume') >= 0 ? A.indexOf('--resume') : A.indexOf('--session-id')) + 1];
const T = sid === 'sess-A' ? T0 : require('path').join(${JSON.stringify(path.join(tmp, 'projects', 'p1'))}, sid + '.jsonl');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const add = (o) => fs.appendFileSync(T, JSON.stringify({ timestamp: new Date().toISOString(), ...o }) + '\\n');
out({ type: 'system', subtype: 'init', session_id: sid });
let waiting = null;
let n = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_response' && String(m.response.request_id).startsWith('vr-')) {
    const prev = fs.existsSync(${JSON.stringify(vaultLog)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(vaultLog)}, 'utf8')) : {};
    prev[m.response.request_id] = m.response.response.behavior;
    fs.writeFileSync(${JSON.stringify(vaultLog)}, JSON.stringify(prev));
    return;
  }
  if (m.type === 'control_response') {
    const r = m.response.response;
    add({ type: 'assistant', uuid: 'a' + (++n), message: { role: 'assistant', content: [{ type: 'text', text: r.behavior === 'allow' ? 'feito: ' + JSON.stringify(r.updatedInput) : 'negado: ' + r.message }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sid });
    return;
  }
  if (m.type === 'control_request' && m.request.subtype === 'interrupt' && !global.stubborn) {
    add({ type: 'user', uuid: 'u' + (++n), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'interrompido', session_id: sid });
    clearTimeout(waiting);
    return;
  }
  if (m.type !== 'user') return;
  fs.writeFileSync(${JSON.stringify(lastFile)}, JSON.stringify(m.message.content));
  const text = m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\\n');
  add({ type: 'user', uuid: 'u' + (++n), message: { role: 'user', content: text } });
  if (text.includes('Pergunta do departamento')) {
    add({ type: 'assistant', uuid: 'a' + (++n), message: { role: 'assistant', content: [{ type: 'text', text: 'A resposta é 42' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: text.includes('quebrar') ? '' : 'A resposta é 42', session_id: sid });
  } else if (text.includes('ferramentas')) {
    const ask = (id, tool, input) => out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, display_name: tool, input, tool_use_id: id } });
    ask('vr-lista', 'mcp__escritorio__listar_departamentos', {});
    ask('vr-pergunta', 'mcp__escritorio__perguntar_departamento', { departamento: 'Redação', pergunta: 'oi' });
    ask('vr-outra', 'mcp__outro__coisa', {});
    setTimeout(() => out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sid }), 700);
  } else if (text.includes('cerebro')) {
    const V = ${JSON.stringify(vaultDir)};
    const ask = (id, tool, input) => out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, display_name: tool, input, tool_use_id: id } });
    ask('vr-ler', 'Read', { file_path: V + '/Projetos/Plano.md' });
    ask('vr-escrever', 'Write', { file_path: V + '/Projetos/Nova.md', content: 'oi' });
    ask('vr-ponto', 'Read', { file_path: V + '/.bot/token.md' });
    ask('vr-bash', 'Bash', { command: 'cat ' + V + '/Projetos/Plano.md' });
    ask('vr-fora', 'Read', { file_path: '/etc/hostname' });
    setTimeout(() => out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sid }), 700);
  } else if (text.includes('rodar')) {
    out({ type: 'control_request', request_id: 'req-' + n, request: { subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input: { command: 'ls -la', description: 'lista' }, tool_use_id: 't' + n } });
  } else if (text.includes('teimoso')) {
    global.stubborn = true;
  } else if (text.includes('demorar')) {
    waiting = setTimeout(() => out({ type: 'result', subtype: 'success', is_error: false, result: 'tarde', session_id: sid }), 20000);
  } else if (text.includes('vazia')) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', errors: ['boom interno'], session_id: sid });
  } else if (text.includes('semconversa')) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'No conversation found with session ID: ' + sid, session_id: sid });
  } else if (text.includes('falhar')) {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Authentication error', session_id: sid });
  } else {
    add({ type: 'assistant', uuid: 'a' + (++n), message: { role: 'assistant', content: [{ type: 'text', text: 'Olá! Recebi: ' + text }, { type: 'tool_use', name: 'Read', input: { file_path: '/x/y.js' } }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sid });
  }
});
`, { mode: 0o755 });

let status = 'idle';
let lastActivity = 0;
const settled = [];
const collector = {
  settle: (sid, text) => settled.push([sid, text]),
  sessionInfo: (id) => (id === 'sess-B' ? { id, cwd: project, project: 'proj-b', status: 'idle', lastActivity: 0, transcriptPath: path.join(tmp, 'projects', 'p1', 'sess-B.jsonl') } : id === 'sess-A' ? { id, cwd: project, project: 'proj', status, lastActivity, transcriptPath: transcript } : id === 'sess-vazia' ? { id, cwd: project, project: 'proj', status: 'idle', lastActivity: 0, transcriptPath: path.join(tmp, 'nao-existe.jsonl') } : null),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await sleep(40);
  }
  throw new Error('tempo esgotado: ' + fn.toString());
};

(async () => {
  // histórico: pula meta, sidechain, tool_result e comandos; resume ferramentas
  fs.writeFileSync(transcript, [
    { type: 'user', uuid: 'h1', message: { role: 'user', content: 'primeira pergunta' } },
    { type: 'user', uuid: 'h2', isMeta: true, message: { role: 'user', content: 'meta' } },
    { type: 'user', uuid: 'h3', message: { role: 'user', content: '<command-name>/rename</command-name>' } },
    { type: 'assistant', uuid: 'h4', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'resposta **um**' }, { type: 'tool_use', name: 'Edit', input: { file_path: '/a/b.ts' } }] } },
    { type: 'user', uuid: 'h5', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', uuid: 'h6', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'do subagente' }] } },
    { type: 'attachment', attachment: {} },
  ].map((o) => JSON.stringify(o)).join('\n') + '\nlinha quebrada{\n');
  let h = parseHistory(transcript).messages;
  assert.deepStrictEqual(h.map((m) => [m.role, m.kind]), [['user', 'text'], ['assistant', 'text'], ['assistant', 'tool']]);
  assert.strictEqual(h[0].text, 'primeira pergunta');
  assert.strictEqual(h[2].text, 'Edit: /a/b.ts');

  const events = [];
  const chat = createChat({ collector, getConfig: () => ({ claudeBin: fake }), claudeDir: tmp, onChange: () => events.push(1) });

  // validações
  assert(chat.send('sess-A', '', 'ask').error);
  assert(chat.send('sess-A', 'oi', 'bypassPermissions').error);
  assert(chat.send('outra', 'oi', 'ask').error);
  assert(chat.send('sess-A', 'x'.repeat(20001), 'ask').error);

  // mensagem simples
  assert.strictEqual(chat.send('sess-A', 'bom dia', 'ask').ok, true);
  assert(chat.poll('sess-A').state.busy);
  assert(chat.send('sess-A', 'outra', 'ask').error, 'não manda duas ao mesmo tempo');
  await until(() => !chat.poll('sess-A').state.busy);
  let p = chat.poll('sess-A');
  assert(p.messages.some((m) => m.role === 'user' && m.text === 'bom dia'));
  assert(p.messages.some((m) => m.kind === 'text' && m.text === 'Olá! Recebi: bom dia'));
  assert(p.messages.some((m) => m.kind === 'tool' && m.text === 'Read: /x/y.js'));
  assert.strictEqual(chat.poll('sess-A', p.rev).messages, null, 'sem mudança não reenvia o histórico');
  const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.deepStrictEqual(args.slice(0, 8), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio']);
  assert(args.includes('--resume') && args.includes('sess-A') && args.includes('default'));
  assert(!args.some((a) => /dangerously|bypass/i.test(a)));

  // permissão: aprovar
  chat.send('sess-A', 'pode rodar isso', 'ask');
  await until(() => chat.poll('sess-A').state.pending.length === 1);
  const pend = chat.poll('sess-A').state.pending[0];
  assert.strictEqual(pend.tool, 'Bash');
  assert.strictEqual(pend.detail, 'ls -la');
  assert.strictEqual(pend.kind, 'perm');
  assert.deepStrictEqual(chat.inbox().map((x) => [x.sid, x.id, x.kind, x.tool]), [['sess-A', pend.id, 'perm', 'Bash']], 'a caixa de entrada lista o pedido');
  assert.strictEqual(chat.decide('sess-A', 'req-inexistente', 'allow'), false);
  assert.strictEqual(chat.decide('sess-A', pend.id, 'talvez'), false);
  assert.strictEqual(chat.decide('sess-A', pend.id, 'allow'), true);
  assert.strictEqual(chat.inbox().length, 0, 'decidido: sai da caixa de entrada');
  await until(() => !chat.poll('sess-A').state.busy);
  p = chat.poll('sess-A');
  assert(p.messages.some((m) => m.text.startsWith('feito: ') && m.text.includes('ls -la')), 'devolve a entrada original');

  // permissão: negar
  chat.send('sess-A', 'rodar de novo', 'ask');
  await until(() => chat.poll('sess-A').state.pending.length === 1);
  chat.decide('sess-A', chat.poll('sess-A').state.pending[0].id, 'deny');
  await until(() => !chat.poll('sess-A').state.busy);
  assert(chat.poll('sess-A').messages.some((m) => m.text.startsWith('negado: ')));

  // erro da resposta
  chat.send('sess-A', 'vai falhar', 'ask');
  await until(() => !chat.poll('sess-A').state.busy);
  assert.strictEqual(chat.poll('sess-A').state.error, 'Authentication error');

  // trocar de modo reabre o processo com o novo modo
  chat.send('sess-A', 'agora editando', 'edit');
  await until(() => !chat.poll('sess-A').state.busy);
  assert(JSON.parse(fs.readFileSync(argsFile, 'utf8')).includes('acceptEdits'));
  assert.strictEqual(chat.poll('sess-A').state.error, null, 'erro some na próxima mensagem boa');

  // parar uma resposta demorada
  chat.send('sess-A', 'vai demorar', 'edit');
  await sleep(300);
  assert(chat.poll('sess-A').state.busy);
  assert.strictEqual(chat.stop('sess-A'), true);
  await until(() => !chat.poll('sess-A').state.busy);
  assert(chat.poll('sess-A').messages.some((m) => m.kind === 'note' && m.text === 'Interrompido.'));
  // Parar de verdade: o processo não fica vivo em segundo plano e a sala volta a "Ocioso"
  assert.strictEqual(chat.hasProc('sess-A'), false, 'depois de parar, o processo é encerrado');
  assert.strictEqual(chat.poll('sess-A').state.error, null, 'parar não é erro');
  assert.deepStrictEqual(settled.at(-1), ['sess-A', 'Interrompido pelo usuário'], 'o escritório é avisado que a sala parou');
  // e dá para continuar a mesma conversa logo em seguida (reabre com --resume)
  assert.strictEqual(chat.send('sess-A', 'continua', 'edit').ok, true);
  await until(() => !chat.poll('sess-A').state.busy);
  assert(JSON.parse(fs.readFileSync(argsFile, 'utf8')).includes('--resume'));
  assert(chat.poll('sess-A').messages.some((m) => m.role === 'user' && m.text === 'continua'));
  // processo teimoso, que ignora o pedido de parar: o hub derruba o processo inteiro
  chat.send('sess-A', 'seja teimoso', 'edit');
  await until(() => chat.poll('sess-A').state.busy && chat.hasProc('sess-A'));
  await sleep(300);
  assert.strictEqual(chat.stop('sess-A'), true);
  await until(() => !chat.hasProc('sess-A'), 6000);
  assert.strictEqual(chat.poll('sess-A').state.busy, false);
  assert.strictEqual(chat.poll('sess-A').state.error, null, 'derrubar um processo que não obedeceu também não é erro');

  // sessão trabalhando por fora (VS Code): recusa
  status = 'working';
  lastActivity = Date.now();
  await sleep(4200); // passa o intervalo de tolerância depois do último turno do hub
  let r = chat.send('sess-A', 'oi', 'edit');
  assert(r.error && /VS Code/.test(r.error), r.error);
  assert(chat.poll('sess-A').state.blocked);
  status = 'idle';
  assert.strictEqual(chat.send('sess-A', 'agora pode', 'edit').ok, true);
  await until(() => !chat.poll('sess-A').state.busy);


  // ---- compositor: modelo, esforço, modos, anexos, comandos e arquivos
  const chat2 = createChat({ collector, getConfig: () => ({ claudeBin: fake, models: [{ id: 'claude-meu-modelo', label: 'Meu modelo' }, { id: 'rm -rf /', label: 'ruim' }] }), claudeDir: tmp });
  const names = chat2.models().map((m) => m.id);
  assert(names.includes('') && names.includes('opus') && names.includes('claude-meu-modelo') && !names.includes('rm -rf /'), 'lista de modelos');
  assert.strictEqual(chat2.models().find((m) => m.id === 'claude-haiku-4-5').effort, false);

  assert(chat2.send('sess-A', 'oi', { mode: 'ask', model: 'rm -rf /' }).error, 'modelo inválido');
  assert(chat2.send('sess-A', 'oi', { mode: 'ask', effort: 'enorme' }).error, 'esforço inválido');
  assert(chat2.send('sess-A', 'oi', { mode: 'bypassPermissions' }).error, 'modo inválido');
  assert(chat2.send('sess-A', 'oi', { mode: 'ask', attachments: [{ kind: 'image', mediaType: 'image/svg+xml', data: 'AAAA' }] }).error, 'só imagens comuns');
  assert(chat2.send('sess-A', 'oi', { mode: 'ask', attachments: [{ kind: 'image', mediaType: 'image/png', data: 'não é base64!' }] }).error, 'base64 inválido');
  assert(chat2.send('sess-A', 'oi', { mode: 'ask', attachments: [{ kind: 'file', path: 'relativo.txt' }] }).error, 'caminho relativo');
  assert(chat2.send('sess-A', 'oi', { mode: 'ask', attachments: [{ kind: 'file', path: path.join(tmp, 'nao-existe.txt') }] }).error, 'arquivo inexistente');
  assert(chat2.send('sess-A', 'oi', { mode: 'ask', attachments: Array.from({ length: 6 }, () => ({ kind: 'image', mediaType: 'image/png', data: 'AAAA' })) }).error, 'máximo de imagens');

  // modo automático + modelo + esforço viram flags
  assert.strictEqual(chat2.send('sess-A', 'oi', { mode: 'auto', model: 'sonnet', effort: 'high' }).ok, true);
  await until(() => !chat2.poll('sess-A').state.busy);
  let a2 = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert(a2.join(' ').includes('--permission-mode auto') && a2.join(' ').includes('--model sonnet') && a2.join(' ').includes('--effort high'), a2.join(' '));
  assert(!a2.some((x) => /dangerously|bypass/i.test(x)));

  // mudar o modelo reabre o processo; ultracode vira --effort ultracode
  assert.strictEqual(chat2.send('sess-A', 'agora ultra', { mode: 'plan', model: 'opus', effort: 'low', ultracode: true }).ok, true);
  await until(() => !chat2.poll('sess-A').state.busy);
  a2 = JSON.parse(fs.readFileSync(argsFile, 'utf8')).join(' ');
  assert(a2.includes('--permission-mode plan') && a2.includes('--model opus') && a2.includes('--effort ultracode') && !a2.includes('--effort low'), a2);
  assert.strictEqual(chat2.poll('sess-A').state.error, null, 'a troca de processo não deixa erro nem trava o estado');

  // sem modelo/esforço: nenhuma flag extra
  assert.strictEqual(chat2.send('sess-A', 'padrão', { mode: 'ask' }).ok, true);
  await until(() => !chat2.poll('sess-A').state.busy);
  a2 = JSON.parse(fs.readFileSync(argsFile, 'utf8')).join(' ');
  assert(!a2.includes('--model') && !a2.includes('--effort'), a2);

  // imagem + arquivo: bloco de imagem vem antes do texto, arquivo vira lista de caminhos
  const anexo = path.join(tmp, 'relatorio.txt');
  fs.writeFileSync(anexo, 'conteúdo');
  const png = Buffer.from('iVBORw0KGgo=', 'base64').toString('base64');
  assert.strictEqual(chat2.send('sess-A', 'veja isto', { mode: 'ask', attachments: [{ kind: 'image', mediaType: 'image/png', data: png }, { kind: 'file', path: anexo }] }).ok, true);
  await until(() => !chat2.poll('sess-A').state.busy);
  const sent = JSON.parse(fs.readFileSync(lastFile, 'utf8'));
  assert.strictEqual(sent[0].type, 'image');
  assert.deepStrictEqual(sent[0].source, { type: 'base64', media_type: 'image/png', data: png });
  assert.strictEqual(sent[1].type, 'text');
  assert(sent[1].text.startsWith('veja isto') && sent[1].text.includes(`- ${anexo}`), sent[1].text);
  // só anexo, sem texto
  assert.strictEqual(chat2.send('sess-A', '', { mode: 'ask', attachments: [{ kind: 'image', mediaType: 'image/png', data: png }] }).ok, true);
  await until(() => !chat2.poll('sess-A').state.busy);
  assert.strictEqual(JSON.parse(fs.readFileSync(lastFile, 'utf8')).pop().text, 'Veja a imagem anexada.');
  assert(chat2.send('sess-A', '', { mode: 'ask' }).error, 'vazio sem anexo continua recusado');

  // histórico mostra imagem anexada e chamada de skill
  fs.appendFileSync(transcript, [
    { type: 'user', uuid: 'i1', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, { type: 'text', text: 'olha o print' }] } },
    { type: 'user', uuid: 'i2', message: { role: 'user', content: '<command-name>/revisar</command-name>\n<command-args>src/app.js</command-args>' } },
    { type: 'user', uuid: 'i3', message: { role: 'user', content: '<command-name>/model</command-name>' } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  const hist = parseHistory(transcript).messages;
  assert(hist.some((m) => m.text === 'olha o print\n[imagem anexada]'), 'imagem no histórico');
  assert(hist.some((m) => m.text === '/revisar src/app.js'), 'skill no histórico');
  assert(!hist.some((m) => m.text === '/model'), 'comando local fica de fora');

  // comandos e skills do projeto e do usuário
  fs.mkdirSync(path.join(project, '.claude', 'commands', 'git'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'commands', 'revisar.md'), '---\ndescription: Revisa o código\n---\nFaça isto');
  fs.writeFileSync(path.join(project, '.claude', 'commands', 'git', 'commit.md'), '# Commit bonito\ncorpo');
  fs.mkdirSync(path.join(project, '.claude', 'skills', 'minha-skill'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'skills', 'minha-skill', 'SKILL.md'), '---\nname: minha-skill\ndescription: Faz coisa\n---\n');
  fs.mkdirSync(path.join(tmp, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'commands', 'global.md'), 'Comando global do usuário');
  const cmds = chat2.commands('sess-A');
  const byName = Object.fromEntries(cmds.map((c) => [c.name, c]));
  assert(byName.compact && byName.revisar.description === 'Revisa o código' && byName.revisar.source === 'projeto');
  assert(byName['git:commit'].description === 'Commit bonito');
  assert(byName['minha-skill'].description === 'Faz coisa');
  assert(byName.global.source === 'usuário');
  assert.deepStrictEqual(chat2.commands('nao-existe').map((c) => c.name), ['compact', 'global'], 'sem sessão, só os do usuário');


  // plugins instalados, skills de pastas acima, descrição em várias linhas e skills que o Claude Code listou
  const plug = path.join(tmp, 'plugins', 'cache', 'mk', 'design', '1.0.0');
  fs.mkdirSync(path.join(plug, 'skills', 'critique'), { recursive: true });
  fs.mkdirSync(path.join(plug, 'skills', 'escondida'), { recursive: true });
  fs.mkdirSync(path.join(plug, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(plug, 'skills', 'critique', 'SKILL.md'), '---\nname: design-critique\ndescription: >\n  Dá feedback estruturado\n  sobre um design\n---\ncorpo');
  fs.writeFileSync(path.join(plug, 'skills', 'escondida', 'SKILL.md'), '---\nuser-invocable: false\ndescription: nao aparece\n---\n');
  fs.writeFileSync(path.join(plug, 'commands', 'handoff.md'), '---\ndescription: Gera o handoff\n---\n');
  const off = path.join(tmp, 'plugins', 'cache', 'mk', 'desligado', '1.0.0');
  fs.mkdirSync(path.join(off, 'skills', 'x'), { recursive: true });
  fs.writeFileSync(path.join(off, 'skills', 'x', 'SKILL.md'), '---\ndescription: plugin desligado\n---\n');
  fs.writeFileSync(path.join(tmp, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'design@mk': [{ scope: 'user', installPath: plug, version: '1.0.0' }], 'desligado@mk': [{ scope: 'user', installPath: off }] } }));
  fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ enabledPlugins: { 'design@mk': true, 'desligado@mk': false } }));
  const chat3 = createChat({ collector, getConfig: () => ({ claudeBin: fake }), claudeDir: tmp });
  let info3 = chat3.commandsInfo('sess-A');
  const n3 = Object.fromEntries(info3.list.map((c) => [c.name, c]));
  assert(n3['design:design-critique'] && n3['design:design-critique'].description === 'Dá feedback estruturado sobre um design', 'skill de plugin com descrição em várias linhas');
  assert(n3['design:handoff'] && n3['design:handoff'].description === 'Gera o handoff', 'comando de plugin');
  assert(!n3['design:escondida'] && !Object.keys(n3).some((k) => k.startsWith('desligado:')), 'user-invocable:false e plugin desligado ficam de fora');
  assert(info3.sources.some((x) => /1 plugin/.test(x.label) && x.count === 2), JSON.stringify(info3.sources));

  // sem installed_plugins.json: procura no cache
  fs.rmSync(path.join(tmp, 'plugins', 'installed_plugins.json'));
  fs.writeFileSync(path.join(tmp, 'settings.json'), '{}');
  const chat4 = createChat({ collector, getConfig: () => ({ claudeBin: fake }), claudeDir: tmp });
  assert(chat4.commands('sess-A').some((c) => c.name === 'design:design-critique'), 'achou plugin pelo cache');
  chat4.shutdown();

  // skills de uma pasta acima do projeto (até a raiz do repositório)
  fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'do-repo'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.claude', 'skills', 'do-repo', 'SKILL.md'), '---\ndescription: Skill da raiz do repo\n---\n');
  assert(createChat({ collector, getConfig: () => ({}), claudeDir: path.join(tmp, 'vazio') }).commands('sess-A').some((c) => c.name === 'do-repo' && c.source === 'projeto'), 'pasta acima do projeto');
  chat3.shutdown();

  // arquivos do projeto para @menção
  fs.mkdirSync(path.join(project, 'src', 'comissoes'), { recursive: true });
  fs.mkdirSync(path.join(project, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'comissoes', 'regras.ts'), '');
  fs.writeFileSync(path.join(project, 'src', 'index.ts'), '');
  fs.writeFileSync(path.join(project, 'node_modules', 'x', 'regras.js'), '');
  assert(chat2.files('sess-A', '').includes('src/index.ts'));
  assert.deepStrictEqual(chat2.files('sess-A', 'regras'), ['src/comissoes/regras.ts'], 'ignora node_modules');
  assert.deepStrictEqual(chat2.files('nao-existe', 'x'), []);

  // exportar
  const md = chat2.exportMarkdown('sess-A', 'Meu chat');
  assert(md.startsWith('# Meu chat') && md.includes('**Você:**') && md.includes('olha o print'));
  chat2.shutdown();


  // ---- novo departamento criado pelo hub, e chat vazio do VS Code
  const chat5 = createChat({ collector, getConfig: () => ({ claudeBin: fake }), claudeDir: tmp });
  assert(chat5.prepare('relativo/pasta').error && chat5.prepare(path.join(tmp, 'nao-existe-pasta')).error && chat5.prepare(123).error, 'pasta inválida');
  const novo = chat5.prepare(project);
  assert(novo.id && /^[0-9a-f-]{36}$/.test(novo.id) && novo.cwd === project && novo.project === 'proj', JSON.stringify(novo));
  assert.strictEqual(chat5.poll(novo.id).state.blocked, null, 'rascunho pode enviar');
  assert.deepStrictEqual(chat5.poll(novo.id).messages, [], 'sem mensagens ainda');
  assert(chat5.commands(novo.id).some((c) => c.name === 'revisar'), 'comandos do projeto no rascunho');
  assert(chat5.files(novo.id, 'index').includes('src/index.ts'), '@arquivos no rascunho');
  assert.strictEqual(chat5.send(novo.id, 'primeira mensagem', { mode: 'ask' }).ok, true);
  await until(() => !chat5.poll(novo.id).state.busy);
  let a5 = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert(a5.includes('--session-id') && a5[a5.indexOf('--session-id') + 1] === novo.id && !a5.includes('--resume'), 'nasce com --session-id: ' + a5.join(' '));
  let p5 = chat5.poll(novo.id);
  assert(p5.messages.some((m) => m.role === 'assistant' && m.text.includes('primeira mensagem')), 'histórico do departamento novo');
  // depois da primeira mensagem, reabrir o processo continua a mesma conversa
  chat5.send(novo.id, 'segunda', { mode: 'edit' });
  await until(() => !chat5.poll(novo.id).state.busy);
  a5 = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert(a5.includes('--resume') && a5[a5.indexOf('--resume') + 1] === novo.id && !a5.includes('--session-id'), 'continua com --resume: ' + a5.join(' '));

  // chat vazio no VS Code: o hub orienta em vez de falhar
  const vz = chat5.send('sess-vazia', 'oi', { mode: 'ask' });
  assert(vz.error && /Novo departamento/.test(vz.error) && /vazio/.test(vz.error), vz.error);
  assert(/Novo departamento/.test(chat5.poll('sess-vazia').state.blocked));

  // erros com detalhe
  chat5.send(novo.id, 'resposta vazia', { mode: 'ask' });
  await until(() => !chat5.poll(novo.id).state.busy);
  let er = chat5.poll(novo.id).state.error;
  assert(/error_during_execution/.test(er) === false && /boom interno/.test(er), 'usa o campo errors: ' + er);
  chat5.send(novo.id, 'semconversa', { mode: 'ask' });
  await until(() => !chat5.poll(novo.id).state.busy);
  assert(/não achou essa conversa/.test(chat5.poll(novo.id).state.error), chat5.poll(novo.id).state.error);
  chat5.close(novo.id);
  chat5.shutdown();

  chat.close('sess-A');
  chat.shutdown();

  // Cérebro: vault do Obsidian nos chats do hub
  const cb = createChat({ collector, getConfig: () => ({ claudeBin: fake, vaultDir }), claudeDir: tmp });
  assert.strictEqual(cb.poll('sess-A').state.vault, 'cerebro');
  assert.strictEqual(cb.send('sess-A', 'consulta o cerebro', 'ask').ok, true);
  await until(() => !cb.poll('sess-A').state.busy && cb.poll('sess-A').state.pending.length === 3);
  const vargs = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  const real = fs.realpathSync(vaultDir);
  assert.strictEqual(vargs[vargs.indexOf('--add-dir') + 1], real, '--add-dir com o vault');
  assert(/Cérebro/.test(vargs[vargs.indexOf('--append-system-prompt') + 1]), 'instrução do Cérebro');
  assert.deepStrictEqual(cb.poll('sess-A').state.pending.map((x) => x.id).sort(), ['vr-bash', 'vr-fora', 'vr-ponto'], 'só o que não é nota do vault pergunta');
  await until(() => fs.existsSync(vaultLog) && Object.keys(JSON.parse(fs.readFileSync(vaultLog, 'utf8'))).length === 2);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(vaultLog, 'utf8')), { 'vr-ler': 'allow', 'vr-escrever': 'allow' }, 'ler e escrever nota liberados sem perguntar');
  cb.shutdown();
  // modo Planejar: leitura passa, escrita pergunta
  fs.rmSync(vaultLog);
  const cp = createChat({ collector, getConfig: () => ({ claudeBin: fake, vaultDir }), claudeDir: tmp });
  cp.send('sess-A', 'consulta o cerebro', 'plan');
  await until(() => !cp.poll('sess-A').state.busy && cp.poll('sess-A').state.pending.length === 4);
  assert(cp.poll('sess-A').state.pending.some((x) => x.id === 'vr-escrever'), 'escrita no vault pergunta no modo Planejar');
  cp.shutdown();
  // desligado ou sem vault: nada de --add-dir e nada liberado
  for (const cfg of [{ vaultOn: false, vaultDir }, { vaultDir: path.join(tmp, 'nao-existe') }]) {
    const co = createChat({ collector, getConfig: () => ({ claudeBin: fake, ...cfg }), claudeDir: tmp });
    assert.strictEqual(co.poll('sess-A').state.vault, null);
    co.send('sess-A', 'oi', 'ask');
    await until(() => !co.poll('sess-A').state.busy);
    assert(!JSON.parse(fs.readFileSync(argsFile, 'utf8')).includes('--add-dir'), 'sem vault, sem --add-dir');
    co.shutdown();
  }

  // Escritório: ferramentas MCP do hub, aprovação do próprio hub e perguntas entre departamentos
  fs.mkdirSync(path.join(tmp, 'projects', 'p1'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'projects', 'p1', 'sess-B.jsonl'), '');
  const office = {
    mcpConfig: (sid) => JSON.stringify({ mcpServers: { escritorio: { type: 'http', url: 'http://127.0.0.1:1/mcp/x/' + sid } } }),
    systemNote: () => 'Você trabalha no "Escritório" do Claude Hub',
  };
  const co = createChat({ collector, getConfig: () => ({ claudeBin: fake, vaultOn: false }), claudeDir: tmp, getOffice: () => office });
  assert.strictEqual(co.hasProc('sess-A'), false);
  assert.strictEqual(co.requestApproval('sess-A', { tool: 'x', detail: 'y' }) instanceof Promise, true);
  assert.strictEqual(await co.requestApproval('sess-A', { tool: 'x', detail: 'y' }), 'abort', 'sem processo, sem pedido');
  fs.rmSync(vaultLog, { force: true });
  co.send('sess-A', 'use as ferramentas', 'ask');
  await until(() => co.hasProc('sess-A'));
  await until(() => !co.poll('sess-A').state.busy && co.poll('sess-A').state.pending.length === 1);
  const oargs = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  const mc = JSON.parse(oargs[oargs.indexOf('--mcp-config') + 1]);
  assert.strictEqual(mc.mcpServers.escritorio.url, 'http://127.0.0.1:1/mcp/x/sess-A', 'cada chat recebe o seu endereço');
  assert(/Escritório/.test(oargs[oargs.indexOf('--append-system-prompt') + 1]));
  assert.deepStrictEqual(co.poll('sess-A').state.pending.map((x) => x.id), ['vr-outra'], 'as duas ferramentas do hub passam; MCP de terceiros continua perguntando');
  await until(() => fs.existsSync(vaultLog) && Object.keys(JSON.parse(fs.readFileSync(vaultLog, 'utf8'))).length === 2);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(vaultLog, 'utf8')), { 'vr-lista': 'allow', 'vr-pergunta': 'allow' });
  co.decide('sess-A', 'vr-outra', 'deny');

  // aprovação do hub: aparece como pedido, e decidir devolve a resposta a quem esperava
  let okA = co.requestApproval('sess-A', { tool: 'Perguntar a outro departamento', detail: 'Redação: oi', description: 'x' });
  const pa = co.poll('sess-A').state.pending.find((x) => x.tool === 'Perguntar a outro departamento');
  assert(pa && pa.detail === 'Redação: oi', 'card de aprovação');
  assert.strictEqual(pa.kind, 'office');
  assert.deepStrictEqual(co.inbox().map((x) => x.kind), ['office']);
  assert.strictEqual(co.decide('sess-A', pa.id, 'talvez'), false);
  assert.strictEqual(co.decide('sess-A', pa.id, 'allow'), true);
  assert.strictEqual(await okA, 'allow');
  assert.strictEqual(co.poll('sess-A').state.pending.length, 0);
  const longPlan = `Objetivo: x\n\n${Array.from({ length: 30 }, (_, i) => `${i + 1}. Setor: ${'t'.repeat(60)}`).join('\n')}`;
  const okP = co.requestApproval('sess-A', { kind: 'plan', tool: 'Plano de delegação', detail: longPlan, description: 'd' });
  const pp = co.poll('sess-A').state.pending.find((x) => x.kind === 'plan');
  assert(pp && pp.detail.length > 800 && pp.detail.includes('\n'), 'o plano mantém as quebras de linha e cabe mais texto que um pedido comum');
  co.decide('sess-A', pp.id, 'allow');
  assert.strictEqual(await okP, 'allow');
  okA = co.requestApproval('sess-A', { tool: 'Perguntar a outro departamento', detail: 'a' });
  co.decide('sess-A', co.poll('sess-A').state.pending[0].id, 'deny');
  assert.strictEqual(await okA, 'deny');
  okA = co.requestApproval('sess-A', { tool: 'Perguntar a outro departamento', detail: 'b' });
  co.stop('sess-A'); // parar cancela o pedido que ainda espera o usuário
  assert.strictEqual(await okA, 'abort');
  // quem pediu desistiu (conexão caiu / Parar): o card some e ninguém mais consegue aprovar
  const ac = new AbortController();
  okA = co.requestApproval('sess-A', { kind: 'plan', tool: 'Plano de delegação', detail: 'z' }, { signal: ac.signal, timeoutMs: 60000 });
  const pz = co.poll('sess-A').state.pending.find((x) => x.kind === 'plan');
  assert(pz);
  ac.abort();
  assert.strictEqual(await okA, 'abort');
  assert.strictEqual(co.poll('sess-A').state.pending.length, 0, 'o pedido desistido some');
  assert.strictEqual(co.decide('sess-A', pz.id, 'allow'), false, 'aprovar depois não faz nada');
  // prazo do próprio hub
  okA = co.requestApproval('sess-A', { tool: 'Perguntar a outro departamento', detail: 't' }, { timeoutMs: 60 });
  assert.strictEqual(await okA, 'timeout');
  assert.strictEqual(co.poll('sess-A').state.pending.length, 0, 'prazo vencido tira o card');
  okA = co.requestApproval('sess-A', { tool: 'Perguntar a outro departamento', detail: 'c' });
  co.close('sess-A');
  assert.strictEqual(await okA, 'abort', 'fechar o chat cancela');

  // perguntar a outro departamento (B): vira mensagem do chat de B e volta a resposta final
  assert.strictEqual(co.canAsk('sess-B'), null);
  assert(/não existe/.test(co.canAsk('sess-nao-existe')));
  const ans = await co.ask('sess-B', '[Pergunta do departamento "Mezanino" (outro agente)]\nQual é a resposta?');
  assert.deepStrictEqual(ans, { text: 'A resposta é 42' });
  assert(co.poll('sess-B').messages.some((m) => m.role === 'user' && /Pergunta do departamento/.test(m.text)), 'a pergunta fica no histórico do outro departamento');
  assert.deepStrictEqual(await co.ask('sess-B', '[Pergunta do departamento "X"] quebrar'), { text: '(sem resposta em texto)' });
  // ocupado: não aceita pergunta
  co.send('sess-B', 'demorar bastante', 'ask');
  assert(/respondendo outra coisa/.test(co.canAsk('sess-B')));
  assert((await co.ask('sess-B', 'oi')).error, 'ocupado devolve erro');
  co.stop('sess-B');
  await until(() => !co.poll('sess-B').state.busy);
  co.shutdown();

  // gerente: trocar o papel reabre o processo (a instrução vai no começo do `claude`), mantendo a conversa
  let mgr = null;
  const office2 = {
    mcpConfig: (sid) => JSON.stringify({ mcpServers: { escritorio: { type: 'http', url: 'http://127.0.0.1:1/mcp/x/' + sid } } }),
    systemNote: (sid) => (sid === mgr ? 'VOCÊ É O GERENTE do Escritório' : 'Você trabalha no Escritório'),
    isManager: (sid) => sid === mgr,
  };
  const cm = createChat({ collector, getConfig: () => ({ claudeBin: fake, vaultOn: false }), claudeDir: tmp, getOffice: () => office2 });
  const noteOf = () => {
    const a2 = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    return a2[a2.indexOf('--append-system-prompt') + 1];
  };
  cm.send('sess-A', 'oi', 'ask');
  await until(() => !cm.poll('sess-A').state.busy);
  assert(!/GERENTE/.test(noteOf()));
  const pid1 = cm.hasProc('sess-A');
  mgr = 'sess-A';
  cm.send('sess-A', 'outra', 'ask');
  await until(() => !cm.poll('sess-A').state.busy);
  assert(/GERENTE/.test(noteOf()), 'virou gerente: o processo reabriu com a instrução do gerente');
  mgr = null;
  cm.send('sess-A', 'mais uma', 'ask');
  await until(() => !cm.poll('sess-A').state.busy);
  assert(!/GERENTE/.test(noteOf()), 'deixou de ser gerente: reabriu sem ela');
  cm.shutdown();

  // limite de conversas abertas: no máximo 4 `claude`, mas a mais antiga e parada cede a vaga (volta sozinha depois)
  const ce = createChat({ collector, getConfig: () => ({ claudeBin: fake, vaultOn: false }), claudeDir: tmp });
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const nd = ce.prepare(project);
    ids.push(nd.id);
    assert(!ce.send(nd.id, `chat ${i}`, 'ask').error, 'abre até 4');
    await until(() => !ce.poll(nd.id).state.busy);
    await sleep(15);
  }
  assert(ids.every((id) => ce.hasProc(id)), '4 abertos');
  const five = ce.prepare(project);
  assert.strictEqual(ce.canAsk(five.id), null, 'há vaga: o mais antigo parado cede');
  assert(ids.every((id) => ce.hasProc(id)), 'só olhar não fecha nada');
  assert(!ce.send(five.id, 'quinto', 'ask').error);
  assert.strictEqual(ce.hasProc(ids[0]), false, 'o mais antigo foi fechado');
  assert(ids.slice(1).every((id) => ce.hasProc(id)) && ce.hasProc(five.id));
  await until(() => !ce.poll(five.id).state.busy);
  // todos ocupados: sem vaga
  for (const id of ids.slice(1)) ce.send(id, 'demorar muito', 'ask');
  ce.send(five.id, 'demorar muito', 'ask');
  const six = ce.prepare(project);
  assert(/todas ocupadas/.test(ce.canAsk(six.id)) && /todas ocupadas/.test(ce.send(six.id, 'oi', 'ask').error), 'ocupadas não são fechadas');
  for (const id of [...ids.slice(1), five.id]) ce.stop(id);
  await sleep(400);
  // a conversa fechada volta ao receber mensagem (reabre com --resume)
  assert(!ce.send(ids[0], 'voltei', 'ask').error);
  await until(() => !ce.poll(ids[0]).state.busy);
  assert(ce.hasProc(ids[0]));
  ce.shutdown();

  // sem Escritório (desligado): nada de --mcp-config
  const cn = createChat({ collector, getConfig: () => ({ claudeBin: fake, vaultOn: false }), claudeDir: tmp, getOffice: () => ({ mcpConfig: () => null, systemNote: () => '' }) });
  cn.send('sess-A', 'oi', 'ask');
  await until(() => !cn.poll('sess-A').state.busy);
  assert(!JSON.parse(fs.readFileSync(argsFile, 'utf8')).includes('--mcp-config'));
  assert.strictEqual(cn.poll('sess-A').state.pending.length, 0);
  cn.shutdown();

  // fechar derruba o processo
  chat.close('sess-A');
  chat.shutdown();

  // comando claude inexistente
  const bad = createChat({ collector, getConfig: () => ({ claudeBin: '/nao/existe/claude' }), claudeDir: tmp });
  bad.send('sess-A', 'oi', 'ask');
  await until(() => bad.poll('sess-A').state.error, 12000);
  assert(/claudeBin/.test(bad.poll('sess-A').state.error), bad.poll('sess-A').state.error);
  assert.strictEqual(bad.poll('sess-A').state.busy, false);
  bad.shutdown();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('OK: testes do chat passaram');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
