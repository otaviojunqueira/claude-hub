'use strict';
const assert = require('assert');
const B = require('../renderer/habbridge.js');

const persona = (name, g, extra = {}) => ({ name, g, cargo: 'Revisor', color: '#14b8a6', look: { skin: '#E8B48F', hair: '#1d1a1a', glasses: false, ...extra } });
const emp = (key, o = {}) => ({
  key, isLeader: false, status: 'working', kind: 'edit', statusSince: 5000, startedAt: 1000, description: 'revisar',
  stats: { tools: 7 }, persona: persona('Caio', 'm'), say: { text: 'Editando: src/app.js', short: 'Editando' }, ...o,
});
const st = {
  sessions: [
    { id: 's1', sector: 'Mezanino', project: 'indica', cwd: '~/indica', title: 'Comissões', startedAt: 900, lastActivity: 6000, employees: [
      emp('s1:main', { isLeader: true, persona: persona('Marina', 'f', { glasses: true }) }),
      emp('s1:a1', { status: 'waiting', kind: 'wait' }),
      emp('s1:a2', { status: 'ended' }),
      emp('s1:a3', { status: 'error' }),
    ] },
    { id: 's2', sector: 'Oficina', project: 'api', cwd: '~/api', startedAt: 800, lastActivity: 2000, employees: [emp('s2:main', { isLeader: true, status: 'idle', kind: null, say: { text: 'Aguardando', short: 'Livre' } })] },
  ],
};

// ---- salas e agentes
let snap = B.toSnapshot(st, new Map(), 10000);
assert.deepStrictEqual(snap.rooms.map((r) => [r.id, r.name, r.slot]), [['s1', 'Mezanino', 0], ['s2', 'Oficina', 1]], 'a ordem das salas vira o slot (as salas seguem a ordem da lista)');
assert.strictEqual(snap.agents.length, 5);
const A = Object.fromEntries(snap.agents.map((a) => [a.id, a]));
assert.strictEqual(A['s1:main'].kind, 'main');
assert.strictEqual(A['s1:a1'].kind, 'sub');
assert.strictEqual(A['s1:a1'].parentId, 's1:main', 'subagente aponta para o líder');
assert.strictEqual(A['s1:main'].parentId, undefined);
assert.strictEqual(A['s1:main'].look, 'f');
assert.strictEqual(A['s1:main'].name, 'Marina');
assert.strictEqual(A['s1:a1'].status, 'waiting');
assert.ok(A['s1:a1'].waitingFor, 'quem espera você diz por quê (vira o balão do escritório)');
assert.strictEqual(A['s1:a2'].status, 'offline', 'saiu do expediente -> offline');
assert.strictEqual(A['s1:a3'].status, 'idle', 'erro vira ocioso (o escritório não tem estado de erro)');
assert.strictEqual(A['s2:main'].status, 'idle');
assert.strictEqual(A['s1:main'].activity.text, 'Editando: src/app.js');
assert.strictEqual(A['s1:a1'].activity.kind, 'ask');
assert.strictEqual(A['s1:main'].title, 'Comissões');
// aparência: a pele e o cabelo da persona do hub valem no canvas
assert.deepStrictEqual(A['s1:main'].parts, { skin: '#e8b48f', hair: '#1d1a1a', accessory: 'glasses' });
assert.strictEqual(A['s1:a1'].parts.accessory, undefined);
// semente estável: o mesmo agente é sempre a mesma pessoa
assert.strictEqual(A['s1:main'].seed, B.hashStr('s1:main'));
assert.strictEqual(B.toSnapshot(st, new Map(), 20000).agents[0].seed, A['s1:main'].seed);
// campos que o motor exige
for (const a of snap.agents) {
  for (const k of ['id', 'kind', 'roomId', 'name', 'look', 'role', 'sessionId', 'account', 'status', 'activity', 'recent', 'tasks', 'startedAt', 'lastEventAt', 'statusSince', 'stats', 'seed']) assert.ok(a[k] !== undefined, `${a.id} sem ${k}`);
  assert.ok(a.activity.text.length <= 46 && a.activity.at > 0);
}
assert.deepStrictEqual(snap.accounts, []);

// texto muito longo é cortado (balão cabe no escritório)
const long = JSON.parse(JSON.stringify(st));
long.sessions[0].employees[0].say.text = 'x'.repeat(200);
long.sessions[0].employees[0].persona = persona('Marina', 'f');
assert.strictEqual(B.toSnapshot(long, new Map(), 1).agents[0].activity.text.length, 46);

// ---- festa de quem conclui
const last = new Map();
const fx = new Map();
B.trackParties(st, last, fx, 1000);
assert.strictEqual(fx.size, 0, 'primeira leitura não comemora');
const st2 = JSON.parse(JSON.stringify(st));
st2.sessions[0].employees[1].status = 'done';
st2.sessions[0].employees.forEach((e) => (e.persona = persona(e.persona.name, e.persona.g)));
B.trackParties(st2, last, fx, 2000);
assert.deepStrictEqual([...fx.keys()], ['s1']);
assert.strictEqual(fx.get('s1').text, 'Caio concluiu!');
snap = B.toSnapshot(st2, fx, 3000);
assert.strictEqual(snap.rooms[0].effect.kind, 'party');
assert.strictEqual(snap.rooms[0].effect.agentId, 's1:a1');
assert.ok(snap.rooms[0].effect.until > 3000);
assert.strictEqual(snap.rooms[1].effect, undefined);
B.trackParties(st2, last, fx, 2000 + B.PARTY_MS + 1);
assert.strictEqual(fx.size, 0, 'a festa acaba sozinha');
assert.strictEqual(B.toSnapshot(st2, fx, 2000 + B.PARTY_MS + 1).rooms[0].effect, undefined);
// concluir de novo (já estava done) não repete a festa
B.trackParties(st2, last, fx, 99999);
assert.strictEqual(fx.size, 0);

// sem o motor carregado, a ponte devolve null (o hub segue na visão Equipe)
assert.strictEqual(B.create({}, {}), null);

console.log('bridge.test.js: ok');

// ---- equipe fixa: residentes aparecem sempre, parados/passeando, sem líder nem subagente
{
  const sess = { id: 's9', project: 'p', sector: 'Setor', cwd: '/x', startedAt: 500, lastActivity: 900, status: 'ended', employees: [], residents: [
    { key: 'res:s9:0', name: 'Bia', g: 'f', cargo: 'Dev', look: { skin: '#f6d2b5', hair: '#1d1a1a', glasses: true } },
    { key: 'res:s9:1', name: 'Caio', g: 'm', cargo: 'QA', look: { skin: '#a56a43', hair: '#3a2418' } },
  ] };
  const out = B.toSnapshot({ sessions: [sess] }, new Map(), 5000);
  assert.strictEqual(out.agents.length, 2);
  assert.ok(out.agents.every((a) => a.status === 'idle' && a.kind === 'main' && !a.parentId && a.roomId === 's9'));
  assert.strictEqual(out.agents[0].parts.accessory, 'glasses');
  assert.ok(out.agents[0].statusSince > 5000 + 10 * 60e3); // nunca "ocioso há muito tempo": não cochila, continua passeando
  assert.strictEqual(B.toSnapshot({ sessions: [sess] }, new Map(), 9000).agents[1].seed, out.agents[1].seed);
}
