'use strict';
/* Testa o Cérebro (vault do Obsidian): contenção de caminhos, pastas com ponto, busca e liberação automática. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../src/vault');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-vault-'));
const vault = path.join(tmp, 'cerebro');
const outside = path.join(tmp, 'fora');
const w = (rel, text, base = vault) => {
  const f = path.join(base, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
w('Projetos/jongo/Plano.md', '# Plano\nA estratégia do JONGO para 2027.');
w('Projetos/jongo/Reunião 12.md', 'Falamos de cultura.');
w('Pessoal/Diário.md', 'dia bom');
w('00-Inbox/ideia.md', 'ideia solta sobre estratégia');
w('.bot/segredo.md', 'token=123');
w('.obsidian/app.json', '{}');
w('segredo.md', 'fora', outside);
fs.symlinkSync(outside, path.join(vault, 'atalho'));
fs.symlinkSync(path.join(outside, 'segredo.md'), path.join(vault, 'Pessoal', 'link.md'));

const root = V.resolveRoot(vault);
assert(root, 'vault existe');
assert.strictEqual(V.resolveRoot(path.join(tmp, 'nao-existe')), null);
assert.strictEqual(V.resolveRoot('relativo/x'), null);
assert.strictEqual(V.resolveRoot('', tmp), fs.realpathSync(vault), 'vazio = ~/cerebro');
assert.strictEqual(V.resolveRoot('', path.join(tmp, 'vazio-home')), null, 'sem ~/cerebro');
fs.mkdirSync(path.join(tmp, 'cerebro-home'));
assert(V.resolveRoot('~/cerebro-home', tmp), 'til expande');

// listar
const top = V.list(root, '');
assert.deepStrictEqual(top.entries.map((e) => e.name), ['00-Inbox', 'Pessoal', 'Projetos'], 'sem pontos e sem atalho para fora');
const pessoal = V.list(root, 'Pessoal');
assert(!pessoal.entries.some((e) => e.name === 'link'), 'link para fora não aparece');
assert(pessoal.entries.some((e) => e.name === 'Diário' && e.type === 'note'));
assert(V.list(root, '.bot').error, 'pasta com ponto bloqueada');
assert(V.list(root, '../fora').error, 'subir bloqueado');
assert(V.list(root, 'atalho').error, 'atalho para fora bloqueado');
assert(V.list(root, '/etc').error, 'absoluto bloqueado');

// ler
assert.strictEqual(V.read(root, 'Projetos/jongo/Plano.md').title, 'Plano');
assert(V.read(root, 'Projetos/jongo/Plano.md').text.includes('estratégia'));
assert(V.read(root, '.bot/segredo.md').error);
assert(V.read(root, '../fora/segredo.md').error);
assert(V.read(root, 'Pessoal/link.md').error, 'link para fora bloqueado');
assert(V.read(root, 'Projetos/jongo').error, 'pasta não é nota');
assert(V.read(root, '.obsidian/app.json').error);

// buscar
const s = V.search(root, 'estratégia');
assert.deepStrictEqual(s.results.map((r) => r.path).sort(), ['00-Inbox/ideia.md', 'Projetos/jongo/Plano.md']);
assert(s.results[0].snippet.includes('estratégia'));
assert.strictEqual(V.search(root, 'token').results.length, 0, 'pastas com ponto não entram na busca');
assert.strictEqual(V.search(root, 'plano').results[0].path, 'Projetos/jongo/Plano.md', 'nome conta mais');
assert.strictEqual(V.search(root, 'a').results.length, 0, 'busca curta demais');

// resumo
const ov = V.overview(root);
assert.strictEqual(ov.total, 4);
assert(ov.folders.some((f) => f.name === 'Projetos' && f.notes === 2));

// liberação automática
const A = (tool, input) => V.autoAllow(root, tool, input);
assert(A('Read', { file_path: path.join(root, 'Pessoal/Diário.md') }));
assert(A('Write', { file_path: path.join(root, 'Projetos/jongo/Nova.md'), content: 'x' }), 'criar nota nova (arquivo ainda não existe)');
assert(A('Write', { file_path: path.join(root, 'PastaNova/Sub/Nota.md'), content: 'x' }), 'criar pasta nova');
assert(A('Edit', { file_path: path.join(root, 'Pessoal/Diário.md') }));
assert(A('Grep', { path: root, pattern: 'x' }));
assert(A('Glob', { path: path.join(root, 'Projetos'), pattern: '**/*.md' }));
assert(!A('Glob', { path: root, pattern: '../**' }), 'glob que escapa');
assert(!A('Glob', { path: root, pattern: '.bot/*' }), 'glob em pasta com ponto');
assert(!A('Grep', { pattern: 'x' }), 'sem pasta: roda no cwd, pergunta');
assert(!A('Read', { file_path: path.join(root, '.bot/segredo.md') }), 'dot bloqueado');
assert(!A('Write', { file_path: path.join(root, '.obsidian/app.json') }));
assert(!A('Read', { file_path: path.join(outside, 'segredo.md') }), 'fora do vault');
assert(!A('Read', { file_path: path.join(root, '..', 'fora', 'segredo.md') }), 'com ..');
assert(!A('Read', { file_path: path.join(root, 'Pessoal/link.md') }), 'symlink para fora');
assert(!A('Write', { file_path: path.join(root, 'atalho', 'novo.md') }), 'criar através de symlink para fora');
assert(!A('Read', { file_path: 'Pessoal/Diário.md' }), 'relativo');
assert(!A('Bash', { command: `cat ${root}/Pessoal/Diário.md` }), 'Bash sempre pergunta');
assert(!A('WebFetch', { url: 'http://x' }));
assert(!A('Read', {}) && !A('Read', null));
assert(!V.autoAllow(null, 'Read', { file_path: '/x' }), 'sem vault');
// vault de mentira com prefixo parecido
fs.mkdirSync(path.join(tmp, 'cerebro-extra'));
w('x.md', 'x', path.join(tmp, 'cerebro-extra'));
assert(!A('Read', { file_path: path.join(tmp, 'cerebro-extra', 'x.md') }), 'prefixo parecido não conta');

// atividade
assert.deepStrictEqual(V.touchOf(root, 'Read', { file_path: path.join(root, 'Pessoal/Diário.md') }), { note: 'Pessoal/Diário.md', op: 'read' });
assert.deepStrictEqual(V.touchOf(root, 'Edit', { file_path: path.join(root, 'Pessoal/Diário.md') }), { note: 'Pessoal/Diário.md', op: 'write' });
assert.strictEqual(V.touchOf(root, 'Grep', { path: root, pattern: 'x' }).op, 'search');
assert.strictEqual(V.touchOf(root, 'Read', { file_path: '/etc/passwd' }), null);
assert.strictEqual(V.touchOf(root, 'Bash', { command: `ls ${root}` }).op, 'other');
assert.strictEqual(V.touchOf(root, 'Bash', { command: 'ls' }), null);
assert(V.touchOf(root, 'Read', { file_path: path.join(root, '.bot/segredo.md') }), 'atividade em pasta com ponto aparece (mas não é liberada)');

assert(V.systemNote(root).includes(root));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('vault: ok');
