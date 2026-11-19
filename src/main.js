'use strict';
const { app, BrowserWindow, Notification, ipcMain, nativeTheme, clipboard, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { createCollector } = require('./collector');
const { createPhone } = require('./phone');
const { createChat } = require('./chat');
const V = require('./vault');
const { createOffice } = require('./office');
const { createUsage } = require('./usage');
const QRCode = require('qrcode');

const DEFAULT_CONFIG = {
  sound: true,
  notifyWaiting: true,
  notifyDone: true,
  notifyError: true,
  minTurnSeconds: 20, // só avisa "terminou" se o turno durou pelo menos isso
  shiftSince: 0, // início do expediente atual (ms); 0 = desde a meia-noite
  phoneMinutes: 60, // quanto tempo o Modo celular fica ligado antes de desligar sozinho
  phoneWait: 45, // segundos que o hook de permissão espera a resposta do celular
  claudeBin: '', // caminho do comando claude (vazio = procurar sozinho)
  officeOn: true, // Escritório: agentes podem perguntar uns aos outros (cada pergunta pede sua aprovação)
  vaultOn: true, // Cérebro: vault do Obsidian dentro do escritório (chats abertos pelo hub enxergam e escrevem lá)
  vaultDir: '', // pasta do vault (vazio = ~/cerebro)
  awayOn: true, // mostrar o resumo "o que aconteceu enquanto você estava fora" ao voltar
  awayMinutes: 15, // tempo mínimo fora do hub para o resumo aparecer
  phoneIp: '', // força o IP da rede local usado pelo Modo celular (vazio = detectar o Wi-Fi)
};

let win = null;
let collector = null;
let config = { ...DEFAULT_CONFIG };
let configFile = null;
let lastState = null;
let phone = null;
let chat = null;
let office = null;
let managerSid = null; // departamento escolhido como gerente do Escritório
let managerFile = null;
let lastSeen = Date.now(); // última vez que o usuário olhou o hub (para o resumo ao voltar)
let holdSeen = false; // enquanto o resumo está na tela, não avança
let seenFile = null;

function touchSeen() {
  lastSeen = Date.now();
  try {
    if (seenFile) fs.writeFileSync(seenFile, JSON.stringify({ at: lastSeen }) + '\n');
  } catch {
    /* sem disco: o resumo só perde a memória entre execuções */
  }
}

function loadConfig(file) {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  } catch (e) {
    console.error('[claude-hub] não consegui salvar a configuração:', e.message);
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function shouldAlert(a) {
  if (a.kind === 'waiting') return config.notifyWaiting;
  if (a.kind === 'error') return config.notifyError;
  if (a.kind === 'done') return config.notifyDone && (a.durationMs || 0) >= config.minTurnSeconds * 1000;
  return false;
}

function handleAlert(a) {
  if (!shouldAlert(a)) return;
  const titles = {
    waiting: `${a.project}: precisa de você`,
    done: `${a.project}: terminou`,
    error: `${a.project}: erro`,
  };
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: titles[a.kind] || a.project, body: a.text, silent: true });
      n.on('click', () => {
        if (win) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
          send('focus-session', a.sessionId);
        }
      });
      n.show();
    }
  } catch (e) {
    console.error('[claude-hub] notificação falhou:', e.message);
  }
  send('alert', { kind: a.kind, sessionId: a.sessionId, sound: !!config.sound });
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 520,
    title: 'Claude Hub',
    backgroundColor: '#0f1115',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('blur', () => {
    if (!holdSeen) touchSeen();
  });
  win.on('focus', () => send('welcome-back'));
  win.on('close', () => {
    if (!holdSeen) touchSeen();
  });
  win.on('closed', () => {
    win = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    collector = createCollector({
      onChange: (state) => {
        lastState = state;
        send('state', state);
      },
      onAlert: handleAlert,
    });
    configFile = path.join(collector.paths.hubDir, 'config.json');
    loadConfig(configFile);
    managerFile = path.join(collector.paths.hubDir, 'manager.json');
    try {
      const m = JSON.parse(fs.readFileSync(managerFile, 'utf8')).sid;
      if (typeof m === 'string' && /^[\w-]{1,80}$/.test(m)) managerSid = m;
    } catch {
      /* sem gerente */
    }
    seenFile = path.join(collector.paths.hubDir, 'seen.json');
    try {
      const at = Number(JSON.parse(fs.readFileSync(seenFile, 'utf8')).at);
      if (at > 0 && at <= Date.now()) lastSeen = at;
    } catch {
      /* primeira execução: não há o que resumir */
    }
    // enquanto a janela está em foco, o "visto por último" acompanha; ao perder o foco ele congela
    setInterval(() => {
      if (win && win.isFocused() && !holdSeen) touchSeen();
    }, 30000);
    // Mostrador de uso (5 h / semana): lê só arquivos locais; reenvia à interface só quando algo muda.
    const usage = createUsage({ hubDir: collector.paths.hubDir, claudeDir: collector.paths.claudeDir });
    let usageSig = '';
    const pushUsage = () => {
      const u = usage.read();
      const sig = JSON.stringify({ ...u, now: 0 });
      if (sig !== usageSig) {
        usageSig = sig;
        send('usage', u);
      }
    };
    ipcMain.handle('usage-get', () => usage.read());
    setInterval(pushUsage, 20000);
    const vaultRoot = () => (config.vaultOn === false ? null : V.resolveRoot(config.vaultDir));
    const applyVault = () => collector.setVault(vaultRoot());
    applyVault();

    phone = createPhone({
      collector,
      hubDir: collector.paths.hubDir,
      rootDir: path.join(__dirname, '..'),
      getConfig: () => config,
    });
    const phoneStatus = async () => {
      const st = phone.status();
      let qr = null;
      if (st.pairUrl) qr = await QRCode.toDataURL(st.pairUrl, { margin: 1, width: 280, errorCorrectionLevel: 'M' });
      return { ...st, qr };
    };
    let phoneTimer = null;
    phone.onChange(() => {
      clearTimeout(phoneTimer);
      phoneTimer = setTimeout(async () => send('phone', await phoneStatus()), 80);
    });
    ipcMain.handle('phone-status', () => phoneStatus());
    ipcMain.handle('phone-start', async (_e, opts) => {
      const minutes = Number(opts && opts.minutes) || config.phoneMinutes;
      config = { ...config, phoneMinutes: Math.max(5, Math.min(minutes, 480)) };
      saveConfig();
      try {
        await phone.start({ minutes: config.phoneMinutes, wait: config.phoneWait });
        return { ok: true, status: await phoneStatus() };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
    ipcMain.handle('phone-stop', async () => {
      phone.stop();
      return phoneStatus();
    });
    ipcMain.handle('phone-new-qr', async () => {
      phone.newPairing();
      return phoneStatus();
    });
    ipcMain.handle('phone-names', (_e, names) => {
      phone.setNames(names);
      if (office) office.setNames(names);
    });

    // ---- chat do departamento: conversar com a sessão pelo hub
    chat = createChat({ collector, getConfig: () => config, claudeDir: collector.paths.claudeDir, onChange: () => send('chat-changed'), getOffice: () => office });
    phone.setChat(chat);
    // ---- Escritório: agentes perguntando uns aos outros (servidor MCP local, só 127.0.0.1)
    office = createOffice({
      collector,
      chat,
      getConfig: () => config,
      onChange: () => send('office', office.state()),
      getManager: () => managerSid,
      listProjects: () => collector.knownProjects().filter((p) => {
        try {
          return fs.statSync(p.cwd).isDirectory();
        } catch {
          return false;
        }
      }),
    });
    office.start();
    ipcMain.handle('office-state', () => office.state());
    // gerente do Escritório: um só departamento por vez, lembrado entre execuções
    ipcMain.handle('manager-get', () => managerSid);
    ipcMain.handle('manager-set', (_e, sid) => {
      managerSid = typeof sid === 'string' && /^[\w-]{1,80}$/.test(sid) ? sid : null;
      try {
        fs.writeFileSync(managerFile, JSON.stringify({ sid: managerSid }) + '\n');
      } catch {
        /* sem disco: vale só até fechar o hub */
      }
      send('manager', managerSid);
      return managerSid;
    });
    const str = (v) => (typeof v === 'string' ? v : '');
    ipcMain.handle('chat-poll', (_e, sid, rev) => chat.poll(str(sid), str(rev) || undefined));
    ipcMain.handle('chat-send', (_e, sid, text, opts) => chat.send(str(sid), text, opts && typeof opts === 'object' ? opts : str(opts)));
    ipcMain.handle('chat-inbox', () => chat.inbox());
    ipcMain.handle('chat-decide', (_e, sid, id, behavior) => chat.decide(str(sid), str(id), str(behavior)));
    ipcMain.handle('chat-stop', (_e, sid) => chat.stop(str(sid)));
    ipcMain.handle('chat-close', (_e, sid) => chat.close(str(sid)));
    ipcMain.handle('chat-mode', (_e, sid, mode) => chat.setMode(str(sid), str(mode)));
    ipcMain.handle('chat-models', () => chat.models());
    // Novo departamento: projetos que o hub já viu (só os que ainda existem), escolher outra pasta e reservar a sessão.
    ipcMain.handle('chat-projects', () =>
      collector.knownProjects().filter((p) => {
        try {
          return fs.statSync(p.cwd).isDirectory();
        } catch {
          return false;
        }
      }).slice(0, 40));
    ipcMain.handle('chat-pick-folder', async () => {
      const r = await dialog.showOpenDialog(win, { title: 'Pasta do novo departamento', properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths[0]) return null;
      return { cwd: r.filePaths[0], project: path.basename(r.filePaths[0]) };
    });
    ipcMain.handle('chat-prepare', (_e, cwd) => chat.prepare(str(cwd)));
    ipcMain.handle('chat-commands', (_e, sid) => chat.commandsInfo(str(sid)));
    ipcMain.handle('chat-files', (_e, sid, query) => chat.files(str(sid), str(query)));
    // "Anexar arquivo": o seletor de arquivos é do sistema; só o que a pessoa escolher volta para a tela.
    ipcMain.handle('chat-pick', async () => {
      const r = await dialog.showOpenDialog(win, { title: 'Anexar ao chat', properties: ['openFile', 'multiSelections'] });
      if (r.canceled) return [];
      const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
      const out = [];
      for (const f of r.filePaths.slice(0, 8)) {
        try {
          const st = fs.statSync(f);
          const mediaType = IMG[path.extname(f).toLowerCase()];
          const item = { name: path.basename(f), path: f, size: st.size };
          if (mediaType) {
            if (st.size > 5 * 1024 * 1024) {
              item.error = 'Imagem maior que 5 MB.';
            } else {
              item.kind = 'image';
              item.mediaType = mediaType;
              item.data = fs.readFileSync(f).toString('base64');
            }
          } else item.kind = 'file';
          out.push(item);
        } catch {
          /* sumiu entre a escolha e a leitura */
        }
      }
      return out;
    });
    ipcMain.handle('chat-export', async (_e, sid, title) => {
      const md = chat.exportMarkdown(str(sid), str(title).slice(0, 120));
      const safe = (str(title) || 'conversa').replace(/[^\p{L}\p{N} _.-]+/gu, '').trim().slice(0, 60) || 'conversa';
      const r = await dialog.showSaveDialog(win, { title: 'Exportar conversa', defaultPath: path.join(app.getPath('documents'), `${safe}.md`), filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (r.canceled || !r.filePath) return null;
      fs.writeFileSync(r.filePath, md);
      return r.filePath;
    });

    // ---- Cérebro: navegar, buscar e abrir notas do vault (nada sai da pasta do vault)
    const vaultCfg = () => {
      const root = V.resolveRoot(config.vaultDir);
      return { on: config.vaultOn !== false, dir: config.vaultDir || '', root, exists: !!root };
    };
    ipcMain.handle('vault-info', () => {
      const c = vaultCfg();
      return { on: c.on, exists: c.exists, dir: c.root || V.expand(config.vaultDir), name: c.root ? path.basename(c.root) : '', overview: c.on && c.root ? V.overview(c.root) : null };
    });
    const withVault = (fn) => (_e, ...a) => {
      const c = vaultCfg();
      return c.on && c.root ? fn(c.root, ...a) : { error: 'O Cérebro está desligado ou não foi encontrado.' };
    };
    ipcMain.handle('vault-list', withVault((root, rel) => V.list(root, str(rel))));
    ipcMain.handle('vault-read', withVault((root, rel) => V.read(root, str(rel))));
    ipcMain.handle('vault-search', withVault((root, q) => V.search(root, str(q))));
    ipcMain.handle('vault-open', withVault((root, rel) => {
      const abs = V.safeAbs(root, str(rel));
      if (!abs || !fs.existsSync(abs)) return { error: 'Nota não encontrada.' };
      // tenta o Obsidian; se não estiver instalado, mostra o arquivo na pasta
      shell.openExternal(`obsidian://open?path=${encodeURIComponent(abs)}`).catch(() => shell.showItemInFolder(abs));
      return { ok: true };
    }));
    ipcMain.handle('vault-pick', async () => {
      const r = await dialog.showOpenDialog(win, { title: 'Pasta do vault do Obsidian', properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths[0]) return null;
      config = { ...config, vaultDir: r.filePaths[0], vaultOn: true };
      saveConfig();
      applyVault();
      send('chat-changed');
      return vaultCfg().root;
    });

    ipcMain.handle('get-state', () => lastState || collector.snapshot());
    ipcMain.handle('get-config', () => config);
    ipcMain.handle('set-config', (_e, patch) => {
      const clean = {};
      for (const k of Object.keys(DEFAULT_CONFIG)) {
        if (patch && k in patch && typeof patch[k] === typeof DEFAULT_CONFIG[k]) clean[k] = patch[k];
      }
      config = { ...config, ...clean };
      saveConfig();
      applyVault();
      return config;
    });
    ipcMain.handle('dismiss', (_e, id) => {
      if (typeof id !== 'string') return false;
      collector.dismiss(id);
      try {
        chat.close(id); // encerra o processo do chat, se houver
      } catch {}
      return true;
    });
    ipcMain.handle('dismiss-inactive', () => collector.dismissInactive(managerSid ? [managerSid] : []));
    ipcMain.handle('undismiss', (_e, ids) => {
      collector.undismiss((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string').slice(0, 200));
      return true;
    });
    ipcMain.handle('get-paths', () => collector.paths);

    // ---- expediente: relatório do dia, salvar, copiar e encerrar
    const rawReport = (from) => {
      const rc = createCollector({
        hubDir: collector.paths.hubDir,
        claudeDir: collector.paths.claudeDir,
        replayAll: true,
        readOnly: true,
        noTranscripts: true,
        taskMax: 500,
        from,
      });
      rc.pollOnce();
      const sessions = rc.reportData();
      rc.stop();
      return { from, to: Date.now(), sessions };
    };
    ipcMain.handle('get-report', () => {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      return rawReport(Math.max(midnight.getTime(), Number(config.shiftSince) || 0));
    });

    // ---- resumo ao voltar: o que aconteceu desde a última vez que você olhou o hub
    ipcMain.handle('away-summary', () => {
      const away = Date.now() - lastSeen;
      const minMs = Math.max(1, Number(config.awayMinutes) || 15) * 60000;
      if (config.awayOn === false || away < minMs) {
        if (!holdSeen) touchSeen();
        return null;
      }
      const raw = rawReport(lastSeen);
      if (!raw.sessions.length) {
        touchSeen();
        return null;
      }
      holdSeen = true; // enquanto o cartão está na tela, o "visto por último" não anda
      return raw;
    });
    ipcMain.handle('seen-now', () => {
      holdSeen = false;
      touchSeen();
      return true;
    });
    ipcMain.handle('save-report', (_e, markdown) => {
      if (typeof markdown !== 'string' || !markdown.trim()) return null;
      const dir = path.join(collector.paths.hubDir, 'expedientes');
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.md`;
      const file = path.join(dir, name);
      fs.writeFileSync(file, markdown);
      return file;
    });
    ipcMain.handle('copy-text', (_e, text) => {
      if (typeof text === 'string') clipboard.writeText(text);
      return true;
    });
    ipcMain.handle('close-shift', () => {
      config = { ...config, shiftSince: Date.now() };
      saveConfig();
      collector.endShift(); // os departamentos ficam; só a equipe vai embora
      return config;
    });

    createWindow();
    collector.start();
  });

  app.on('before-quit', () => {
    if (phone) phone.stop();
    if (office) office.stop();
    if (chat) chat.shutdown();
  });

  app.on('window-all-closed', () => {
    if (collector) collector.stop();
    app.quit();
  });
}
