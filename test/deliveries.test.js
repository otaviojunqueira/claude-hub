'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDeliveries, openable } = require('../src/deliveries');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-deliv-'));
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
fs.mkdirSync(path.join(proj, 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(proj, 'docs', 'plano.md'), '# Plano\nitem 1\n');
fs.writeFileSync(path.join(proj, 'logo.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
fs.writeFileSync(path.join(proj, 'relatorio.pdf'), '%PDF-1.4\n');
fs.writeFileSync(path.join(proj, 'icon.svg'), '<svg onload="alert(1)"></svg>');
fs.writeFileSync(path.join(proj, '.env'), 'SEGREDO=1');
fs.writeFileSync(path.join(proj, 'credentials.json'), '{}');
fs.writeFileSync(path.join(proj, 'chave.pem'), 'x');
fs.writeFileSync(path.join(proj, '.git', 'config'), 'x');
fs.writeFileSync(path.join(proj, 'node_modules', 'a.js'), 'x');
fs.writeFileSync(path.join(proj, 'binario.exe'), 'x');
fs.writeFileSync(path.join(proj, 'grande.txt'), 'a'.repeat(400 * 1024));
fs.writeFileSync(path.join(tmp, 'fora.txt'), 'fora do projeto');
fs.symlinkSync(path.join(tmp, 'fora.txt'), path.join(proj, 'atalho.txt'));
fs.symlinkSync(tmp, path.join(proj, 'pasta-link'));

// ---- quem pode abrir
const ok = (rel) => openable(path.join(proj, rel), proj);
assert.strictEqual(ok('docs/plano.md').kind, 'text');
assert.strictEqual(ok('logo.png').kind, 'image');
assert.strictEqual(ok('relatorio.pdf').kind, 'pdf');
assert.strictEqual(ok('icon.svg').mime, 'text/plain; charset=utf-8', 'SVG é servido como texto, nunca como imagem/página');
assert.strictEqual(ok('.env'), null, 'oculto');
assert.strictEqual(ok('credentials.json'), null, 'parece segredo');
assert.strictEqual(ok('chave.pem'), null);
assert.strictEqual(ok('.git/config'), null);
assert.strictEqual(ok('node_modules/a.js'), null);
assert.strictEqual(ok('binario.exe'), null, 'tipo desconhecido');
assert.strictEqual(ok('grande.txt'), null, 'grande demais');
assert.strictEqual(ok('atalho.txt'), null, 'link simbólico que sai da pasta');
assert.strictEqual(ok('pasta-link/fora.txt'), null);
assert.strictEqual(openable('/etc/passwd', proj), null);
assert.strictEqual(openable(path.join(proj, 'nao-existe.md'), proj), null);

// ---- transcript -> entregas
const T = (o) => JSON.stringify(o);
const lines = [];
let n = 0;
const ts = () => new Date(Date.UTC(2026, 10, 14, 12, 0, n++)).toISOString();
const user = (text, extra) => lines.push(T({ type: 'user', uuid: `u${n}`, timestamp: ts(), message: { role: 'user', content: text }, ...extra }));
const asst = (blocks, extra) => lines.push(T({ type: 'assistant', uuid: `a${n}`, timestamp: ts(), message: { role: 'assistant', content: blocks }, ...extra }));
const result = () => lines.push(T({ type: 'user', uuid: `r${n}`, timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }));

// pedido 1: trabalhou, criou arquivos, respondeu
user('Escreva o plano e o logo');
asst([{ type: 'text', text: 'Vou ler primeiro.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: path.join(proj, 'x.js') } }]);
result();
asst([{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: path.join(proj, 'docs', 'plano.md'), content: 'x' } }]);
result();
asst([{ type: 'tool_use', id: 't3', name: 'Write', input: { file_path: 'logo.png', content: 'x' } }, { type: 'tool_use', id: 't4', name: 'Edit', input: { file_path: path.join(proj, '.env') } }]);
result();
asst([{ type: 'tool_use', id: 't5', name: 'Write', input: { file_path: '/tmp/fora-do-projeto.md', content: 'x' } }]);
result();
asst([{ type: 'text', text: '**Pronto**: criei o plano e o logo. Veja docs/plano.md.\n\nO próximo passo é revisar os itens 1 e 2 com você.' }]);
// pedido 2: só conversa (sem ferramentas) -> não é entrega
user('Obrigado!');
asst([{ type: 'text', text: 'De nada.' }]);
// pedido 3: com ferramenta mas sem resposta final ainda -> não é entrega
user('Agora rode os testes');
asst([{ type: 'text', text: 'Rodando…' }, { type: 'tool_use', id: 't6', name: 'Bash', input: { command: 'npm test' } }]);
// subagente (sidechain) não conta
asst([{ type: 'tool_use', id: 't7', name: 'Write', input: { file_path: 'logo.png' } }], { isSidechain: true });
// pedido 4: injeções do sistema são ignoradas como pedido
user('<system-reminder>lembrete</system-reminder>');
const tpath = path.join(tmp, 't.jsonl');
fs.writeFileSync(tpath, lines.join('\n') + '\n');

const collector = {
  sessionInfo: (id) => (id === 's1' ? { id: 's1', cwd: proj, project: 'proj', status: 'idle', lastActivity: 0, transcriptPath: tpath } : null),
};
const D = createDeliveries({ collector });
let list = D.list(['s1', 'nao-existe']);
assert.strictEqual(list.length, 1, 'só o pedido 1 virou entrega');
const d = list[0];
assert.strictEqual(d.request, 'Escreva o plano e o logo');
assert.strictEqual(d.tools, 5);
assert(/^Pronto: criei o plano e o logo\./.test(d.headline), d.headline);
assert(/próximo passo/.test(d.summary));
assert.strictEqual(d.edited, 4);
const byName = Object.fromEntries(d.files.map((f) => [f.name, f]));
assert(byName['docs/plano.md'] && byName['docs/plano.md'].open && byName['docs/plano.md'].how === 'created');
assert(byName['logo.png'] && byName['logo.png'].kind === 'image');
assert(byName['.env'] && !byName['.env'].open && byName['.env'].id === null, 'segredo aparece como "só no PC", sem id');
assert(byName['fora-do-projeto.md'] && !byName['fora-do-projeto.md'].open);
assert(!JSON.stringify(d).includes(proj) && !JSON.stringify(d).includes(tmp), 'nenhum caminho do computador vai ao celular');
const sum = D.summary(['s1']);
assert.strictEqual(sum.n, 1);
assert(sum.latest > 0);

// arquivo por id opaco
const f = D.file(byName['docs/plano.md'].id);
assert(f && f.kind === 'text' && fs.readFileSync(f.path, 'utf8').includes('Plano'));
assert.strictEqual(D.file('../../etc/passwd'), null);
assert.strictEqual(D.file('0'.repeat(20)), null);
// se o arquivo virar um link para fora depois, deixa de abrir
fs.rmSync(path.join(proj, 'docs', 'plano.md'));
fs.symlinkSync(path.join(tmp, 'fora.txt'), path.join(proj, 'docs', 'plano.md'));
assert.strictEqual(D.file(byName['docs/plano.md'].id), null, 'confere de novo na hora de servir');

// transcript cresce: nova entrega aparece (cache pela assinatura do arquivo)
user('Agora rode os testes de novo');
asst([{ type: 'tool_use', id: 't8', name: 'Bash', input: { command: 'npm test' } }]);
result();
asst([{ type: 'text', text: 'Todos os testes passaram.' }]);
fs.writeFileSync(tpath, lines.join('\n') + '\n');
list = D.list(['s1']);
assert.strictEqual(list.length, 2);
assert.strictEqual(list[0].headline, 'Todos os testes passaram.');
assert.strictEqual(list[0].summary, '');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('OK: testes das entregas passaram');
