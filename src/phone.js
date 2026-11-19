'use strict';
/**
 * Modo celular: servidor HTTP local, só para a rede privada (Wi-Fi de casa).
 *
 * Segurança:
 *  - desligado por padrão; liga só pelo botão do hub e desliga sozinho (tempo escolhido);
 *  - escuta apenas no IP do Wi-Fi (não em 0.0.0.0) e só atende endereços de rede privada;
 *  - QR de uso único: o código vai no fragmento da URL (#), que nunca é enviado ao servidor;
 *    o primeiro celular que o usar recebe uma chave própria, e o código deixa de valer;
 *  - um único celular pareado por vez; "Novo QR" revoga o anterior;
 *  - toda chamada de dados exige a chave (comparação em tempo constante), com bloqueio
 *    temporário após tentativas erradas;
 *  - confere o cabeçalho Host (contra DNS rebinding), limita o tamanho do corpo e só aceita JSON;
 *  - novas tarefas só rodam em pastas de projeto que o hub já viu, sem shell, com modo de
 *    permissão restrito (só ler/planejar, ou também editar arquivos), no máximo 2 ao mesmo tempo.
 *
 * O tráfego é HTTP puro dentro da sua rede. Por isso o modo é temporário e o pareamento é único.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { findClaude } = require('./claudebin');
const { createDeliveries } = require('./deliveries');

const PORT_START = 4747;
const MAX_BODY = 8 * 1024;
const MAX_PROMPT = 4000;
const MAX_RUNNING = 2;
const TASK_TIMEOUT_MS = 30 * 60 * 1000;
const OUT_LIMIT = 400 * 1024;
const FAIL_LIMIT = 8;
const FAIL_LOCK_MS = 60 * 1000;

const STATIC = {
  '/': ['phone/index.html', 'text/html; charset=utf-8'],
  '/phone.css': ['phone/phone.css', 'text/css; charset=utf-8'],
  '/phone.js': ['phone/phone.js', 'application/javascript; charset=utf-8'],
  '/persona.js': ['renderer/persona.js', 'application/javascript; charset=utf-8'],
  '/sector.js': ['renderer/sector.js', 'application/javascript; charset=utf-8'],
};

const rand = (n) => crypto.randomBytes(n).toString('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

function isPrivateAddress(addr) {
  let a = String(addr || '');
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || a === '127.0.0.1') return true;
  const m = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [o1, o2] = [Number(m[1]), Number(m[2])];
    return o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168) || (o1 === 169 && o2 === 254);
  }
  return /^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a);
}

/** Endereços IPv4 privados das interfaces de rede, Wi-Fi primeiro. */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || !isPrivateAddress(i.address)) continue;
      if (/^(docker|br-|veth|virbr|lo|tun|tap|wg|zt)/i.test(name)) continue;
      out.push({ name, address: i.address, wifi: /^(wl|wlan|wi-?fi)/i.test(name) });
    }
  }
  return out.sort((a, b) => Number(b.wifi) - Number(a.wifi));
}

function clip(t, n) {
  const x = String(t == null ? '' : t).replace(/\r/g, '').trim();
  return x.length > n ? x.slice(0, n - 1) + '…' : x;
}

function oneLine(t, n) {
  const x = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  return x.length > n ? x.slice(0, n - 1) + '…' : x;
}

