'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createUsage, parseWindow, rollover, toEpochMs, STALE_AFTER_MS } = require('../src/usage');

// ---- conversões
assert.strictEqual(toEpochMs(1893456000), 1893456000000, 'segundos viram ms');
assert.strictEqual(toEpochMs(1893456000000), 1893456000000, 'ms ficam como estão');
assert.strictEqual(toEpochMs('2030-01-01T00:00:00Z'), Date.parse('2030-01-01T00:00:00Z'));
assert.strictEqual(toEpochMs('lixo'), undefined);
assert.deepStrictEqual(parseWindow({ used_percentage: 150, resets_at: 1893456000 }), { pct: 100, resetsAt: 1893456000000 }, 'limita a 100%');
assert.deepStrictEqual(parseWindow({ utilization: '42' }), { pct: 42 });
assert.strictEqual(parseWindow({ used_percentage: 'x' }), undefined);
assert.strictEqual(parseWindow(null), undefined);

// ---- janela vencida some (não vira 0%)
const NOW = 1_800_000_000_000;
const r = rollover({ source: 'cache', fetchedAt: NOW, fiveHour: { pct: 90, resetsAt: NOW - 1 }, sevenDay: { pct: 10, resetsAt: NOW + 1000 } }, NOW);
assert.strictEqual(r.fiveHour, undefined);
assert.strictEqual(r.sevenDay.pct, 10);

// ---- leitura de arquivos
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-usage-'));
const home = path.join(tmp, 'home');
const claudeDir = path.join(home, '.claude');
const hubDir = path.join(home, '.claude-hub');
fs.mkdirSync(claudeDir, { recursive: true });
fs.mkdirSync(hubDir, { recursive: true });
let now = NOW;
const make = () => createUsage({ hubDir, claudeDir, home, now: () => now });

assert.strictEqual(make().read().state, 'empty', 'sem nada: vazio');
assert.strictEqual(make().read().tapInstalled, false);

// cache do Claude Code (~/.claude.json)
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: NOW - 60_000, utilization: { five_hour: { utilization: 20, resets_at: new Date(NOW + 3600e3).toISOString() }, seven_day: { utilization: 50, resets_at: new Date(NOW + 86400e3).toISOString() } } } }));
let u = make().read();
assert.strictEqual(u.state, 'ok');
assert.strictEqual(u.source, 'cache');
assert.strictEqual(u.fiveHour.pct, 20);
assert.strictEqual(u.sevenDay.resetsAt, NOW + 86400e3);

// o tap do statusline é mais novo: vale ele
fs.writeFileSync(path.join(hubDir, 'usage.json'), JSON.stringify({ fetchedAt: NOW - 1000, five_hour: { used_percentage: 34, resets_at: Math.floor((NOW + 5340e3) / 1000) }, seven_day: { used_percentage: 38, resets_at: Math.floor((NOW + 170e6) / 1000) } }));
u = make().read();
assert.strictEqual(u.source, 'statusline');
assert.strictEqual(u.fiveHour.pct, 34);
assert.strictEqual(u.account, 'Conta');

// números velhos: marcados como desatualizados
now = NOW + STALE_AFTER_MS + 5000;
assert.strictEqual(make().read().state, 'stale');
// janela de 5 h renovou: some a barra dela, a semanal continua
now = NOW + 6000e3;
u = make().read();
assert.strictEqual(u.fiveHour, null, 'janela vencida fica sem dado');
assert.strictEqual(u.sevenDay.pct, 38);
now = NOW;

// arquivo quebrado não derruba nada
fs.writeFileSync(path.join(hubDir, 'usage.json'), '{quebrado');
assert.strictEqual(make().read().source, 'cache');

// conta com outra pasta: nome amigável, e o .claude.json fica dentro dela
const dirC = path.join(home, '.claude-c');
fs.mkdirSync(dirC);
assert.strictEqual(createUsage({ hubDir, claudeDir: dirC, home, now: () => NOW }).read().account, 'Conta C');
assert.strictEqual(createUsage({ hubDir, claudeDir: dirC, home, now: () => NOW }).read().state, 'empty', 'outra conta não herda o cache da padrão');

