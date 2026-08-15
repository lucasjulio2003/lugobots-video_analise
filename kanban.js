// Quadro de correções: reúne os lances de TODAS as partidas guardadas e os organiza em
// colunas de trabalho. Não há banco novo — cada card é a leitura de um lance que já mora no
// estado do vídeo dele (ver comum.js), e mover um card só reescreve o campo 'lances' daquele
// vídeo. Por isso o analisador e este quadro nunca discordam sobre o que é um lance.
(() => {
  "use strict";

  const {
    CHAVE, CHAVE_QUADRO, fmtTempo, resumoTipos, agruparLances,
    ESTAGIOS, ESTAGIO_PADRAO, PRIORIDADES, estagioDe, entradaVazia,
    lerEstado, gravarLances, videosGuardados, lerBiblioteca, rotuloDe,
    lerRetrato, apagarRetrato
  } = window.Analisador;

  // id do card -> foto do lance (ou null quando aquele lance não tem). Fica em memória para o
  // quadro não reler o banco a cada redesenho — e para a imagem não piscar ao mover um card.
  const retratos = new Map();
  // A foto mora no IndexedDB, que não dispara evento nenhum quando muda: um lance antigo
  // fotografado agora, no analisador, chegaria aqui como "não tem" para sempre. Por isso as
  // faltas são esquecidas quando há notícia do outro lado ou quando se volta para esta aba.
  const esquecerFaltas = () => { for (const [k, v] of retratos) if (!v) retratos.delete(k); };

  const $ = (id) => document.getElementById(id);

  let cards = [];                       // todos os cards levantados, de todos os vídeos
  let editando = null;                  // id do card com a anotação aberta
  let arrastando = null;                // id do card em viagem
  let filtros = { partida: "", busca: "", soTrabalho: true };

  // identidade de um card na tela: o vídeo mais o instante. Nunca é separada de volta — só
  // comparada inteira —, e a chave é sempre "dígitos.dígitos", então o espaço não confunde.
  const idDe = (c) => `${c.imp} ${c.chave}`;
  const achar = (id) => cards.find(c => idDe(c) === id);

  // Um lance sem anotação, sem prioridade e ainda em Análise é um rabisco de análise, não uma
  // correção a fazer: é isso que o filtro de cima esconde.
  const temTrabalho = (c) => !!(c.nota || c.prioridade || c.estagio !== ESTAGIO_PADRAO || c.orfao);

  // ------------------------------------------------------------------ leitura transversal
  function levantarCards() {
    const bib = lerBiblioteca();
    const fora = [];
    for (const imp of videosGuardados()) {
      const s = lerEstado(imp);
      if (!s) continue;
      const it = bib.find(x => x.imp === imp);
      // o vídeo pode ter saído da lista e as anotações dele continuarem guardadas: aí o nome
      // técnico do arquivo é tudo o que resta para nomear a partida
      const partida = it ? rotuloDe(it) : ((s.video && s.video.nome) || imp);

      const vivos = new Set();
      for (const g of agruparLances(s.anotacoes)) {
        vivos.add(g.chave);
        fora.push(montar(imp, partida, g.chave, g.t, s.lances[g.chave], resumoTipos(g.itens), false));
      }
      // órfãos: o trabalho ficou, os desenhos não. Some do analisador, permanece aqui.
      for (const chave of Object.keys(s.lances || {})) {
        if (vivos.has(chave) || entradaVazia(s.lances[chave])) continue;
        fora.push(montar(imp, partida, chave, Number(chave), s.lances[chave], "", true));
      }
    }
    return fora;
  }

  function montar(imp, partida, chave, t, e, tipos, orfao) {
    return {
      imp, partida, chave, t, tipos, orfao,
      nota: (e && e.nota) || "",
      prioridade: (e && PRIORIDADES.some(p => p.chave === e.prioridade)) ? e.prioridade : "",
      estagio: estagioDe(e),
      ordem: (e && typeof e.ordem === "number") ? e.ordem : null
    };
  }

  // Dentro da coluna manda a ordem que o usuário deu; quem nunca foi arrastado entra depois,
  // em ordem de partida e instante — que é como o trabalho aparece ao assistir ao jogo.
  function ordenar(lista) {
    return lista.slice().sort((a, b) => {
      const oa = a.ordem === null ? Infinity : a.ordem, ob = b.ordem === null ? Infinity : b.ordem;
      if (oa !== ob) return oa - ob;
      if (a.partida !== b.partida) return a.partida.localeCompare(b.partida, "pt-BR");
      return a.t - b.t;
    });
  }

  const daColuna = (estagio) => ordenar(cards.filter(c => c.estagio === estagio));

  function visivel(c) {
    if (filtros.soTrabalho && !temTrabalho(c)) return false;
    if (filtros.partida && c.partida !== filtros.partida) return false;
    if (filtros.busca) {
      const alvo = `${c.nota} ${c.partida} ${c.tipos}`.toLowerCase();
      if (!alvo.includes(filtros.busca.toLowerCase())) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ escrita
  // Grava com o mesmo atraso do analisador: digitar uma anotação não pode reserializar o
  // estado inteiro do vídeo a cada tecla.
  const aGravar = new Map();            // impressão -> lances esperando ir para o armazenamento
  let temporizador = 0;

  function gravarPendentes() {
    clearTimeout(temporizador);
    temporizador = 0;
    for (const [imp, lances] of aGravar) gravarLances(imp, lances);
    aGravar.clear();
  }

  // Toda mudança passa por aqui: relê o estado do vídeo na hora (o analisador pode ter mexido
  // nele em outra aba), aplica os campos e devolve o registro inteiro para o armazenamento.
  // Campo com "" ou null é campo apagado — é assim que um card perde a prioridade ou a nota.
  function alterar(mudancas, agora) {
    for (const m of mudancas) {
      if (!aGravar.has(m.imp)) {
        const s = lerEstado(m.imp);
        if (!s) continue;
        aGravar.set(m.imp, s.lances);
      }
      const lances = aGravar.get(m.imp);
      const e = lances[m.chave] || {};
      for (const k of Object.keys(m.campos)) {
        if (m.campos[k] === "" || m.campos[k] === null) delete e[k];
        else e[k] = m.campos[k];
      }
      lances[m.chave] = e;
    }
    if (agora) return gravarPendentes();
    clearTimeout(temporizador);
    temporizador = setTimeout(gravarPendentes, 400);
  }

  // ------------------------------------------------------------------ desenho
  function desenhar() {
    cards = levantarCards();
    montarFiltroPartidas();

    const caixa = $("colunas");
    caixa.textContent = "";
    let mostrados = 0;
    for (const est of ESTAGIOS) {
      const lista = daColuna(est.chave).filter(visivel);
      mostrados += lista.length;
      caixa.appendChild(montarColuna(est, lista));
    }

    const anotados = cards.filter(temTrabalho).length;
    const partidas = new Set(cards.map(c => c.partida)).size;
    $("resumoQuadro").textContent = cards.length
      ? `${cards.length} lance(s) em ${partidas} partida(s) · ${anotados} com trabalho · ${mostrados} à vista`
      : "";

    // Um quadro de colunas vazias não diz nada por si. Quando não há nada à vista, o motivo
    // vem no alto da página — e, se for filtro, com o botão que o desfaz.
    const aviso = $("avisoQuadro"), botao = $("btMostrarTudo");
    aviso.hidden = mostrados > 0;
    botao.hidden = cards.length === 0;
    $("txtAviso").textContent = cards.length === 0
      ? "Nenhum lance guardado ainda. Abra o analisador, pause o vídeo e desenhe sobre um lance — ele aparece aqui."
      : `${cards.length} lance(s) guardado(s), nenhum à vista: os filtros de cima estão escondendo` +
        ` todos. Um lance só “tem trabalho” depois de ganhar anotação, prioridade ou estágio.`;
  }

  function montarColuna(est, lista) {
    const col = document.createElement("section");
    col.className = `coluna col-${est.chave}`;
    col.dataset.estagio = est.chave;

    const cab = document.createElement("header");
    cab.className = "col-topo";
    const nome = document.createElement("strong");
    nome.textContent = est.nome;
    const cont = document.createElement("span");
    cont.className = "cont";
    cont.textContent = String(lista.length);
    cab.append(nome, cont);

    const pilha = document.createElement("div");
    pilha.className = "pilha";
    for (const c of lista) pilha.appendChild(montarCard(c));
    if (!lista.length) {
      const oco = document.createElement("p");
      oco.className = "oco rot";
      oco.textContent = "arraste um lance para cá";
      pilha.appendChild(oco);
    }

    // a coluna inteira é alvo do arraste; a linha de inserção sai do card sob o ponteiro
    pilha.addEventListener("dragover", (e) => {
      if (!arrastando) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      marcarAlvo(pilha, e.clientY);
    });
    pilha.addEventListener("dragleave", (e) => {
      if (!pilha.contains(e.relatedTarget)) limparMarcas(pilha);
    });
    pilha.addEventListener("drop", (e) => {
      e.preventDefault();
      const antes = pilha.querySelector(".alvo-antes");
      limparMarcas(pilha);
      soltar(est.chave, antes ? antes.dataset.id : null);
    });

    col.append(cab, pilha);
    return col;
  }

  function montarCard(c) {
    const art = document.createElement("article");
    art.className = "card" + (c.orfao ? " orfao" : "") + (c.prioridade ? ` p-${c.prioridade}` : "");
    art.dataset.id = idDe(c);
    art.draggable = true;
    art.addEventListener("dragstart", (e) => {
      arrastando = idDe(c);
      art.classList.add("viajando");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", idDe(c));
    });
    art.addEventListener("dragend", () => {
      arrastando = null;
      art.classList.remove("viajando");
      for (const p of document.querySelectorAll(".pilha")) limparMarcas(p);
    });

    // A foto entra escondida e só aparece quando chega: assim o card não pisca nem salta de
    // altura, e um lance sem retrato (anterior a isto, ou de vídeo de outra origem) não deixa
    // uma moldura vazia no lugar.
    const foto = document.createElement("img");
    foto.className = "c-foto";
    foto.alt = "";
    foto.draggable = false;              // senão o navegador arrasta a imagem, e não o card
    foto.hidden = true;
    const vestirFoto = (dados) => {
      if (!dados) return;
      foto.src = dados;
      foto.hidden = false;
      art.classList.add("com-retrato");
    };
    if (retratos.has(art.dataset.id)) vestirFoto(retratos.get(art.dataset.id));
    else lerRetrato(c.imp, c.chave).then((dados) => {
      retratos.set(art.dataset.id, dados || null);
      vestirFoto(dados);
    });

    const topo = document.createElement("div");
    topo.className = "c-topo";
    const tempo = document.createElement("span");
    tempo.className = "c-tempo";
    tempo.textContent = fmtTempo(c.t);
    const partida = document.createElement("span");
    partida.className = "c-partida";
    partida.textContent = c.partida;
    partida.title = c.partida;
    topo.append(tempo, partida);

    const nota = document.createElement("p");
    nota.className = "c-nota" + (c.nota ? "" : " sem");
    nota.textContent = c.nota || "sem anotação";

    const pe = document.createElement("div");
    pe.className = "c-pe rot";
    pe.textContent = c.orfao ? "⚠ sem desenhos no analisador" : c.tipos;
    if (c.orfao) pe.title = "Os desenhos deste lance foram apagados; a anotação e o estágio ficaram.";

    art.append(topo, foto, nota, pe);
    art.appendChild(editando === idDe(c) ? montarEditor(c) : montarAcoes(c));
    return art;
  }

  function montarAcoes(c) {
    const linha = document.createElement("div");
    linha.className = "c-acoes";
    const i = ESTAGIOS.findIndex(x => x.chave === c.estagio);

    // as setas cobrem o que o arraste não cobre: toque, teclado e uma coluna fora da tela
    const passo = (n, rotulo, titulo) => {
      const b = document.createElement("button");
      b.className = "acao";
      b.textContent = rotulo;
      b.disabled = !ESTAGIOS[i + n];
      b.title = ESTAGIOS[i + n] ? `${titulo}: ${ESTAGIOS[i + n].nome}` : titulo;
      b.addEventListener("click", () => colocar(c, ESTAGIOS[i + n].chave, null));
      return b;
    };

    const prio = document.createElement("select");
    prio.className = "c-prio";
    prio.title = "Prioridade";
    prio.appendChild(new Option("— prioridade", ""));
    for (const p of PRIORIDADES) prio.appendChild(new Option(p.nome, p.chave));
    prio.value = c.prioridade;
    prio.addEventListener("change", () => {
      alterar([{ imp: c.imp, chave: c.chave, campos: { prioridade: prio.value } }], true);
      desenhar();
    });

    const anotar = document.createElement("button");
    anotar.className = "acao";
    anotar.textContent = "✎";
    anotar.title = c.nota ? "Editar a anotação" : "Anotar este lance";
    anotar.addEventListener("click", () => { editando = idDe(c); redesenhar(); });

    const ir = document.createElement("a");
    ir.className = "acao";
    ir.textContent = "↗";
    ir.title = "Abrir o analisador neste instante";
    ir.href = `index.html#lance=${encodeURIComponent(c.imp)}@${c.chave}`;

    linha.append(passo(-1, "◀", "Voltar para"), passo(1, "▶", "Avançar para"), prio, anotar, ir);

    if (c.orfao) {
      const x = document.createElement("button");
      x.className = "acao fechar";
      x.textContent = "✕";
      x.title = "Descartar este card (o lance não existe mais no vídeo)";
      x.addEventListener("click", () => {
        if (!confirm(`Descartar o card de ${fmtTempo(c.t)} — ${c.partida}?`)) return;
        alterar([{ imp: c.imp, chave: c.chave, campos: { nota: "", prioridade: "", estagio: "" } }], true);
        apagarRetrato(c.imp, c.chave);   // sem desenhos e sem card, a foto não serve a ninguém
        retratos.delete(idDe(c));
        desenhar();
      });
      linha.appendChild(x);
    }
    return linha;
  }

  function montarEditor(c) {
    const ed = document.createElement("div");
    ed.className = "c-editor";
    const ta = document.createElement("textarea");
    ta.rows = 4;
    ta.placeholder = "O que precisa ser corrigido no bot?";
    ta.value = c.nota;
    ta.addEventListener("input", () => {
      alterar([{ imp: c.imp, chave: c.chave, campos: { nota: ta.value.trim() } }]);
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); fechar(); }
    });

    const fechar = () => {
      alterar([{ imp: c.imp, chave: c.chave, campos: { nota: ta.value.trim() } }], true);
      editando = null;
      desenhar();
    };
    const pronto = document.createElement("button");
    pronto.className = "compacto";
    pronto.textContent = "Pronto";
    // pointerdown, e não click: o redesenho tira o botão da tela antes de o clique fechar
    pronto.addEventListener("pointerdown", (e) => { e.preventDefault(); fechar(); });

    ed.append(ta, pronto);
    return ed;
  }

  // ------------------------------------------------------------------ mover
  // Mover é sempre reescrever a ordem da coluna de destino INTEIRA, e não só a do card que
  // chegou: a lista final é a verdade, e uma sequência 0..n-1 não deixa empate para o
  // desempate resolver por conta própria. 'idAntes' nulo significa "no fim".
  function colocar(c, estagio, idAntes) {
    const alvo = daColuna(estagio).filter(x => idDe(x) !== idDe(c));
    const i = idAntes ? alvo.findIndex(x => idDe(x) === idAntes) : -1;
    alvo.splice(i < 0 ? alvo.length : i, 0, c);

    alterar(alvo.map((x, n) => ({
      imp: x.imp, chave: x.chave,
      campos: idDe(x) === idDe(c) ? { estagio, ordem: n } : { ordem: n }
    })), true);
    desenhar();
  }

  function soltar(estagio, idAntes) {
    const c = achar(arrastando);
    arrastando = null;
    if (c) colocar(c, estagio, idAntes);
  }

  function marcarAlvo(pilha, y) {
    limparMarcas(pilha);
    for (const el of pilha.querySelectorAll(".card:not(.viajando)")) {
      const r = el.getBoundingClientRect();
      if (y < r.top + r.height / 2) { el.classList.add("alvo-antes"); return; }
    }
    pilha.classList.add("alvo-fim");
  }

  function limparMarcas(pilha) {
    pilha.classList.remove("alvo-fim");
    for (const el of pilha.querySelectorAll(".alvo-antes")) el.classList.remove("alvo-antes");
  }

  // ------------------------------------------------------------------ filtros
  function montarFiltroPartidas() {
    const sel = $("selPartida");
    const nomes = [...new Set(cards.map(c => c.partida))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    const atual = filtros.partida;
    sel.textContent = "";
    sel.appendChild(new Option("todas as partidas", ""));
    for (const n of nomes) sel.appendChild(new Option(n, n));
    sel.value = nomes.includes(atual) ? atual : "";
    filtros.partida = sel.value;
  }

  function guardarFiltros() {
    try { localStorage.setItem(CHAVE_QUADRO, JSON.stringify(filtros)); } catch (err) {}
  }

  function lerFiltros() {
    try {
      const f = JSON.parse(localStorage.getItem(CHAVE_QUADRO) || "null");
      if (f && typeof f === "object") filtros = { partida: "", busca: "", soTrabalho: true, ...f };
    } catch (err) {}
  }

  // redesenha na próxima volta do laço: várias mudanças seguidas viram um desenho só
  let pedido = 0;
  function redesenhar() {
    if (pedido) return;
    pedido = requestAnimationFrame(() => { pedido = 0; desenhar(); });
  }

  function ligar() {
    lerFiltros();
    $("ckAnotados").checked = filtros.soTrabalho;
    $("txtBusca").value = filtros.busca;

    $("selPartida").addEventListener("change", (e) => {
      filtros.partida = e.target.value; guardarFiltros(); desenhar();
    });
    $("txtBusca").addEventListener("input", (e) => {
      filtros.busca = e.target.value.trim(); guardarFiltros(); redesenhar();
    });
    $("ckAnotados").addEventListener("change", (e) => {
      filtros.soTrabalho = e.target.checked; guardarFiltros(); desenhar();
    });
    $("btMostrarTudo").addEventListener("click", () => {
      filtros = { partida: "", busca: "", soTrabalho: false };
      $("ckAnotados").checked = false;
      $("txtBusca").value = "";
      guardarFiltros();
      desenhar();
    });

    // O analisador está na outra aba mexendo nos mesmos registros. Com uma anotação aberta
    // aqui, a notícia espera: refazer o quadro trocaria o textarea debaixo de quem escreve —
    // e fechar o editor relê tudo de qualquer forma.
    window.addEventListener("storage", (e) => {
      if (!e.key || !e.key.startsWith(CHAVE) || editando) return;
      esquecerFaltas();
      desenhar();
    });
    // voltar para esta aba é justamente o momento de reler o que faltava
    window.addEventListener("focus", () => {
      if (editando) return;
      esquecerFaltas();
      desenhar();
    });
    // uma anotação presa no atraso de 400 ms não pode morrer com a aba
    window.addEventListener("pagehide", gravarPendentes);

    desenhar();
  }

  ligar();
})();
