'use strict';
// "Cérebro": o vault do Obsidian dentro do escritório.
// Tudo aqui é seguro por construção: nenhum caminho sai do vault (realpath), pastas com ponto
// (.bot, .obsidian, .git, .trash) nunca são listadas, lidas, buscadas nem liberadas sozinhas.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_READ = 400 * 1024;
const MAX_SEARCH_FILE = 1024 * 1024;
const MAX_WALK = 6000;
const NOTE_EXT = /\.(md|markdown|txt|canvas)$/i;

// Ferramentas de arquivo que o hub libera sozinho dentro do vault (Bash continua pedindo).
const AUTO_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function expand(dir, home) {
  const d = String(dir || '').trim();
  if (!d) return path.join(home || os.homedir(), 'cerebro');
  if (d === '~') return home || os.homedir();
  if (d.startsWith('~/')) return path.join(home || os.homedir(), d.slice(2));
  return d;
}

/** Caminho real do vault, ou null se não existir. */
function resolveRoot(dir, home) {
  try {
    const p = expand(dir, home);
    if (!path.isAbsolute(p)) return null;
    const real = fs.realpathSync(p);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

const hasDot = (rel) => rel.split(path.sep).some((s) => s.startsWith('.') && s !== '.' && s !== '..');

/** Realpath do que existe (o ancestral mais fundo existente) + o resto ainda não criado. */
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (let i = 0; i < 64; i++) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return null;
      rest.push(path.basename(cur));
      cur = up;
    }
  }
  return null;
}

/** Caminho relativo ao vault (sem pontos escondidos) ou null. `allowDot` só para mostrar atividade. */
function relInside(root, abs, allowDot = false) {
  if (!root || typeof abs !== 'string' || !path.isAbsolute(abs) || abs.includes('\0')) return null;
  const real = realish(abs);
  if (!real) return null;
  const rel = path.relative(root, real);
  if (rel === '') return '';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!allowDot && hasDot(rel)) return null;
  return rel;
}

/** Resolve um caminho relativo vindo da tela para um caminho absoluto dentro do vault. */
function safeAbs(root, rel) {
  if (!root || typeof rel !== 'string' || rel.includes('\0') || path.isAbsolute(rel)) return null;
  const abs = path.join(root, rel);
  return relInside(root, abs) === null ? null : realish(abs);
}

function list(root, rel = '') {
  const abs = safeAbs(root, rel);
  if (!abs) return { error: 'Pasta fora do vault.' };
  let ents;
  try {
    ents = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return { error: 'Não consegui abrir essa pasta.' };
  }
  const dirs = [];
  const notes = [];
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(abs, e.name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    // atalho que aponta para fora do vault não aparece
    if (e.isSymbolicLink() && relInside(root, full) === null) continue;
    const r = path.join(rel, e.name);
    if (st.isDirectory()) dirs.push({ name: e.name, path: r, type: 'dir' });
    else if (NOTE_EXT.test(e.name)) notes.push({ name: e.name.replace(/\.(md|markdown)$/i, ''), path: r, type: 'note', mtime: Math.floor(st.mtimeMs), size: st.size });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'pt'));
  notes.sort((a, b) => b.mtime - a.mtime);
  return { path: rel, entries: [...dirs, ...notes] };
}

function read(root, rel) {
  const abs = safeAbs(root, rel);
  if (!abs || !NOTE_EXT.test(abs)) return { error: 'Nota não encontrada.' };
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { error: 'Nota não encontrada.' };
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(Math.min(st.size, MAX_READ));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return { path: rel, title: path.basename(abs).replace(/\.(md|markdown)$/i, ''), text: buf.toString('utf8'), truncated: st.size > MAX_READ, mtime: Math.floor(st.mtimeMs) };
  } catch {
    return { error: 'Não consegui ler essa nota.' };
  }
}

function walk(root, visit) {
  const stack = [root];
  let n = 0;
  while (stack.length && n < MAX_WALK) {
    const dir = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(full);
      else if (NOTE_EXT.test(e.name)) {
        n += 1;
        if (visit(full) === false) return;
      }
    }
  }
}