// ---- instalador do statusline (backup, preserva o original, idempotente, desfaz)
const hasPy = spawnSync('python3', ['--version']).status === 0;
const settings = path.join(tmp, 'settings.json');
const env = { ...process.env, CLAUDE_HUB_DIR: path.join(tmp, 'hub2') };
const install = (...a) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'install-hooks.js'), '--settings', settings, ...a], { env, encoding: 'utf8' });
const orig = { type: 'command', command: `echo "oi 'mundo'"`, padding: 1 };
fs.writeFileSync(settings, JSON.stringify({ model: 'x', statusLine: orig }));
let out = install();
assert.strictEqual(out.status, 0, out.stderr);
let s = JSON.parse(fs.readFileSync(settings, 'utf8'));
assert.ok(s.statusLine.command.includes('claude-hub-statusline.py'), 'statusline passa pelo tap');
assert.ok(s.statusLine.command.includes(`'echo "oi '\\''mundo'\\''"'`) || s.statusLine.command.includes('--cmd'), 'comando original preservado');
assert.strictEqual(s.statusLine.padding, 1, 'padding preservado');
assert.strictEqual(s.model, 'x');
assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith('settings.json.bak-claude-hub-')), 'backup feito');
const wrapped = s.statusLine.command;
install();
assert.strictEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command, wrapped, 'instalar de novo não empilha o tap');
// o mostrador sabe se o tap está instalado (lê o settings.json da conta)
fs.writeFileSync(path.join(claudeDir, 'settings.json'), fs.readFileSync(settings, 'utf8'));
assert.strictEqual(make().read().tapInstalled, true);
fs.rmSync(path.join(claudeDir, 'settings.json'));
if (hasPy) {
  const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12.5, resets_at: 1893456000 }, seven_day: { used_percentage: 3, resets_at: 1893556000 } } });
  const run = spawnSync('sh', ['-c', wrapped], { input, env, encoding: 'utf8' });
  assert.strictEqual(run.status, 0);
  assert.strictEqual(run.stdout.trim(), "oi 'mundo'", 'o tap repassa a saída do statusline original');
  const rec = JSON.parse(fs.readFileSync(path.join(tmp, 'hub2', 'usage.json'), 'utf8'));
  assert.strictEqual(rec.five_hour.used_percentage, 12.5);
  assert.deepStrictEqual(Object.keys(rec).sort(), ['fetchedAt', 'five_hour', 'seven_day'], 'só os números do uso são gravados');
  const fromTap = createUsage({ hubDir: path.join(tmp, 'hub2'), claudeDir: path.join(tmp, 'x'), home: tmp, now: () => rec.fetchedAt + 1000 }).read();
  assert.strictEqual(fromTap.fiveHour.pct, 12.5);
  // JSON sem rate_limits (ou lixo): não grava nada e o original ainda roda
  fs.rmSync(path.join(tmp, 'hub2', 'usage.json'));
  const run2 = spawnSync('sh', ['-c', wrapped], { input: 'não é json', env, encoding: 'utf8' });
  assert.strictEqual(run2.status, 0);
  assert.strictEqual(run2.stdout.trim(), "oi 'mundo'");
  assert.ok(!fs.existsSync(path.join(tmp, 'hub2', 'usage.json')));
}
install('--uninstall');
s = JSON.parse(fs.readFileSync(settings, 'utf8'));
assert.deepStrictEqual(s.statusLine, orig, 'desinstalar devolve o statusline original');
assert.strictEqual(s.hooks, undefined);

// sem statusline anterior: cria o tap puro e, ao desfazer, remove
fs.writeFileSync(settings, JSON.stringify({}));
install();
s = JSON.parse(fs.readFileSync(settings, 'utf8'));
assert.ok(s.statusLine.command.includes('claude-hub-statusline.py') && !s.statusLine.command.includes('--cmd'));
install('--uninstall');
assert.strictEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine, undefined);

// --no-usage não mexe no statusline
fs.writeFileSync(settings, JSON.stringify({ statusLine: orig }));
install('--no-usage');
assert.deepStrictEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine, orig);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('usage.test.js: ok');
