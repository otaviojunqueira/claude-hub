#!/usr/bin/env node
'use strict';
/**
 * Gera ~90s de atividade FALSA (3 sessões, 6 tipos de subagente, permissão, erros)
 * para você ver o hub funcionando sem precisar de agentes reais.
 *
 *   npm run demo
 *
 * As sessões de exemplo usam o prefixo "demo-" e se encerram sozinhas no final.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const hubDir = process.env.CLAUDE_HUB_DIR || path.join(os.homedir(), '.claude-hub');
const demoDir = path.join(hubDir, 'demo');
fs.mkdirSync(demoDir, { recursive: true });
const eventsFile = path.join(hubDir, 'events.jsonl');

// Mostrador de uso: só inventa números se não houver nenhum de verdade (não sobrescreve o que o statusline gravou).
{
  const f = path.join(hubDir, 'usage.json');
  if (!fs.existsSync(f)) {
    const t = Date.now();
    fs.writeFileSync(f, JSON.stringify({ fetchedAt: t, five_hour: { used_percentage: 34, resets_at: Math.floor((t + 89 * 60e3) / 1000) }, seven_day: { used_percentage: 38, resets_at: Math.floor((t + 47 * 3600e3) / 1000) } }) + '\n');
  }
}

const SESSIONS = {
  'demo-indica': { cwd: '/home/demo/projetos/indica-monorepo', model: 'claude-sonnet-5-5' },
  'demo-painel': { cwd: '/home/demo/projetos/painel-de-comando', model: 'claude-opus-4-5' },
  'demo-api': { cwd: '/home/demo/projetos/api-pagamentos', model: 'claude-haiku-4-5' },
};
for (const [id, s] of Object.entries(SESSIONS)) {
  s.transcript = path.join(demoDir, `${id}.jsonl`);
  fs.writeFileSync(s.transcript, '');
  s.msg = 0;
}

function emit(id, ev) {
  const s = SESSIONS[id];
  const line = { ts: Date.now(), session_id: id, cwd: s.cwd, transcript_path: s.transcript, ...ev };
  fs.appendFileSync(eventsFile, JSON.stringify(line) + '\n');
}

function tokens(id, input, output, cacheRead = 0, cacheWrite = 0, sidechain = false) {
  const s = SESSIONS[id];
  s.msg += 1;
  const row = {
    type: 'assistant',
    isSidechain: sidechain,
    timestamp: new Date().toISOString(),
    cwd: s.cwd,
    message: {
      id: `${id}-m${s.msg}`,
      model: s.model,
      content: [],
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      },
    },
  };
  fs.appendFileSync(s.transcript, JSON.stringify(row) + '\n');
}

const tool = (id, name, input, agent) => {
  emit(id, { hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, ...(agent || {}) });
  tokens(id, 400 + Math.floor(Math.random() * 900), 150 + Math.floor(Math.random() * 600), 18000, 1200, !!agent);
};

const A = (id, type) => ({ agent_id: id, agent_type: type });
const EXPLORE = A('ag-exp-1', 'Explore');
const PLAN = A('ag-plan-1', 'Plan');
const REVIEW = A('ag-rev-1', 'code-reviewer');
const TEST = A('ag-test-1', 'test-runner');
const GEN = A('ag-gen-1', 'general-purpose');
const SEC = A('ag-sec-1', 'security-reviewer');

const spawn = (id, ag, desc) => {
  tool(id, 'Task', { subagent_type: ag.agent_type, description: desc });
  emit(id, { hook_event_name: 'SubagentStart', ...ag });
};
const stop = (id, ag, msg) => emit(id, { hook_event_name: 'SubagentStop', ...ag, last_assistant_message: msg });
const post = (id, ag) => emit(id, { hook_event_name: 'PostToolUse', ...(ag || {}) });

const steps = [
  [0, () => { for (const id of Object.keys(SESSIONS)) emit(id, { hook_event_name: 'SessionStart', source: 'startup' }); }],
  [1, () => emit('demo-indica', { hook_event_name: 'UserPromptSubmit', prompt: 'Adicione indicação em dois níveis no módulo de comissões' })],
  [2, () => emit('demo-painel', { hook_event_name: 'UserPromptSubmit', prompt: 'Crie a aba Arquivos reaproveitando a conexão SSH' })],
  [3, () => emit('demo-api', { hook_event_name: 'UserPromptSubmit', prompt: 'Corrija o webhook de pagamento que está duplicando' })],
  [4, () => { tool('demo-indica', 'Read', { file_path: 'apps/api/src/comissoes/comissoes.service.ts' }); }],
  [5, () => { post('demo-indica'); tool('demo-painel', 'Glob', { pattern: 'src/**/*.js' }); }],
  [6, () => { post('demo-painel'); spawn('demo-indica', EXPLORE, 'Mapear onde a comissão é calculada'); }],
  [7, () => tool('demo-indica', 'Grep', { pattern: 'calcularComissao' }, EXPLORE)],
  [8, () => { post('demo-indica', EXPLORE); tool('demo-api', 'Bash', { command: 'npm test -- webhook' }); }],
  [9, () => { post('demo-api'); tool('demo-painel', 'Edit', { file_path: 'src/ssh/arquivos.js' }); }],
  [10, () => { post('demo-painel'); tool('demo-indica', 'Read', { file_path: 'apps/api/src/comissoes/regras.ts' }, EXPLORE); }],
  [12, () => { emit('demo-api', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test -- webhook' }, error: 'exit 1' }); }],
  [13, () => { post('demo-indica', EXPLORE); tool('demo-api', 'Read', { file_path: 'src/webhooks/pagamento.ts' }); }],
  [14, () => stop('demo-indica', EXPLORE, 'A regra fica em regras.ts e é chamada por 3 serviços.')],
  [15, () => { post('demo-api'); spawn('demo-api', GEN, 'Procurar chamadas duplicadas do webhook'); }],
  [16, () => emit('demo-painel', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm install ssh2 --save' } })],
  [17, () => { post('demo-indica'); spawn('demo-indica', PLAN, 'Desenhar a estrutura dos dois níveis'); }],
  [18, () => tool('demo-indica', 'Read', { file_path: 'docs/comissoes.md' }, PLAN)],
  [19, () => tool('demo-api', 'Grep', { pattern: 'processarWebhook' }, GEN)],
  [22, () => { post('demo-painel'); tool('demo-painel', 'Bash', { command: 'npm install ssh2 --save' }); }],
  [23, () => { post('demo-api', GEN); tool('demo-api', 'Read', { file_path: 'src/webhooks/fila.ts' }, GEN); }],
  [24, () => { post('demo-painel'); stop('demo-indica', PLAN, 'Plano: tabela de níveis + regra de repasse 70/30.'); }],
  [25, () => { post('demo-indica'); tool('demo-indica', 'Write', { file_path: 'apps/api/src/comissoes/niveis.ts' }); }],
  [27, () => { post('demo-indica'); tool('demo-indica', 'Edit', { file_path: 'apps/api/src/comissoes/regras.ts' }); }],
  [28, () => { post('demo-indica'); stop('demo-api', GEN, 'O webhook é chamado duas vezes pela fila e pelo retry.'); }],
  [29, () => { post('demo-api'); tool('demo-api', 'Edit', { file_path: 'src/webhooks/pagamento.ts' }); }],
  [30, () => { post('demo-api'); tool('demo-painel', 'Edit', { file_path: 'renderer/arquivos.html' }); }],
  [32, () => { post('demo-painel'); spawn('demo-indica', TEST, 'Rodar a suíte de comissões'); }],
  [33, () => tool('demo-indica', 'Bash', { command: 'npm run test -- comissoes' }, TEST)],
  [36, () => { emit('demo-indica', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm run test -- comissoes' }, error: '2 testes falharam', ...TEST }); }],
  [37, () => tool('demo-indica', 'Edit', { file_path: 'apps/api/test/niveis.spec.ts' }, TEST)],
  [39, () => { post('demo-indica', TEST); tool('demo-indica', 'Bash', { command: 'npm run test -- comissoes' }, TEST); }],
  [42, () => { post('demo-indica', TEST); stop('demo-indica', TEST, '14 testes passando (2 corrigidos).'); }],
  [43, () => emit('demo-api', { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' })],
  [44, () => { post('demo-indica'); spawn('demo-indica', REVIEW, 'Revisar a mudança de comissões'); }],
  [45, () => tool('demo-indica', 'Read', { file_path: 'apps/api/src/comissoes/regras.ts' }, REVIEW)],
  [47, () => { post('demo-indica', REVIEW); spawn('demo-indica', SEC, 'Checar abuso do repasse entre níveis'); }],
  [49, () => tool('demo-indica', 'Grep', { pattern: 'repasse' }, SEC)],
  [52, () => stop('demo-indica', REVIEW, 'Achei 1 risco: falta teste do nível 2.')],
  [54, () => { stop('demo-indica', SEC, 'Sem abuso possível: repasse limitado a 100%.'); }],
  [56, () => emit('demo-indica', { hook_event_name: 'Stop', last_assistant_message: 'Comissões em dois níveis implementadas; 14 testes passando e revisão concluída.' })],
  [58, () => emit('demo-indica', { hook_event_name: 'UserPromptSubmit', prompt: 'Agora gere a migration do banco' })],
  [59, () => tool('demo-indica', 'Write', { file_path: 'apps/api/migrations/0042_niveis.sql' })],
  [62, () => emit('demo-painel', { hook_event_name: 'Stop', last_assistant_message: 'Aba Arquivos criada com envio e download por arrastar e soltar.' })],
  [75, () => emit('demo-api', { hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_input: { command: 'npm test -- webhook' } })],
  [78, () => emit('demo-api', { hook_event_name: 'Stop', last_assistant_message: 'Webhook agora é idempotente (chave por pagamento).' })],
  [88, () => { for (const id of Object.keys(SESSIONS)) emit(id, { hook_event_name: 'SessionEnd', reason: 'other' }); }],
];

console.log(`Demo escrevendo em ${eventsFile}. Abra o hub (npm start). Dura ~1 minuto e meio.`);
for (const [at, fn] of steps) {
  setTimeout(fn, at * (Number(process.env.DEMO_SPEED) ? 1000 / Number(process.env.DEMO_SPEED) : 1000));
}
setTimeout(() => {
  console.log('Demo concluída. Use "Limpar inativos" no hub para esconder as sessões de exemplo.');
}, 90000);
