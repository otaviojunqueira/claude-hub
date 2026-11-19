'use strict';
/**
 * Coletor do Claude Hub.
 *
 * Fontes de dados (todas somente leitura):
 *   1. ~/.claude-hub/events.jsonl  -> eventos dos hooks (status, ações, subagentes, avisos)
 *   2. ~/.claude/projects/**.jsonl -> transcripts (tokens por modelo; e, para sessões
 *      sem hooks, um status aproximado)
 *
 * Nada aqui escreve nos arquivos do Claude Code.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const V = require('./vault');

const FEED_PER_SESSION = 120;
const FEED_GLOBAL = 250;
const HIDE_AFTER_MS = 72 * 3600e3; // some da tela após 3 dias sem atividade (departamento é de longa duração: você remove à mão quando quiser)
const HIDE_ENDED_AFTER_MS = HIDE_AFTER_MS; // encerrada ("Saiu") continua aparecendo, como qualquer departamento parado
const STALE_WORKING_MS = 5 * 60e3; // "trabalhando" sem nenhum sinal há 5min
const TRANSCRIPT_ONLY_IDLE_MS = 120e3;
const DISCOVERY_EVERY_MS = 3000;
const DISCOVERY_WINDOW_MS = 30 * 60e3;
const REPLAY_BYTES = 3 * 1024 * 1024;
const MAX_EVENTS_FILE = 30 * 1024 * 1024;

const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function bump(target, src, sign) {
  target.input += sign * src.input;
  target.output += sign * src.output;
  target.cacheRead += sign * src.cacheRead;
  target.cacheWrite += sign * src.cacheWrite;
}

/** Lê um arquivo .jsonl de forma incremental, sem reler o que já foi lido. */
class FileTail {
  constructor(file, { fromEnd = 0 } = {}) {
    this.file = file;
    this.offset = 0;
    this.rest = '';
    this.fromEnd = fromEnd;
    this.started = false;
    this.skipFirst = false;
    this.decoder = new StringDecoder('utf8');
  }

  read(maxBytes = 4 * 1024 * 1024) {
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      return { lines: [], more: false, exists: false };
    }
    if (!this.started) {
      this.started = true;
      if (this.fromEnd && st.size > this.fromEnd) {
        this.offset = st.size - this.fromEnd;
        this.skipFirst = true;
      }
    }
    if (st.size < this.offset) {
      // arquivo foi truncado/rotacionado
      this.offset = 0;
      this.rest = '';
      this.decoder = new StringDecoder('utf8');
    }
    if (st.size === this.offset) return { lines: [], more: false, exists: true, mtimeMs: st.mtimeMs };

    const len = Math.min(st.size - this.offset, maxBytes);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(this.file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset += len;

    const parts = (this.rest + this.decoder.write(buf)).split('\n');
    this.rest = parts.pop();
    if (this.skipFirst && parts.length) {
      parts.shift();
      this.skipFirst = false;
    }
    return {
      lines: parts.filter(Boolean),
      more: this.offset < st.size,
      exists: true,
      mtimeMs: st.mtimeMs,
    };
  }
}

function clip(text, n) {
  if (text == null) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function summarizeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const isAgent = name === 'Task' || name === 'Agent';
  if (isAgent) {
    const kind = i.subagent_type ? ` (${i.subagent_type})` : '';
    return `Subagente${kind}: ${clip(i.description || i.prompt, 110)}`;
  }
  if (name === 'mcp__escritorio__perguntar_departamento') return `Perguntando a ${clip(i.departamento, 40) || 'outro departamento'}: ${clip(i.pergunta, 110)}`;
  if (name === 'mcp__escritorio__delegar_tarefas') return `Delegando: ${clip(i.objetivo, 110) || 'plano de tarefas'}`;
  if (name === 'mcp__escritorio__listar_departamentos') return 'Vendo quem são os outros departamentos';
  const detail = i.command || i.file_path || i.path || i.pattern || i.url || i.query || i.skill || i.description || '';
  const firstLine = String(detail).split('\n')[0];
  return detail ? `${name}: ${clip(firstLine, 130)}` : String(name || 'ferramenta');
}

function shortModel(model) {
  if (!model) return null;
  return String(model).replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function homeShort(p, home) {
  if (!p) return '';
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}


// ------------------------------------------------------------ funcionários
const SEG_MAX = 300;
const TASK_MAX = 40;
const SEG_KEEP_MS = 2 * 3600e3;

function kindOf(name) {
  if (!name) return 'other';
  if (name === 'Task' || name === 'Agent') return 'delegate';
  if (/^(Read|Glob|Grep|LS|NotebookRead|WebFetch|WebSearch|ToolSearch|LSP)$/.test(name)) return 'read';
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) return 'edit';
  if (/^(Bash|BashOutput|KillShell|PowerShell|Monitor)$/.test(name)) return 'run';
  return 'other';
}

function toolDetail(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (name === 'Task' || name === 'Agent') return clip(i.description || i.prompt || i.subagent_type, 110);
  const d = i.command || i.file_path || i.path || i.pattern || i.url || i.query || i.skill || i.description || '';
  return clip(String(d).split('\n')[0], 130);
}