/** Busca por nome e por conteúdo. Mais recentes primeiro. */
function search(root, query, limit = 40) {
  const q = String(query || '').trim().toLowerCase().slice(0, 80);
  if (!root || q.length < 2) return { query: q, results: [] };
  const out = [];
  walk(root, (full) => {
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      return true;
    }
    const rel = path.relative(root, full);
    const name = path.basename(full).replace(/\.(md|markdown)$/i, '');
    let snippet = '';
    let score = 0;
    if (name.toLowerCase().includes(q)) score = 2;
    if (st.size <= MAX_SEARCH_FILE) {
      try {
        const text = fs.readFileSync(full, 'utf8');
        const i = text.toLowerCase().indexOf(q);
        if (i >= 0) {
          score = Math.max(score, 1);
          const a = Math.max(0, i - 50);
          snippet = text.slice(a, i + q.length + 90).replace(/\s+/g, ' ').trim();
        }
      } catch {
        /* binário ou sem permissão */
      }
    }
    if (score) out.push({ name, path: rel, snippet, score, mtime: Math.floor(st.mtimeMs) });
    return true;
  });
  out.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  return { query: q, results: out.slice(0, limit) };
}

/** Resumo para a sala do Cérebro: pastas de topo com contagem e notas mexidas por último. */
function overview(root) {
  if (!root) return { exists: false };
  const folders = [];
  const recent = [];
  let total = 0;
  walk(root, (full) => {
    total += 1;
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      return true;
    }
    const rel = path.relative(root, full);
    const top = rel.includes(path.sep) ? rel.split(path.sep)[0] : '';
    let f = folders.find((x) => x.name === top);
    if (!f) folders.push((f = { name: top, notes: 0 }));
    f.notes += 1;
    recent.push({ name: path.basename(full).replace(/\.(md|markdown)$/i, ''), path: rel, mtime: Math.floor(st.mtimeMs) });
    return true;
  });
  folders.sort((a, b) => b.notes - a.notes);
  recent.sort((a, b) => b.mtime - a.mtime);
  return { exists: true, name: path.basename(root), total, folders: folders.slice(0, 12), recent: recent.slice(0, 8) };
}

/**
 * O hub pode liberar esta chamada sem perguntar? Só ferramentas de arquivo, com o caminho
 * (ou a pasta da busca) dentro do vault e fora de pastas com ponto. Bash nunca passa por aqui.
 */
function autoAllow(root, toolName, input) {
  if (!root || !AUTO_TOOLS.has(toolName) || !input || typeof input !== 'object') return false;
  const target = input.file_path || input.notebook_path || input.path;
  if (typeof target !== 'string' || !target) return false;
  if (relInside(root, target) === null) return false;
  if (toolName === 'Glob' || toolName === 'Grep') {
    // padrões que escapam da pasta ou apontam para pastas com ponto não passam
    for (const k of ['pattern', 'glob']) {
      const v = input[k];
      if (typeof v !== 'string') continue;
      if (toolName === 'Glob' && (v.includes('..') || path.isAbsolute(v))) return false;
      if (toolName === 'Glob' && /(^|[\\/])\.[^\\/.]/.test(v)) return false;
    }
  }
  return true;
}

/** A chamada mexe no vault? Para mostrar atividade na sala (pastas com ponto contam). */
function touchOf(root, toolName, input) {
  if (!root || !input || typeof input !== 'object') return null;
  const target = input.file_path || input.notebook_path || input.path;
  if (typeof target === 'string' && target) {
    const rel = relInside(root, target, true);
    if (rel === null) return null;
    const op = WRITE_TOOLS.has(toolName) ? 'write' : toolName === 'Grep' || toolName === 'Glob' || toolName === 'LS' ? 'search' : toolName === 'Read' ? 'read' : 'other';
    return { note: rel, op };
  }
  if (toolName === 'Bash' && typeof input.command === 'string' && input.command.includes(root)) return { note: '', op: 'other' };
  return null;
}

/** Instrução que o hub acrescenta ao Claude nos chats que abre. */
function systemNote(root) {
  return [
    `Você tem acesso ao "Cérebro", o vault do Obsidian da pessoa, em ${root}.`,
    'Consulte-o quando o assunto pedir contexto: notas de projetos (Projetos/<projeto>), pessoais (Pessoal), recursos (Recursos) e a caixa de entrada (00-Inbox).',
    'Leia e escreva notas em Markdown livremente por lá, preservando os links [[assim]] e o frontmatter. Pastas que começam com ponto (.bot, .obsidian, .git) são do sistema: não mexa nelas.',
    'Ao criar ou alterar uma nota, diga o caminho dela.',
  ].join(' ');
}

const isWrite = (toolName) => WRITE_TOOLS.has(toolName);

module.exports = { isWrite, resolveRoot, expand, relInside, safeAbs, list, read, search, overview, autoAllow, touchOf, systemNote };
