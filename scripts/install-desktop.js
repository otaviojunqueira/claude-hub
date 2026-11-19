#!/usr/bin/env node
'use strict';
/**
 * Cria o atalho do Claude Hub no menu de aplicativos do Ubuntu
 * (~/.local/share/applications/claude-hub.desktop).
 *
 *   node scripts/install-desktop.js              só o atalho no menu
 *   node scripts/install-desktop.js --autostart  também abre ao ligar o PC
 *   node scripts/install-desktop.js --remove     remove atalho e autostart
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron');
const icon = path.join(root, 'assets', 'icon.png');
const appsDir = path.join(os.homedir(), '.local', 'share', 'applications');
const autoDir = path.join(os.homedir(), '.config', 'autostart');
const desktopFile = path.join(appsDir, 'claude-hub.desktop');
const autoFile = path.join(autoDir, 'claude-hub.desktop');
const args = process.argv.slice(2);

if (args.includes('--remove')) {
  for (const f of [desktopFile, autoFile]) if (fs.existsSync(f)) fs.unlinkSync(f);
  console.log('Atalho e autostart removidos.');
  process.exit(0);
}

if (!fs.existsSync(electronBin)) {
  console.error('Electron não encontrado. Rode "npm install" na pasta do hub primeiro.');
  process.exit(1);
}

const q = (p) => `"${p.replace(/(["\\$`])/g, '\\$1')}"`;
const content = `[Desktop Entry]
Type=Application
Name=Claude Hub
Comment=Acompanhe seus agentes do Claude Code
Exec=${q(electronBin)} ${q(root)} --no-sandbox
Path=${root}
Icon=${icon}
Terminal=false
Categories=Development;
StartupWMClass=claude-hub
`;

fs.mkdirSync(appsDir, { recursive: true });
fs.writeFileSync(desktopFile, content, { mode: 0o755 });
console.log(`Atalho criado: ${desktopFile}`);

if (args.includes('--autostart')) {
  fs.mkdirSync(autoDir, { recursive: true });
  fs.writeFileSync(autoFile, content + 'X-GNOME-Autostart-enabled=true\n', { mode: 0o755 });
  console.log(`Início automático ativado: ${autoFile}`);
}
console.log('Procure por "Claude Hub" no menu de aplicativos (pode ser preciso reabrir o menu).');