function newEmp(key, type, isLeader, ts) {
  return {
    key,
    type,
    isLeader,
    status: isLeader ? null : 'working',
    statusSince: ts,
    startedAt: ts,
    endedAt: null,
    lastTs: ts,
    waiting: false,
    description: null,
    currentAction: null,
    currentTool: null,
    currentDetail: null,
    lastMessage: null,
    segments: [],
    seg: null,
    tasks: [],
    task: null,
    stats: { tools: 0, reads: 0, editsTotal: 0, files: new Set(), commands: 0, delegations: 0, errors: 0, activeMs: 0, waitMs: 0 },
  };
}

function closeSeg(e, ts) {
  if (!e.seg) return;
  const end = Math.max(ts, e.seg.start);
  e.seg.end = end;
  const d = end - e.seg.start;
  if (e.seg.kind === 'wait') e.stats.waitMs += d;
  else e.stats.activeMs += d;
  e.seg = null;
}

function openSeg(e, kind, label, ts) {
  closeSeg(e, ts);
  const seg = { kind, label: clip(label, 100), start: ts, end: null };
  e.seg = seg;
  e.segments.push(seg);
  if (e.segments.length > SEG_MAX) e.segments.splice(0, e.segments.length - SEG_MAX);
  const cutoff = ts - SEG_KEEP_MS;
  while (e.segments.length > 1 && e.segments[0].end !== null && e.segments[0].end < cutoff) e.segments.shift();
}

function startTask(e, title, ts, max = TASK_MAX) {
  if (e.task && e.task.status === 'running') finishTask(e, ts, 'interrupted');
  e.task = { id: `${e.key}#${e.tasks.length + 1}`, title: clip(title, 160) || 'Tarefa', start: ts, end: null, status: 'running', result: null, tools: 0, commands: 0, files: new Set() };
  e.tasks.push(e.task);
  if (e.tasks.length > max) e.tasks.splice(0, e.tasks.length - max);
}

function finishTask(e, ts, status, result) {
  if (!e.task || e.task.status !== 'running') return;
  e.task.end = ts;
  e.task.status = status;
  if (result) e.task.result = clip(result, 400);
  e.task = null;
}

function recordTool(e, name, input, ts) {
  const i = input && typeof input === 'object' ? input : {};
  const kind = kindOf(name);
  const text = summarizeTool(name, i);
  e.currentTool = name;
  e.currentDetail = toolDetail(name, i);
  e.currentAction = text;
  e.stats.tools += 1;
  if (e.task) e.task.tools += 1;
  if (kind === 'read') e.stats.reads += 1;
  else if (kind === 'edit') {
    e.stats.editsTotal += 1;
    const f = i.file_path || i.notebook_path;
    if (f) {
      e.stats.files.add(f);
      if (e.task) e.task.files.add(f);
    }
  } else if (kind === 'run') {
    e.stats.commands += 1;
    if (e.task) e.task.commands += 1;
  } else if (kind === 'delegate') e.stats.delegations += 1;
  openSeg(e, kind, text, ts);
}

function empBase(e) {
  return path.basename(String(e));
}

