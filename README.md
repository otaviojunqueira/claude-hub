# Claude Hub

App nativo (Electron) para **acompanhar e conversar** com os agentes do Claude Code, mesmo usando a extensão do VS Code com vários agentes e subagentes ao mesmo tempo. Por padrão o hub só observa; a conversa pelo hub e o Modo celular só agem quando você pede.

Cada agente vira um **funcionário** com nome, cargo, avatar e humor. O líder do projeto é a sessão principal, e cada subagente é um colega que "entra na sala" quando é chamado.

**Dois modos** (botão no topo):

- **Escritório:** o prédio do [Habblaud](https://github.com/marmottajr/habblaud) ocupando a **janela inteira**, com os painéis (lista de departamentos, ficha/chat, atividade) flutuando por cima em vidro escuro translúcido. Cada sessão é uma sala com o nome do setor na placa. O líder senta na mesa, os subagentes nas mesas ao lado; cada um digita quando trabalha, levanta a mão com balão âmbar quando precisa de você, e ao terminar a sala faz festa.
- **Equipe:** uma faixa por sessão com as mesas lado a lado e o que cada um está fazendo, em português ("Editando: …/ssh/arquivos.js"), com modelo e tokens da sessão no cabeçalho.

**Clique em qualquer funcionário** para abrir a ficha dele: linha do tempo, ficha de desempenho (ferramentas, arquivos editados, comandos, leituras, delegações, falhas, tempo ativo, tempo esperando você; o líder também mostra os tokens da sessão), lista de tarefas (cada prompt vira uma tarefa, e cada subagente tem a sua) e atividade recente.

**Linha do tempo da equipe** (rodapé): uma faixa por funcionário, estilo Gantt, com cores por tipo de trabalho: pensando, lendo e buscando, editando, executando, delegando e esperando você. Janela de tempo automática, 5 min, 15 min ou 1 h. Passe o mouse num trecho para ver o que era.

Também avisa na tela e com som quando um agente pede permissão, termina uma tarefa longa ou dá erro.

### Modo celular

Botão **Celular** (topo). Ligado, o hub abre um servidor só na sua rede Wi-Fi e mostra um QR code. Pelo celular você:

- **vê o escritório** (setores, funcionários, o que cada um faz agora);
- **aprova ou nega pedidos de permissão** dos agentes (cada botão pede dois toques; o celular vibra quando chega um pedido). Entram aqui também os pedidos dos chats abertos pelo hub: permissões de ferramentas, planos do gerente e perguntas entre departamentos;
- **conversa com um departamento** (aba Equipe → Conversar): vê o histórico, escreve, para uma resposta em andamento e aprova pedidos na própria conversa. É a mesma conversa do chat do PC (mesma sessão do Claude Code). Pelo celular o modo é *perguntar antes* (padrão: cada ferramenta pede sua aprovação no celular), *editar arquivos* ou *só planejar*; o modo que pula permissões nunca vale pelo celular, e o modelo e o esforço escolhidos no PC são mantidos;
- **vê as entregas dos agentes** (aba Entregas): quando um agente termina um pedido em que trabalhou, aparece o pedido, a manchete e o resumo da resposta, quantas ferramentas usou e os arquivos que criou ou alterou. Arquivos de texto, imagens e PDFs abrem com um toque (PDF baixa); o celular vibra quando chega uma entrega nova. Só abre o que está dentro da pasta do projeto: arquivos ocultos, pastas como `node_modules`, nomes que parecem segredo (`.env`, chaves, credenciais), links simbólicos que saem da pasta e arquivos grandes ficam só no PC. Texto, código e SVG são sempre mostrados como texto, nunca como página;
- **manda tarefas novas** para um projeto que o hub já viu, em dois modos: *só ler e planejar* (padrão) ou *pode editar arquivos*. Comandos livres ficam bloqueados nos dois. A tarefa roda no PC sem tela (`claude -p`, texto entregue pelo stdin) e aparece no escritório como qualquer sessão. No máximo 2 ao mesmo tempo.

Como a segurança funciona:

- Desligado por padrão. Liga só pelo botão e **desliga sozinho** (30 min, 1 h, 2 h ou 4 h) ou ao fechar o hub.
- Escuta só no IP do Wi-Fi (não em `0.0.0.0`) e só atende endereços de rede privada; confere o cabeçalho `Host`.
- **QR de uso único**: o código vai depois do `#` da URL, que nunca chega ao servidor. O primeiro celular que o usar recebe uma chave própria e o QR deixa de valer. **Um celular por vez**; "Novo QR" revoga o anterior.
- Toda chamada exige a chave (comparação em tempo constante); depois de 8 erros o endereço fica bloqueado por 1 minuto.
- Corpo limitado a 8 KB, só JSON. A página do celular tem política de segurança de conteúdo restrita.
- **A conexão é HTTP puro** dentro da sua rede, sem criptografia. Use só no Wi-Fi de casa, nunca em rede pública ou de terceiros.

Pedidos de permissão: o script `hook/claude-hub-permit.py` (instalado por `npm run install-hooks`) só age quando o Modo celular está ligado **e** há um celular pareado. Ele publica o pedido e espera a resposta por até `phoneWait` segundos (45 por padrão, em `~/.claude-hub/config.json`). Sem resposta, ou com o modo desligado, ele sai sem imprimir nada e o diálogo normal de permissão aparece no PC. Se for aprovado ou negado pelo celular, o Claude Code recebe a decisão.

O Modo celular **não desliga o terminal nem o VS Code**: eles continuam funcionando normalmente no PC. Configurações úteis em `~/.claude-hub/config.json`: `phoneMinutes`, `phoneWait`, `phoneIp` (força a interface de rede, se o hub escolher a errada) e `claudeBin` (caminho do comando `claude`, se o hub não achar).

### Chat do departamento

Cada sala (e cada faixa na aba Equipe) tem um botão **Conversar**. Ele abre, no painel da direita, o chat daquele departamento: o histórico da conversa (lido do transcript, o mesmo que o VS Code mostra) e uma caixa para escrever. Você conversa com o agente líder do setor direto pelo hub, em vez de usar o painel do VS Code, e continua vendo o escritório trabalhando ao lado.

- **O subtítulo da placa é o nome do chat**, como aparece no VS Code (título renomeado por você, ou o gerado automaticamente). Se o chat ainda não tem nome, a placa mostra o primeiro pedido dele (ou o nome do projeto).
- **A caixa de texto tem as ferramentas do painel do VS Code:**
  - **`+`** anexa arquivo ou imagem pelo seletor do sistema. Também dá para **colar uma imagem** (Ctrl+V) ou **arrastar arquivos** para a caixa. Imagens (PNG, JPEG, GIF, WebP, até 5 MB, no máximo 5) vão como imagem para o modelo; os outros arquivos vão como caminho, e o agente os lê (se estiverem fora da pasta do projeto, ele pede permissão).
  - **`/`** (botão, ou digitando `/` no começo) abre o menu de comandos: anexar, mencionar arquivo, trocar modelo, esforço, Ultracode, trocar modo, exportar a conversa para Markdown, compactar (`/compact`) e os **comandos e skills** que o Claude Code carregaria nessa sessão, que rodam como `/nome argumentos`: os do projeto (`.claude/commands` e `.claude/skills`, da pasta da sessão subindo até a raiz do repositório), os seus em `~/.claude` (inclusive `skills/synced`) e os dos **plugins instalados** (`/plugin:skill`, lidos de `~/.claude/plugins`, respeitando os plugins desligados em `settings.json`). Skills com `user-invocable: false` não aparecem, como no Claude Code. Depois da primeira mensagem, o hub também usa a lista de skills que o próprio Claude Code informa ao abrir a sessão. Se nada combinar com o que você digitou, o menu mostra onde procurou.
  - **`@`** busca arquivos da pasta do projeto (ignora `node_modules`, `.git` e afins) e insere `@caminho/do/arquivo` na mensagem.
  - **Modelo e esforço:** a pílula do meio abre a lista de modelos, o esforço (Baixo, Médio, Alto, Extra, Máx.) e o **Ultracode**. "Padrão" não passa `--model` e usa o padrão da sua conta; o esforço "Padrão" também não passa nada. O Haiku 4.5 não tem ajuste de esforço. Para acrescentar outros modelos, use `"models": [{ "id": "claude-...", "label": "Nome", "desc": "texto" }]` no `~/.claude-hub/config.json`.
  - **Modos** (pílula da direita, ou **Shift+Tab** para alternar): *Manual* (pede antes de editar), *Editar automaticamente*, *Planejar* e *Automático*. O Automático depende do modelo e da conta; se estiver indisponível, o Claude Code começa em Manual. O hub nunca usa o modo que pula permissões.
  - Modelo, esforço e modo valem a partir da **próxima mensagem** (o hub reabre a mesma sessão com as novas opções) e ficam lembrados.
- **Pedidos de permissão** aparecem no próprio chat como cartão, com o comando ou arquivo, e botões **Aprovar** e **Negar**.
- **Largura ajustável:** arraste a borda esquerda do painel lateral (vale para o chat, a ficha e o feed) para alargar ou estreitar; duplo clique volta ao tamanho padrão. Também funciona com as setas do teclado (Shift para passos maiores). O hub lembra a largura escolhida.
- **Respostas bem separadas:** títulos, listas (inclusive aninhadas), tabelas, citações, linhas de seção em negrito e links aparecem com espaçamento próprio. Blocos de código mostram a linguagem e um botão **Copiar** que copia tudo; cada resposta tem também **Copiar resposta**.
- **Rascunho por chat:** o que você digitou (e os anexos) fica guardado por departamento e volta quando você retorna ao chat, mesmo depois de fechar o hub. **↑** na caixa traz de volta suas mensagens anteriores (como no VS Code), **↓** avança; o texto que você estava escrevendo é preservado ao navegar.
- **Parar** interrompe a resposta em andamento: o hub encerra o processo do chat (e os filhos dele), a sala volta para **Ocioso** na hora e o próximo envio já funciona. Ele só consegue parar o que foi pedido **pelo hub**; uma resposta que está rodando dentro do VS Code tem de ser parada lá. Enter envia e Shift+Enter quebra a linha.
- Por baixo, o hub continua a **mesma sessão** (`claude -p --resume <id>`), então histórico, contexto e arquivos são os mesmos do VS Code.

### O escritório (motor do Habblaud) e os painéis flutuantes
O desenho do prédio é **o do Habblaud, de verdade**: o motor dele (pixel art em `<canvas>`: salas, móveis, Recepção, Copa, Lounge, banheiros, rua e jardim, ciclo dia/noite, personagens que andam por caminhos A\*, balões, festa ao concluir, decoração de Natal/Halloween) vem empacotado em `renderer/habblaud-world.js`, e a ponte `renderer/habbridge.js` entrega a ele os departamentos (salas) e funcionários (personagens) do hub. Licença MIT, © Márcio Junior (ver `THIRD-PARTY-HABBLAUD.txt`).

- **Tela cheia, sem "responsividade":** o prédio ocupa a janela e a câmera se enquadra sozinha na área livre entre os painéis. Roda do mouse dá zoom, arrastar move, duplo clique numa sala aproxima, **+ − ⤢** (canto direito) enquadram de novo.
- **Esquerda, "Escritório":** a lista de departamentos (cor de estado, quantos estão ativos, a equipe em chips que abrem a ficha, **Conversar**, ⋯, alça ⠿ para reordenar — a ordem da lista é a ordem das salas no prédio) e o cartão do **Cérebro** (vault do Obsidian; mostra quem está lendo qual nota).
- **Direita:** ficha do funcionário, chat do departamento, dois chats lado a lado ou o Cérebro. Só aparece quando há algo para mostrar; arraste a borda para mudar a largura.
- **Embaixo:** abas **Atividade ao vivo** e **Linha do tempo da equipe** (Recolher/Expandir).
- **Botão direito numa sala** abre o mesmo menu do ⋯ (Conversar, tornar gerente, remover). Clicar num personagem abre a ficha dele.
- **Ajustes** (topo): som, avisos e **decoração** (automática segue o calendário: Halloween em outubro, Natal de 1º de novembro a 26 de dezembro; ou fixe Normal, Natal ou Halloween).
- As perguntas e tarefas entre departamentos aparecem como etiqueta na linha do departamento e o envelope voa de um líder para o outro.
- Se o motor não carregar por algum motivo, o hub abre na visão **Equipe**.

O que mudou em relação ao prédio antigo do hub: ele foi **removido**. O Cérebro deixou de ser uma sala do prédio (agora é o cartão da esquerda), a Recepção/Copa vêm do prédio do Habblaud, e quem espera você aparece no contador do topo, no sino e no balão do personagem.

Para atualizar o motor (só se quiser acompanhar o Habblaud): `git clone https://github.com/marmottajr/habblaud /tmp/habblaud`, `npm i --no-save esbuild` e `HABBLAUD_SRC=/tmp/habblaud npm run build-world`.

### Mostrador de uso do plano (topo)
No lugar do contador de tokens há o mostrador de uso, igual ao do Habblaud: barras segmentadas da **sessão de 5 h** e da **semana**, com a porcentagem e o tempo até renovar (`↻1h29`, `↻1d23h`), verde, âmbar acima de 70% e vermelho acima de 90%. Passe o mouse para ver a fonte dos números.

- **Ao vivo:** `npm run install-hooks` também coloca o hub na frente do seu *statusline* do Claude Code. O Claude Code já manda o uso do plano para o statusline; o hub anota só `rate_limits` (5 h e semana) em `~/.claude-hub/usage.json` e repassa tudo ao comando que você já tinha (backup do `settings.json` antes; o comando original fica guardado e `npm run uninstall-hooks` devolve tudo como estava; `--no-usage` pula essa parte). Reinicie as sessões abertas.
- **Sem instalar nada:** usa o último número que o próprio Claude Code guarda no `~/.claude.json` (atualiza quando alguém roda `/usage`) e avisa "desatualizado" depois de 30 min.
- **Sem dados:** aparece "sem dados de uso" e **Como ativar**.
- Uma janela que já renovou some em vez de virar um "0%" enganoso, até chegar número novo. Só arquivos locais: nada de credenciais, nada de rede.
- A ideia vem do Habblaud (MIT). Não testado com dados reais do seu plano nesta versão.

### Remover departamentos
No menu ⋯ de cada sala há **Remover departamento**: tira só aquele da planta e encerra o chat dele. Aparece um aviso com **Desfazer** por alguns segundos, e o departamento também volta sozinho se tiver nova atividade. **Encerrar expediente** não apaga departamentos: eles continuam na planta e só a equipe vai embora (as mesas ficam vazias, "Saiu"), até haver nova atividade. **Limpar departamentos inativos** (em Ajustes) remove os departamentos parados, mas poupa o gerente e quem está trabalhando ou esperando você, e também oferece **Desfazer**.

### Pendências (caixa de entrada)

O **sino** no topo (ou **Alt+I**) reúne tudo que espera você, de todos os departamentos: pedidos de permissão, perguntas entre departamentos e planos de delegação dos chats abertos pelo hub. Cada item mostra o setor, o que está sendo pedido e **Aprovar / Negar** direto, sem abrir o chat (há também **Abrir chat**). O contador no sino soma tudo; chega um aviso sonoro (se o som estiver ligado) quando um pedido novo vem de um chat que não está aberto na tela. Agentes que esperam você **no VS Code** aparecem como aviso com **Ir para a sala**: o hub não consegue responder por lá.

### Dois chats lado a lado

Com um chat aberto, o botão **Dividir** (no cabeçalho do chat) abre uma segunda coluna no painel da direita: escolha o departamento e converse com os dois ao mesmo tempo, cada um com o seu rascunho e histórico de ↑/↓. O painel alarga sozinho (e volta à largura anterior ao fechar). A coluna em foco fica sublinhada e **Conversar** nas salas abre o chat nela. O **✕** da segunda coluna fecha a divisão; o ✕ da primeira faz a segunda virar o chat principal.

### Resumo ao voltar

Depois de **15 minutos ou mais** fora do hub (janela sem foco ou app fechado), ao voltar aparece um cartão com o que aconteceu: tarefas concluídas, arquivos editados, falhas e quanto os agentes esperaram você, por departamento, com as últimas tarefas e seus resultados. Também avisa se há pendências esperando e leva ao relatório do expediente. É feito só com os dados que o hub já registra (não gasta o Claude). **Entendi** (ou Esc) marca como visto. No `~/.claude-hub/config.json`: `awayOn` (desliga) e `awayMinutes` (tempo mínimo fora).

### Organizar o escritório

- **Reordenar as salas:** cada departamento da lista da esquerda (e cada faixa da Equipe) tem uma alça **⠿**. Arraste-a até outro para trocar de lugar, e as salas do prédio seguem a mesma ordem (a lista rola sozinha perto das bordas; **Esc** cancela). Com a alça focada, as setas do teclado movem a sala. A ordem fica salva, e salas novas entram no fim, sem bagunçar as outras (a ordem não muda mais por status).
- **Atividade ao vivo:** fica na aba de baixo do painel; **Recolher** esconde o painel e o hub lembra a escolha.

### Novo departamento

O botão **Novo departamento** (topo) abre um chat novo direto no hub, sem passar pelo VS Code: você escolhe o projeto (os que o hub já viu, ou **Escolher outra pasta…**) e escreve a primeira mensagem. A sessão nasce nessa pasta (`claude -p --session-id <id novo>`) e a sala aparece no escritório com o nome do chat. Os menus `/` e `@`, modelo, esforço e modos funcionam desde a primeira mensagem. Fechar a tela sem enviar não cria nada.

Chat **vazio no VS Code:** o hub só continua conversas que já têm mensagens salvas. Se você abrir um chat novo no VS Code e tentar mandar a primeira mensagem pelo hub, ele avisa e sugere mandar a primeira por lá ou criar o departamento pelo hub. Quando uma resposta falha, a mensagem agora mostra o motivo que o Claude Code deu (ou o tipo da falha e o fim do log).

Cuidados:

- **Converse com um chat por vez, ou pelo hub ou pelo VS Code.** Duas telas escrevendo na mesma sessão ao mesmo tempo embaralham o histórico. O hub bloqueia o envio, com um aviso, quando vê a sessão trabalhando por fora (provavelmente no VS Code); não consegue detectar um painel do VS Code aberto e parado. Para voltar ao VS Code depois de conversar pelo hub, reabra a conversa (`/resume`) para ela recarregar o que foi dito aqui.
- O chat só abre para sessões cuja pasta de projeto o hub conhece (quem já deixou algum evento ou transcript). Se o `claude` não for encontrado, informe o caminho em `claudeBin` no `~/.claude-hub/config.json`.
- O hub encerra os chats abertos ao fechar.

### Cérebro (vault do Obsidian)

O vault entra no escritório como uma sala própria, o **Cérebro**, ao lado da Recepção e da Copa. Por padrão o hub usa `~/cerebro`; para outra pasta, clique na sala e em **Trocar pasta** (ou ajuste `vaultDir` no `~/.claude-hub/config.json`).

- **Na planta:** a sala mostra quantas notas existem e, ao vivo, quem está lendo, escrevendo ou procurando em qual nota (setor, ajudante e nota; some 30 segundos depois). Isso vem dos mesmos eventos dos hooks, então também aparece para sessões abertas no VS Code.
- **Navegador de notas:** clicar na sala (ou no selo **Cérebro** do chat) abre no painel lateral as pastas, a busca por nome e conteúdo, e a leitura da nota com links `[[assim]]` clicáveis. **Abrir no Obsidian** abre a nota no app.
- **Acesso dos agentes (só nos chats abertos pelo hub):** o `claude` é iniciado com `--add-dir <vault>` e uma instrução curta explicando o Cérebro. Ler e escrever notas lá **não pede aprovação** (ferramentas de arquivo: Read, Write, Edit, MultiEdit, NotebookEdit, Glob, Grep, LS). No modo **Planejar** só a leitura é liberada. Sessões do VS Code e as suas configurações globais não mudam.
- **O que continua pedindo aprovação:** `Bash` (mesmo mexendo no vault), qualquer caminho fora do vault, e **pastas que começam com ponto** (`.bot`, `.obsidian`, `.git`, `.trash`): o código do bot do Telegram e a configuração do Obsidian não são liberados, listados nem buscados. Atalhos (symlinks) que apontam para fora do vault também são barrados.
- O desligamento é no rodapé do painel (**Chats do hub usam o Cérebro**) e vale para conversas iniciadas depois. Conversas já abertas mantêm o acesso até serem fechadas ou ficarem 10 minutos paradas.

### Agentes perguntando uns aos outros

Um departamento pode pedir uma resposta a outro sem você copiar e colar. Nos chats abertos pelo hub, o `claude` ganha duas ferramentas (um servidor MCP local do hub, só em `127.0.0.1`, com um segredo no endereço): **listar_departamentos** (quem existe, projeto, título, estado) e **perguntar_departamento** (nome do setor + pergunta).

- **Você aprova cada pergunta.** Aparece no chat de quem perguntou um card "Perguntar a outro departamento pede permissão", com a pergunta completa. Só depois de **Aprovar** o hub entrega a pergunta ao outro chat (como uma mensagem, `claude --resume`) e devolve a resposta final dele para quem perguntou. A aprovação é do próprio hub e vale em qualquer modo, inclusive no Automático.
- **No Escritório:** um envelope voa de uma sala para a outra quando a pergunta é entregue e volta (verde) com a resposta. Enquanto isso, as salas mostram "perguntando a…" e "respondendo a…" e o feed de atividade registra as três linhas. A pergunta fica no histórico do chat do outro departamento, marcada como vinda de outro agente.
- **Limites contra confusão e custo:** uma pergunta por vez por departamento, nada de perguntar a quem está esperando a resposta de outro (sem travar em círculo), no máximo 3 perguntas ao mesmo tempo e 8 por 10 minutos por departamento, e pergunta sem resposta em 4 minutos devolve um aviso (a resposta ainda aparece no chat do outro).
- **O outro departamento precisa estar livre:** não vale perguntar a quem está respondendo outra coisa ou trabalhando agora no VS Code. Se o hub não puder entregar, o agente que perguntou recebe o motivo e segue sem a resposta.
- Quem recebe a pergunta é avisado de que ela veio de outro agente e de que deve responder sem editar arquivos nem rodar comandos; as permissões do chat dele continuam valendo e aparecem nele.
- Para desligar tudo: `"officeOn": false` no `~/.claude-hub/config.json`.

### Encerrar expediente

O botão **Encerrar expediente** (topo) mostra o resumo do dia: quanto os agentes trabalharam (somado), quanto ficaram esperando você, tarefas concluídas, arquivos editados, comandos e falhas. Abaixo, cada setor lista seus funcionários com tempo de trabalho, tempo de espera e as principais tarefas (as 3 mais longas, com o resultado). Dá para **salvar o relatório** em Markdown (`~/.claude-hub/expedientes/`), **copiar um resumo** em texto e **encerrar e zerar o dia**, que esconde as sessões paradas e faz o próximo expediente contar a partir desse momento. Sem encerrar, o período vai da meia-noite até agora. O tempo de espera é uma aproximação: conta do pedido de permissão até a resposta.

### Personas

Cada funcionário **sorteia o nome uma vez** quando aparece (nome, aparência e gênero) e o mantém até sair do escritório, então uma aba nova do mesmo projeto traz gente nova, e dois funcionários visíveis nunca têm o mesmo nome. O cargo vem do tipo do agente: `Explore` é Batedor(a), `Plan` é Arquiteto(a), `general-purpose` é Faz-tudo, `code-reviewer` é Revisor(a), `security-reviewer` é Segurança, `test-runner` é QA, e o líder da sessão é "Líder do setor". Tipos desconhecidos ganham cargo e cor pelo próprio nome do tipo. As listas de nomes e cargos estão em `renderer/persona.js`, e os nomes de setor em `renderer/sector.js`.

## Como funciona

```
Claude Code (VS Code ou terminal)
   ├─ hooks ──► hook/claude-hub-hook.py ──► ~/.claude-hub/events.jsonl ─┐
   └─ transcripts em ~/.claude/projects/*.jsonl (tokens por modelo) ────┤
                                                                         ▼
                                          src/collector.js (lê tudo, nunca escreve)
                                                                         ▼
                                              janela do Claude Hub (Electron)
```

- Os **hooks** dão o status em tempo real e o feed. O script só **acrescenta uma linha** num arquivo, não imprime nada e **sempre sai com código 0**. Se o hub estiver fechado ou quebrado, o Claude Code não é afetado.
- Os **transcripts** dão os tokens (por modelo, sem contar duas vezes a mesma mensagem). Sessões que ainda não têm hooks também aparecem, com status aproximado e a etiqueta "sem hooks".
- O hook **não guarda a resposta das ferramentas**, só um resumo curto (comando, caminho do arquivo, padrão buscado) e textos cortados em 300 a 500 caracteres. Tudo fica em `~/.claude-hub/`, na sua máquina.

## Instalação (Ubuntu)

Requisitos: Node 18+ (você já usa nvm) e `python3` (já vem no Ubuntu).

```bash
cd claude-hub
npm install                 # baixa o Electron
npm run install-hooks       # registra os hooks em ~/.claude/settings.json (faz backup antes)
npm start                   # abre o hub
```

Depois **reinicie as sessões do Claude Code** que já estavam abertas (no VS Code, abra uma conversa nova ou recarregue a janela), porque elas só carregam os hooks ao iniciar. Dentro do Claude Code, o comando `/hooks` mostra o que está ativo.

Para ver a tela funcionando antes de ter agentes reais:

```bash
npm run demo                # ~1,5 minuto de atividade de exemplo (3 sessões, 6 tipos de subagente, permissão, erros)
```

### Ícone no menu e início automático

```bash
npm run install-desktop              # cria o atalho "Claude Hub" no menu de aplicativos
npm run install-desktop:autostart    # idem, e abre ao ligar o PC
node scripts/install-desktop.js --remove   # remove os dois
```

### Desinstalar os hooks

```bash
npm run uninstall-hooks     # remove só o que o hub adicionou; seus outros hooks ficam
```

### Gerente e delegação encadeada

Para tarefas que passam por vários departamentos, escolha um **gerente**: nos **três pontinhos (⋯)** no canto de cada sala (Escritório e Equipe), **Tornar gerente do Escritório**. Só há um gerente por vez (trocar tira o anterior) e a escolha fica lembrada (`~/.claude-hub/manager.json`). A sala do gerente ganha uma **★** no nome e o chat dele, o selo **Gerente · montar plano**.

- **Ele decide sozinho.** Você não precisa explicar o objetivo: o gerente recebe a instrução de olhar os departamentos (estado, título e **último recado** de cada um, e os projetos disponíveis), deduzir o que vale delegar e montar o plano. O menu ⋯ do gerente (ou o selo no chat) tem **Montar um plano agora**, que pede isso a ele; você também pode simplesmente conversar com ele. Se nada precisar ser delegado, ele responde direto. A instrução vai na abertura do `claude`: ao virar (ou deixar de ser) gerente, o chat reabre na mesma conversa na próxima mensagem.
- **Você aprova o plano uma vez.** Aparece um card "Plano de delegação aguarda a sua aprovação" (e na caixa de Pendências) com o objetivo e as etapas (departamento + tarefa). Nada é entregue antes do **Aprovar plano**.
- **Pode criar departamento novo.** Se faltar um departamento, o gerente pede um **novo** (num projeto que o hub já conhece: os mesmos da lista do botão "Novo departamento"). No plano ele aparece como `[NOVO departamento em <projeto>]` e só é criado **depois da sua aprovação**, quando a etapa chega. No máximo 2 por plano.
- **Execução em ordem, de verdade.** O hub entrega cada etapa ao chat do departamento (até 6 etapas por plano). Os departamentos **trabalham** (editam, rodam comandos) com as permissões normais do chat deles, e cada pedido de permissão aparece nas Pendências. O resultado de uma etapa segue para a próxima, e o relatório final volta para o gerente, que resume para você.
- **No Escritório:** a sala do gerente mostra "quer delegar a…" e depois "delegando a…", a sala que recebe mostra "tarefa de…", e o envelope voa a cada etapa.
- **Limites:** só o gerente delega (os outros recebem tarefas e não delegam adiante); um plano por vez e no máximo 3 planos em 10 minutos; se uma etapa falha, demora mais de 25 minutos ou o departamento está ocupado, o plano para e o relatório diz onde parou (as etapas seguintes não são iniciadas). Se você negar o plano, nada acontece.
- **Conversas abertas pelo hub:** no máximo 4 `claude` ao mesmo tempo. No limite, o hub fecha a conversa **parada há mais tempo** (sem resposta em andamento nem pedido pendente) para dar a vaga; ela reabre sozinha, na mesma conversa, quando você ou o gerente mandar algo. Se todas estiverem ocupadas, avisa.

## Por que `--no-sandbox`?

No Ubuntu 24.04 o Electron baixado pelo npm costuma falhar ao abrir por causa da restrição de namespaces de usuário (erro de "SUID sandbox helper"). O hub só abre arquivos locais dele mesmo e não carrega nenhuma página da internet, então o `--no-sandbox` já vem nos comandos `npm start` e no atalho. Se preferir o sandbox, libere-o no sistema e remova a flag.

## Configurações

- **Avisos** (`~/.claude-hub/config.json`): som, avisar pedidos, avisar término. Por padrão o aviso de término só dispara se a tarefa durou 20 segundos ou mais (`minTurnSeconds`).
- **Limpar departamentos inativos** (em Ajustes): esconde sessões paradas. Elas voltam sozinhas se tiverem nova atividade.
- A linha do tempo do funcionário vem dos eventos dos hooks. Sessões sem hooks mostram só o líder, com trechos aproximados.
- Os tokens são por sessão (o transcript não separa por subagente), então aparecem na ficha do líder.
- O hub não mostra mais custo estimado. Se existir um `~/.claude-hub/pricing.json` de versões antigas, ele não é mais usado e pode ser apagado.
- Departamentos (sessões) ficam na tela mesmo parados ou encerrados ("Saiu") e só somem sozinhos após 3 dias sem nenhuma atividade. Para tirar antes, use **Remover departamento** (menu ⋯) ou **Limpar departamentos inativos** (Ajustes).
- **Resumo ao voltar:** `awayOn` e `awayMinutes` (veja acima). O momento da última vez que você olhou o hub fica em `~/.claude-hub/seen.json`.

## Limitações conhecidas

- O que é **"aguardando você"** depende dos eventos de permissão e de notificação do Claude Code. Se uma versão mudar o texto da notificação, o estado pode demorar a aparecer. O card mostra um aviso de "sem sinal" quando uma sessão fica 5 minutos sem nenhum evento.
- Os transcripts de subagentes são lidos quando existem como arquivos próprios (`<sessão>/subagents/*.jsonl`) ou dentro do arquivo principal; a mesma mensagem nunca é somada duas vezes.
- O hub só envia prompts quando você usa o **Chat do departamento** (no PC) ou, com o Modo celular ligado, o celular pareado (aprovar pedidos, conversar com um departamento e iniciar tarefas novas).
- A aba Nova do celular inicia tarefas **novas**; para continuar uma sessão existente use Conversar (celular ou PC). As mesmas regras do chat valem: o hub recusa enviar enquanto a sessão está trabalhando por fora (VS Code) e a conversa não deve ser digitada nos dois lugares ao mesmo tempo.
- As entregas vêm do transcript da sessão: só contam pedidos em que o agente usou ferramentas e respondeu; arquivos criados por subagentes (que têm transcript próprio) não entram na lista.
- O nome do chat vem das entradas de título do transcript (`custom-title`, `ai-title`, `summary`). Se uma versão do Claude Code mudar esse formato, a placa volta a mostrar o primeiro pedido.
- As perguntas entre departamentos dependem de o `claude --mcp-config` aceitar um servidor MCP por HTTP (Claude Code recente). O servidor do hub foi testado com chamadas JSON-RPC reais e com um `claude` simulado, não com o Claude Code de verdade; se as ferramentas `mcp__escritorio__…` não aparecerem no chat (peça ao agente para listá-las), atualize o Claude Code.
- O Cérebro libera arquivos do vault sozinho, mas isso depende de o Claude Code pedir permissão pelo canal do hub (`--permission-prompt-tool stdio`); se uma versão passar a liberar ou bloquear por conta própria, o comportamento muda. Não foi testado com um `claude` real.
- A **delegação** foi testada com um `claude` simulado e com chamadas MCP reais ao servidor do hub, não com o Claude Code de verdade: se o gerente não conseguir chamar `mcp__escritorio__delegar_tarefas`, atualize o Claude Code. O hub só entrega a tarefa se o outro chat estiver livre e só enxerga chats abertos pelo hub.
- O chat foi testado com um `claude` simulado e com o protocolo documentado do modo headless; se a sua versão do Claude Code mudar esse protocolo, o chat pode precisar de ajuste.
- Do menu do VS Code ficaram de fora o que depende do painel dele: Rewind, Bookmarks e Limpar conversa (para recomeçar, abra um chat novo no VS Code). Ultracode exige Claude Code 2.1.203 ou mais novo, e o id do Fable 5.2 (`claude-fable-5-2`) é uma suposição: se der erro de modelo, ajuste em `models`.

## Estrutura

```
src/collector.js     lê eventos e transcripts; monta funcionários, linha do tempo, tarefas, tokens e relatório do expediente
src/main.js          janela, avisos do sistema, preferências
src/phone.js         Modo celular: servidor local, pareamento, permissões, chat do departamento, entregas e tarefas remotas
src/deliveries.js    Entregas: pedidos concluídos e arquivos entregues, a partir do transcript (com as regras de segurança dos arquivos)
src/chat.js          Chat do departamento: processos `claude` por sessão, histórico, permissões
src/claudebin.js     localiza o comando `claude`
phone/               página do celular
hook/claude-hub-permit.py   hook de permissão do Modo celular
hook/claude-hub-statusline.py   tap do statusline: anota o uso do plano e repassa ao statusline original
vendor/habblaud/     ponto de entrada e trocas do empacotamento do motor (scripts/build-world.mjs)
src/office.js        Escritório: servidor MCP local, aprovação e regras das perguntas e da delegação entre departamentos
src/usage.js         Mostrador de uso do plano: lê o tap do statusline e o cache do Claude Code (só arquivos locais)
src/vault.js         Cérebro: listar/ler/buscar notas com contenção de caminhos e liberação automática das ferramentas de arquivo
renderer/            interface sem dependências: habblaud-world.js (motor do escritório, MIT, empacotado) + habbridge.js (hub → escritório), glass.css (layout em tela cheia e painéis de vidro), app.js (telas), inbox.js (sino de pendências), away.js (resumo ao voltar), vault.js (navegador de notas), chat.js (chat do departamento), composer.js (caixa de texto: anexos, menus, modelo, modo), persona.js (nomes e avatares), sector.js (setores), report.js (encerrar expediente), timeline.js (faixas)
hook/                script que o Claude Code chama a cada evento
scripts/             install-hooks (hooks + tap do statusline), install-desktop, demo, build-world
test/                npm test (coletor, hook, Modo celular, chat, Cérebro, Escritório, entregas, uso do plano e ponte do escritório, com dados simulados)
```
