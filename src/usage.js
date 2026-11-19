'use strict';
/**
 * Uso do plano (sessão de 5 h e semana) para o mostrador da barra do topo.
 *
 * Só lê arquivos que já existem na máquina (nada de credenciais, nada de rede):
 *  - "statusline": <hubDir>/usage.json, gravado pelo hook/claude-hub-statusline.py a cada atualização do
 *    statusline do Claude Code (campo rate_limits do JSON que ele manda). É ao vivo; instalar: npm run install-hooks.
 *  - "cache": `cachedUsageUtilization` do .claude.json, que o próprio Claude Code grava quando alguém roda /usage.
 * Vale a fonte com os números mais recentes. Janela cujo reinício já passou fica sem dado (um 0% inventado
 * faria a cota parecer cheia); números com mais de 30 min são marcados como desatualizados.
 *
 * A ideia de ler o rate_limits do statusline e o cache do .claude.json vem do Habblaud
 * (https://github.com/marmottajr/habblaud, MIT, © Márcio Junior).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const STALE_AFTER_MS = 30 * 60e3;

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** Data ISO, epoch em ms ou epoch em segundos -> epoch ms. */
function toEpochMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** { utilization | used_percentage, resets_at } -> { pct, resetsAt } (ou undefined). */
function parseWindow(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = num(raw.utilization ?? raw.used_percentage ?? raw.used_percent);
  if (u === undefined) return undefined;
  const w = { pct: Math.min(100, Math.max(0, u)) };
  const r = toEpochMs(raw.resets_at ?? raw.resetsAt);
  if (r !== undefined) w.resetsAt = r;
  return w;
}

function fromWindows(win, source, fetchedAt) {
  if (!win || typeof win !== 'object') return undefined;
  const fiveHour = parseWindow(win.five_hour);
  const sevenDay = parseWindow(win.seven_day);
  if (!fiveHour && !sevenDay) return undefined;
  const u = { source, fetchedAt };
  if (fiveHour) u.fiveHour = fiveHour;
  if (sevenDay) u.sevenDay = sevenDay;
  return u;
}

/** Janelas cujo reinício já passou ficam sem dado. */
function rollover(u, now) {
  const out = { ...u };
  for (const k of ['fiveHour', 'sevenDay']) if (out[k] && out[k].resetsAt !== undefined && out[k].resetsAt <= now) delete out[k];
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function createUsage({ hubDir, claudeDir, home = os.homedir(), now = Date.now, env = process.env } = {}) {
  const tapFile = path.join(hubDir, 'usage.json');
  const isDefault = path.resolve(claudeDir) === path.join(home, '.claude');
  const claudeJsons = isDefault ? [path.join(home, '.claude.json'), path.join(claudeDir, '.claude.json')] : [path.join(claudeDir, '.claude.json')];

  function fromTap() {
    const j = readJson(tapFile);
    if (!j || typeof j !== 'object') return undefined;
    const at = toEpochMs(j.fetchedAt);
    if (at === undefined) return undefined;
    return fromWindows(j, 'statusline', at);
  }

  function fromCache() {
    for (const f of claudeJsons) {
      const j = readJson(f);
      const c = j && j.cachedUsageUtilization;
      if (!c || typeof c !== 'object') continue;
      const at = toEpochMs(c.fetchedAtMs ?? c.fetchedAt);
      if (at === undefined) continue;
      const u = fromWindows(c.utilization, 'cache', at);
      if (u) return u;
    }
    return undefined;
  }

  /** O statusline do Claude Code já passa pelo tap do hub (settings.json)? */
  function tapInstalled() {
    const s = readJson(path.join(claudeDir, 'settings.json'));
    const cmd = s && s.statusLine && typeof s.statusLine.command === 'string' ? s.statusLine.command : '';
    return cmd.includes('claude-hub-statusline.py');
  }

  function read() {
    const t = now();
    const all = [fromTap(), fromCache()].filter(Boolean);
    const best = all.reduce((acc, u) => (!acc || u.fetchedAt > acc.fetchedAt ? u : acc), undefined);
    const base = { tapInstalled: tapInstalled(), account: accountName(), now: t };
    if (!best) return { ...base, state: 'empty' };
    const u = rollover(best, t);
    return {
      ...base,
      state: t - best.fetchedAt > STALE_AFTER_MS ? 'stale' : 'ok',
      source: best.source,
      fetchedAt: best.fetchedAt,
      fiveHour: u.fiveHour || null,
      sevenDay: u.sevenDay || null,
    };
  }

  /** "Conta C" para ~/.claude-c, "Conta" para o padrão; só o nome da pasta, nunca e-mail. */
  function accountName() {
    const b = path.basename(path.resolve(claudeDir));
    const m = /^\.claude-(.+)$/.exec(b);
    return m ? `Conta ${m[1].toUpperCase().slice(0, 12)}` : 'Conta';
  }

  return { read, STALE_AFTER_MS, env };
}

module.exports = { createUsage, parseWindow, fromWindows, rollover, toEpochMs, STALE_AFTER_MS };
