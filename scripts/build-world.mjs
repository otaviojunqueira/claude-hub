#!/usr/bin/env node
// Reempacota o motor do escritório do Habblaud (https://github.com/marmottajr/habblaud, MIT, © Márcio Junior) em
// renderer/habblaud-world.js. Só é preciso rodar de novo para atualizar o motor: o arquivo pronto já vem no projeto.
//
//   git clone https://github.com/marmottajr/habblaud /tmp/habblaud
//   HABBLAUD_SRC=/tmp/habblaud npm run build-world        (precisa do esbuild: npm i --no-save esbuild)
//
// Trocas feitas no empacotamento: os quadros/placas gerados por IA (fetch de /assets) viram "sem arte extra" e só o
// português entra (os dicionários en/es/fr ficam de fora): o hub é em português e a CSP dele não permite fetch.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(process.env.HABBLAUD_SRC || '');
if (!process.env.HABBLAUD_SRC || !fs.existsSync(path.join(SRC, 'client/src/world/index.ts'))) {
  console.error('Defina HABBLAUD_SRC com a pasta do repositório do Habblaud (git clone https://github.com/marmottajr/habblaud).');
  process.exit(1);
}
const entry = path.join(root, 'vendor/habblaud/entry.ts');
const tmpEntry = path.join(root, 'vendor/habblaud/.entry.generated.ts');
fs.writeFileSync(tmpEntry, fs.readFileSync(entry, 'utf8').replaceAll('__HABBLAUD_SRC__', SRC));
try {
  await build({
    entryPoints: [tmpEntry], bundle: true, format: 'iife', globalName: 'HabblaudWorld', platform: 'browser', target: 'chrome120', minify: true,
    outfile: path.join(root, 'renderer/habblaud-world.js'), legalComments: 'none',
    plugins: [{
      name: 'hub-swaps',
      setup(b) {
        b.onResolve({ filter: /locales\/all$/ }, () => ({ path: path.join(SRC, 'shared/locales/none.ts') }));
        b.onResolve({ filter: /\/assets$/ }, (a) => (a.importer.includes('/client/src/world/') ? { path: path.join(root, 'vendor/habblaud/assets-stub.ts') } : null));
      },
    }],
    banner: { js: '/* Motor do escritório do Habblaud — https://github.com/marmottajr/habblaud — MIT, © Márcio Junior. Empacotado para o Claude Hub; ver THIRD-PARTY-HABBLAUD.txt */' },
  });
} finally {
  fs.rmSync(tmpEntry, { force: true });
}
console.log('renderer/habblaud-world.js atualizado.');
