'use strict';
/* Testa o Modo celular: pareamento, autenticação, hook de permissão (ponta a ponta) e tarefas remotas. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { createPhone, isPrivateAddress } = require('../src/phone');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-phone-'));
const hubDir = path.join(tmp, 'hub');
const project = path.join(tmp, 'meu-projeto');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(hubDir, { recursive: true });

const fakeClaude = path.join(tmp, 'claude');
fs.writeFileSync(fakeClaude, '#!/bin/sh\ncat > "$PWD/.prompt"\necho "$@" > "$PWD/.args"\nsleep "${FAKE_SLEEP:-0}"\necho \'{"result":"feito: linha1\\nlinha2","session_id":"abc","is_error":false}\'\n', { mode: 0o755 });

const transcript = path.join(tmp, 's1.jsonl');
const collector = {
  snapshot: () => ({ now: Date.now(), sessions: [{ id: 's1', project: 'meu-projeto', title: 'Teste', status: 'idle', stale: false, startedAt: 0, lastActivity: 0, employees: [] }], feed: [], totals: { active: 0, workers: 0, waiting: 0, tokens: 0 } }),
  knownProjects: () => [{ cwd: project, project: 'meu-projeto' }],
  sessionInfo: (id) => (id === 's1' ? { id: 's1', cwd: project, project: 'meu-projeto', status: 'idle', lastActivity: 0, transcriptPath: transcript } : null),
};
{
  const L = (o) => JSON.stringify(o);
  fs.writeFileSync(path.join(project, 'plano.md'), '# Plano\n');
  fs.writeFileSync(path.join(project, 'logo.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(project, 'icone.svg'), '<svg onload="alert(1)"/>');
  fs.writeFileSync(path.join(project, 'segredo.env'), 'x');
  fs.writeFileSync(transcript, [
    L({ type: 'user', uuid: 'u1', timestamp: '2026-11-14T12:00:00Z', message: { role: 'user', content: 'Faça o plano' } }),
    L({ type: 'assistant', uuid: 'a1', timestamp: '2026-11-14T12:00:05Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: path.join(project, 'plano.md') } },
      { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: path.join(project, 'logo.png') } },
      { type: 'tool_use', id: 't3', name: 'Write', input: { file_path: path.join(project, 'icone.svg') } },
      { type: 'tool_use', id: 't4', name: 'Write', input: { file_path: path.join(project, 'segredo.env') } },
    ] } }),
    L({ type: 'assistant', uuid: 'a2', timestamp: '2026-11-14T12:00:09Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Plano pronto. Veja plano.md.' }] } }),
  ].join('\n') + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port;

function req(method, url, { token, body, host, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers: {
      Host: host || `127.0.0.1:${port}`,
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(token ? { 'X-Hub-Token': token } : {}),
      ...headers,
    } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch { /* html */ }
        resolve({ status: res.statusCode, json, text: out, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function runHook(env, input) {
  return new Promise((resolve) => {
    const p = spawn('python3', [path.join(root, 'hook', 'claude-hub-permit.py')], { env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
    p.stdin.end(JSON.stringify(input));
  });
}

(async () => {
  // endereços
  assert(isPrivateAddress('192.168.0.10') && isPrivateAddress('10.1.2.3') && isPrivateAddress('172.20.0.1') && isPrivateAddress('::ffff:192.168.1.5'));
  assert(!isPrivateAddress('8.8.8.8') && !isPrivateAddress('172.32.0.1') && !isPrivateAddress('200.10.10.10'));

  const phone = createPhone({ collector, hubDir, rootDir: root, getConfig: () => ({ claudeBin: fakeClaude }) });
  let st = await phone.start({ minutes: 30, wait: 20, address: '127.0.0.1', port: 47950 });
  port = st.port;
  assert(st.on && st.pairUrl && !st.paired);
  const code = st.pairUrl.split('#p=')[1];
  assert(code && code.length >= 30);

  // página estática e cabeçalhos de segurança
  let r = await req('GET', '/');
  assert.strictEqual(r.status, 200);
  assert(/Claude Hub/.test(r.text));
  assert(/default-src 'none'/.test(r.headers['content-security-policy']));
  assert.strictEqual((await req('GET', '/phone.js')).status, 200);
  assert.strictEqual((await req('GET', '/persona.js')).status, 200);
  assert.strictEqual((await req('GET', '/../src/main.js')).status, 404);
  assert.strictEqual((await req('GET', '/events.jsonl')).status, 404);

  // Host inválido (DNS rebinding)
  assert.strictEqual((await req('GET', '/', { host: 'evil.example.com' })).status, 421);

  // sem token
  assert.strictEqual((await req('GET', '/api/state')).status, 401);
  assert.strictEqual((await req('GET', '/api/state', { token: 'qualquer' })).status, 401);
  // pareamento: código errado, depois certo, e não vale duas vezes
  assert.strictEqual((await req('POST', '/api/pair', { body: { code: 'errado' } })).status, 401);
  r = await req('POST', '/api/pair', { body: { code } });
  assert.strictEqual(r.status, 200);
  const token = r.json.token;
  assert(token && token.length >= 40);
  assert.strictEqual((await req('POST', '/api/pair', { body: { code } })).status, 401, 'código de uso único');
  assert(phone.status().paired);
  const pf = JSON.parse(fs.readFileSync(path.join(hubDir, 'phone.json'), 'utf8'));
  assert(pf.active && pf.paired && pf.pid === process.pid);

  // estado
  r = await req('GET', '/api/state', { token });
  assert.strictEqual(r.status, 200);
  assert(Array.isArray(r.json.permits) && Array.isArray(r.json.projects) && r.json.projects[0].project === 'meu-projeto');
  assert(!JSON.stringify(r.json).includes('tokens_secret'));

  // corpo grande e tipo errado
  assert.strictEqual((await req('POST', '/api/permit', { token, body: { x: 'a'.repeat(20000) } })).status, 413);
  assert.strictEqual((await req('POST', '/api/permit', { token, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.strictEqual((await req('DELETE', '/api/state', { token })).status, 405);

  // hook de permissão ponta a ponta: aprovar
  const env = { CLAUDE_HUB_DIR: hubDir };
  const input = { session_id: 's1', cwd: project, tool_name: 'Bash', tool_input: { command: 'npm test', outro: 'x' } };
  let hook = runHook(env, input);
  let permits = [];
  for (let i = 0; i < 40 && !permits.length; i++) {
    await sleep(100);
    permits = (await req('GET', '/api/state', { token })).json.permits;
  }
  assert.strictEqual(permits.length, 1);
  assert.strictEqual(permits[0].tool, 'Bash');
  assert.strictEqual(permits[0].input.command, 'npm test');
  assert(!('outro' in permits[0].input), 'só campos conhecidos');
  assert.strictEqual((await req('POST', '/api/permit', { token, body: { id: '../../etc', behavior: 'allow' } })).status, 409);
  assert.strictEqual((await req('POST', '/api/permit', { token, body: { id: permits[0].id, behavior: 'talvez' } })).status, 409);
  assert.strictEqual((await req('POST', '/api/permit', { token, body: { id: permits[0].id, behavior: 'allow' } })).status, 200);
  let out = await hook;
  assert.strictEqual(out.code, 0);
  const j = JSON.parse(out.out);
  assert.strictEqual(j.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.strictEqual(j.hookSpecificOutput.decision.behavior, 'allow');
  assert.deepStrictEqual(fs.readdirSync(path.join(hubDir, 'permits')), [], 'hook limpa os arquivos');

  // negar
  hook = runHook(env, input);
  permits = [];
  for (let i = 0; i < 40 && !permits.length; i++) {
    await sleep(100);
    permits = (await req('GET', '/api/state', { token })).json.permits;
  }
  await req('POST', '/api/permit', { token, body: { id: permits[0].id, behavior: 'deny' } });
  out = JSON.parse((await hook).out);
  assert.strictEqual(out.hookSpecificOutput.decision.behavior, 'deny');
  assert(out.hookSpecificOutput.decision.message);

  // tarefas remotas
  assert.strictEqual((await req('POST', '/api/task', { token, body: { cwd: '/etc', prompt: 'oi', mode: 'plan' } })).status, 400);
  assert.strictEqual((await req('POST', '/api/task', { token, body: { cwd: project, prompt: '', mode: 'plan' } })).status, 400);
  assert.strictEqual((await req('POST', '/api/task', { token, body: { cwd: project, prompt: 'oi', mode: 'bypassPermissions' } })).status, 400);
  assert.strictEqual((await req('POST', '/api/task', { token, body: { cwd: project, prompt: 'x'.repeat(4001), mode: 'plan' } })).status, 400);
  r = await req('POST', '/api/task', { token, body: { cwd: project, prompt: '--dangerously-skip-permissions faça isso', mode: 'plan' } });
  assert.strictEqual(r.status, 200);
  let task;
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    task = (await req('GET', '/api/state', { token })).json.tasks[0];
    if (task.status !== 'running') break;
  }
  assert.strictEqual(task.status, 'done');
  assert(task.result.includes('linha1\nlinha2'), 'mantém as quebras de linha');
  assert.strictEqual(fs.readFileSync(path.join(project, '.prompt'), 'utf8'), '--dangerously-skip-permissions faça isso', 'o texto vai pelo stdin, não vira argumento');
  const args = fs.readFileSync(path.join(project, '.args'), 'utf8').trim();
  assert(/-p/.test(args) && /--permission-mode plan/.test(args) && !/dangerously/.test(args), args);
  await req('POST', '/api/task', { token, body: { cwd: project, prompt: 'edite', mode: 'edit' } });
  await sleep(500);
  assert(/--permission-mode acceptEdits/.test(fs.readFileSync(path.join(project, '.args'), 'utf8')));

  // limite de tarefas ao mesmo tempo (script lento)
  process.env.FAKE_SLEEP = '2';
  await req('POST', '/api/task', { token, body: { cwd: project, prompt: 'a', mode: 'plan' } });
  await req('POST', '/api/task', { token, body: { cwd: project, prompt: 'b', mode: 'plan' } });
  r = await req('POST', '/api/task', { token, body: { cwd: project, prompt: 'c', mode: 'plan' } });
  assert.strictEqual(r.status, 400);
  assert(/rodando/.test(r.json.error));
  const running = (await req('GET', '/api/state', { token })).json.tasks.find((t) => t.status === 'running');
  assert.strictEqual((await req('POST', '/api/task/stop', { token, body: { id: running.id } })).json.ok, true);

  // ---- chat do departamento e entregas (chat de mentira, só para conferir as rotas)
  assert.strictEqual((await req('GET', '/api/chat?sid=s1', { token })).status, 404, 'sem chat ligado');
  assert.strictEqual((await req('GET', '/api/deliveries')).status, 401);
  const calls = [];
  phone.setChat({
    known: (sid) => sid === 's1',
    poll: (sid, rev) => ({ rev: 'r1', messages: rev === 'r1' ? null : [{ id: 'm1', ts: 1, role: 'user', kind: 'text', text: 'oi' }], state: { running: true, busy: false, mode: 'ask', opts: {}, error: null, blocked: null, vault: 'secreto', pending: [{ id: 'p1', kind: 'perm', tool: 'Bash', detail: 'npm test', description: 'rodar', ts: 1 }] } }),
    getOpts: () => ({ mode: 'auto', model: 'opus', effort: 'high', ultracode: true }),
    send: (sid, text, opts) => { calls.push(['send', sid, text, opts]); return text === 'erro' ? { error: 'Ainda respondendo.' } : { ok: true }; },
    stop: (sid) => { calls.push(['stop', sid]); return true; },
    decide: (sid, id, b) => { calls.push(['decide', sid, id, b]); return id === 'p1'; },
    inbox: () => [{ sid: 's1', id: 'p1', kind: 'perm', tool: 'Bash', detail: 'npm test', description: 'rodar', ts: 1 }],
  });
  r = await req('GET', '/api/state', { token });
  assert.strictEqual(r.json.canChat, true);
  assert.strictEqual(r.json.inbox.length, 1);
  assert.strictEqual(r.json.inbox[0].sid, 's1');
  assert.strictEqual(r.json.deliveries.n, 1);
  assert(r.json.deliveries.latest > 0);
  r = await req('GET', '/api/chat?sid=s1', { token });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.messages[0].text, 'oi');
  assert.strictEqual(r.json.state.pending[0].id, 'p1');
  assert(!JSON.stringify(r.json).includes('secreto'), 'só os campos conhecidos do chat');
  assert.strictEqual((await req('GET', '/api/chat?sid=s1&rev=r1', { token })).json.messages, null, 'sem mudança, sem mensagens');
  assert.strictEqual((await req('GET', '/api/chat?sid=outro', { token })).status, 404);
  assert.strictEqual((await req('GET', '/api/chat?sid=' + encodeURIComponent('../../x'), { token })).status, 404);
  // enviar: o modo "auto" do computador nunca vale pelo celular; modelo e esforço escolhidos lá ficam
  r = await req('POST', '/api/chat/send', { token, body: { sid: 's1', text: 'faça X', mode: 'auto' } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(calls.pop().slice(1), ['s1', 'faça X', { mode: 'ask', model: 'opus', effort: 'high', ultracode: true }]);
  await req('POST', '/api/chat/send', { token, body: { sid: 's1', text: 'edite', mode: 'edit' } });
  assert.strictEqual(calls.pop()[3].mode, 'edit');
  await req('POST', '/api/chat/send', { token, body: { sid: 's1', text: 'planeje', mode: 'bypassPermissions' } });
  assert.strictEqual(calls.pop()[3].mode, 'ask', 'modo desconhecido vira "perguntar antes"');
  assert.strictEqual((await req('POST', '/api/chat/send', { token, body: { sid: 's1', text: 'erro' } })).status, 400);
  calls.length = 0;
  assert.strictEqual((await req('POST', '/api/chat/send', { token, body: { sid: 's1', text: 'x'.repeat(4001) } })).status, 400);
  assert.strictEqual((await req('POST', '/api/chat/send', { token, body: { sid: 'outro', text: 'oi' } })).status, 404);
  assert.strictEqual(calls.length, 0, 'nada chegou ao chat');
  assert.strictEqual((await req('POST', '/api/chat/stop', { token, body: { sid: 's1' } })).json.ok, true);
  assert.strictEqual((await req('POST', '/api/chat/decide', { token, body: { sid: 's1', id: 'p1', behavior: 'allow' } })).status, 200);
  assert.deepStrictEqual(calls.pop(), ['decide', 's1', 'p1', 'allow']);
  assert.strictEqual((await req('POST', '/api/chat/decide', { token, body: { sid: 's1', id: 'p1', behavior: 'talvez' } })).status, 409);
  assert.strictEqual((await req('POST', '/api/chat/decide', { token, body: { sid: 's1', id: 'zzz', behavior: 'deny' } })).status, 409);
  assert.strictEqual((await req('POST', '/api/chat/send', { body: { sid: 's1', text: 'oi' } })).status, 401, 'sem chave');

  // entregas
  r = await req('GET', '/api/deliveries', { token });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.deliveries.length, 1);
  const dl = r.json.deliveries[0];
  assert.strictEqual(dl.headline, 'Plano pronto.');
  assert(!r.text.includes(tmp), 'nenhum caminho do computador na resposta');
  const fl = Object.fromEntries(dl.files.map((f) => [f.name, f]));
  assert(fl['plano.md'].open && fl['logo.png'].open && fl['icone.svg'].open && !fl['segredo.env'].open);
  r = await req('GET', '/api/delivery/file?id=' + fl['plano.md'].id, { token });
  assert.strictEqual(r.status, 200);
  assert(/^text\/plain/.test(r.headers['content-type']) && /# Plano/.test(r.text));
  assert(/sandbox/.test(r.headers['content-security-policy']) && r.headers['x-content-type-options'] === 'nosniff');
  r = await req('GET', '/api/delivery/file?id=' + fl['icone.svg'].id, { token });
  assert(/^text\/plain/.test(r.headers['content-type']), 'SVG nunca vai como imagem/página');
  r = await req('GET', '/api/delivery/file?id=' + fl['logo.png'].id, { token });
  assert.strictEqual(r.headers['content-type'], 'image/png');
  assert.strictEqual((await req('GET', '/api/delivery/file?id=' + fl['plano.md'].id)).status, 401, 'precisa da chave');
  assert.strictEqual((await req('GET', '/api/delivery/file?id=nada', { token })).status, 404);
  assert.strictEqual((await req('GET', '/api/delivery/file?id=' + encodeURIComponent('../../etc/passwd'), { token })).status, 404);

  // bloqueio após tentativas erradas
  for (let i = 0; i < 9; i++) await req('GET', '/api/state', { token: 'errado' + i });
  assert.strictEqual((await req('GET', '/api/state', { token })).status, 429);

  // novo QR revoga o celular anterior (mesmo estando bloqueado, o servidor não confia mais na chave)
  const st2 = phone.newPairing();
  assert(!st2.paired && st2.pairUrl);

  // desligar: arquivo some, hook não segura mais o diálogo, porta fecha
  phone.stop();
  assert(!fs.existsSync(path.join(hubDir, 'phone.json')));
  const t0 = Date.now();
  out = await runHook(env, input);
  assert(Date.now() - t0 < 3000 && out.out === '', 'com o modo desligado o hook sai sem imprimir');
  await assert.rejects(req('GET', '/'));

  // hook com celular não pareado também não segura o diálogo
  fs.writeFileSync(path.join(hubDir, 'phone.json'), JSON.stringify({ active: true, until: Date.now() + 60000, paired: false, pid: process.pid }));
  out = await runHook(env, input);
  assert.strictEqual(out.out, '');
  // e com o processo do hub morto
  fs.writeFileSync(path.join(hubDir, 'phone.json'), JSON.stringify({ active: true, until: Date.now() + 60000, paired: true, pid: 999999 }));
  out = await runHook(env, input);
  assert.strictEqual(out.out, '');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('OK: testes do Modo celular passaram');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
