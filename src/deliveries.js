'use strict';
/**
 * Entregas: o que cada agente terminou, do jeito que alguém que pediu o trabalho gostaria de receber.
 *
 * Uma entrega é o fim de um pedido em que o agente trabalhou (usou ferramentas) e respondeu. Sai do
 * transcript da sessão (o mesmo arquivo do Claude Code): o pedido, a primeira frase da resposta
 * (manchete), o último parágrafo (resumo), quantas ferramentas usou e quais arquivos criou ou alterou.
 *
 * Arquivos entregues: o celular nunca recebe um caminho. Cada arquivo ganha um id opaco, e só abre se
 *  - estiver dentro da pasta do projeto da sessão (caminho real, sem escapar por link simbólico);
 *  - não for oculto nem parecer segredo (.env, chaves, credenciais);
 *  - for texto, imagem ou PDF, de tamanho razoável.
 * Texto e código são servidos como texto puro (nunca como página), e SVG também.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { summarizeTool } = require('./collector');

const TAIL_BYTES = 4 * 1024 * 1024;
const MAX_PER_SESSION = 8;
const MAX_TEXT_FILE = 300 * 1024;
const MAX_BINARY_FILE = 8 * 1024 * 1024;
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SKIP_TEXT = /^\s*(<command-|<local-command|<system-reminder|<bash-|Caveat: The messages below)/;

const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.log', '.yml', '.yaml', '.toml', '.xml', '.html', '.htm', '.css', '.scss',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php',
  '.sh', '.sql', '.ini', '.conf', '.vue', '.svelte', '.tex', '.svg', '.prisma', '.graphql',
]);
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const SECRET_NAME = /(^|[\W_])(secret|secrets|credential|credentials|password|passwd|token|apikey|api[-_]key|private[-_]?key|id_rsa|id_ed25519|keystore)([\W_]|$)|\.(pem|key|p12|pfx|jks|kdbx|keystore)$/i;

function oneLine(t, n) {
  const x = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  return x.length > n ? x.slice(0, n - 1) + '…' : x;
}
function clipText(t, n) {
  const x = String(t == null ? '' : t).replace(/\r/g, '').trim();
  return x.length > n ? x.slice(0, n - 1) + '…' : x;
}

/** Tira o markdown mais comum para a manchete e o resumo ficarem legíveis num cartão. */
function plain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/(\*\*|__|\*|_)(.+?)\1/g, '$2')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSentence(t) {
  const x = plain(t);
  const m = x.match(/^(.{12,220}?[.!?])(\s|$)/);
  return clipText(m ? m[1] : x, 220);
}

function lastParagraph(t) {
  const paras = String(t || '').split(/\n\s*\n/).map((p) => plain(p)).filter(Boolean);
  return paras.length > 1 ? clipText(paras[paras.length - 1], 400) : '';
}

/** O arquivo pode ser mostrado no celular? Devolve { path, kind, mime, size } ou null. */
function openable(abs, cwd) {
  try {
    if (!abs || !cwd) return null;
    const root = fs.realpathSync(cwd);
    const real = fs.realpathSync(abs);
    const rel = path.relative(root, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const parts = rel.split(path.sep);
    if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) return null;
    if (SECRET_NAME.test(parts[parts.length - 1])) return null;
    const st = fs.statSync(real);
    if (!st.isFile()) return null;
    const ext = path.extname(real).toLowerCase();
    if (IMAGE_TYPES[ext]) return st.size <= MAX_BINARY_FILE ? { path: real, rel, kind: 'image', mime: IMAGE_TYPES[ext], size: st.size } : null;
    if (ext === '.pdf') return st.size <= MAX_BINARY_FILE ? { path: real, rel, kind: 'pdf', mime: 'application/pdf', size: st.size } : null;
    if (TEXT_EXT.has(ext)) return st.size <= MAX_TEXT_FILE ? { path: real, rel, kind: 'text', mime: 'text/plain; charset=utf-8', size: st.size } : null;
    return null;
  } catch {
    return null;
  }
}

function readTail(file) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return { lines, sig: `${st.size}:${Math.floor(st.mtimeMs)}` };
  } finally {
    fs.closeSync(fd);
  }
}

