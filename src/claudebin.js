'use strict';
/** Acha o comando `claude` neste computador (configuração, pastas comuns, nvm, extensão do VS Code, shell de login). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

let cached = null;

function findClaude(getConfig, cb) {
  const cfg = (getConfig && getConfig()) || {};
  if (cfg.claudeBin) {
    // Caminho definido por você manda: se não existir, avisa em vez de procurar outro.
    try {
      fs.accessSync(cfg.claudeBin, fs.constants.X_OK);
      return cb(null, cfg.claudeBin);
    } catch {
      return cb(new Error(`O "claudeBin" definido em ~/.claude-hub/config.json não existe ou não é executável: ${cfg.claudeBin}`));
    }
  }
  if (cached && fs.existsSync(cached)) return cb(null, cached);
  const home = os.homedir();
  const candidates = [];
  candidates.push(path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/usr/bin/claude');
  for (const base of [path.join(home, '.nvm', 'versions', 'node'), path.join(home, '.vscode', 'extensions')]) {
    try {
      for (const d of fs.readdirSync(base)) {
        if (base.endsWith('node')) candidates.push(path.join(base, d, 'bin', 'claude'));
        else if (d.startsWith('anthropic.claude-code')) candidates.push(path.join(base, d, 'resources', 'native-binary', 'claude'));
      }
    } catch {
      /* pasta inexistente */
    }
  }
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      cached = c;
      return cb(null, c);
    } catch {
      /* próximo */
    }
  }
  execFile('bash', ['-lc', 'command -v claude'], { timeout: 8000 }, (err, stdout) => {
    const p = String(stdout || '').trim().split('\n')[0];
    if (!err && p && fs.existsSync(p)) {
      cached = p;
      return cb(null, p);
    }
    cb(new Error('Não achei o comando "claude" neste computador. Defina "claudeBin" em ~/.claude-hub/config.json.'));
  });
}

module.exports = { findClaude };
