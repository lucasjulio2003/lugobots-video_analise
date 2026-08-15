// O pouco que o analisador (index.html) e o quadro de correções (kanban.html) precisam
// dividir: as chaves do armazenamento, a identidade de um lance e o vocabulário do quadro.
//
// É um script comum, e não um módulo ES, para as duas páginas continuarem abrindo direto do
// disco por file:// — onde import/export esbarra na política de origem do navegador.
(() => {
  "use strict";

  const CHAVE = "analisador_video:v1:";
  const CHAVE_BIB = CHAVE + "biblioteca";
  const CHAVE_LATERAL = CHAVE + "lateral";
  const CHAVE_GUIA = CHAVE + "guia";
  const CHAVE_BOT = CHAVE + "bot";
  const CHAVE_QUADRO = CHAVE + "quadro";
  // Tudo o que tem o prefixo e não está nesta lista é o estado de um vídeo. Uma chave de
  // ajuste nova precisa entrar aqui, senão ela vira uma partida fantasma no quadro.
  const RESERVADAS = new Set([CHAVE_BIB, CHAVE_LATERAL, CHAVE_GUIA, CHAVE_BOT, CHAVE_QUADRO]);

  // ------------------------------------------------------------------ lances
  // A identidade de um lance é o instante em que ele foi desenhado. Esta função é a chave do
  // acordo entre as duas páginas: mudá-la de um lado só desgarra todas as notas do outro.
  const chaveLance = (t) => (t || 0).toFixed(3);

  function fmtTempo(t) {
    if (!isFinite(t)) return "0:00.000";
    const m = Math.floor(t / 60), s = Math.floor(t % 60), ms = Math.floor((t % 1) * 1000);
    return `${m}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  }

  const PLURAL = {
    seta: "setas", linha: "linhas", livre: "traços", retangulo: "retângulos",
    elipse: "elipses", zona: "zonas", texto: "textos", jogador: "jogadores"
  };

  function resumoTipos(itens) {
    const conta = new Map();
    for (const a of itens) conta.set(a.tipo, (conta.get(a.tipo) || 0) + 1);
    return [...conta].map(([tipo, n]) => n > 1 ? `${n} ${PLURAL[tipo] || tipo}` : `1 ${tipo}`).join(" · ");
  }

  function agruparLances(anotacoes) {
    const m = new Map();
    for (const a of anotacoes || []) {
      const k = chaveLance(a.t);
      if (!m.has(k)) m.set(k, { chave: k, t: a.t, itens: [] });
      m.get(k).itens.push(a);
    }
    return [...m.values()].sort((x, y) => x.t - y.t);
  }

  // ------------------------------------------------------------------ quadro de correções
  const ESTAGIOS = [
    { chave: "analise", nome: "Análise" },
    { chave: "desenvolvimento", nome: "Desenvolvimento" },
    { chave: "testes", nome: "Testes" },
    { chave: "resolvido", nome: "Resolvido" },
    { chave: "arquivado", nome: "Arquivados" }
  ];
  const ESTAGIO_PADRAO = "analise";
  const PRIORIDADES = [
    { chave: "alta", nome: "alta", cor: "var(--adv)" },
    { chave: "media", nome: "média", cor: "var(--bola)" },
    { chave: "baixa", nome: "baixa", cor: "var(--manter)" }
  ];

  const estagioDe = (e) => {
    const c = e && e.estagio;
    return ESTAGIOS.some(x => x.chave === c) ? c : ESTAGIO_PADRAO;
  };

  // Uma entrada de lance guarda o que o usuário escreveu ou moveu; sem nada disso ela não tem
  // por que existir. É o que sustenta o card órfão: apagar os desenhos não apaga o trabalho.
  const entradaVazia = (e) => !e || (!e.nota && !e.prioridade && estagioDe(e) === ESTAGIO_PADRAO);

  function podarLances(lances) {
    for (const k of Object.keys(lances || {})) if (entradaVazia(lances[k])) delete lances[k];
    return lances;
  }

  // ------------------------------------------------------------------ armazenamento
  // Leitura e escrita CRUAS, de propósito: o app grava a tolerância "sempre visível" como a
  // string "sempre" (JSON não tem Infinity). Reviver aqui viraria Infinity e o stringify
  // seguinte devolveria null — a tolerância do usuário morreria numa ida e volta.
  function lerEstado(imp) {
    try {
      const bruto = localStorage.getItem(CHAVE + imp);
      if (!bruto) return null;
      const s = JSON.parse(bruto);
      if (!s || !Array.isArray(s.anotacoes)) return null;
      if (!s.lances || typeof s.lances !== "object") s.lances = {};
      return s;
    } catch (err) { return null; }
  }

  // Escreve só o campo 'lances', relendo na hora: o analisador pode ter gravado outra coisa
  // no meio do caminho, e o quadro não tem nada a dizer sobre o resto do estado.
  function gravarLances(imp, lances) {
    const s = lerEstado(imp);
    if (!s) return false;
    s.lances = podarLances(lances);
    try {
      localStorage.setItem(CHAVE + imp, JSON.stringify(s));
      return true;
    } catch (err) { return false; }
  }

  function videosGuardados() {
    const fora = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(CHAVE) || RESERVADAS.has(k)) continue;
        fora.push(k.slice(CHAVE.length));
      }
    } catch (err) {}
    return fora;
  }

  function lerBiblioteca() {
    try {
      const b = JSON.parse(localStorage.getItem(CHAVE_BIB) || "[]");
      return Array.isArray(b) ? b.filter(x => x && x.imp && x.nome) : [];
    } catch (err) { return []; }
  }

  // O título e a descrição são do usuário e vivem na lista; 'nome' continua sendo a
  // identidade técnica (arquivo ou link).
  const rotuloDe = (it) => (it && it.titulo) || (it && it.nome) || "—";

  window.Analisador = {
    CHAVE, CHAVE_BIB, CHAVE_LATERAL, CHAVE_GUIA, CHAVE_BOT, CHAVE_QUADRO, RESERVADAS,
    chaveLance, fmtTempo, PLURAL, resumoTipos, agruparLances,
    ESTAGIOS, ESTAGIO_PADRAO, PRIORIDADES, estagioDe, entradaVazia, podarLances,
    lerEstado, gravarLances, videosGuardados, lerBiblioteca, rotuloDe
  };
})();
