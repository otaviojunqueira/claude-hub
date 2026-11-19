#!/usr/bin/env node
'use strict';
/**
 * Registra (ou remove) os hooks do Claude Hub em ~/.claude/settings.json.
 *
 *   node scripts/install-hooks.js              instala
 *   node scripts/install-hooks.js --uninstall  remove só o que o hub adicionou
 *   node scripts/install-hooks.js --dry-run    mostra o resultado sem gravar
 *   node scripts/install-hooks.js --no-usage   não mexe no statusline (sem o mostrador de uso ao vivo)
 *   node scripts/install-hooks.js --settings /outro/caminho/settings.json
 *
 * Sempre faz um backup ao lado do arquivo antes de gravar e nunca mexe em hooks
 * que não sejam do hub. Pode ser rodado várias vezes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER = 'claude-hub-hook.py';
const PERMIT_MARKER = 'claude-hub-permit.py';
const EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
];

const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const dryRun = args.includes('--dry-run');
const si = args.indexOf('--settings');
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const settingsPath = si >= 0 && args[si + 1] ? path.resolve(args[si + 1]) : path.join(claudeDir, 'settings.json');
const hookScript = path.resolve(__dirname, '..', 'hook', MARKER);
const permitScript = path.resolve(__dirname, '..', 'hook', PERMIT_MARKER);
const TAP_MARKER = 'claude-hub-statusline.py';
const tapScript = path.resolve(__dirname, '..', 'hook', TAP_MARKER);
const noUsage = args.includes('--no-usage');
const hubDir = process.env.CLAUDE_HUB_DIR || path.join(os.homedir(), '.claude-hub');
const origFile = path.join(hubDir, 'statusline-original.json');

function isHubGroup(group) {
  return (
    group &&
    Array.isArray(group.hooks) &&
    group.hooks.some((h) => h && typeof h.command === 'string' && (h.command.includes(MARKER) || h.command.includes(PERMIT_MARKER)))
  );
}

let settings = {};
if (fs.existsSync(settingsPath)) {
  const raw = fs.readFileSync(settingsPath, 'utf8');
  if (raw.trim()) {
    try {
      settings = JSON.parse(raw);
    } catch (e) {
      console.error(`Não consegui ler ${settingsPath} como JSON (${e.message}).`);
      console.error('Nada foi alterado. Corrija o arquivo (ou use --settings) e rode de novo.');
      process.exit(1);
    }
  }
}
if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
  console.error(`${settingsPath} não contém um objeto JSON. Nada foi alterado.`);
  process.exit(1);
}

settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};

// Remove entradas antigas do hub (torna a instalação idempotente e permite atualizar o caminho).
for (const [event, groups] of Object.entries(settings.hooks)) {
  if (!Array.isArray(groups)) continue;
  const kept = groups.filter((g) => !isHubGroup(g));
  if (kept.length) settings.hooks[event] = kept;
  else delete settings.hooks[event];
}

if (!uninstall) {
  const command = `python3 "${hookScript}"`;
  for (const event of EVENTS) {
    const group = { hooks: [{ type: 'command', command, async: true, timeout: 10 }] };
    settings.hooks[event] = [...(settings.hooks[event] || []), group];
  }
  // Hook de permissão do Modo celular: síncrono, mas sai na hora quando o modo está desligado.
  const permitGroup = { hooks: [{ type: 'command', command: `python3 "${permitScript}"`, timeout: 330 }] };
  settings.hooks.PermissionRequest = [...(settings.hooks.PermissionRequest || []), permitGroup];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

// Mostrador de uso (5 h / semana): o statusline passa pelo tap do hub, que só anota o uso e repassa ao comando original.
// O comando original fica guardado ao lado (hubDir) para a remoção devolver tudo como estava.
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
let usageNote = '';
if (!noUsage) {
  const cur = settings.statusLine && typeof settings.statusLine === 'object' ? settings.statusLine : null;
  const wrapped = !!(cur && typeof cur.command === 'string' && cur.command.includes(TAP_MARKER));
  if (uninstall) {
    if (wrapped) {
      let orig = null;
      try {
        orig = JSON.parse(fs.readFileSync(origFile, 'utf8'));
      } catch {
        // sem registro do original: some o statusline que era só do tap
      }
      if (orig && orig.statusLine) settings.statusLine = orig.statusLine;
      else delete settings.statusLine;
      usageNote = 'statusline devolvido ao que era';
      if (!dryRun) fs.rmSync(origFile, { force: true });
    }
  } else if (!wrapped) {
    const orig = cur && typeof cur.command === 'string' && cur.command.trim() ? cur.command : '';
    const command = `python3 "${tapScript}"${orig ? ` --cmd ${shq(orig)}` : ''}`;
    if (!dryRun) {
      fs.mkdirSync(hubDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(origFile, JSON.stringify({ statusLine: cur }) + '\n', { mode: 0o600 });
    }
    settings.statusLine = { ...(cur || {}), type: 'command', command };
    usageNote = orig ? 'statusline existente preservado (o tap roda na frente dele)' : 'statusline criado só para ler o uso';
  } else {
    usageNote = 'tap do statusline já estava instalado';
  }
}

const out = JSON.stringify(settings, null, 2) + '\n';

if (dryRun) {
  console.log(out);
  process.exit(0);
}

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
if (fs.existsSync(settingsPath)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${settingsPath}.bak-claude-hub-${stamp}`;
  fs.copyFileSync(settingsPath, backup);
  console.log(`Backup: ${backup}`);
}
fs.writeFileSync(settingsPath, out);

if (uninstall) {
  console.log(`Hooks do Claude Hub removidos de ${settingsPath}.`);
  if (usageNote) console.log(`Mostrador de uso: ${usageNote}.`);
} else {
  console.log(`Hooks do Claude Hub instalados em ${settingsPath} (${EVENTS.length} eventos, mais o hook de permissão do Modo celular).`);
  if (usageNote) console.log(`Mostrador de uso: ${usageNote}.`);
  console.log('Sessões do Claude Code já abertas só carregam os hooks quando forem reiniciadas.');
  console.log('Dica: dentro do Claude Code, o comando /hooks mostra o que está ativo.');
}