function createPhone(opts) {
  const { collector, hubDir, rootDir, getConfig } = opts;
  let chat = opts.chat || null; // o chat do departamento (pode ser ligado depois com setChat)
  const deliveries = createDeliveries({ collector });
  const permitsDir = path.join(hubDir, 'permits');
  const phoneFile = path.join(hubDir, 'phone.json');

  let server = null;
  let ip = null;
  let port = null;
  let until = 0;
  let waitSeconds = 45;
  let pairCode = null; // uso único
  let deviceToken = null;
  let deviceSeenAt = 0;
  let offTimer = null;
  let onChange = () => {};
  const fails = new Map(); // ip -> { n, lockedUntil }
  const tasks = []; // tarefas remotas (mais recente primeiro)
  const children = new Map();
  let names = { sectors: {}, people: {} };

  const hostOk = (host) => {
    const h = String(host || '').toLowerCase();
    return h === `${ip}:${port}` || h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  };

  /* ------------------------------------------------------------- arquivos */
  function writePhoneFile() {
    const data = { active: true, until, waitSeconds, paired: !!deviceToken, pid: process.pid };
    try {
      fs.mkdirSync(hubDir, { recursive: true });
      const tmp = phoneFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, phoneFile);
    } catch (e) {
      console.error('[claude-hub] phone.json:', e.message);
    }
  }
  function removePhoneFile() {
    try {
      fs.rmSync(phoneFile, { force: true });
    } catch {
      /* ok */
    }
  }
  function clearPermits() {
    try {
      for (const f of fs.readdirSync(permitsDir)) fs.rmSync(path.join(permitsDir, f), { force: true });
    } catch {
      /* pasta ainda não existe */
    }
  }

  function pendingPermits() {
    const out = [];
    let files = [];
    try {
      files = fs.readdirSync(permitsDir);
    } catch {
      return out;
    }
    const t = Date.now();
    for (const f of files) {
      if (!/^[0-9a-f]{32}\.json$/.test(f)) continue;
      const id = f.slice(0, -5);
      if (fs.existsSync(path.join(permitsDir, id + '.decision'))) continue;
      try {
        const p = JSON.parse(fs.readFileSync(path.join(permitsDir, f), 'utf8'));
        const wait = Math.max(5, Math.min(Number(p.waitSeconds) || 45, 300));
        if (t - p.ts > wait * 1000 + 3000) continue; // o hook já desistiu
        out.push({
          id,
          ts: p.ts,
          expiresAt: p.ts + wait * 1000,
          sessionId: p.session_id,
          agentId: p.agent_id || null,
          agentType: p.agent_type || null,
          tool: oneLine(p.tool_name, 60),
          input: p.tool_input || {},
        });
      } catch {
        /* arquivo ainda sendo escrito */
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  function decide(id, behavior) {
    if (!/^[0-9a-f]{32}$/.test(String(id)) || !['allow', 'deny'].includes(behavior)) return false;
    const req = path.join(permitsDir, id + '.json');
    const dec = path.join(permitsDir, id + '.decision');
    if (!fs.existsSync(req) || fs.existsSync(dec)) return false;
    const tmp = dec + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ behavior, ts: Date.now() }));
    fs.renameSync(tmp, dec);
    return true;
  }

  /* -------------------------------------------------------- tarefas remotas */
  function projectAllowed(cwd) {
    return collector.knownProjects().some((p) => p.cwd === cwd) && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory();
  }

  function startTask({ cwd, prompt, mode }) {
    if (typeof cwd !== 'string' || !projectAllowed(cwd)) return { error: 'Projeto desconhecido.' };
    if (typeof prompt !== 'string' || !prompt.trim()) return { error: 'Escreva a tarefa.' };
    if (prompt.length > MAX_PROMPT) return { error: `A tarefa passa de ${MAX_PROMPT} caracteres.` };
    if (!['plan', 'edit'].includes(mode)) return { error: 'Modo inválido.' };
    if (tasks.filter((t) => t.status === 'running').length >= MAX_RUNNING) return { error: `Já há ${MAX_RUNNING} tarefas rodando. Espere uma terminar.` };

    const task = {
      id: rand(9),
      cwd,
      project: path.basename(cwd),
      prompt: prompt.trim(),
      mode,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      result: '',
      sessionId: null,
    };
    tasks.unshift(task);
    tasks.length = Math.min(tasks.length, 12);
    onChange();

    findClaude(getConfig, (err, bin) => {
      if (err) return finish(task, 'error', err.message);
      const args = ['-p', '--output-format', 'json', '--permission-mode', mode === 'edit' ? 'acceptEdits' : 'plan'];
      let child;
      try {
        child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
      } catch (e) {
        return finish(task, 'error', e.message);
      }
      children.set(task.id, child);
      let out = '';
      let errOut = '';
      child.stdout.on('data', (d) => {
        if (out.length < OUT_LIMIT) out += d;
      });
      child.stderr.on('data', (d) => {
        if (errOut.length < 20000) errOut += d;
      });
      child.on('error', (e) => finish(task, 'error', e.message));
      child.on('close', (code) => {
        children.delete(task.id);
        clearTimeout(timer);
        if (task.status !== 'running') return;
        let text = '';
        let bad = code !== 0;
        try {
          const j = JSON.parse(out);
          text = String(j.result || '');
          task.sessionId = j.session_id || null;
          if (j.is_error) bad = true;
        } catch {
          text = out || errOut;
        }
        finish(task, bad ? 'error' : 'done', clip(text || errOut || (bad ? `Saiu com código ${code}.` : 'Sem resposta.'), 4000));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(task.prompt);
      const timer = setTimeout(() => {
        if (task.status === 'running') {
          finish(task, 'error', 'Passou de 30 minutos e foi interrompida.');
          child.kill('SIGTERM');
        }
      }, TASK_TIMEOUT_MS);
    });
    return { task: publicTask(task) };
  }

  function finish(task, status, result) {
    if (task.status !== 'running') return;
    task.status = status;
    task.result = result;
    task.endedAt = Date.now();
    onChange();
  }

  function stopTask(id) {
    const t = tasks.find((x) => x.id === id);
    if (!t || t.status !== 'running') return false;
    finish(t, 'stopped', 'Interrompida pelo celular.');
    const c = children.get(id);
    if (c) c.kill('SIGTERM');
    return true;
  }

  const publicTask = (t) => ({
    id: t.id,
    project: t.project,
    prompt: oneLine(t.prompt, 300),
    mode: t.mode,
    status: t.status,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    result: t.result,
  });

  /* ------------------------------------------------------------------ dados */
  function mobileState() {
    const snap = collector.snapshot();
    const sessions = snap.sessions.map((s) => ({
      id: s.id,
      project: s.project,
      title: oneLine(s.title, 120),
      status: s.status,
      stale: s.stale,
      startedAt: s.startedAt,
      lastActivity: s.lastActivity,
      employees: s.employees.map((e) => ({
        key: e.key,
        empKey: e.empKey,
        isLeader: e.isLeader,
        type: e.type,
        description: oneLine(e.description, 140),
        status: e.status,
        kind: e.kind,
        live: e.live,
        startedAt: e.startedAt,
        currentAction: oneLine(e.currentAction, 160),
        currentTool: e.currentTool,
        currentDetail: oneLine(e.currentDetail, 160),
        lastMessage: oneLine(e.lastMessage, 240),
        stats: e.stats,
        tasks: e.tasks.slice(0, 3).map((k) => ({ id: k.id, title: oneLine(k.title, 160), start: k.start, end: k.end, status: k.status, result: oneLine(k.result, 200) })),
      })),
    }));
    return {
      now: Date.now(),
      until,
      totals: snap.totals,
      sessions,
      feed: snap.feed.slice(-30).map((f) => ({ ts: f.ts, sessionId: f.sessionId, emp: f.emp, project: f.project, kind: f.kind, text: oneLine(f.text, 200) })),
      permits: pendingPermits(),
      inbox: chat ? chat.inbox().map((p) => ({ sid: p.sid, id: p.id, kind: p.kind, tool: oneLine(p.tool, 60), detail: clip(p.detail, 1500), description: oneLine(p.description, 300), ts: p.ts })) : [],
      deliveries: deliveries.summary(snap.sessions.map((s) => s.id)),
      canChat: !!chat,
      tasks: tasks.map(publicTask),
      names,
      projects: collector.knownProjects().slice(0, 30).map((p) => ({ cwd: p.cwd, project: p.project })),
    };
  }

  /* ---------------------------------------------------------------- servidor */
  function send(res, code, body, type, extra) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(code, {
      'Content-Type': type || 'application/json; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      ...extra,
    });
    res.end(buf);
  }

  function readBody(req, cb) {
    let size = 0;
    const chunks = [];
    let dead = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        dead = true;
        cb(new Error('grande'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (dead) return;
      try {
        const txt = Buffer.concat(chunks).toString('utf8');
        cb(null, txt ? JSON.parse(txt) : {});
      } catch {
        cb(new Error('json'));
      }
    });
    req.on('error', () => {});
  }

  function lockedOut(addr) {
    const f = fails.get(addr);
    return !!f && f.lockedUntil > Date.now();
  }
  function registerFail(addr) {
    const f = fails.get(addr) || { n: 0, lockedUntil: 0 };
    f.n += 1;
    if (f.n >= FAIL_LIMIT) {
      f.n = 0;
      f.lockedUntil = Date.now() + FAIL_LOCK_MS;
    }
    fails.set(addr, f);
  }

  function handle(req, res) {
    const addr = req.socket.remoteAddress;
    if (!isPrivateAddress(addr)) return send(res, 403, { error: 'rede não permitida' });
    if (!hostOk(req.headers.host)) return send(res, 421, { error: 'host inválido' });
    if (lockedOut(addr)) return send(res, 429, { error: 'muitas tentativas; espere um minuto' });

    const url = new URL(req.url, `http://${ip}:${port}`);
    const route = url.pathname;

    if (req.method === 'GET' && STATIC[route]) {
      const [rel, type] = STATIC[route];
      try {
        return send(res, 200, fs.readFileSync(path.join(rootDir, rel)), type);
      } catch {
        return send(res, 404, { error: 'não encontrado' });
      }
    }
    if (!route.startsWith('/api/')) return send(res, 404, { error: 'não encontrado' });

    const needsBody = req.method === 'POST';
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'método não permitido' });
    if (needsBody && !String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'use JSON' });

    const run = (body) => {
      if (route === '/api/pair') {
        const ok = pairCode && !deviceToken && safeEqual(body.code, pairCode);
        if (!ok) {
          registerFail(addr);
          return send(res, 401, { error: 'código inválido ou já usado' });
        }
        pairCode = null;
        deviceToken = rand(32);
        deviceSeenAt = Date.now();
        writePhoneFile();
        onChange();
        return send(res, 200, { token: deviceToken, until });
      }

      if (!deviceToken || !safeEqual(req.headers['x-hub-token'], deviceToken)) {
        registerFail(addr);
        return send(res, 401, { error: 'não autorizado' });
      }
      deviceSeenAt = Date.now();

      if (req.method === 'GET' && route === '/api/state') return send(res, 200, mobileState());
      if (req.method === 'POST' && route === '/api/permit') {
        const ok = decide(body.id, body.behavior);
        return send(res, ok ? 200 : 409, { ok });
      }
      if (req.method === 'POST' && route === '/api/task') {
        const r = startTask(body);
        return send(res, r.error ? 400 : 200, r);
      }
      if (req.method === 'POST' && route === '/api/task/stop') return send(res, 200, { ok: stopTask(String(body.id || '')) });

      /* ---- entregas dos agentes */
      if (req.method === 'GET' && route === '/api/deliveries') {
        const ids = collector.snapshot().sessions.map((x) => x.id);
        return send(res, 200, { deliveries: deliveries.list(ids, 20) });
      }
      if (req.method === 'GET' && route === '/api/delivery/file') {
        const f = deliveries.file(url.searchParams.get('id'));
        if (!f) return send(res, 404, { error: 'arquivo indisponível' });
        let buf;
        try {
          buf = fs.readFileSync(f.path);
        } catch {
          return send(res, 404, { error: 'arquivo indisponível' });
        }
        return send(res, 200, buf, f.mime, { 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `inline; filename="${f.name.replace(/[^\w.\-]/g, '_')}"` });
      }

      /* ---- chat do departamento */
      if (route.startsWith('/api/chat')) {
        if (!chat) return send(res, 404, { error: 'chat indisponível' });
        const sid = String(route === '/api/chat' ? url.searchParams.get('sid') : body.sid || '');
        if (!/^[\w.:-]{1,100}$/.test(sid) || !chat.known(sid)) return send(res, 404, { error: 'departamento desconhecido' });
        if (req.method === 'GET' && route === '/api/chat') {
          const r = chat.poll(sid, String(url.searchParams.get('rev') || ''));
          const st = r.state;
          return send(res, 200, {
            rev: r.rev,
            messages: r.messages ? r.messages.slice(-60).map((m) => ({ id: m.id, ts: m.ts, role: m.role, kind: m.kind, text: clip(m.text, 6000) })) : null,
            state: { running: st.running, busy: st.busy, mode: st.mode, error: st.error || null, blocked: st.blocked || null, pending: st.pending.map((p) => ({ id: p.id, kind: p.kind, tool: oneLine(p.tool, 60), detail: clip(p.detail, 1500), description: oneLine(p.description, 300), ts: p.ts })) },
          });
        }
        if (req.method === 'POST' && route === '/api/chat/send') {
          const text = typeof body.text === 'string' ? body.text : '';
          if (text.length > MAX_PROMPT) return send(res, 400, { error: `A mensagem passa de ${MAX_PROMPT} caracteres.` });
          const mode = ['ask', 'edit', 'plan'].includes(body.mode) ? body.mode : 'ask';
          const r = chat.send(sid, text, { ...chat.getOpts(sid), mode });
          return send(res, r.error ? 400 : 200, r);
        }
        if (req.method === 'POST' && route === '/api/chat/stop') return send(res, 200, { ok: chat.stop(sid) });
        if (req.method === 'POST' && route === '/api/chat/decide') {
          const ok = ['allow', 'deny'].includes(body.behavior) && chat.decide(sid, String(body.id || ''), body.behavior);
          return send(res, ok ? 200 : 409, { ok });
        }
      }
      return send(res, 404, { error: 'não encontrado' });
    };

    if (needsBody) readBody(req, (err, body) => (err ? send(res, err.message === 'grande' ? 413 : 400, { error: 'corpo inválido' }) : run(body && typeof body === 'object' ? body : {})));
    else run({});
  }

  /* ---------------------------------------------------------------- controle */
  function listen(address, p, cb, tries = 0) {
    const s = http.createServer(handle);
    s.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && tries < 12) return listen(address, p + 1, cb, tries + 1);
      cb(e);
    });
    s.headersTimeout = 10000;
    s.requestTimeout = 15000;
    s.listen(p, address, () => cb(null, s, p));
  }

  function newPairing() {
    pairCode = rand(24);
    deviceToken = null;
    writePhoneFile();
  }

  function start({ minutes, wait, address, port: startPort }) {
    return new Promise((resolve, reject) => {
      if (server) return resolve(status());
      const forced = address || (getConfig() || {}).phoneIp;
      if (forced && !isPrivateAddress(forced)) return reject(new Error('phoneIp precisa ser um endereço de rede privada (192.168.x.x, 10.x.x.x ou 172.16-31.x.x).'));
      const lan = forced ? [{ address: forced, name: 'manual', wifi: true }] : lanAddresses();
      if (!lan.length) return reject(new Error('Não achei uma rede Wi-Fi privada. Conecte este computador ao Wi-Fi de casa.'));
      listen(lan[0].address, startPort || PORT_START, (err, s, p) => {
        if (err) return reject(err);
        server = s;
        ip = lan[0].address;
        port = p;
        until = Date.now() + Math.max(1, Math.min(Number(minutes) || 60, 480)) * 60000;
        waitSeconds = Math.max(5, Math.min(Number(wait) || 45, 300));
        clearPermits();
        newPairing();
        clearTimeout(offTimer);
        offTimer = setTimeout(() => stop(), until - Date.now());
        onChange();
        resolve(status());
      });
    });
  }

  function stop() {
    clearTimeout(offTimer);
    for (const t of tasks) if (t.status === 'running') stopTask(t.id);
    const s = server;
    server = null;
    pairCode = null;
    deviceToken = null;
    until = 0;
    removePhoneFile();
    clearPermits();
    if (s) {
      s.closeAllConnections?.();
      s.close();
    }
    onChange();
  }

  function status() {
    const on = !!server;
    return {
      on,
      ip: on ? ip : null,
      port: on ? port : null,
      until: on ? until : 0,
      paired: on && !!deviceToken,
      pairUrl: on && pairCode ? `http://${ip}:${port}/#p=${pairCode}` : null,
      lastSeenAt: deviceSeenAt,
      pending: on ? pendingPermits().length : 0,
      running: tasks.filter((t) => t.status === 'running').length,
      waitSeconds,
    };
  }

  return {
    start,
    stop,
    status,
    newPairing: () => {
      if (server) {
        newPairing();
        onChange();
      }
      return status();
    },
    setChat: (c) => {
      chat = c || null;
    },
    setNames: (n) => {
      if (n && typeof n === 'object') names = { sectors: n.sectors || {}, people: n.people || {} };
    },
    onChange: (fn) => {
      onChange = fn;
    },
    _internals: { isPrivateAddress, lanAddresses, decide, pendingPermits },
  };
}

module.exports = { createPhone, isPrivateAddress, lanAddresses };
