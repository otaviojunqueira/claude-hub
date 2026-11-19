'use strict';
/**
 * Chat do departamento: conversa com a sessão do Claude Code direto pelo hub.
 *
 * Como funciona:
 *  - o histórico vem do próprio transcript da sessão (o mesmo que o VS Code usa), então
 *    aparece também o que foi dito no VS Code, e o que o hub manda entra no mesmo arquivo;
 *  - para falar, o hub abre `claude -p --resume <sessão>` (mesma sessão, sem criar cópia) com
 *    entrada e saída em stream-json e `--permission-prompt-tool stdio`: os pedidos de permissão
 *    chegam ao hub, que mostra "Aprovar/Negar" e devolve a resposta;
 *  - o processo fica vivo entre mensagens e é encerrado após 10 minutos parado;
 *  - nunca usa o modo que pula permissões.
 *
 * Cuidado de uso: a mesma conversa não deve ser digitada no VS Code e no hub ao mesmo tempo.
 * O hub recusa enviar enquanto a sessão está trabalhando por fora, mas um painel do VS Code
 * que já estava aberto só enxerga as mensagens do hub depois que a conversa é reaberta.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { findClaude } = require('./claudebin');
const { summarizeTool } = require('./collector');
const V = require('./vault');
const { ASK_TOOL, LIST_TOOL, DELEGATE_TOOL } = require('./office');

const MAX_TEXT = 20000;
const MAX_PROCS = 4;
// Quanto o Claude Code espera uma ferramenta do Escritório (aprovação sua + trabalho de outro departamento). O padrão dele é curto demais.
const MCP_TOOL_TIMEOUT_MS = 45 * 60 * 1000;
const IDLE_KILL_MS = 10 * 60 * 1000;
const TAIL_BYTES = 3 * 1024 * 1024;
const MAX_MESSAGES = 120;
const GRACE_MS = 4000;
const MODES = { ask: 'default', edit: 'acceptEdits', plan: 'plan', auto: 'auto' };
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_IMAGES = 5;
const MAX_IMAGE_B64 = 7 * 1024 * 1024; // ~5 MB de imagem
const MAX_FILES = 8;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MODEL_RE = /^[A-Za-z0-9._\-:[\]]{1,80}$/;

/** Modelos do seletor. `id` vazio = o padrão da sua conta (nenhum --model). Dá para acrescentar outros em
 *  ~/.claude-hub/config.json, em "models": [{ "id": "...", "label": "...", "desc": "..." }]. */
const BASE_MODELS = [
  { id: '', label: 'Padrão (recomendado)', desc: 'Opus 5.5 · Melhor para tarefas do dia a dia e complexas', effort: true },
  { id: 'opus', label: 'Opus 5.5', desc: 'Para trabalho complexo e do dia a dia', effort: true },
  { id: 'sonnet', label: 'Sonnet 5.5', desc: 'Mais eficiente para tarefas mais simples', effort: true },
  { id: 'claude-fable-5-2', label: 'Fable 5.2', desc: 'Para as tarefas mais difíceis', effort: true },
  { id: 'haiku', label: 'Haiku 5.5', desc: 'Mais rápido para respostas rápidas', effort: true },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', desc: 'O mais capaz para tarefas longas e difíceis', effort: true },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', desc: 'Rápido para respostas rápidas (sem ajuste de esforço)', effort: false },
];

function modelList(config) {
  const extra = config && Array.isArray(config.models) ? config.models : [];
  const out = BASE_MODELS.slice();
  for (const m of extra) {
    if (!m || typeof m.id !== 'string' || !MODEL_RE.test(m.id) || out.some((x) => x.id === m.id)) continue;
    out.push({ id: m.id, label: clip(m.label || m.id, 40), desc: clip(m.desc || 'Modelo adicionado na configuração', 100), effort: m.effort !== false });
  }
  return out;
}

const clip = (t, n) => {
  const x = String(t == null ? '' : t);
  return x.length > n ? x.slice(0, n - 1) + '…' : x;
};

/* ------------------------------------------------------------ histórico */
const LOCAL_CMDS = /^\/(rename|clear|model|effort|config|help|login|logout|status|cost|resume|exit|quit|mcp|permissions|memory|ide|doctor|color|fast|output-style|usage|context|terminal-setup|vim|theme|agents|hooks|add-dir|bug|release-notes)$/;
const SKIP_TEXT = /^\s*(<command-|<local-command|<system-reminder|<bash-|Caveat: The messages below)/;