/** Transcript -> entregas daquela sessão (mais recentes primeiro). */
function parseTranscript(file, cwd) {
  const { lines, sig } = readTail(file);
  const reqs = [];
  let cur = null;
  const close = () => {
    if (cur && cur.tools > 0 && cur.text) reqs.push(cur);
    cur = null;
  };
  for (const raw of lines) {
    if (!raw) continue;
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!o || o.isSidechain || o.isMeta || (o.type !== 'user' && o.type !== 'assistant') || !o.message) continue;
    const ts = o.timestamp ? Date.parse(o.timestamp) || 0 : 0;
    const content = typeof o.message.content === 'string' ? [{ type: 'text', text: o.message.content }] : Array.isArray(o.message.content) ? o.message.content : [];
    if (o.type === 'user') {
      if (content.some((b) => b && b.type === 'tool_result')) continue;
      const t = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
      if (!t || SKIP_TEXT.test(t) || /^\[Request interrupted/.test(t)) continue;
      close();
      cur = { id: o.uuid || String(ts), request: oneLine(t, 240), startedAt: ts, finishedAt: ts, tools: 0, edited: new Map(), text: '', ids: 0 };
      continue;
    }
    if (!cur) continue;
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'tool_use') {
        cur.tools += 1;
        cur.text = ''; // a resposta final vem depois da última ferramenta
        const inp = b.input && typeof b.input === 'object' ? b.input : {};
        if (EDIT_TOOLS.has(b.name)) {
          const p = inp.file_path || inp.notebook_path;
          if (typeof p === 'string' && p) cur.edited.set(path.resolve(cwd || '/', p), b.name === 'Write' ? 'created' : 'edited');
        }
        cur.last = summarizeTool(b.name, inp);
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() && !o.isApiErrorMessage) {
        cur.text = b.text.trim();
        cur.finishedAt = ts || cur.finishedAt;
      }
    }
  }
  close();
  return { sig, reqs };
}

function createDeliveries({ collector }) {
  const cache = new Map(); // sid -> { sig, reqs, cwd }
  const files = new Map(); // id -> { path, mime, kind, sid }

  const fileId = (sid, abs) => crypto.createHash('sha256').update(`${sid}\0${abs}`).digest('hex').slice(0, 20);

  function ofSession(sid) {
    const info = collector.sessionInfo(sid);
    if (!info || !info.transcriptPath) return [];
    let hit = cache.get(sid);
    let sig = null;
    try {
      const st = fs.statSync(info.transcriptPath);
      sig = `${st.size}:${Math.floor(st.mtimeMs)}`;
    } catch {
      return [];
    }
    if (!hit || hit.sig !== sig || hit.cwd !== info.cwd) {
      try {
        const parsed = parseTranscript(info.transcriptPath, info.cwd);
        hit = { sig: parsed.sig, reqs: parsed.reqs, cwd: info.cwd };
        cache.set(sid, hit);
      } catch {
        return [];
      }
    }
    return hit.reqs.slice(-MAX_PER_SESSION).map((r) => ({ ...r, sid, project: info.project, cwd: info.cwd }));
  }

  /** Lista as entregas de todas as sessões (mais recentes primeiro), já no formato do celular. */
  function list(sessionIds, limit = 20) {
    const all = [];
    for (const sid of sessionIds) all.push(...ofSession(sid));
    all.sort((a, b) => b.finishedAt - a.finishedAt);
    return all.slice(0, limit).map((r) => {
      const fl = [];
      for (const [abs, how] of r.edited) {
        const ok = openable(abs, r.cwd);
        const id = fileId(r.sid, abs);
        if (ok) files.set(id, { path: ok.path, cwd: r.cwd, name: path.basename(ok.path) });
        fl.push({
          id: ok ? id : null,
          name: ok ? ok.rel : path.basename(abs),
          kind: ok ? ok.kind : 'file',
          how,
          open: !!ok,
          size: ok ? ok.size : 0,
        });
      }
      return {
        id: `${r.sid}:${r.id}`,
        sessionId: r.sid,
        project: r.project,
        request: r.request,
        headline: firstSentence(r.text),
        summary: lastParagraph(r.text),
        text: clipText(r.text, 6000),
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        tools: r.tools,
        edited: r.edited.size,
        files: fl.slice(0, 12),
      };
    });
  }

  /** Só o total e a hora da mais recente (barato: usa o cache do transcript), para o selo da aba. */
  function summary(sessionIds) {
    let n = 0;
    let latest = 0;
    for (const sid of sessionIds) {
      for (const r of ofSession(sid)) {
        n += 1;
        if (r.finishedAt > latest) latest = r.finishedAt;
      }
    }
    return { n, latest };
  }

  /** Dados de um arquivo entregue, se o id existe e o arquivo ainda é seguro de mostrar (confere de novo na hora). */
  function file(id) {
    const f = files.get(String(id));
    if (!f) return null;
    const ok = openable(f.path, f.cwd);
    return ok ? { path: ok.path, mime: ok.mime, kind: ok.kind, name: path.basename(ok.path), size: ok.size } : null;
  }

  return { list, file, summary, _internals: { parseTranscript, openable, firstSentence, lastParagraph, plain } };
}

module.exports = { createDeliveries, parseTranscript, openable };
