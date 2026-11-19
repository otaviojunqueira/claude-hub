'use strict';
/**
 * Setores do escritório. Cada sessão do Claude Code ocupa um setor, batizado pelo que
 * se pede nela (palavras do primeiro pedido). O nome é sorteado uma vez e fica guardado,
 * e dois setores visíveis nunca têm o mesmo nome.
 */
(function () {
  const RULES = [
    { re: /test|qa\b|bug|erro|falh|corrig|quebr|conserta|fix/i, names: ['Setor de Qualidade', 'Bancada de Testes', 'Controle de Qualidade'] },
    { re: /design|layout|css|tela|visual|\bui\b|\bux\b|p[áa]gina|front|cor\b|estilo|bonito/i, names: ['Estúdio de Design', 'Ateliê de Interface', 'Sala de Criação'] },
    { re: /banco|migration|migra|sql|mongo|query|dados|schema|tabela|planilha/i, names: ['Central de Dados', 'Arquivo Geral', 'Sala dos Bancos'] },
    { re: /deploy|servidor|ssh|build|docker|infra|produ[çc][ãa]o|homolog|publicar|subir/i, names: ['Sala de Servidores', 'Central de Operações', 'Doca de Entregas'] },
    { re: /doc|readme|texto|redig|relat[óo]rio|escrev|explica/i, names: ['Redação', 'Sala de Documentação', 'Biblioteca'] },
    { re: /plan|arquitet|estrutur|desenh|proje[tç]|roadmap|organiz/i, names: ['Sala de Planejamento', 'Mesa de Arquitetura', 'Sala de Estratégia'] },
    { re: /api|endpoint|webhook|backend|back-end|rota|servi[çc]o|integra/i, names: ['Oficina de APIs', 'Setor de Integrações', 'Balcão de Serviços'] },
    { re: /refator|limp|renom|reorgan|atualiz|upgrade|depend/i, names: ['Manutenção', 'Oficina de Reformas', 'Setor de Atualizações'] },
    { re: /pesquis|analis|investig|busca|entend|descobr|auditor|revis/i, names: ['Laboratório de Pesquisa', 'Sala de Análises', 'Central de Investigação'] },
    { re: /segur|senha|permiss|login|autentic|token|criptograf/i, names: ['Cofre de Segurança', 'Sala de Acessos', 'Guarita'] },
  ];
  const FALLBACK = ['Setor de Desenvolvimento', 'Mesa de Operações', 'Sala de Reuniões', 'Bancada Principal', 'Sala de Projetos', 'Baia Central', 'Sala dos Fundos', 'Mezanino', 'Cantinho do Café', 'Sala de Produção'];

  const cache = new Map(); // sessionId -> nome
  const provisional = new Map();

  function hash(str) {
    let x = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      x ^= str.charCodeAt(i);
      x = Math.imul(x, 0x01000193) >>> 0;
    }
    return x >>> 0;
  }

  function firstPrompt(session) {
    const leader = session.employees.find((e) => e.isLeader);
    if (!leader || !leader.tasks.length) return '';
    // O primeiro pedido da sessão é a tarefa mais antiga (a ordem da lista varia entre painel e relatório).
    let first = leader.tasks[0];
    for (const t of leader.tasks) if (t.start < first.start) first = t;
    return first.title || '';
  }

  function pickFree(candidates, h, used) {
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[(h + i) % candidates.length];
      if (!used.has(c)) return c;
    }
    return null;
  }

  /** Dá nome a cada sessão, na ordem em que chegaram. Define session.sector. */
  function assign(sessions) {
    const used = new Set(cache.values());
    const ordered = [...sessions].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    for (const s of ordered) {
      if (cache.has(s.id)) {
        s.sector = cache.get(s.id);
        continue;
      }
      const prompt = firstPrompt(s);
      const h = hash(s.id);
      let name = null;
      if (prompt) {
        const rule = RULES.find((r) => r.re.test(prompt));
        if (rule) name = pickFree(rule.names, h, used);
        if (!name) name = pickFree(FALLBACK, h, used);
        if (!name) name = `Anexo ${s.project}`;
        cache.set(s.id, name);
        used.add(name);
        provisional.delete(s.id);
      } else {
        // Ainda não pediram nada: nome provisório (não fica guardado até existir o primeiro pedido).
        name = provisional.get(s.id) || pickFree(FALLBACK, h, used) || `Anexo ${s.project}`;
        provisional.set(s.id, name);
        used.add(name);
      }
      s.sector = name;
    }
  }

  /** Fixa setores já batizados em outra tela. */
  function preset(map) {
    for (const [id, name] of Object.entries(map || {})) if (!cache.has(id) && typeof name === 'string') cache.set(id, name.slice(0, 60));
  }

  window.Sector = { assign, preset };
})();