function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function parseHistory(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { rev: 'none', messages: [] };
  }
  const start = Math.max(0, st.size - TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  let text;
  try {
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split('\n');
  if (start > 0) lines.shift(); // primeira linha pode estar cortada
  const out = [];
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
    const id = o.uuid || `${ts}-${out.length}`;
    const blocks = blocksOf(o.message.content);
    if (o.type === 'user') {
      if (blocks.some((b) => b && b.type === 'tool_result')) continue;
      let t = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
      const cmd = t.match(/<command-name>\s*([^<]*?)\s*<\/command-name>/);
      if (cmd) {
        const name = cmd[1].startsWith('/') ? cmd[1] : '/' + cmd[1];
        const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/);
        t = LOCAL_CMDS.test(name) ? '' : `${name}${args && args[1].trim() ? ' ' + args[1].trim() : ''}`;
      } else if (SKIP_TEXT.test(t)) t = '';
      const imgs = blocks.filter((b) => b && b.type === 'image').length;
      if (imgs) t = `${t}${t ? '\n' : ''}[${imgs === 1 ? 'imagem anexada' : imgs + ' imagens anexadas'}]`;
      if (!t) continue;
      if (/^\[Request interrupted/.test(t)) out.push({ id, ts, role: 'system', kind: 'note', text: 'Interrompido.' });
      else out.push({ id, ts, role: 'user', kind: 'text', text: clip(t, 8000) });
    } else {
      blocks.forEach((b, i) => {
        if (!b) return;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          out.push({ id: `${id}:${i}`, ts, role: 'assistant', kind: o.isApiErrorMessage ? 'error' : 'text', text: clip(b.text.trim(), 12000) });
        } else if (b.type === 'tool_use') {
          out.push({ id: `${id}:${i}`, ts, role: 'assistant', kind: 'tool', text: clip(summarizeTool(b.name, b.input), 200) });
        }
      });
    }
  }
  return { rev: `${st.size}:${Math.floor(st.mtimeMs)}`, messages: out.slice(-MAX_MESSAGES) };
}

/* -------------------------------------------------------------- gerente */
/** Encerra o processo `claude` e tudo o que ele abriu (comandos, servidores MCP): vão juntos, no mesmo grupo. */
function killProc(proc, sig = 'SIGTERM') {
  if (!proc) return;
  try {
    if (proc.pid && process.platform !== 'win32') process.kill(-proc.pid, sig);
    else proc.kill(sig);
  } catch {
    try {
      proc.kill(sig);
    } catch {
      /* já saiu */
    }
  }
}