function createCollector(opts = {}) {
  const home = opts.home || os.homedir();
  const hubDir = opts.hubDir || path.join(home, '.claude-hub');
  const claudeDir =
    opts.claudeDir || process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const eventsFile = opts.eventsFile || path.join(hubDir, 'events.jsonl');
  const from = Number(opts.from) || 0;
  const taskMax = opts.taskMax || TASK_MAX;
  const newTask = (e, title, ts) => startTask(e, title, ts, taskMax);
    const dismissedFile = path.join(hubDir, 'dismissed.json');
  const now = opts.now || (() => Date.now());

  const onChange = opts.onChange || (() => {});
  const onAlert = opts.onAlert || (() => {});

  const sessions = new Map();
  // Cérebro: quem mexeu em notas do vault (as mais recentes) — a sala da planta mostra isso ao vivo
  let vaultRoot = null;
  let vaultName = '';
  const vaultTouches = [];
  const VAULT_LIVE_MS = 30000;
  function noteVault(s, emp, name, input, ts) {
    if (!vaultRoot) return;
    const t = V.touchOf(vaultRoot, name, input);
    if (!t) return;
    const who = emp && !emp.isLeader ? emp.type || 'ajudante' : null;
    const last = vaultTouches[vaultTouches.length - 1];
    if (last && last.sessionId === s.id && last.who === who && last.note === t.note && last.op === t.op) {
      last.ts = ts;
      return;
    }
    vaultTouches.push({ ts, sessionId: s.id, project: s.project, who, note: t.note, op: t.op });
    if (vaultTouches.length > 60) vaultTouches.shift();
    dirty = true;
  }
  let eventsTail = null;
  let replaying = true;
  let dirty = true;
  let emitTimer = null;
  let pollTimer = null;
  let lastDiscovery = 0;
  let dismissed = {};
  let left = {}; // sessão -> instante em que o expediente acabou e os funcionários "foram embora"
  const leftFile = path.join(hubDir, 'left.json');

  // ---------------------------------------------------------------- preparação
  fs.mkdirSync(hubDir, { recursive: true });
  try {
    dismissed = JSON.parse(fs.readFileSync(dismissedFile, 'utf8')) || {};
  } catch {
    dismissed = {};
  }
  try {
    left = JSON.parse(fs.readFileSync(leftFile, 'utf8')) || {};
  } catch {
    left = {};
  }
  try {
    if (!opts.readOnly && fs.statSync(eventsFile).size > MAX_EVENTS_FILE) {
      fs.renameSync(eventsFile, path.join(hubDir, 'events.old.jsonl'));
    }
  } catch {
    /* arquivo ainda não existe */
  }
  // ------------------------------------------------------------------ sessões
  function getSession(id, ts) {
    let s = sessions.get(id);
    if (!s) {
      s = {
        id,
        cwd: '',
        project: '(sem nome)',
        transcriptPath: null,
        titles: { custom: null, ai: null, summary: null },
        hasHooks: false,
        status: 'idle',
        statusSince: ts,
        startedAt: null,
        lastActivity: 0,
        model: null,
        permissionMode: null,
        lastMessage: null,
        turnStartedAt: null,
        leader: newEmp('main', 'lider', true, ts),
        pending: [],
        agents: new Map(),
        feed: [],
        usage: { byMsg: new Map(), total: zero(), side: zero(), byModel: new Map() },
        tail: null,
        subTails: new Map(),
        subDirCheckedAt: 0,
        initialRead: false,
        lastFileMtime: 0,
      };
      sessions.set(id, s);
    }
    return s;
  }

  function setCwd(s, cwd) {
    if (cwd && cwd !== s.cwd) {
      s.cwd = cwd;
      s.project = path.basename(cwd) || cwd;
    }
  }

  function pushFeed(s, ts, kind, text, agentLabel, empKey) {
    s.feed.push({ ts, sessionId: s.id, project: s.project, agent: agentLabel || null, emp: empKey || 'main', kind, text });
    if (s.feed.length > FEED_PER_SESSION) s.feed.splice(0, s.feed.length - FEED_PER_SESSION);
    dirty = true;
  }

  function setStatus(s, status, ts, text) {
    if (s.status === status) return;
    const prev = s.status;
    s.status = status;
    s.statusSince = ts;
    dirty = true;
    if (replaying) return;
    if (status === 'waiting') {
      onAlert({ kind: 'waiting', sessionId: s.id, project: s.project, text: text || 'Aguardando você' });
    } else if (status === 'done' && prev === 'working') {
      onAlert({
        kind: 'done',
        sessionId: s.id,
        project: s.project,
        text: text || 'Terminou a tarefa',
        durationMs: s.turnStartedAt ? ts - s.turnStartedAt : 0,
      });
    } else if (status === 'error') {
      onAlert({ kind: 'error', sessionId: s.id, project: s.project, text: text || 'Erro no agente' });
    }
  }

  function markWorking(s, ts) {
    if (s.status === 'ended') return;
    if (s.status !== 'working') {
      s.turnStartedAt = ts;
      setStatus(s, 'working', ts);
    }
  }

  function ensureAgent(s, agentId, agentType, ts) {
    let a = s.agents.get(agentId);
    if (!a) {
      a = newEmp(agentId, agentType || 'subagente', false, ts);
      s.agents.set(agentId, a);
    } else if (agentType && a.type === 'subagente') {
      a.type = agentType;
    }
    return a;
  }

  function takePending(s, type) {
    if (!s.pending.length) return null;
    let i = s.pending.findIndex((p) => p.type && p.type === type);
    if (i < 0) i = 0;
    return s.pending.splice(i, 1)[0].description || null;
  }

  function anyWaiting(s) {
    if (s.leader.waiting) return true;
    for (const a of s.agents.values()) if (a.waiting) return true;
    return false;
  }

  function setWaiting(s, emp, ts, text) {
    emp.waiting = true;
    emp.currentAction = text;
    emp.currentTool = null;
    emp.currentDetail = null;
    openSeg(emp, 'wait', text, ts);
    setStatus(s, 'waiting', ts, text);
  }

  function clearWaiting(emp) {
    emp.waiting = false;
  }

  // ---------------------------------------------------------- eventos de hook
  function applyEvent(ev) {
    const type = ev.hook_event_name;
    const id = ev.session_id;
    if (!type || !id) return;
    const ts = Number(ev.ts) || now();
    if (from && ts < from) return;
    const s = getSession(id, ts);
    s.hasHooks = true;
    s.lastActivity = Math.max(s.lastActivity, ts);
    if (!s.startedAt) s.startedAt = ts;
    setCwd(s, ev.cwd);
    if (ev.transcript_path) s.transcriptPath = ev.transcript_path;
    if (ev.model) s.model = ev.model;
    if (ev.permission_mode) s.permissionMode = ev.permission_mode;

    const agent = ev.agent_id ? ensureAgent(s, ev.agent_id, ev.agent_type, ts) : null;
    const emp = agent || s.leader;
    emp.lastTs = ts;
    const label = agent ? agent.type : null;
    const fk = emp.key;
    const leader = s.leader;

    switch (type) {
      case 'SessionStart':
        s.status = 'idle';
        s.statusSince = ts;
        pushFeed(s, ts, 'session', `Sessão iniciada${ev.source ? ` (${ev.source})` : ''}`);
        break;

      case 'SessionEnd':
        setStatus(s, 'ended', ts);
        for (const e of [leader, ...s.agents.values()]) {
          closeSeg(e, ts);
          clearWaiting(e);
          finishTask(e, ts, 'interrupted');
          e.currentAction = null;
          e.currentTool = null;
          e.currentDetail = null;
          if (!e.isLeader && e.status === 'working') {
            e.status = 'done';
            e.endedAt = ts;
          }
        }
        pushFeed(s, ts, 'session', `Sessão encerrada${ev.reason && ev.reason !== 'other' ? ` (${ev.reason})` : ''}`);
        break;

      case 'UserPromptSubmit':
        s.turnStartedAt = ts;
        clearWaiting(leader);
        if (s.status !== 'working') setStatus(s, 'working', ts);
        newTask(leader, ev.prompt, ts);
        openSeg(leader, 'think', 'Pensando…', ts);
        leader.currentAction = 'Pensando…';
        leader.currentTool = null;
        leader.currentDetail = null;
        pushFeed(s, ts, 'prompt', `Prompt: ${clip(ev.prompt, 160)}`);
        break;

      case 'PreToolUse': {
        clearWaiting(emp);
        recordTool(emp, ev.tool_name, ev.tool_input, ts);
        noteVault(s, emp, ev.tool_name, ev.tool_input, ts);
        if (kindOf(ev.tool_name) === 'delegate') {
          const i = ev.tool_input || {};
          s.pending.push({ type: i.subagent_type || null, description: i.description || i.prompt || null });
          if (s.pending.length > 12) s.pending.shift();
        }
        markWorking(s, ts);
        pushFeed(s, ts, 'tool', emp.currentAction, label, fk);
        break;
      }

      case 'PostToolUse':
        clearWaiting(emp);
        markWorking(s, ts);
        openSeg(emp, 'think', 'Pensando…', ts);
        break;

      case 'PostToolUseFailure':
        emp.stats.errors += 1;
        clearWaiting(emp);
        markWorking(s, ts);
        openSeg(emp, 'think', 'Pensando…', ts);
        pushFeed(s, ts, 'error', `Falhou: ${summarizeTool(ev.tool_name, ev.tool_input)}`, label, fk);
        break;

      case 'PermissionRequest': {
        const txt = `Pede permissão: ${summarizeTool(ev.tool_name, ev.tool_input)}`;
        pushFeed(s, ts, 'notify', txt, label, fk);
        setWaiting(s, emp, ts, clip(txt, 110));
        break;
      }

      case 'PermissionDenied':
        clearWaiting(emp);
        openSeg(emp, 'think', 'Pensando…', ts);
        pushFeed(s, ts, 'notify', `Permissão negada: ${summarizeTool(ev.tool_name, ev.tool_input)}`, label, fk);
        break;

      case 'Notification': {
        const msg = ev.message || 'Notificação';
        const nt = ev.notification_type || '';
        pushFeed(s, ts, 'notify', msg, label, fk);
        if (nt === 'permission_prompt' || /permiss|permission/i.test(msg)) {
          if (!emp.waiting) setWaiting(s, emp, ts, clip(msg, 100));
        } else if (nt === 'idle_prompt' || /waiting for your input|aguardando/i.test(msg)) {
          if (!agent && s.status === 'working') setStatus(s, 'idle', ts);
        }
        break;
      }

      case 'Stop': {
        closeSeg(leader, ts);
        clearWaiting(leader);
        leader.currentAction = null;
        leader.currentTool = null;
        leader.currentDetail = null;
        s.lastMessage = clip(ev.last_assistant_message, 240) || s.lastMessage;
        leader.lastMessage = s.lastMessage;
        finishTask(leader, ts, 'done', ev.last_assistant_message);
        pushFeed(s, ts, 'stop', `Terminou: ${clip(ev.last_assistant_message, 200) || 'resposta concluída'}`);
        setStatus(s, 'done', ts, clip(ev.last_assistant_message, 110) || undefined);
        break;
      }

      case 'StopFailure':
        closeSeg(leader, ts);
        clearWaiting(leader);
        leader.currentAction = null;
        finishTask(leader, ts, 'error', ev.error || ev.message);
        pushFeed(s, ts, 'error', `Erro: ${clip(ev.error || ev.message || 'falha ao responder', 200)}`);
        setStatus(s, 'error', ts, clip(ev.error || ev.message, 110) || undefined);
        break;

      case 'SubagentStart': {
        if (agent) {
          const desc = takePending(s, agent.type);
          if (desc) agent.description = clip(desc, 160);
          agent.status = 'working';
          agent.statusSince = ts;
          newTask(agent, agent.description || agent.type, ts);
          openSeg(agent, 'think', 'Pensando…', ts);
        }
        pushFeed(s, ts, 'agent', `Subagente iniciado: ${label || 'subagente'}`, label, fk);
        markWorking(s, ts);
        break;
      }

      case 'SubagentStop':
        if (agent) {
          closeSeg(agent, ts);
          clearWaiting(agent);
          agent.status = 'done';
          agent.statusSince = ts;
          agent.endedAt = ts;
          agent.lastMessage = clip(ev.last_assistant_message, 240) || null;
          agent.currentAction = null;
          agent.currentTool = null;
          agent.currentDetail = null;
          finishTask(agent, ts, 'done', ev.last_assistant_message);
        }
        pushFeed(
          s,
          ts,
          'agent',
          `Subagente terminou${ev.last_assistant_message ? `: ${clip(ev.last_assistant_message, 160)}` : ''}`,
          label,
          fk
        );
        if (!anyWaiting(s) && s.status === 'waiting') setStatus(s, 'working', ts);
        break;

      case 'PreCompact':
        pushFeed(s, ts, 'session', 'Compactando o contexto da conversa');
        break;

      default:
        break;
    }
    dirty = true;
  }

  // ------------------------------------------------------- transcripts (tokens)
  function ingestTranscriptLine(s, raw, fromSubFile) {
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      return;
    }
    if (!o || typeof o !== 'object') return;
    const ts = o.timestamp ? Date.parse(o.timestamp) || 0 : 0;
    if (o.cwd && !s.cwd) setCwd(s, o.cwd);
    const side = !!o.isSidechain || fromSubFile;
    const msg = o.message;

    // Nome do chat, como o VS Code mostra: renomeado por você > título automático > resumo antigo.
    if (!side && typeof o.type === 'string') {
      const t = (v) => (typeof v === 'string' && v.trim() ? clip(v.replace(/\s+/g, ' ').trim(), 120) : null);
      const before = `${s.titles.custom}|${s.titles.ai}|${s.titles.summary}`;
      if (o.type === 'custom-title') s.titles.custom = t(o.customTitle) || s.titles.custom;
      else if (o.type === 'ai-title') s.titles.ai = t(o.aiTitle) || s.titles.ai;
      else if (o.type === 'summary') s.titles.summary = t(o.summary) || s.titles.summary;
      if (before !== `${s.titles.custom}|${s.titles.ai}|${s.titles.summary}`) dirty = true;
    }

    if (!s.hasHooks && ts) {
      s.lastActivity = Math.max(s.lastActivity, ts);
      if (!s.startedAt) s.startedAt = ts;
    }

    if (o.type === 'assistant' && msg && typeof msg === 'object') {
      const model = msg.model && msg.model !== '<synthetic>' ? msg.model : null;
      if (model && !side) s.model = model;

      const u = msg.usage;
      if (u && model) {
        const key = msg.id || o.uuid || `${o.requestId || ''}:${ts}`;
        const cur = {
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheWrite: u.cache_creation_input_tokens || 0,
          model,
          side,
        };
        const prev = s.usage.byMsg.get(key);
        if (prev) {
          bump(s.usage.total, prev, -1);
          if (prev.side) bump(s.usage.side, prev, -1);
          bump(modelBucket(s, prev.model), prev, -1);
        }
        bump(s.usage.total, cur, +1);
        if (cur.side) bump(s.usage.side, cur, +1);
        bump(modelBucket(s, cur.model), cur, +1);
        s.usage.byMsg.set(key, cur);
        dirty = true;
      }

      // Sessões sem hooks: status, feed e linha do tempo aproximados a partir do transcript.
      if (!s.hasHooks && !side && Array.isArray(msg.content)) {
        const when = ts || now();
        for (const block of msg.content) {
          if (block && block.type === 'tool_use') {
            if (s.status !== 'working') {
              s.turnStartedAt = when;
              setStatus(s, 'working', when);
            }
            recordTool(s.leader, block.name, block.input, when);
            noteVault(s, s.leader, block.name, block.input, when);
            s.leader.lastTs = when;
            pushFeed(s, when, 'tool', summarizeTool(block.name, block.input), null, 'main');
          }
        }
        if (msg.stop_reason === 'end_turn') {
          closeSeg(s.leader, when);
          s.leader.currentAction = null;
          s.leader.currentTool = null;
          const text = msg.content.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ');
          s.lastMessage = clip(text, 240) || s.lastMessage;
          s.leader.lastMessage = s.lastMessage;
          finishTask(s.leader, when, 'done', text);
          setStatus(s, 'done', when);
        }
      }
    } else if (o.type === 'user' && !s.hasHooks && !side && msg) {
      const c = msg.content;
      const when = ts || now();
      const isPrompt =
        typeof c === 'string' ||
        (Array.isArray(c) && c.some((b) => b && b.type === 'text'));
      if (isPrompt && !o.isMeta) {
        const text = typeof c === 'string' ? c : c.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
        s.turnStartedAt = when;
        setStatus(s, 'working', when);
        newTask(s.leader, text, when);
        openSeg(s.leader, 'think', 'Pensando…', when);
        s.leader.currentAction = 'Pensando…';
        pushFeed(s, when, 'prompt', `Prompt: ${clip(text, 160)}`, null, 'main');
      } else if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) {
        openSeg(s.leader, 'think', 'Pensando…', when);
      }
    }
  }

  function modelBucket(s, model) {
    let b = s.usage.byModel.get(model);
    if (!b) {
      b = zero();
      s.usage.byModel.set(model, b);
    }
    return b;
  }

  function pumpTranscripts(s) {
    if (!s.transcriptPath) return;
    if (!s.tail) s.tail = new FileTail(s.transcriptPath);

    const r = s.tail.read();
    for (const line of r.lines) ingestTranscriptLine(s, line, false);
    if (r.mtimeMs) s.lastFileMtime = Math.max(s.lastFileMtime, r.mtimeMs);
    if (r.exists && !r.more) s.initialRead = true;

    // Transcripts de subagentes em arquivos próprios (quando existirem):
    // <transcript sem .jsonl>/subagents/*.jsonl
    const t = now();
    if (t - s.subDirCheckedAt > 4000) {
      s.subDirCheckedAt = t;
      const dir = path.join(s.transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.jsonl') && !s.subTails.has(f)) {
            s.subTails.set(f, new FileTail(path.join(dir, f)));
          }
        }
      } catch {
        /* pasta não existe */
      }
    }
    for (const tail of s.subTails.values()) {
      const rr = tail.read();
      for (const line of rr.lines) ingestTranscriptLine(s, line, true);
    }
  }

  // --------------------------------------------- descoberta de sessões sem hook
  function discoverTranscripts() {
    const t = now();
    if (t - lastDiscovery < DISCOVERY_EVERY_MS) return;
    lastDiscovery = t;
    const root = path.join(claudeDir, 'projects');
    let dirs;
    try {
      dirs = fs.readdirSync(root);
    } catch {
      return;
    }
    for (const d of dirs) {
      const dir = path.join(root, d);
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const id = f.slice(0, -'.jsonl'.length);
        if (sessions.has(id)) continue;
        const full = path.join(dir, f);
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (t - st.mtimeMs > DISCOVERY_WINDOW_MS) continue;
        const s = getSession(id, st.mtimeMs);
        s.transcriptPath = full;
        s.lastActivity = st.mtimeMs;
        // se o transcript não trouxer cwd, usa o nome da pasta do projeto
        if (!s.cwd) s.project = d.replace(/^-/, '').split('-').filter(Boolean).pop() || d;
        dirty = true;
      }
    }
  }

  function inferTranscriptOnly() {
    const t = now();
    for (const s of sessions.values()) {
      if (s.hasHooks) continue;
      const lastSignal = Math.max(s.lastActivity, s.lastFileMtime);
      if (s.status === 'working' && s.initialRead && t - lastSignal > TRANSCRIPT_ONLY_IDLE_MS) {
        closeSeg(s.leader, lastSignal);
        s.leader.currentAction = null;
        finishTask(s.leader, lastSignal, 'interrupted');
        setStatus(s, 'idle', t);
        dirty = true;
      }
    }
  }

  // ----------------------------------------------------------------- snapshots
  function isVisible(s, t) {
    if (!s.lastActivity) return false;
    const d = dismissed[s.id];
    if (d && s.lastActivity <= d) return false;
    if (s.status === 'ended' && t - s.lastActivity > HIDE_ENDED_AFTER_MS) return false;
    if (t - s.lastActivity > HIDE_AFTER_MS) return false;
    return true;
  }

  const ORDER = { waiting: 0, working: 1, error: 2, done: 3, idle: 4, ended: 5 };
  const WINDOW_MAX_MS = 60 * 60e3;

  function empStatus(s, e) {
    if (e.isLeader) {
      if (s.status === 'ended') return 'ended';
      if (e.waiting) return 'waiting';
      return s.status === 'waiting' ? 'working' : s.status;
    }
    if (e.waiting && e.status === 'working') return 'waiting';
    return e.status;
  }

  function empView(s, e, t, stale, tk) {
    const status = empStatus(s, e);
    const live = (status === 'working' || status === 'waiting') && !stale;
    const from = t - WINDOW_MAX_MS;
    const segments = [];
    for (const g of e.segments) {
      const end = g.end === null ? (live ? t : Math.min(e.lastTs, t)) : g.end;
      if (end < from) continue;
      segments.push({ kind: g.kind, label: g.label, start: g.start, end: g.end === null && live ? null : end });
    }
    const open = e.seg;
    const openMs = open ? Math.max(0, (live ? t : Math.min(e.lastTs, t)) - open.start) : 0;
    const tasks = e.tasks
      .slice(-15)
      .reverse()
      .map((k) => ({
        id: k.id,
        title: k.title,
        start: k.start,
        end: k.end,
        status: k.status,
        result: k.result,
        tools: k.tools,
        commands: k.commands,
        files: k.files.size,
        fileNames: [...k.files].slice(-4).map(empBase),
      }));
    return {
      key: `${s.id}:${e.key}`,
      empKey: e.key,
      sessionId: s.id,
      project: s.project,
      isLeader: e.isLeader,
      type: e.type,
      description: e.description,
      status,
      statusSince: e.isLeader ? s.statusSince : e.statusSince,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      live,
      kind: open && live ? open.kind : null,
      currentAction: e.currentAction,
      currentTool: e.currentTool,
      currentDetail: e.currentDetail,
      lastMessage: e.lastMessage,
      stats: {
        tools: e.stats.tools,
        reads: e.stats.reads,
        edits: e.stats.files.size,
        editsTotal: e.stats.editsTotal,
        commands: e.stats.commands,
        delegations: e.stats.delegations,
        errors: e.stats.errors,
        activeMs: e.stats.activeMs + (open && open.kind !== 'wait' ? openMs : 0),
        waitMs: e.stats.waitMs + (open && open.kind === 'wait' ? openMs : 0),
      },
      segments,
      tasks,
      tokens: e.isLeader ? { ...tk, sub: { ...s.usage.side } } : null,
    };
  }

  function snapshot() {
    const t = now();
    const views = [];
    const feed = [];
    const totals = { active: 0, workers: 0, waiting: 0, tokens: 0 };

    for (const s of sessions.values()) {
      if (!isVisible(s, t)) continue;
      const tk = s.usage.total;
      const stale = s.status === 'working' && t - s.lastActivity > STALE_WORKING_MS;

      const agents = [...s.agents.values()].sort((a, b) => {
        const wa = empStatus(s, a) === 'done' ? 1 : 0;
        const wb = empStatus(s, b) === 'done' ? 1 : 0;
        return wa - wb || b.startedAt - a.startedAt;
      });
      let employees = [empView(s, s.leader, t, stale, tk), ...agents.slice(0, 16).map((a) => empView(s, a, t, stale, tk))];
      // Fim de expediente: o departamento fica, mas a equipe foi embora até haver nova atividade.
      const wentHome = !!left[s.id] && s.lastActivity <= left[s.id];
      if (wentHome) {
        employees = employees.map((e) => ({ ...e, status: 'ended', live: false, kind: null, currentAction: null, currentTool: null, currentDetail: null }));
      }
      const workers = employees.filter((e) => e.status === 'working' || e.status === 'waiting').length;

      views.push({
        id: s.id,
        project: s.project,
        title: s.titles.custom || s.titles.ai || s.titles.summary || null,
        cwd: homeShort(s.cwd, home),
        status: wentHome ? 'ended' : s.status,
        statusSince: s.statusSince,
        stale: wentHome ? false : stale,
        lastMessage: s.lastMessage,
        model: shortModel(s.model),
        permissionMode: s.permissionMode,
        source: s.hasHooks ? 'hooks' : 'transcript',
        startedAt: s.startedAt,
        lastActivity: s.lastActivity,
        turnStartedAt: s.turnStartedAt,
        tokens: { ...tk, sub: { ...s.usage.side } },
        employees,
        workingAgents: employees.filter((e) => !e.isLeader && (e.status === 'working' || e.status === 'waiting')).length,
      });

      for (const f of s.feed.slice(-60)) feed.push(f);
      if (s.status === 'working' || s.status === 'waiting') totals.active += 1;
      totals.workers += workers;
      totals.waiting += employees.filter((e) => e.status === 'waiting').length;
      totals.tokens += tk.input + tk.output + tk.cacheRead + tk.cacheWrite;
    }

    views.sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.lastActivity - a.lastActivity);
    feed.sort((a, b) => a.ts - b.ts);
    const vault = vaultRoot
      ? {
          name: vaultName,
          live: vaultTouches.filter((x) => t - x.ts <= VAULT_LIVE_MS).slice(-6).reverse(),
          recent: vaultTouches.slice(-10).reverse(),
        }
      : null;
    return { now: t, sessions: views, feed: feed.slice(-FEED_GLOBAL), totals, vault };
  }


  /** Dados de uma sessão para o chat do hub (caminhos reais, sem abreviar). */
  function sessionInfo(id) {
    const s = sessions.get(id);
    if (!s) return null;
    return { id: s.id, cwd: s.cwd || '', project: s.project, status: s.status, lastActivity: s.lastActivity, transcriptPath: s.transcriptPath || null };
  }

  /** Pastas de projeto já vistas (cwd real, sem abreviar), da mais recente para a mais antiga. */
  function knownProjects() {
    const seen = new Map();
    for (const s of [...sessions.values()].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))) {
      if (s.cwd && typeof s.cwd === 'string' && !seen.has(s.cwd)) seen.set(s.cwd, { cwd: s.cwd, project: s.project });
    }
    return [...seen.values()];
  }

  /** Dados do relatório de expediente: tudo que aconteceu desde `from` (opção do coletor). */
  function reportData() {
    const out = [];
    for (const s of sessions.values()) {
      if (!s.lastActivity) continue;
      const emps = [];
      for (const e of [s.leader, ...s.agents.values()]) {
        const open = e.seg;
        let active = e.stats.activeMs;
        let wait = e.stats.waitMs;
        if (open) {
          const d = Math.max(0, Math.max(e.lastTs, open.start) - open.start);
          if (open.kind === 'wait') wait += d;
          else active += d;
        }
        if (!(e.stats.tools > 0 || e.tasks.length > 0 || active > 0)) continue;
        emps.push({
          key: `${s.id}:${e.key}`,
          empKey: e.key,
          sessionId: s.id,
          project: s.project,
          isLeader: e.isLeader,
          type: e.type,
          description: e.description,
          startedAt: e.startedAt,
          lastTs: e.lastTs,
          stats: {
            tools: e.stats.tools,
            reads: e.stats.reads,
            edits: e.stats.files.size,
            editsTotal: e.stats.editsTotal,
            commands: e.stats.commands,
            delegations: e.stats.delegations,
            errors: e.stats.errors,
            activeMs: active,
            waitMs: wait,
          },
          tasks: e.tasks.map((k) => ({
            id: k.id,
            title: k.title,
            start: k.start,
            end: k.end === null ? Math.max(e.lastTs, k.start) : k.end,
            status: k.status,
            result: k.result,
            tools: k.tools,
            commands: k.commands,
            files: k.files.size,
            fileNames: [...k.files].slice(-4).map(empBase),
          })),
        });
      }
      if (!emps.length) continue;
      out.push({
        id: s.id,
        project: s.project,
        cwd: homeShort(s.cwd, home),
        startedAt: Math.min(...emps.map((x) => x.startedAt)),
        lastTs: Math.max(...emps.map((x) => x.lastTs)),
        employees: emps,
      });
    }
    out.sort((a, b) => a.startedAt - b.startedAt);
    return out;
  }

  // --------------------------------------------------------------------- laço
  function scheduleEmit() {
    if (emitTimer) return;
    emitTimer = setTimeout(() => {
      emitTimer = null;
      try {
        onChange(snapshot());
      } catch (e) {
        console.error('[claude-hub] falha ao emitir estado:', e);
      }
    }, 150);
  }

  function pollOnce() {
    if (!eventsTail) eventsTail = new FileTail(eventsFile, { fromEnd: opts.replayAll ? 0 : REPLAY_BYTES });

    let more = true;
    let guard = 0;
    while (more && guard++ < (opts.replayAll ? 1e7 : 20)) {
      const r = eventsTail.read(opts.replayAll ? 4 * 1024 * 1024 : 1024 * 1024);
      for (const line of r.lines) {
        try {
          applyEvent(JSON.parse(line));
        } catch {
          /* linha inválida: ignora */
        }
      }
      more = r.more;
    }
    if (replaying) {
      replaying = false; // a partir daqui, mudanças de status geram alertas
      dirty = true;
    }

    if (!opts.noTranscripts) discoverTranscripts();
    for (const s of sessions.values()) {
      if (opts.noTranscripts || !s.transcriptPath) continue;
      if (!isVisible(s, now())) continue;
      pumpTranscripts(s);
    }
    inferTranscriptOnly();

    if (dirty) {
      dirty = false;
      scheduleEmit();
    }
  }

  function saveDismissed() {
    try {
      fs.writeFileSync(dismissedFile, JSON.stringify(dismissed));
    } catch {
      /* ignora */
    }
  }

  return {
    start() {
      pollOnce();
      pollTimer = setInterval(pollOnce, 500);
    },
    stop() {
      if (pollTimer) clearInterval(pollTimer);
      if (emitTimer) clearTimeout(emitTimer);
      pollTimer = null;
      emitTimer = null;
    },
    pollOnce,
    snapshot,
    /** O usuário mandou parar pelo hub: o hook "Stop" não dispara numa interrupção, então a sala é aquietada aqui. */
    settle(sessionId, text) {
      const s = sessions.get(sessionId);
      if (!s || (s.status !== 'working' && s.status !== 'waiting')) return;
      const t = now();
      for (const e of [s.leader, ...s.agents.values()]) {
        closeSeg(e, t);
        clearWaiting(e);
        e.currentAction = null;
        e.currentTool = null;
        e.currentDetail = null;
        finishTask(e, t, 'interrupted', text);
        if (e !== s.leader && e.status === 'working') {
          e.status = 'done';
          e.statusSince = t;
          e.endedAt = t;
        }
      }
      pushFeed(s, t, 'stop', clip(text || 'Interrompido pelo usuário', 120));
      setStatus(s, 'idle', t);
    },
    /** Linha avulsa no feed de uma sessão (ex.: troca de mensagens entre departamentos). */
    note(sessionId, text) {
      const s = sessions.get(sessionId);
      if (!s) return;
      pushFeed(s, now(), 'ask', clip(text, 220));
    },
    /** Liga (ou desliga, com null) a vigilância das notas do Cérebro. */
    setVault(root) {
      vaultRoot = root || null;
      vaultName = root ? path.basename(root) : '';
      if (!root) vaultTouches.length = 0;
      dirty = true;
    },
    reportData,
    knownProjects,
    sessionInfo,
    /** Esconde uma sessão até que ela tenha nova atividade. */
    dismiss(id) {
      dismissed[id] = now();
      saveDismissed();
      dirty = true;
    },
    /** Esconde todas as sessões que não estão trabalhando nem esperando você. */
    dismissInactive(keep = []) {
      const t = now();
      const gone = [];
      for (const s of sessions.values()) {
        // Mantém quem está esperando você, ou trabalhando e dando sinal de vida, e os ids em `keep` (o gerente).
        const alive = s.status === 'waiting' || (s.status === 'working' && t - s.lastActivity <= STALE_WORKING_MS);
        if (!alive && !keep.includes(s.id) && isVisible(s, t)) {
          dismissed[s.id] = t;
          gone.push(s.id);
        }
      }
      saveDismissed();
      dirty = true;
      return gone;
    },
    /**
     * Fim de expediente: os departamentos continuam na planta e só os funcionários vão embora
     * (ficam como "Saiu"). Quem está trabalhando ou esperando você segue como está.
     */
    endShift() {
      const t = now();
      const gone = [];
      for (const s of sessions.values()) {
        const alive = s.status === 'waiting' || (s.status === 'working' && t - s.lastActivity <= STALE_WORKING_MS);
        if (!alive && isVisible(s, t)) {
          left[s.id] = t;
          gone.push(s.id);
        }
      }
      try {
        fs.writeFileSync(leftFile, JSON.stringify(left));
      } catch {
        /* ignora */
      }
      dirty = true;
      return gone;
    },
    /** Desfaz dismiss/dismissInactive: as sessões voltam para a planta. */
    undismiss(ids) {
      for (const id of Array.isArray(ids) ? ids : []) delete dismissed[id];
      saveDismissed();
      dirty = true;
    },
    paths: { hubDir, eventsFile, claudeDir },
  };
}

module.exports = { createCollector, FileTail, summarizeTool };