function createChat({ collector, getConfig, claudeDir, onChange, home, getOffice }) {
  const chats = new Map();
  /** O Cérebro (vault do Obsidian) que os chats abertos pelo hub enxergam; null se desligado ou ausente. */
  const vaultRoot = () => {
    const cfg = getConfig() || {};
    return cfg.vaultOn === false ? null : V.resolveRoot(cfg.vaultDir, home);
  };
  let seq = 0;
  let notify = onChange || (() => {});

  /** Dados da sessão: os do coletor ou, para um departamento recém-criado no hub, o que o hub já sabe. */
  function infoOf(sid) {
    const real = collector.sessionInfo(sid);
    if (real) return real;
    const c = chats.get(sid);
    if (c && c.isNew && c.cwd) return { id: sid, cwd: c.cwd, project: path.basename(c.cwd), status: 'idle', lastActivity: 0, transcriptPath: null };
    return null;
  }

  function get(sid) {
    let c = chats.get(sid);
    if (!c) {
      c = { sid, isNew: false, cwd: null, proc: null, busy: false, mode: 'ask', opts: { mode: 'ask', model: '', effort: '', ultracode: false }, procSig: '', pending: new Map(), error: null, lastTurnEnd: 0, lastUse: Date.now(), stderr: '', buf: '', effectiveSid: sid, killTimer: null, vaultRoot: null, mcpOn: false, waiter: null, stopping: false };
      chats.set(sid, c);
    }
    return c;
  }

  function transcriptFor(c) {
    const info = infoOf(c.effectiveSid) || infoOf(c.sid);
    if (info && info.transcriptPath && fs.existsSync(info.transcriptPath)) return info.transcriptPath;
    try {
      const root = path.join(claudeDir, 'projects');
      for (const d of fs.readdirSync(root)) {
        const f = path.join(root, d, `${c.effectiveSid}.jsonl`);
        if (fs.existsSync(f)) return f;
      }
    } catch {
      /* sem pasta de projetos */
    }
    return null;
  }

  function blockedReason(c, info) {
    if (!info) return 'Essa sessão não existe mais no hub.';
    if (!info.cwd) return 'Ainda não sei em qual pasta essa sessão roda.';
    if (!c.isNew && !transcriptFor(c)) return 'Esse chat ainda está vazio no VS Code, e o hub só continua conversas que já têm mensagens. Mande a primeira mensagem por lá, ou crie um departamento novo pelo hub (botão "Novo departamento").';
    const t = Date.now();
    if (!c.busy && t - c.lastTurnEnd > GRACE_MS && (info.status === 'working' || info.status === 'waiting') && t - info.lastActivity < 120000) {
      return 'Essa conversa está trabalhando agora, provavelmente no VS Code. Espere terminar para não misturar as duas.';
    }
    return null;
  }

  function view(c) {
    const info = infoOf(c.sid);
    return {
      sid: c.sid,
      running: !!c.proc,
      busy: c.busy,
      mode: c.mode,
      opts: c.opts,
      error: c.error,
      vault: (() => {
        const r = vaultRoot();
        return r ? path.basename(r) : null;
      })(),
      blocked: blockedReason(c, info),
      pending: [...c.pending.values()].map((p) => ({ id: p.id, tool: p.tool, detail: p.detail, description: p.description, ts: p.ts, kind: p.kind || 'perm' })),
    };
  }

  const changed = () => notify();

  function writeLine(c, obj) {
    try {
      c.proc.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  /** Texto de erro útil: o que o Claude Code disse, ou o tipo da falha e o fim do stderr. */
  function explainFailure(c, j) {
    const parts = [];
    if (typeof j.result === 'string' && j.result.trim()) parts.push(j.result.trim());
    if (Array.isArray(j.errors)) parts.push(...j.errors.filter((e) => typeof e === 'string' && e.trim()).map((e) => e.trim()));
    let text = parts.join(' · ');
    if (/no conversation found/i.test(text)) return 'O Claude Code não achou essa conversa para continuar. Se ela ainda está vazia no VS Code, mande a primeira mensagem por lá ou crie um departamento novo pelo hub.';
    if (/already in use/i.test(text)) return 'Essa conversa já está aberta em outro lugar. Espere alguns segundos e tente de novo.';
    if (!text) {
      const tail = String(c.stderr || '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
      text = `A resposta falhou${j.subtype ? ` (${j.subtype})` : ''}${tail ? `: ${tail}` : ', sem mais detalhes do Claude Code'}.`;
    }
    return clip(text, 400);
  }

  function onLine(c, line) {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    if (!j || typeof j !== 'object') return;
    if (j.type === 'system' && j.subtype === 'init' && j.session_id) {
      c.effectiveSid = j.session_id;
      const si = infoOf(c.sid);
      if (si && si.cwd && Array.isArray(j.skills)) initSkills.set(si.cwd, j.skills.filter((n) => typeof n === 'string' && /^[\w:.-]+$/.test(n)).slice(0, 400));
    } else if (j.type === 'control_request' && j.request && j.request.subtype === 'can_use_tool') {
      const r = j.request;
      const input = r.input && typeof r.input === 'object' ? r.input : {};
      // Escritório: as duas ferramentas do hub passam direto pelo Claude Code; a aprovação do usuário
      // para perguntar a outro departamento é pedida pelo próprio hub (requestApproval), em qualquer modo.
      if (c.mcpOn && (r.tool_name === ASK_TOOL || r.tool_name === LIST_TOOL || r.tool_name === DELEGATE_TOOL)) {
        writeLine(c, { type: 'control_response', response: { subtype: 'success', request_id: j.request_id, response: { behavior: 'allow', updatedInput: input } } });
        return;
      }
      // Cérebro: ler e escrever notas do vault não pergunta (Bash e pastas com ponto continuam perguntando;
      // no modo Planejar só leitura passa).
      if (c.vaultRoot && !(c.opts.mode === 'plan' && V.isWrite(r.tool_name)) && V.autoAllow(c.vaultRoot, r.tool_name, input)) {
        writeLine(c, { type: 'control_response', response: { subtype: 'success', request_id: j.request_id, response: { behavior: 'allow', updatedInput: input } } });
        return;
      }
      const detail = input.command || input.file_path || input.path || input.url || input.pattern || input.query || input.description || input.prompt || '';
      c.pending.set(j.request_id, {
        id: j.request_id,
        tool: clip(r.display_name || r.tool_name, 60),
        detail: clip(detail || JSON.stringify(input), 800),
        description: clip(r.description || '', 300),
        input,
        ts: Date.now(),
      });
      changed();
    } else if (j.type === 'control_cancel_request' && j.request_id) {
      if (c.pending.delete(j.request_id)) changed();
    } else if (j.type === 'result') {
      c.busy = false;
      c.lastTurnEnd = Date.now();
      c.lastUse = Date.now();
      c.error = j.is_error ? explainFailure(c, j) : null;
      clearTimeout(c.killTimer);
      dropLocal(c);
      if (c.stopping) {
        // Parar de verdade: o turno acabou, então o processo não fica vivo em segundo plano (tarefas, comandos, MCP).
        // A próxima mensagem reabre a mesma conversa (--resume). E a sala volta a "Ocioso" no escritório.
        c.stopping = false;
        c.error = null;
        const old = c.proc;
        c.proc = null;
        killProc(old);
        if (collector.settle) collector.settle(c.effectiveSid || c.sid, 'Interrompido pelo usuário');
        if (c.sid !== c.effectiveSid && collector.settle) collector.settle(c.sid, 'Interrompido pelo usuário');
      }
      if (c.waiter) {
        // pergunta de outro departamento: a resposta final deste turno volta para quem perguntou
        const w = c.waiter;
        c.waiter = null;
        w(j.is_error ? { error: c.error || 'A resposta falhou.' } : { text: String(j.result || '').trim() || '(sem resposta em texto)' });
      }
      changed();
    }
  }

  function spawnProc(c, info, cb) {
    findClaude(getConfig, (err, bin) => {
      if (err) return cb(err);
      const args = [
        '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--permission-prompt-tool', 'stdio', '--permission-mode', MODES[c.opts.mode],
        // conversa que já tem mensagens salvas: continua; departamento novo do hub: nasce com este id
        ...(transcriptFor(c) ? ['--resume', c.sid] : ['--session-id', c.sid]),
      ];
      c.vaultRoot = vaultRoot();
      if (c.vaultRoot) args.push('--add-dir', c.vaultRoot);
      const office = getOffice && getOffice();
      const mcp = office ? office.mcpConfig(c.sid) : null;
      c.mcpOn = !!mcp;
      if (mcp) args.push('--mcp-config', mcp);
      const notes = [c.vaultRoot ? V.systemNote(c.vaultRoot) : '', mcp ? office.systemNote(c.sid) : ''].filter(Boolean);
      if (notes.length) args.push('--append-system-prompt', notes.join('\n\n'));
      if (c.opts.model) args.push('--model', c.opts.model);
      if (c.opts.ultracode) args.push('--effort', 'ultracode');
      else if (c.opts.effort) args.push('--effort', c.opts.effort);
      c.procSig = procSigOf(c);
      let child;
      try {
        child = spawn(bin, args, { cwd: info.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS), ...process.env }, detached: process.platform !== 'win32' });
      } catch (e) {
        return cb(e);
      }
      c.proc = child;
      c.buf = '';
      c.stderr = '';
      child.stdout.on('data', (d) => {
        c.buf += d;
        let i;
        while ((i = c.buf.indexOf('\n')) >= 0) {
          const line = c.buf.slice(0, i).trim();
          c.buf = c.buf.slice(i + 1);
          if (line) onLine(c, line);
        }
        if (c.buf.length > 4 * 1024 * 1024) c.buf = '';
      });
      child.stderr.on('data', (d) => {
        c.stderr = (c.stderr + d).slice(-2000);
      });
      child.stdin.on('error', () => {});
      child.on('error', (e) => {
        c.error = e.message;
      });
      child.on('close', (code) => {
        /* processo antigo (trocou de modo ou já foi substituído): não mexe no estado do atual */
        if (c.proc !== child) return;
        c.proc = null;
        const wasBusy = c.busy;
        c.busy = false;
        dropLocal(c);
        c.pending.clear();
        clearTimeout(c.killTimer);
        const stoppedByUser = c.stopping;
        c.stopping = false;
        if (stoppedByUser && collector.settle) collector.settle(c.effectiveSid || c.sid, 'Interrompido pelo usuário');
        if (wasBusy && !c.error && !stoppedByUser) c.error = clip(c.stderr.trim() || `O Claude Code saiu (código ${code}).`, 400);
        if (c.waiter) {
          const w = c.waiter;
          c.waiter = null;
          w({ error: c.error || 'O Claude Code saiu antes de responder.' });
        }
        changed();
      });
      cb(null);
    });
  }

  /** Há vaga para abrir mais um `claude`? No limite, a conversa parada há mais tempo (sem resposta nem pedido pendente) é fechada;
      ela volta sozinha (--resume) na próxima mensagem. `dry`: só diz se há vaga, sem fechar nada. */
  function makeRoom(except, dry) {
    const live = [...chats.values()].filter((x) => x.proc);
    if (live.length < MAX_PROCS) return true;
    const idle = live.filter((x) => x !== except && !x.busy && x.pending.size === 0 && !x.waiter).sort((a, b) => a.lastUse - b.lastUse)[0];
    if (!idle) return false;
    if (!dry) {
      const old = idle.proc;
      idle.proc = null;
      killProc(old);
      changed();
    }
    return true;
  }

  const optsSig = (o) => `${o.mode}|${o.model}|${o.ultracode ? 'ultracode' : o.effort}`;
  /** Assinatura do processo: ao mudar modo/modelo/esforço ou o papel de gerente, o próximo envio reabre a conversa. */
  const procSigOf = (c) => {
    const o = getOffice && getOffice();
    return optsSig(c.opts) + (o && o.isManager && o.isManager(c.sid) ? '|gerente' : '');
  };

  /** Aceita o modo como texto (compatível) ou um objeto { mode, model, effort, ultracode, attachments }. */
  function cleanOpts(raw) {
    const o = typeof raw === 'string' ? { mode: raw } : raw && typeof raw === 'object' ? raw : {};
    const mode = typeof o.mode === 'string' ? o.mode : 'ask';
    if (!MODES[mode]) return { error: 'Modo inválido.' };
    const model = typeof o.model === 'string' ? o.model.trim() : '';
    if (model && !MODEL_RE.test(model)) return { error: 'Nome de modelo inválido.' };
    const effort = typeof o.effort === 'string' ? o.effort : '';
    if (effort && !EFFORTS.includes(effort)) return { error: 'Esforço inválido.' };
    return { opts: { mode, model, effort, ultracode: o.ultracode === true } };
  }

  /** Imagens viram blocos de imagem; arquivos viram uma lista de caminhos no fim da mensagem. */
  function buildContent(text, attachments) {
    const list = Array.isArray(attachments) ? attachments : [];
    const images = [];
    const files = [];
    for (const a of list) {
      if (!a || typeof a !== 'object') continue;
      if (a.kind === 'image') {
        if (!IMAGE_TYPES.includes(a.mediaType) || typeof a.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(a.data)) return { error: 'Imagem inválida (use PNG, JPEG, GIF ou WebP).' };
        if (a.data.length > MAX_IMAGE_B64) return { error: 'Imagem grande demais (máximo de uns 5 MB).' };
        images.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } });
      } else if (a.kind === 'file') {
        if (typeof a.path !== 'string' || !path.isAbsolute(a.path)) return { error: 'Caminho de arquivo inválido.' };
        let ok = false;
        try {
          ok = fs.statSync(a.path).isFile();
        } catch {
          /* não existe */
        }
        if (!ok) return { error: `Não achei o arquivo ${path.basename(a.path)}.` };
        files.push(a.path);
      }
    }
    if (images.length > MAX_IMAGES) return { error: `No máximo ${MAX_IMAGES} imagens por mensagem.` };
    if (files.length > MAX_FILES) return { error: `No máximo ${MAX_FILES} arquivos por mensagem.` };
    let body = text.trim();
    if (!body && (images.length || files.length)) body = images.length && !files.length ? 'Veja a imagem anexada.' : 'Veja os anexos.';
    if (files.length) body += `\n\nArquivos anexados (leia pelo caminho):\n${files.map((f) => `- ${f}`).join('\n')}`;
    return { content: [...images, { type: 'text', text: body }] };
  }

  function send(sid, text, rawOpts) {
    const attachments = rawOpts && typeof rawOpts === 'object' ? rawOpts.attachments : null;
    const hasAtt = Array.isArray(attachments) && attachments.length > 0;
    if (typeof text !== 'string' || (!text.trim() && !hasAtt)) return { error: 'Escreva uma mensagem.' };
    if (text.length > MAX_TEXT) return { error: `A mensagem passa de ${MAX_TEXT} caracteres.` };
    const co = cleanOpts(rawOpts);
    if (co.error) return { error: co.error };
    const built = buildContent(text, attachments);
    if (built.error) return { error: built.error };
    const info = infoOf(sid);
    const c = get(sid);
    const why = blockedReason(c, info);
    if (why) return { error: why };
    if (c.busy) return { error: 'Ainda respondendo. Espere ou clique em Parar.' };
    if (!c.proc && !makeRoom(c)) return { error: `Já há ${MAX_PROCS} conversas abertas pelo hub, todas ocupadas. Espere uma terminar ou feche uma.` };

    c.opts = co.opts;
    if (c.proc && c.procSig !== procSigOf(c)) {
      const old = c.proc;
      c.proc = null;
      killProc(old); // parado: o próximo envio reabre com o novo modo/modelo/esforço
    }
    c.mode = c.opts.mode;
    c.error = null;
    c.busy = true;
    c.lastUse = Date.now();
    changed();

    const deliver = () => {
      const ok = writeLine(c, { type: 'user', message: { role: 'user', content: built.content }, parent_tool_use_id: null, session_id: '' });
      if (!ok) {
        c.busy = false;
        c.error = 'Não consegui falar com o Claude Code.';
        changed();
      }
    };
    if (c.proc) deliver();
    else {
      spawnProc(c, info, (err) => {
        if (err) {
          c.busy = false;
          c.error = err.message;
          changed();
        } else deliver();
      });
    }
    return { ok: true };
  }

  /** Novo departamento: reserva um id de sessão para uma pasta; a sessão nasce na primeira mensagem. */
  function prepare(cwd) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !isDir(cwd)) return { error: 'Essa pasta não existe.' };
    const sid = crypto.randomUUID();
    const c = get(sid);
    c.isNew = true;
    c.cwd = path.resolve(cwd);
    return { id: sid, cwd: c.cwd, project: path.basename(c.cwd) };
  }

  function decide(sid, requestId, behavior) {
    const c = chats.get(sid);
    const p = c && c.pending.get(requestId);
    if (p && p.local && ['allow', 'deny'].includes(behavior)) {
      // pedido do próprio hub (ex.: perguntar a outro departamento): a resposta volta para quem esperava
      c.pending.delete(requestId);
      p.local(behavior);
      changed();
      return true;
    }
    if (!p || !c.proc || !['allow', 'deny'].includes(behavior)) return false;
    const response = behavior === 'allow' ? { behavior: 'allow', updatedInput: p.input } : { behavior: 'deny', message: 'Negado pelo usuário no Claude Hub.' };
    writeLine(c, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    c.pending.delete(requestId);
    changed();
    return true;
  }

  /** Pedidos do hub que ainda esperam o usuário (perguntar a outro departamento) viram "cancelado". */
  function dropLocal(c) {
    for (const [id, p] of [...c.pending]) {
      if (p.local) {
        c.pending.delete(id);
        p.local('abort');
      }
    }
  }

  /** Escritório: o hub pede a aprovação do usuário no chat `sid` e devolve 'allow', 'deny', 'abort' (quem pediu desistiu) ou 'timeout'. */
  function requestApproval(sid, info, extra) {
    const c = chats.get(sid);
    if (!c || !c.proc) return Promise.resolve('abort');
    const { signal, timeoutMs } = extra || {};
    if (signal && signal.aborted) return Promise.resolve('abort');
    return new Promise((resolve) => {
      const id = `hub-ask-${++seq}`;
      const kind = info.kind === 'plan' ? 'plan' : 'office';
      let timer = null;
      let onAbort = null;
      const finish = (v) => {
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        resolve(v);
      };
      // Quem pediu desistiu (a chamada caiu ou foi interrompida) ou o prazo acabou: o pedido some e ninguém
      // pode mais aprová-lo, para não executar um plano que o agente já deu por perdido.
      const drop = (v) => {
        if (c.pending.delete(id)) changed();
        finish(v);
      };
      c.pending.set(id, { id, kind, tool: clip(info.tool, 60), detail: clip(info.detail, kind === 'plan' ? 2400 : 800), description: clip(info.description, 400), input: {}, ts: Date.now(), local: finish });
      if (signal) {
        onAbort = () => drop('abort');
        signal.addEventListener('abort', onAbort);
      }
      if (timeoutMs > 0) timer = setTimeout(() => drop('timeout'), timeoutMs);
      changed();
    });
  }

  /** Escritório: este chat pode receber uma pergunta agora? Devolve o motivo (texto) ou null. */
  function canAsk(sid) {
    const info = infoOf(sid);
    const c = get(sid);
    const why = blockedReason(c, info);
    if (why) return why;
    if (c.busy) return 'ele está respondendo outra coisa agora.';
    if (!c.proc && !makeRoom(c, true)) return `já há ${MAX_PROCS} conversas abertas pelo hub, todas ocupadas.`;
    return null;
  }

  /** Escritório: manda a pergunta como mensagem deste chat e resolve com a resposta final ({ text } ou { error }). */
  function ask(sid, text) {
    return new Promise((resolve) => {
      const c = get(sid);
      const r = send(sid, text, { ...c.opts });
      if (r.error) return resolve({ error: r.error });
      c.waiter = resolve;
    });
  }

  /** Caixa de entrada: tudo que espera o usuário em qualquer chat aberto pelo hub (permissões, perguntas e planos). */
  function inbox() {
    const out = [];
    for (const c of chats.values()) {
      if (!c.proc) continue;
      for (const p of c.pending.values()) out.push({ sid: c.sid, id: p.id, kind: p.kind || 'perm', tool: p.tool, detail: p.detail, description: p.description, ts: p.ts });
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  function stop(sid) {
    const c = chats.get(sid);
    if (c) dropLocal(c);
    if (!c || !c.proc || !c.busy) return false;
    writeLine(c, { type: 'control_request', request_id: `hub-int-${++seq}`, request: { subtype: 'interrupt' } });
    clearTimeout(c.killTimer);
    const proc = c.proc;
    c.stopping = true;
    // Se o Claude Code não encerrar o turno logo, derruba o processo inteiro (e, se preciso, à força).
    c.killTimer = setTimeout(() => {
      if (c.busy && c.proc === proc) {
        killProc(proc);
        setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) killProc(proc, 'SIGKILL');
        }, 2000);
      }
    }, 2500);
    return true;
  }

  function close(sid) {
    const c = chats.get(sid);
    if (!c) return;
    clearTimeout(c.killTimer);
    if (c.proc) killProc(c.proc);
    chats.delete(sid);
    changed();
  }

  function poll(sid, knownRev) {
    const c = get(sid);
    const file = transcriptFor(c);
    let rev = 'none';
    let messages = [];
    if (file) {
      try {
        const st = fs.statSync(file);
        rev = `${st.size}:${Math.floor(st.mtimeMs)}`;
      } catch {
        /* sumiu */
      }
      if (rev !== knownRev) ({ rev, messages } = parseHistory(file));
      else messages = null;
    }
    return { rev, messages, state: view(c) };
  }

  function setMode(sid, mode) {
    const c = get(sid);
    if (!MODES[mode] || c.busy) return view(c);
    c.mode = mode;
    c.opts = { ...c.opts, mode };
    return view(c);
  }


  /* ---------------------------------------------- comandos, arquivos e exportação */
  /** Lê o cabeçalho (frontmatter) simples de um .md; aceita `description: >` e `|` de várias linhas. */
  function frontmatter(text) {
    const m = String(text).match(/^---\r?\n([\s\S]*?)(\r?\n---|$)/);
    const out = {};
    if (!m) return out;
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const kv = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/);
      if (!kv) continue;
      let v = kv[2].trim();
      if (/^[>|][+-]?$/.test(v)) {
        const parts = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
        v = parts.join(' ');
      }
      out[kv[1].toLowerCase()] = v.replace(/^["']|["']$/g, '').trim();
    }
    return out;
  }

  function readHead(file) {
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(8192);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        return buf.toString('utf8', 0, n);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return '';
    }
  }

  const readJson = (f) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return null;
    }
  };
  const isDir = (d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  };
  const asList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

  function describeCmd(head, fallback) {
    const fm = frontmatter(head);
    if (fm.description) return clip(fm.description, 140);
    const body = head.replace(/^---[\s\S]*?(---|$)\s*/, '').split(/\r?\n/).find((l) => l.trim());
    return clip((body || fallback).replace(/^#+\s*/, ''), 140);
  }

  /** `.claude/commands`: .md soltos; subpastas viram `pasta:nome`. */
  function scanCommands(dir, source, out, prefix = '', ns = '', depth = 0) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (out.length > 600) return;
      if (e.isDirectory() && depth < 3) scanCommands(path.join(dir, e.name), source, out, `${prefix}${e.name}:`, ns, depth + 1);
      else if (e.isFile() && e.name.endsWith('.md')) {
        const head = readHead(path.join(dir, e.name));
        out.push({ name: `${ns}${prefix}${e.name.slice(0, -3)}`, description: describeCmd(head, 'Comando personalizado'), source });
      }
    }
  }

  /** `skills/<nome>/SKILL.md`; a skill não aparece no menu se tiver `user-invocable: false`. */
  function scanSkills(dir, source, out, ns = '') {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (out.length > 600) return;
      if (!e.isDirectory()) continue;
      const f = path.join(dir, e.name, 'SKILL.md');
      if (!fs.existsSync(f)) continue;
      const head = readHead(f);
      const fm = frontmatter(head);
      if (fm['user-invocable'] === 'false') continue;
      const name = /^[\w:.-]+$/.test(fm.name || '') ? fm.name : e.name;
      out.push({ name: `${ns}${name}`, description: describeCmd(head, 'Skill'), source });
    }
  }

  /** Plugins instalados: usa installed_plugins.json e, se não der, procura no cache de plugins. */
  function pluginRoots() {
    const roots = new Map(); // nome do plugin -> pasta
    const settings = [path.join(claudeDir, 'settings.json')];
    const enabled = {};
    for (const f of settings) {
      const j = readJson(f);
      if (j && j.enabledPlugins && typeof j.enabledPlugins === 'object') Object.assign(enabled, j.enabledPlugins);
    }
    const isOff = (key) => enabled[key] === false;
    const inst = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
    const table = inst && inst.plugins && typeof inst.plugins === 'object' ? inst.plugins : {};
    for (const [key, val] of Object.entries(table)) {
      if (isOff(key)) continue;
      const entries = asList(val);
      for (const ent of entries) {
        const root = ent && typeof ent.installPath === 'string' ? ent.installPath : null;
        if (root && isDir(root)) {
          roots.set(key.split('@')[0], root);
          break;
        }
      }
    }
    if (!roots.size) {
      // sem installed_plugins.json legível: cache/<marketplace>/<plugin>/<versão>
      const cache = path.join(claudeDir, 'plugins', 'cache');
      let mks = [];
      try {
        mks = fs.readdirSync(cache);
      } catch {
        /* sem cache */
      }
      for (const mk of mks) {
        let plugs = [];
        try {
          plugs = fs.readdirSync(path.join(cache, mk));
        } catch {
          continue;
        }
        for (const pl of plugs) {
          if (isOff(`${pl}@${mk}`)) continue;
          const base = path.join(cache, mk, pl);
          let vers = [];
          try {
            vers = fs.readdirSync(base).map((v) => [v, fs.statSync(path.join(base, v)).mtimeMs]).sort((a, b) => b[1] - a[1]);
          } catch {
            continue;
          }
          const hit = vers.map(([v]) => path.join(base, v)).find((d) => isDir(path.join(d, 'skills')) || isDir(path.join(d, 'commands')) || fs.existsSync(path.join(d, '.claude-plugin', 'plugin.json')));
          if (hit) roots.set(pl, hit);
        }
      }
    }
    return roots;
  }

  function scanPlugin(name, root, out) {
    const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json')) || {};
    const ns = `${/^[^\s@:/\\]+$/.test(manifest.name || '') ? manifest.name : name}:`;
    const src = `plugin ${ns.slice(0, -1)}`;
    const inside = (p) => {
      const full = path.resolve(root, p);
      return full === root || full.startsWith(root + path.sep) ? full : null;
    };
    scanSkills(path.join(root, 'skills'), src, out, ns);
    for (const p of asList(manifest.skills)) {
      const full = typeof p === 'string' ? inside(p) : null;
      if (!full) continue;
      if (fs.existsSync(path.join(full, 'SKILL.md'))) {
        const head = readHead(path.join(full, 'SKILL.md'));
        const fm = frontmatter(head);
        if (fm['user-invocable'] !== 'false') out.push({ name: `${ns}${/^[\w:.-]+$/.test(fm.name || '') ? fm.name : path.basename(full)}`, description: describeCmd(head, 'Skill'), source: src });
      } else scanSkills(full, src, out, ns);
    }
    if (!isDir(path.join(root, 'skills')) && !manifest.skills && fs.existsSync(path.join(root, 'SKILL.md'))) {
      const head = readHead(path.join(root, 'SKILL.md'));
      const fm = frontmatter(head);
      out.push({ name: `${ns}${/^[\w:.-]+$/.test(fm.name || '') ? fm.name : name}`, description: describeCmd(head, 'Skill'), source: src });
    }
    const cm = manifest.commands;
    if (cm && typeof cm === 'object' && !Array.isArray(cm)) {
      for (const [k, v] of Object.entries(cm)) {
        if (!/^[\w.-]+$/.test(k) || !v || typeof v !== 'object') continue;
        const f = typeof v.source === 'string' ? inside(v.source) : null;
        out.push({ name: `${ns}${k}`, description: clip(v.description || (f ? describeCmd(readHead(f), 'Comando do plugin') : 'Comando do plugin'), 140), source: src });
      }
    } else if (cm) {
      for (const p of asList(cm)) {
        const full = typeof p === 'string' ? inside(p) : null;
        if (!full) continue;
        if (isDir(full)) scanCommands(full, src, out, '', ns);
        else if (full.endsWith('.md')) out.push({ name: `${ns}${path.basename(full, '.md')}`, description: describeCmd(readHead(full), 'Comando do plugin'), source: src });
      }
    } else scanCommands(path.join(root, 'commands'), src, out, '', ns);
  }

  const pluginCache = { at: 0, list: [], count: 0 };
  function pluginCommands() {
    if (Date.now() - pluginCache.at < 30000) return pluginCache;
    const out = [];
    const roots = pluginRoots();
    for (const [name, root] of roots) scanPlugin(name, root, out);
    Object.assign(pluginCache, { at: Date.now(), list: out, count: roots.size });
    return pluginCache;
  }

  /** Skills que o próprio Claude Code listou ao abrir a sessão (por pasta de projeto). */
  const initSkills = new Map();

  /** Comandos e skills disponíveis: projeto (inclusive pastas acima), usuário, sincronizadas da conta e plugins. */
  function commandsInfo(sid) {
    const info = infoOf(sid);
    const out = [{ name: 'compact', description: 'Compactar a conversa para liberar contexto', source: 'Claude Code' }];
    const sources = [];
    const count = (label, fn, always = true) => {
      const before = out.length;
      fn();
      const n = out.length - before;
      if (n > 0 || always) sources.push({ label, count: n });
    };
    const home = require('os').homedir();
    if (info && info.cwd) {
      // da pasta do projeto subindo até a raiz do repositório (ou a pasta pessoal)
      let dir = info.cwd;
      for (let i = 0; i < 8; i++) {
        if (dir === home || dir === path.dirname(dir)) break;
        const d = dir;
        count(`projeto ${path.basename(d)}`, () => {
          scanCommands(path.join(d, '.claude', 'commands'), 'projeto', out);
          scanSkills(path.join(d, '.claude', 'skills'), 'projeto', out);
        }, i === 0); // pastas acima só aparecem quando acham algo
        if (fs.existsSync(path.join(d, '.git'))) break;
        dir = path.dirname(dir);
      }
    }
    count('~/.claude', () => {
      scanCommands(path.join(claudeDir, 'commands'), 'usuário', out);
      scanSkills(path.join(claudeDir, 'skills'), 'usuário', out);
      scanSkills(path.join(claudeDir, 'skills', 'synced'), 'conta', out);
    });
    const pl = pluginCommands();
    sources.push({ label: `${pl.count} plugin(s)`, count: pl.list.length });
    out.push(...pl.list);
    const known = new Set(out.map((c) => c.name));
    const live = info && info.cwd ? initSkills.get(info.cwd) : null;
    let extra = 0;
    for (const n of live || []) {
      if (!known.has(n)) {
        out.push({ name: n, description: 'Skill instalada', source: 'Claude Code' });
        extra++;
      }
    }
    if (live) sources.push({ label: 'lista do Claude Code', count: extra });
    const seen = new Set();
    return { list: out.filter((c) => (seen.has(c.name) ? false : seen.add(c.name))), sources };
  }

  const commands = (sid) => commandsInfo(sid).list;

  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '__pycache__', 'venv', '.venv', 'coverage', 'target', '.cache', '.turbo', '.gradle', 'vendor']);
  const fileCache = new Map();

  function projectFiles(cwd) {
    const hit = fileCache.get(cwd);
    if (hit && Date.now() - hit.at < 20000) return hit.list;
    const list = [];
    const queue = [['', 0]];
    while (queue.length && list.length < 6000) {
      const [rel, depth] = queue.shift();
      let ents;
      try {
        ents = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of ents) {
        if (list.length >= 6000) break;
        if (e.name.startsWith('.') && e.name !== '.env.example' && !['.github', '.claude'].includes(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && depth < 8) queue.push([r, depth + 1]);
        } else if (e.isFile()) list.push(r);
      }
    }
    fileCache.set(cwd, { at: Date.now(), list });
    if (fileCache.size > 8) fileCache.delete(fileCache.keys().next().value);
    return list;
  }

  /** Arquivos da pasta do projeto que combinam com o texto (para @menção). */
  function files(sid, query) {
    const info = infoOf(sid);
    if (!info || !info.cwd) return [];
    const q = String(query || '').toLowerCase().slice(0, 100);
    const all = projectFiles(info.cwd);
    if (!q) return all.slice(0, 40);
    const scored = [];
    for (const f of all) {
      const low = f.toLowerCase();
      const i = low.indexOf(q);
      if (i < 0) continue;
      const base = low.slice(low.lastIndexOf('/') + 1);
      scored.push([base.startsWith(q) ? 0 : base.includes(q) ? 1 : 2, f.length, f]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return scored.slice(0, 40).map((x) => x[2]);
  }

  /** A conversa inteira em Markdown (o que o transcript guarda). */
  function exportMarkdown(sid, title) {
    const c = get(sid);
    const file = transcriptFor(c);
    const { messages } = file ? parseHistory(file) : { messages: [] };
    const lines = [`# ${title || 'Conversa'}`, ''];
    for (const m of messages) {
      if (m.kind === 'tool') lines.push(`> ${m.text}`, '');
      else if (m.kind === 'note') lines.push(`_${m.text}_`, '');
      else lines.push(`**${m.role === 'user' ? 'Você' : 'Agente'}:**`, '', m.text, '');
    }
    return lines.join('\n');
  }

  const sweeper = setInterval(() => {
    const t = Date.now();
    for (const c of chats.values()) {
      if (c.proc && !c.busy && c.pending.size === 0 && t - c.lastUse > IDLE_KILL_MS) killProc(c.proc);
      if (c.isNew && !c.proc && !c.busy && t - c.lastUse > 2 * 60 * 60 * 1000 && !transcriptFor(c)) chats.delete(c.sid); // rascunho esquecido
    }
  }, 60000);
  if (sweeper.unref) sweeper.unref();

  return {
    send,
    prepare,
    known: (sid) => !!infoOf(sid),
    getOpts: (sid) => ({ ...get(sid).opts }),
    hasProc: (sid) => {
      const c = chats.get(sid);
      return !!(c && c.proc);
    },
    canAsk,
    inbox,
    requestApproval,
    ask,
    decide,
    stop,
    close,
    poll,
    setMode,
    commands,
    commandsInfo,
    files,
    exportMarkdown,
    models: () => modelList(getConfig()),
    onChange: (fn) => {
      notify = fn;
    },
    shutdown() {
      clearInterval(sweeper);
      for (const c of chats.values()) {
        clearTimeout(c.killTimer);
        if (c.proc) killProc(c.proc);
      }
      chats.clear();
    },
    _parseHistory: parseHistory,
  };
}

module.exports = { createChat, parseHistory };
