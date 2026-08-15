(() => {
  "use strict";

  // Medidas reais do campo do Lugo (espelham lugo4py/src/specs.py e o visualizador_campo.html).
  const MAX_X = 20000, MAX_Y = 10000, GOL_MIN_Y = 3500, GOL_MAX_Y = 6500;
  const RAIO_JOGADOR = 200;                 // PLAYER_SIZE / 2
  const RAZAO_CAMPO = MAX_X / MAX_Y;        // 2.0
  const LIM_MIN = -6000, LIM_MAX_X = MAX_X + 6000, LIM_MAX_Y = MAX_Y + 6000;
  // comum.js entra antes deste arquivo (ver index.html): dele saem as chaves do armazenamento,
  // a identidade de um lance e o vocabulário do quadro — tudo o que a página kanban.html
  // também lê, e que não pode divergir entre as duas.
  const {
    CHAVE, CHAVE_BIB, CHAVE_LATERAL, CHAVE_GUIA, CHAVE_BOT,
    chaveLance, fmtTempo, resumoTipos, agruparLances,
    ESTAGIOS, ESTAGIO_PADRAO, estagioDe, podarLances, lerEstado, lerBiblioteca, rotuloDe,
    comBanco, guardarRetrato, lerRetrato, apagarRetrato
  } = window.Analisador;
  const VERSAO = 1;
  const svgNS = "http://www.w3.org/2000/svg";

  const CORES = ["var(--eu)", "var(--adv)", "var(--atr)", "var(--bola)", "var(--outro)", "var(--res)"];
  const TIPOS_DOIS_PONTOS = new Set(["seta", "linha", "retangulo", "elipse"]);

  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);

  // ------------------------------------------------------------------ estado
  let vw = 0, vh = 0;                 // dimensoes nativas do video, em px
  let urlVideo = null;                // object URL vigente (precisa ser revogado)
  let impressao = null;               // chave do localStorage para o video atual
  let biblioteca = [];                // lista de videos guardados, na ordem do mais recente
  let editando = null;                // impressao do item com o editor de titulo aberto
  let guia = "videos";                // guia visivel na lateral: "videos" ou "lances"
  let lanceAberto = null;             // chave do lance com o editor de nota aberto
  let lanceMarcado = "";              // ultimo lance destacado, para nao mexer no DOM a cada quadro
  let lanceAlvo = null;               // lance pedido pelo link do quadro, esperando o video abrir
  const minis = new Map();            // impressao -> miniatura, para nao reler o banco
  let fonteAtual = null;              // { fonte, handle } do video que esta abrindo
  let aguardandoReabrir = null;       // item da lista que o usuario foi localizar no disco
  let fps = 30, fpsDetectado = null;
  let amostrasFps = [], ultimoMediaTime = null;

  let estado = novoEstado();
  let seq = 1;                        // gerador de id das anotacoes

  let ferramenta = "selecionar";
  let cor = CORES[0];
  let espessura = 120;
  let selecionado = null;             // id da anotacao selecionada

  let modoRecorte = false;
  let recorteAntes = null;            // copia para o botao Cancelar
  let arraste = null;                 // maquina de estado do ponteiro
  let previa = null;                  // anotacao ainda nao confirmada, desenhada por cima

  let pilhaDesfazer = [], pilhaRefazer = [];
  let pedidoRender = 0, assinatura = "";
  let temporizadorSalvar = 0, pendente = null;
  let entradaTexto = null;
  let importadoPendente = false;      // JSON importado antes de abrir o video
  let semCors = false;                // o video atual ja voltou a carregar sem crossorigin
  let jaAbriu = false;                // o video atual ja chegou a abrir ao menos uma vez

  // 'lances' guarda so o que o usuario escreveu, indexado pelo instante (ver chaveLance):
  // o lance em si nao e um registro, e o conjunto dos desenhos que dividem aquele instante.
  function novoEstado() {
    return { versao: VERSAO, video: null, recorte: null, tolPadrao: 0.5, anotacoes: [], lances: {} };
  }

  // ------------------------------------------------------ conversao de coordenadas
  // Campo: origem no canto INFERIOR esquerdo, y crescendo para CIMA.
  // Video: origem no canto SUPERIOR esquerdo, y crescendo para BAIXO.
  // Nao usamos transform="scale(1,-1)" no <g> (era o mais curto) porque isso espelharia
  // os rotulos de texto; convertemos na hora de desenhar, igual ao visualizador_campo.html.
  const RX = () => estado.recorte.fx * vw;
  const RY = () => estado.recorte.fy * vh;
  const RW = () => estado.recorte.fw * vw;
  const RH = () => estado.recorte.fh * vh;

  const cx = (x) => RX() + (x / MAX_X) * RW();
  const cy = (y) => RY() + (1 - y / MAX_Y) * RH();
  const paraCampoX = (px) => ((px - RX()) / RW()) * MAX_X;
  const paraCampoY = (py) => (1 - (py - RY()) / RH()) * MAX_Y;

  // px de video por unidade de campo (usa o eixo x; com a trava 2:1 os dois eixos batem)
  const esc = () => RW() / MAX_X;

  // px de video por px de tela: mantem alcas e linhas finas com espessura constante na tela
  function uTela() {
    const r = $("tela").getBoundingClientRect();
    return r.width > 0 ? vw / r.width : 1;
  }

  function pontoDoEvento(e) {
    const r = $("tela").getBoundingClientRect();
    if (!r.width || !r.height) return { x: 0, y: 0 };
    return { x: (e.clientX - r.left) / r.width * vw, y: (e.clientY - r.top) / r.height * vh };
  }

  function pontoCampo(e) {
    const p = pontoDoEvento(e);
    return [clamp(paraCampoX(p.x), LIM_MIN, LIM_MAX_X), clamp(paraCampoY(p.y), LIM_MIN, LIM_MAX_Y)];
  }

  // ------------------------------------------------------------------ helpers SVG
  function el(tag, attrs, pai) {
    const n = document.createElementNS(svgNS, tag);
    for (const k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) {
      n.setAttribute(k, attrs[k]);
    }
    if (pai) pai.appendChild(n);
    return n;
  }

  function seta(pai, x1, y1, x2, y2, cor, largura, tracejado, opacidade) {
    const dx = x2 - x1, dy = y2 - y1, m = Math.hypot(dx, dy);
    if (m < 0.5) return;
    el("line", { x1, y1, x2, y2, stroke: cor, "stroke-width": largura,
                 "stroke-dasharray": tracejado || null, "stroke-linecap": "round",
                 opacity: opacidade ?? 1 }, pai);
    // ponta: dimensionada pela largura do traco, nao pelo comprimento do vetor
    const ux = dx / m, uy = dy / m, L = largura * 4.5, A = 0.45;
    const px = x2 - ux * L, py = y2 - uy * L, nx = -uy * L * A, ny = ux * L * A;
    el("polygon", { points: `${x2},${y2} ${px + nx},${py + ny} ${px - nx},${py - ny}`,
                    fill: cor, opacity: opacidade ?? 1 }, pai);
  }

  const fmtTol = (tol) => isFinite(tol) ? `±${String(tol).replace(".", ",")} s` : "sempre";

  // o nome do arquivo vem do disco do usuario e entra em innerHTML; escapamos por higiene
  const escapar = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // ------------------------------------------------------------------ video
  function carregarVideoPorFonte(fonte, handle) {
    if (!fonte || !fonte.src) return;
    salvarPendente();                   // grava o video que sai antes de a chave mudar
    $("menuAdd").open = false;          // o menu de adicionar ja cumpriu o papel dele
    if (urlVideo) URL.revokeObjectURL(urlVideo);
    urlVideo = fonte.revogavel ? fonte.src : null;
    impressao = fonte.impressao;
    fonteAtual = { fonte, handle: handle || null };

    // Um JSON importado antes de abrir o video vence o que estiver salvo no navegador;
    // fora esse caso, trocar de video NAO carrega as anotacoes do video anterior.
    const usarImportado = importadoPendente;
    importadoPendente = false;
    const salvo = lerSalvo(impressao);
    if (usarImportado) {
      nota(`Anotações importadas mantidas sobre "${fonte.nome}".`);
    } else if (salvo) {
      estado = salvo;
      nota(`${estado.anotacoes.length} anotação(ões) restaurada(s) do navegador.`);
    } else {
      estado = novoEstado();
      nota(`"${fonte.nome}" carregado.`);
    }
    estado.video = fonte.videoInfo;
    seq = estado.anotacoes.reduce((m, a) => Math.max(m, a.id), 0) + 1;
    selecionado = null;
    lanceAberto = null; lanceMarcado = "";
    pilhaDesfazer = []; pilhaRefazer = [];

    $("selTol").value = String(estado.tolPadrao);
    const v = $("video");
    // 'anonymous' é o que mantém o canvas limpo e permite tirar o retrato do lance. Se o
    // servidor do vídeo não mandar Access-Control-Allow-Origin o navegador recusa o arquivo —
    // e aí o ouvinte de erro tenta de novo sem o atributo (ver ligar()): o vídeo abre igual,
    // só fica sem retrato. Arquivo do disco chega por blob:, mesma origem, e não precisa disso.
    semCors = false;
    jaAbriu = false;
    v.crossOrigin = fonte.revogavel ? null : "anonymous";
    v.src = fonte.src;
    v.load();
  }

  function carregarVideo(arq, handle) {
    if (!arq) return;
    const imp = `${arq.name}|${arq.size}|${arq.lastModified}`;
    const esperado = aguardandoReabrir;
    aguardandoReabrir = null;
    carregarVideoPorFonte({
      src: URL.createObjectURL(arq),
      revogavel: true,
      nome: arq.name,
      impressao: imp,
      videoInfo: { nome: arq.name, tamanho: arq.size, modificado: arq.lastModified, origem: "arquivo" }
    }, handle);
    // a impressao digital e o que liga o arquivo as anotacoes: se ela nao bate, o usuario
    // escolheu outro arquivo (ou o mesmo video reexportado) e vai abrir um caderno em branco
    if (esperado && esperado.imp !== imp) {
      nota(`"${arq.name}" não é o arquivo que estava na lista — as anotações guardadas continuam com o original.`, true);
    }
  }

  // 'extra' é o que a busca de partidas sabe e a URL não conta: um rótulo legível, uma linha
  // de contexto e o aviso de que o vídeo é passageiro (não entra sozinho na lista).
  function carregarVideoUrl(url, extra) {
    const limpa = String(url || "").trim();
    if (!limpa) return nota("Informe um link de vídeo válido.", true);
    try { new URL(limpa); } catch (_) { return nota("O link do vídeo não parece ser uma URL válida.", true); }
    carregarVideoPorFonte({
      src: limpa,
      revogavel: false,
      nome: (extra && extra.titulo) || limpa,
      titulo: (extra && extra.titulo) || "",
      descricao: (extra && extra.descricao) || "",
      temporario: !!(extra && extra.temporario),
      impressao: `url|${limpa}`,
      videoInfo: { nome: limpa, url: limpa, origem: "url" }
    });
  }

  // O palco e absoluto dentro da area do video, entao o tamanho dele nao realimenta o
  // layout e da para caber a imagem inteira sem barra de rolagem. A razao TEM de ser a
  // nativa do video: o SVG por cima usa preserveAspectRatio="none" e sairia esticado em
  // relacao a imagem se a caixa fosse achatada.
  function ajustarPalco() {
    if (!vw || !vh) return;
    const c = $("grade").getBoundingClientRect();
    if (!c.width || !c.height) return;
    let w = c.width, h = w * vh / vw;
    if (h > c.height) { h = c.height; w = h * vw / vh; }
    $("palco").style.width = `${w}px`;
    $("palco").style.height = `${h}px`;
  }

  function aoCarregarMetadados() {
    const v = $("video");
    jaAbriu = true;                     // daqui em diante, erro é erro (ver o ouvinte de 'error')
    vw = v.videoWidth || 1280;
    vh = v.videoHeight || 720;
    $("tela").setAttribute("viewBox", `0 0 ${vw} ${vh}`);

    estado.video.duracao = v.duration;
    estado.video.largura = vw;
    estado.video.altura = vh;

    $("slTempo").max = String(isFinite(v.duration) ? v.duration : 0);
    $("slTempo").value = "0";
    $("vazio").hidden = true;
    $("painelTempo").hidden = false;
    $("selInfo").hidden = false;        // a partir daqui ela nunca mais sai do fluxo
    $("painelRecorte").hidden = false;
    $("grade").hidden = false;
    $("btExportar").disabled = false;
    ajustarPalco();                     // so depois de a area sair do hidden e ter tamanho

    amostrasFps = []; ultimoMediaTime = null; fpsDetectado = null;
    // uma partida aberta pela busca é passageira: entra na lista só pelo + sobre o palco
    if (fonteAtual && !fonteAtual.fonte.temporario) lembrarVideo();
    marcarPartidas();     // a partida passageira não passa pela lista, mas é a que está aberta
    aplicarFps();
    atualizarRecorteUI();
    atualizarPainel();
    agendarRender();

    // o vídeo que o quadro de correções pediu acabou de abrir: vai direto ao lance
    if (lanceAlvo && lanceAlvo.imp === impressao) {
      const alvo = lanceAlvo;
      lanceAlvo = null;
      $("convite").hidden = true;
      alternarLateral(true);
      escolherGuia("lances");
      irLance(alvo.chave, alvo.t);
    }
  }

  // Descobre os quadros/s medindo os deltas de mediaTime; so funciona onde
  // requestVideoFrameCallback existe (Chrome/Edge/Safari). Firefox fica no valor do select.
  function amostrarFps(_, meta) {
    const v = $("video");
    if (typeof v.requestVideoFrameCallback !== "function") return;
    if (ultimoMediaTime !== null) {
      const d = meta.mediaTime - ultimoMediaTime;
      if (d > 0.002 && d < 0.2) amostrasFps.push(d);
    }
    ultimoMediaTime = meta.mediaTime;
    if (amostrasFps.length >= 12 && fpsDetectado === null) {
      const ord = amostrasFps.slice().sort((a, b) => a - b);
      const mediana = ord[ord.length >> 1];
      const bruto = 1 / mediana;
      const opcoes = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
      fpsDetectado = opcoes.reduce((m, o) => Math.abs(o - bruto) < Math.abs(m - bruto) ? o : m, opcoes[0]);
      aplicarFps();
    }
    if (!v.paused) v.requestVideoFrameCallback(amostrarFps);
    agendarRender();
  }

  function aplicarFps() {
    const escolha = $("selFps").value;
    fps = escolha === "auto" ? (fpsDetectado || 30) : Number(escolha);
    $("slTempo").step = String(1 / fps);
    $("lbFps").textContent = escolha === "auto"
      ? (fpsDetectado ? `detectado: ${fpsDetectado}` : "medindo ao tocar… (usando 30)")
      : "";
    atualizarRelogio();
  }

  function irPara(t) {
    const v = $("video");
    if (!isFinite(v.duration)) return;
    v.currentTime = clamp(t, 0, Math.max(0, v.duration - 1e-4));
  }

  function passoQuadro(n) {
    const v = $("video");
    v.pause();
    // +1e-3 para cair com folga DENTRO do quadro alvo, e nao na fronteira dele
    irPara((Math.round(v.currentTime * fps) + n) / fps + 1e-3);
  }

  function atualizarRelogio() {
    const v = $("video");
    const t = v.currentTime || 0;
    $("relogio").textContent = `${fmtTempo(t)}  ·  q${Math.round(t * fps)}`;
    if (document.activeElement !== $("slTempo")) $("slTempo").value = String(t);
    $("btPlay").textContent = v.paused ? "▶" : "⏸";
    marcarLanceAtual();
  }

  // ------------------------------------------------------------------ recorte
  function entrarRecorte() {
    modoRecorte = true;
    recorteAntes = estado.recorte ? { ...estado.recorte } : null;
    $("video").pause();
    if (!estado.recorte) {
      // um retangulo inicial centrado, ja em 2:1, so para ter o que arrastar
      let larg = 0.9 * vw, alt = larg / RAZAO_CAMPO;
      if (alt > 0.9 * vh) { alt = 0.9 * vh; larg = alt * RAZAO_CAMPO; }
      const fw = larg / vw, fh = alt / vh;
      estado.recorte = { fx: (1 - fw) / 2, fy: (1 - fh) / 2, fw, fh };
    }
    atualizarRecorteUI();
    agendarRender();
  }

  function sairRecorte(confirmar) {
    if (!confirmar) estado.recorte = recorteAntes;
    modoRecorte = false;
    recorteAntes = null;
    if (confirmar) salvar();
    atualizarRecorteUI();
    agendarRender();
  }

  function atualizarRecorteUI() {
    const tem = !!estado.recorte;
    // enquanto falta o recorte nada mais funciona, entao a barra dele ganha destaque;
    // depois de definido ela encolhe e sai do caminho
    $("painelRecorte").classList.toggle("chamada", !tem);
    $("btRecortar").hidden = modoRecorte;
    $("btConfirmar").hidden = !modoRecorte;
    $("btCancelarRec").hidden = !modoRecorte;
    $("btRecortar").textContent = tem ? "Reajustar recorte do campo" : "Definir recorte do campo";
    $("dicaRecorte").hidden = !modoRecorte;
    $("painelFerr").hidden = !tem;
    $("tela").classList.toggle("recortando", modoRecorte);

    const s = $("statusRecorte");
    if (!tem) {
      s.textContent = "Sem recorte: desenhe o retângulo do campo para liberar as ferramentas.";
      s.className = "rot";
      return;
    }
    const razao = (estado.recorte.fw * vw) / (estado.recorte.fh * vh);
    const desvio = Math.abs(razao - RAZAO_CAMPO) / RAZAO_CAMPO;
    s.textContent = `proporção ${razao.toFixed(3)} : 1` +
      (desvio > 0.01 ? "  ⚠ o campo é 2,000 : 1 — as distâncias saem distorcidas" : "  ✓ bate com o campo");
    s.className = desvio > 0.01 ? "rot aviso" : "rot bom";
  }

  // Aplica a trava 2:1 a um retangulo em px de video, ancorando no canto indicado.
  function travar(r, ancora) {
    if (!$("ckTrava").checked) return r;
    let { x, y, w, h } = r;
    const alvo = RAZAO_CAMPO;
    if (ancora === "livre" || ancora === "canto") {
      const lado = Math.max(Math.abs(w), Math.abs(h) * alvo);
      const nw = Math.sign(w || 1) * lado, nh = Math.sign(h || 1) * (lado / alvo);
      if (ancora === "canto") { x += w - nw; y += h - nh; }
      w = nw; h = nh;
    } else if (ancora === "vertical") {
      const nw = Math.sign(w || 1) * Math.abs(h) * alvo;
      x += (w - nw) / 2; w = nw;
    } else {
      const nh = Math.sign(h || 1) * Math.abs(w) / alvo;
      y += (h - nh) / 2; h = nh;
    }
    return { x, y, w, h };
  }

  function gravarRecorte(x, y, w, h) {
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    estado.recorte = {
      fx: x / vw, fy: y / vh,
      fw: Math.max(20, w) / vw, fh: Math.max(10, h) / vh
    };
    atualizarRecorteUI();
  }

  const ALCAS = [
    ["nw", 0, 0], ["n", 0.5, 0], ["ne", 1, 0], ["e", 1, 0.5],
    ["se", 1, 1], ["s", 0.5, 1], ["sw", 0, 1], ["w", 0, 0.5]
  ];

  function desenharRecorte() {
    const g = $("gRecorte");
    g.textContent = "";
    g.style.pointerEvents = modoRecorte ? "auto" : "none";
    if (!estado.recorte || !modoRecorte) return;

    const x = RX(), y = RY(), w = RW(), h = RH(), u = uTela();
    // veu escuro em volta do recorte, com o miolo recortado pela regra evenodd
    el("path", {
      d: `M0,0 H${vw} V${vh} H0 Z M${x},${y} H${x + w} V${y + h} H${x} Z`,
      "fill-rule": "evenodd", fill: "#000", opacity: 0.45, "pointer-events": "none"
    }, g);
    el("rect", { x, y, width: w, height: h, fill: "transparent",
                 stroke: "var(--eu)", "stroke-width": 1.5 * u, "data-alca": "mover",
                 style: "cursor:move" }, g);
    for (const [nome, ax, ay] of ALCAS) {
      const s = 9 * u;
      el("rect", { x: x + w * ax - s / 2, y: y + h * ay - s / 2, width: s, height: s,
                   fill: "var(--eu)", stroke: "#fff", "stroke-width": 1.2 * u,
                   "data-alca": nome, style: `cursor:${nome}-resize` }, g);
    }
  }

  // ------------------------------------------------------------------ campo sobreposto
  function desenharCampo() {
    const g = $("gCampo");
    g.textContent = "";
    g.style.pointerEvents = "none";
    if (!estado.recorte || !$("ckGrade").checked) return;

    const u = uTela(), fina = 1.6 * u;
    const linha = (x1, y1, x2, y2, larg) => el("line", {
      x1: cx(x1), y1: cy(y1), x2: cx(x2), y2: cy(y2),
      stroke: "var(--linha-campo)", "stroke-width": larg || fina, "stroke-linecap": "butt"
    }, g);

    el("rect", { x: cx(0), y: cy(MAX_Y), width: RW(), height: RH(), fill: "none",
                 stroke: "var(--linha-campo)", "stroke-width": fina }, g);
    linha(MAX_X / 2, 0, MAX_X / 2, MAX_Y);
    el("ellipse", { cx: cx(MAX_X / 2), cy: cy(MAX_Y / 2),
                    rx: 1000 * esc(), ry: 1000 * (RH() / MAX_Y), fill: "none",
                    stroke: "var(--linha-campo)", "stroke-width": fina }, g);
    for (const x of [0, MAX_X]) linha(x, GOL_MIN_Y, x, GOL_MAX_Y, 4.5 * u);
    el("text", { x: cx(0) + 6 * u, y: cy(0) - 6 * u, fill: "var(--linha-campo)",
                 "font-size": 13 * u, "font-family": "ui-monospace, Consolas, monospace" },
       g).textContent = "(0,0)";
  }

  // ------------------------------------------------------------------ anotacoes
  const tolDe = (a) => (a.tol === null || a.tol === undefined) ? estado.tolPadrao : a.tol;

  // Visivel na janela [t-tol, t+tol], com um fade nos ultimos 30% para nao piscar.
  function opacidadeEm(a, t) {
    const tol = tolDe(a);
    if (!isFinite(tol)) return 1;
    const d = Math.abs(t - a.t);
    if (d > tol) return 0;
    const inicioFade = tol * 0.7;
    if (d <= inicioFade || tol <= 0) return 1;
    return 1 - 0.85 * ((d - inicioFade) / (tol - inicioFade));
  }

  // ------------------------------------------------------------------ rotulos de texto
  // O texto e uma <div> sobre o video, nao um <text> dentro do SVG: a fonte sai identica
  // a do resto da pagina (sem passar pela escala do viewBox) e da para medir a largura real
  // da frase, o que deixa a caixa de selecao e a area de clique coladas no que se ve.
  const medidas = new Map();            // id -> { chave, wpx, hpx } em px de video

  const escY = () => RH() / MAX_Y;      // px de video por unidade de campo no eixo y
  const fontePx = (a) => Math.max(7, a.esp * esc() / uTela());   // corpo da fonte em px de tela

  // No texto o campo 'esp' guarda o corpo da fonte, e nao a espessura do traco: a mesma
  // barra do painel serve aos dois, so que aqui multiplicada, senao a letra sairia ilegivel.
  const CORPO_MIN = 120, CORPO_MAX = 4000;
  const corpoTexto = (esp) => clamp(esp * 3, 300, CORPO_MAX);

  function sincronizarRotulo(a, op, vivos) {
    const camada = $("camadaTexto");
    let d = camada.querySelector(`[data-rotulo="${a.id}"]`);
    if (!d) {
      d = document.createElement("div");
      d.className = "rotulo";
      d.setAttribute("data-rotulo", a.id);
      camada.appendChild(d);
    }
    if (vivos) vivos.add(String(a.id));

    const fpx = fontePx(a);
    if (d.textContent !== (a.texto || "")) d.textContent = a.texto || "";
    d.style.color = a.cor;
    d.style.fontSize = `${fpx}px`;
    d.style.left = `${(cx(a.pts[0][0]) / vw) * 100}%`;
    d.style.top = `${(cy(a.pts[0][1]) / vh) * 100}%`;
    d.style.opacity = op;

    // medir custa um layout sincrono, entao so refazemos quando a frase ou o corpo mudam
    const chave = `${a.texto}|${fpx.toFixed(2)}`;
    const m = medidas.get(a.id);
    if (!m || m.chave !== chave) {
      const u = uTela();                // px de tela -> px de video
      medidas.set(a.id, { chave, wpx: d.offsetWidth * u, hpx: d.offsetHeight * u });
    }
    return medidas.get(a.id);
  }

  function limparRotulos(vivos) {
    for (const d of [...$("camadaTexto").children]) {
      const id = d.getAttribute("data-rotulo");
      if (vivos.has(id)) continue;
      medidas.delete(Number(id));
      d.remove();
    }
  }

  function caixa(a) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of a.pts) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    if (a.tipo === "jogador") { x0 -= RAIO_JOGADOR; y0 -= RAIO_JOGADOR; x1 += RAIO_JOGADOR; y1 += RAIO_JOGADOR; }
    if (a.tipo === "texto") {
      // a medida real da div; o palpite so vale no quadro anterior a primeira medicao
      const m = medidas.get(a.id);
      const w = m ? m.wpx / esc() : a.esp * 3;
      const h = m ? m.hpx / escY() : a.esp * 1.4;
      x0 -= w / 2; x1 += w / 2; y0 -= h / 2; y1 += h / 2;
    }
    return { x0, y0, x1, y1 };
  }

  function desenharAnotacao(pai, a, op, vivos) {
    const g = el("g", { "data-id": a.id, opacity: op }, pai);
    const larg = Math.max(0.6, a.esp * esc());
    const P = a.pts.map(([x, y]) => [cx(x), cy(y)]);
    const preench = a.preench ? a.cor : "none";

    switch (a.tipo) {
      case "seta":
        seta(g, P[0][0], P[0][1], P[1][0], P[1][1], a.cor, larg, null, 1);
        break;
      case "linha":
        el("line", { x1: P[0][0], y1: P[0][1], x2: P[1][0], y2: P[1][1], stroke: a.cor,
                     "stroke-width": larg, "stroke-linecap": "round" }, g);
        break;
      case "livre":
        el("polyline", { points: P.map(p => p.join(",")).join(" "), fill: "none", stroke: a.cor,
                         "stroke-width": larg, "stroke-linecap": "round", "stroke-linejoin": "round" }, g);
        break;
      case "zona":
        el("polygon", { points: P.map(p => p.join(",")).join(" "), fill: a.cor, "fill-opacity": 0.18,
                        stroke: a.cor, "stroke-width": larg, "stroke-linejoin": "round" }, g);
        break;
      case "retangulo":
        el("rect", { x: Math.min(P[0][0], P[1][0]), y: Math.min(P[0][1], P[1][1]),
                     width: Math.abs(P[1][0] - P[0][0]), height: Math.abs(P[1][1] - P[0][1]),
                     fill: preench, "fill-opacity": a.preench ? 0.18 : 1,
                     stroke: a.cor, "stroke-width": larg }, g);
        break;
      case "elipse":
        el("ellipse", { cx: (P[0][0] + P[1][0]) / 2, cy: (P[0][1] + P[1][1]) / 2,
                        rx: Math.abs(P[1][0] - P[0][0]) / 2, ry: Math.abs(P[1][1] - P[0][1]) / 2,
                        fill: preench, "fill-opacity": a.preench ? 0.18 : 1,
                        stroke: a.cor, "stroke-width": larg }, g);
        break;
      case "texto": {
        // em 'texto', esp E o corpo da fonte em unidades de campo.
        // O glifo mora na camada HTML; aqui fica so o alvo de clique, do tamanho medido.
        const m = sincronizarRotulo(a, op, vivos);
        const mini = 10 * uTela();
        const w = Math.max(m.wpx, mini), h = Math.max(m.hpx, mini);
        el("rect", { x: P[0][0] - w / 2, y: P[0][1] - h / 2, width: w, height: h,
                     fill: "transparent", "pointer-events": "all" }, g);
        break;
      }
      case "jogador": {
        const r = RAIO_JOGADOR * esc();
        el("circle", { cx: P[0][0], cy: P[0][1], r, fill: a.cor, "fill-opacity": 0.9,
                       stroke: "#fff", "stroke-width": Math.max(1, r * 0.12) }, g);
        el("text", { x: P[0][0], y: P[0][1], fill: "#fff", "font-size": r * 1.15,
                     "font-family": "ui-sans-serif, system-ui, sans-serif", "font-weight": 700,
                     "text-anchor": "middle", "dominant-baseline": "central" },
           g).textContent = String(a.numero ?? "");
        break;
      }
    }

    // area de clique generosa para as formas de traco fino
    if (["seta", "linha", "livre", "zona"].includes(a.tipo)) {
      const alvo = Math.max(larg, 12 * uTela());
      const tag = a.tipo === "zona" ? "polygon" : (a.tipo === "livre" ? "polyline" : "line");
      const at = { stroke: "transparent", "stroke-width": alvo, fill: "none", "pointer-events": "stroke" };
      if (tag === "line") { at.x1 = P[0][0]; at.y1 = P[0][1]; at.x2 = P[1][0]; at.y2 = P[1][1]; }
      else at.points = P.map(p => p.join(",")).join(" ");
      el(tag, at, g);
    }
    return g;
  }

  function desenharSelecao(pai, a) {
    const u = uTela(), c = caixa(a);
    const x0 = cx(c.x0), x1 = cx(c.x1), y0 = cy(c.y1), y1 = cy(c.y0);   // cy inverte
    el("rect", { x: x0 - 3 * u, y: y0 - 3 * u, width: (x1 - x0) + 6 * u, height: (y1 - y0) + 6 * u,
                 fill: "none", stroke: "var(--eu)", "stroke-width": 1.4 * u,
                 "stroke-dasharray": `${5 * u},${4 * u}`, "pointer-events": "none" }, pai);

    if (a.tipo === "texto") {
      // alca no canto inferior direito: arrastar para fora aumenta o corpo da fonte
      const s = 11 * u;
      el("rect", { x: x1 + 3 * u - s / 2, y: y1 + 3 * u - s / 2, width: s, height: s, rx: s / 4,
                   fill: "var(--eu)", stroke: "#fff", "stroke-width": 1.2 * u,
                   "data-escala": a.id, style: "cursor:nwse-resize" }, pai);
      return;
    }

    if (!TIPOS_DOIS_PONTOS.has(a.tipo)) return;
    a.pts.forEach(([x, y], i) => {
      const s = 9 * u;
      el("rect", { x: cx(x) - s / 2, y: cy(y) - s / 2, width: s, height: s,
                   fill: "var(--painel)", stroke: "var(--eu)", "stroke-width": 1.4 * u,
                   "data-vertice": i, style: "cursor:pointer" }, pai);
    });
  }

  // ------------------------------------------------------------------ render
  function agendarRender() {
    if (pedidoRender) return;
    pedidoRender = requestAnimationFrame(() => { pedidoRender = 0; render(); });
  }

  function render() {
    atualizarRelogio();
    if (!vw) return;
    desenharCampo();
    desenharRecorte();

    const g = $("gAnot");
    g.style.pointerEvents = (ferramenta === "selecionar" && !modoRecorte) ? "auto" : "none";
    if (!estado.recorte) { g.textContent = ""; limparRotulos(new Set()); assinatura = ""; return; }

    const t = $("video").currentTime || 0;
    const visiveis = [];
    for (const a of estado.anotacoes) {
      const op = opacidadeEm(a, t);
      if (op > 0.02) visiveis.push([a, op]);
    }
    const nova = visiveis.map(([a, op]) => `${a.id}:${op.toFixed(2)}`).join("|") +
                 `#${selecionado}#${previa ? "p" : ""}#${modoRecorte}#${Math.round(RW())}`;
    if (nova === assinatura && !previa) return;
    assinatura = nova;

    g.textContent = "";
    const vivos = new Set();
    for (const [a, op] of visiveis) desenharAnotacao(g, a, op, vivos);
    if (previa) desenharAnotacao(g, previa, 0.75, vivos);
    limparRotulos(vivos);               // some com as divs de texto que sairam de cena
    const sel = estado.anotacoes.find(a => a.id === selecionado);
    if (sel && opacidadeEm(sel, t) > 0.02) desenharSelecao(g, sel);
  }

  // ------------------------------------------------------------------ ferramentas
  // Atalhos: o numero na ordem da barra ou a inicial do nome. 'linha' e 'livre' brigam pelo
  // L, entao a mao livre fica com o M de "mao"; 'selecionar' cede o S para 'seta' e fica
  // com o V, como na maioria dos editores.
  const ATALHOS = {
    "1": "selecionar", v: "selecionar",
    "2": "seta",       s: "seta",
    "3": "linha",      l: "linha",
    "4": "livre",      m: "livre",
    "5": "retangulo",  r: "retangulo",
    "6": "elipse",     e: "elipse",
    "7": "zona",       z: "zona",
    "8": "texto",      t: "texto",
    "9": "jogador",    j: "jogador"
  };

  function escolherFerramenta(nome) {
    ferramenta = nome;
    for (const b of $("barraFerr").children) {
      b.classList.toggle("ativa", b.getAttribute("data-ferr") === nome);
    }
    $("tela").classList.toggle("desenhando", nome !== "selecionar");
    // opcoes que so valem para uma ferramenta ficam fora do caminho das outras
    $("campoPreench").hidden = nome !== "retangulo" && nome !== "elipse";
    $("campoNum").hidden = nome !== "jogador";
    if (nome !== "selecionar") selecionado = null;
    atualizarSelecao();
    assinatura = ""; agendarRender();
  }

  // Toda ferramenta e de um uso so: assim que a anotacao entra, a mao volta para a seta.
  // Como 'inserir' ja deixa a nova anotacao selecionada, ela sai pronta para mover ou apagar.
  const voltarParaSelecao = () => escolherFerramenta("selecionar");

  // ------------------------------------------------------------------ ponteiro
  function aoPressionar(e) {
    if (e.button !== 0) return;
    // clicar fora confirma o texto que estava sendo digitado; esse clique se esgota nisso,
    // senao ele ainda cairia na ferramenta seguinte e desfaria a selecao do texto recem-criado
    if (fecharEntradaTexto(false)) { e.preventDefault(); return; }
    const tela = $("tela");

    if (modoRecorte) {
      const alca = e.target.getAttribute && e.target.getAttribute("data-alca");
      const p = pontoDoEvento(e);
      if (alca === "mover") {
        arraste = { tipo: "rec-mover", p, base: { x: RX(), y: RY(), w: RW(), h: RH() } };
      } else if (alca) {
        arraste = { tipo: "rec-alca", alca, base: { x: RX(), y: RY(), w: RW(), h: RH() } };
      } else {
        arraste = { tipo: "rec-novo", p };
      }
      tela.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    if (!estado.recorte) return;

    if (ferramenta === "selecionar") {
      const pega = e.target.getAttribute ? e.target.getAttribute("data-escala") : null;
      const vert = e.target.getAttribute && e.target.getAttribute("data-vertice");
      if (pega !== null && pega !== undefined) {
        const a = estado.anotacoes.find(q => q.id === Number(pega));
        // a escala e a razao entre a distancia atual e a inicial ate o centro do texto
        const p = pontoCampo(e);
        const d0 = a ? Math.hypot(p[0] - a.pts[0][0], p[1] - a.pts[0][1]) : 0;
        if (a) arraste = { tipo: "escala", id: a.id, esp: a.esp, d0: Math.max(d0, 30) };
      } else if (vert !== null && vert !== undefined && selecionado !== null) {
        arraste = { tipo: "vertice", i: Number(vert), id: selecionado };
      } else {
        const alvo = e.target.closest ? e.target.closest("[data-id]") : null;
        const id = alvo ? Number(alvo.getAttribute("data-id")) : null;
        selecionado = id;
        atualizarPainel();
        if (id !== null) {
          const a = estado.anotacoes.find(q => q.id === id);
          arraste = { tipo: "mover", id, p: pontoCampo(e), orig: a.pts.map(q => q.slice()) };
        }
      }
      tela.setPointerCapture(e.pointerId);
      agendarRender();
      e.preventDefault();
      return;
    }

    // ferramentas de desenho: sempre pausam antes de comecar
    $("video").pause();
    const t = $("video").currentTime;
    const p = pontoCampo(e);

    if (ferramenta === "texto") {
      // preventDefault ANTES de abrir: sem isso a acao padrao do pointerdown tira o foco
      // do input recem-criado, o blur dispara e o campo some antes de dar para digitar
      e.preventDefault();
      abrirEntradaTexto(e, p, t);
      return;
    }

    if (ferramenta === "jogador") {
      const n = Number($("numJogador").value) || 0;
      empilhar();
      inserir({ tipo: "jogador", pts: [p], numero: n, esp: espessura, t });
      $("numJogador").value = String(clamp(n + 1, 0, 99));
      voltarParaSelecao();
      return;
    }

    previa = {
      id: -1, t, tol: tolAtual(), tipo: ferramenta, cor, esp: espessura,
      preench: $("ckPreench").checked, pts: [p, p]
    };
    if (ferramenta === "livre" || ferramenta === "zona") previa.pts = [p];
    arraste = { tipo: "novo" };
    tela.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function aoMover(e) {
    if (estado.recorte && !modoRecorte) {
      const p = pontoCampo(e);
      const extra = previa && (previa.tipo === "seta" || previa.tipo === "linha")
        ? `  ·  ${Math.round(Math.hypot(previa.pts[1][0] - previa.pts[0][0], previa.pts[1][1] - previa.pts[0][1]))} u`
        : "";
      $("lbRegua").textContent = `campo (${Math.round(p[0])}, ${Math.round(p[1])})${extra}`;
    }
    if (!arraste) return;

    if (arraste.tipo === "rec-novo") {
      const p = pontoDoEvento(e);
      const r = travar({ x: arraste.p.x, y: arraste.p.y, w: p.x - arraste.p.x, h: p.y - arraste.p.y }, "livre");
      gravarRecorte(r.x, r.y, r.w, r.h);
    } else if (arraste.tipo === "rec-mover") {
      const p = pontoDoEvento(e), b = arraste.base;
      gravarRecorte(b.x + (p.x - arraste.p.x), b.y + (p.y - arraste.p.y), b.w, b.h);
    } else if (arraste.tipo === "rec-alca") {
      redimensionarRecorte(e);
    } else if (arraste.tipo === "novo") {
      const p = pontoCampo(e);
      if (previa.tipo === "livre" || previa.tipo === "zona") {
        const ult = previa.pts[previa.pts.length - 1];
        if (Math.hypot(p[0] - ult[0], p[1] - ult[1]) > 25) previa.pts.push(p);
      } else {
        previa.pts[1] = p;
      }
    } else if (arraste.tipo === "escala") {
      const a = estado.anotacoes.find(q => q.id === arraste.id);
      if (!a) return;
      if (!arraste.empilhado) { arraste.empilhado = true; empilhar(); }
      const p = pontoCampo(e);
      const d = Math.hypot(p[0] - a.pts[0][0], p[1] - a.pts[0][1]);
      a.esp = clamp(arraste.esp * (d / arraste.d0), CORPO_MIN, CORPO_MAX);
      atualizarRotuloEsp();
    } else if (arraste.tipo === "mover" || arraste.tipo === "vertice") {
      const a = estado.anotacoes.find(q => q.id === arraste.id);
      if (!a) return;
      // so empilha no primeiro movimento de verdade: um clique simples nao suja o histórico
      if (!arraste.empilhado) { arraste.empilhado = true; empilhar(); }
      if (arraste.tipo === "mover") {
        const p = pontoCampo(e), dx = p[0] - arraste.p[0], dy = p[1] - arraste.p[1];
        a.pts = arraste.orig.map(([x, y]) => [x + dx, y + dy]);
      } else {
        a.pts[arraste.i] = pontoCampo(e);
      }
    }
    assinatura = "";
    agendarRender();
  }

  function aoSoltar(e) {
    if (!arraste) return;
    const tipo = arraste.tipo;
    arraste = null;
    try { $("tela").releasePointerCapture(e.pointerId); } catch (_) {}

    if (tipo === "novo" && previa) {
      const p = previa; previa = null;
      const pequena = p.pts.length < 2 ||
        (TIPOS_DOIS_PONTOS.has(p.tipo) && Math.hypot(p.pts[1][0] - p.pts[0][0], p.pts[1][1] - p.pts[0][1]) < 120);
      if (!pequena) {
        if (p.tipo === "livre" || p.tipo === "zona") p.pts = simplificar(p.pts, 60);
        // um risco curto demais e descartado: nesse caso a ferramenta continua na mao
        if (p.pts.length >= 2) { empilhar(); inserir(p); voltarParaSelecao(); }
      }
    }
    if (tipo === "rec-novo" || tipo === "rec-mover" || tipo === "rec-alca") atualizarRecorteUI();
    if (tipo === "mover" || tipo === "vertice" || tipo === "escala") {
      salvar(); atualizarPainel();
      const a = estado.anotacoes.find(q => q.id === selecionado);
      if (a) tirarRetrato(a.t);         // o desenho mudou de lugar: a foto do lance mudou
    }
    assinatura = "";
    agendarRender();
  }

  function redimensionarRecorte(e) {
    const p = pontoDoEvento(e), b = arraste.base, a = arraste.alca;
    let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
    if (a.includes("w")) x0 = p.x;
    if (a.includes("e")) x1 = p.x;
    if (a.includes("n")) y0 = p.y;
    if (a.includes("s")) y1 = p.y;

    let r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    if ($("ckTrava").checked) {
      const so = (a === "n" || a === "s") ? "vertical" : (a === "e" || a === "w") ? "horizontal" : "canto";
      if (so === "canto") {
        // o canto oposto ao que esta sendo puxado fica parado
        const ancoraX = a.includes("w") ? x1 : x0, ancoraY = a.includes("n") ? y1 : y0;
        const lado = Math.max(Math.abs(r.w), Math.abs(r.h) * RAZAO_CAMPO);
        const sw = (a.includes("w") ? -1 : 1), sh = (a.includes("n") ? -1 : 1);
        r = { x: ancoraX, y: ancoraY, w: sw * lado, h: sh * (lado / RAZAO_CAMPO) };
      } else if (so === "vertical") {
        r = travar(r, "vertical");
      } else {
        r = travar(r, "horizontal");
      }
    }
    gravarRecorte(r.x, r.y, r.w, r.h);
  }

  // Ramer-Douglas-Peucker: um traco a mao livre chega com centenas de pontos.
  function simplificar(pts, tol) {
    if (pts.length < 3) return pts.slice();
    const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
    const dx = bx - ax, dy = by - ay, m = Math.hypot(dx, dy);
    let iMax = 0, dMax = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const [px, py] = pts[i];
      const d = m < 1e-9 ? Math.hypot(px - ax, py - ay)
                         : Math.abs(dy * px - dx * py + bx * ay - by * ax) / m;
      if (d > dMax) { dMax = d; iMax = i; }
    }
    if (dMax <= tol) return [pts[0], pts[pts.length - 1]];
    return simplificar(pts.slice(0, iMax + 1), tol).slice(0, -1)
           .concat(simplificar(pts.slice(iMax), tol));
  }

  // ------------------------------------------------------------------ texto flutuante
  function abrirEntradaTexto(e, p, t) {
    fecharEntradaTexto(true);
    const palco = $("palco"), r = palco.getBoundingClientRect();
    const inp = document.createElement("input");
    inp.type = "text";
    inp.id = "entradaTexto";
    inp.placeholder = "texto e Enter";
    inp.autocomplete = "off";
    inp.style.left = `${clamp(e.clientX - r.left, 0, Math.max(0, r.width - 160))}px`;
    inp.style.top = `${clamp(e.clientY - r.top, 0, Math.max(0, r.height - 32))}px`;
    inp.style.color = cor;              // digitando ja se ve a cor que o rotulo vai ter
    palco.appendChild(inp);
    entradaTexto = { inp, p, t };
    inp.focus();

    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); fecharEntradaTexto(false); }
      if (ev.key === "Escape") { ev.preventDefault(); fecharEntradaTexto(true); }
      ev.stopPropagation();             // segura os atalhos globais (espaco, setas, Delete)
    });
    // O blur so passa a valer no quadro seguinte, depois que o foco assentou: se algum
    // navegador ainda roubar o foco no rastro do clique, devolvemos em vez de fechar.
    requestAnimationFrame(() => {
      if (!entradaTexto || entradaTexto.inp !== inp) return;
      if (document.activeElement !== inp) inp.focus();
      inp.addEventListener("blur", () => fecharEntradaTexto(false));
    });
  }

  // Devolve true so quando o texto virou anotacao, para quem chamou saber se o clique
  // ja teve serventia e nao deve fazer mais nada.
  function fecharEntradaTexto(cancelar) {
    if (!entradaTexto) return false;
    const { inp, p, t } = entradaTexto;
    entradaTexto = null;
    const txt = inp.value.trim();
    inp.remove();
    if (cancelar || !txt) return false;
    empilhar();
    inserir({ tipo: "texto", pts: [p], texto: txt, esp: corpoTexto(espessura), t });
    voltarParaSelecao();
    return true;
  }

  // ------------------------------------------------------------------ CRUD
  function tolAtual() {
    const v = $("selTol").value;
    if (v === "Infinity") return Infinity;
    const n = Number(v);
    // tolerancia zero deixaria a anotacao visivel em um instante exato de ponto flutuante,
    // ou seja, praticamente nunca; qualquer valor invalido cai no padrao
    return isFinite(n) && n > 0 ? n : 0.5;
  }

  function inserir(a) {
    const nova = {
      id: seq++, t: instanteDoLance(a.t ?? $("video").currentTime), tol: a.tol ?? tolAtual(),
      tipo: a.tipo, cor: a.cor ?? cor, esp: a.esp ?? espessura,
      pts: a.pts, texto: a.texto, numero: a.numero,
      preench: a.preench ?? $("ckPreench").checked
    };
    estado.anotacoes.push(nova);
    selecionado = nova.id;
    salvar();
    atualizarPainel();
    tirarRetrato(nova.t);
    assinatura = "";
    agendarRender();
  }

  function remover(id) {
    empilhar();
    const saiu = estado.anotacoes.find(a => a.id === id);
    estado.anotacoes = estado.anotacoes.filter(a => a.id !== id);
    if (selecionado === id) selecionado = null;
    if (saiu) tirarRetrato(saiu.t);
    salvar();
    atualizarPainel();
    assinatura = "";
    agendarRender();
  }

  // O instantaneo leva as notas junto com os desenhos: a nota e do lance, e o lance so existe
  // enquanto os desenhos dele existem — desfazer uma exclusao tem de trazer os dois de volta.
  const instantaneo = () => JSON.stringify(
    { anotacoes: estado.anotacoes, lances: estado.lances || {} }, serializar);

  function restaurar(bruto) {
    const d = JSON.parse(bruto, desserializar);
    estado.anotacoes = d.anotacoes;
    estado.lances = d.lances || {};
  }

  function empilhar() {
    pilhaDesfazer.push(instantaneo());
    if (pilhaDesfazer.length > 50) pilhaDesfazer.shift();
    pilhaRefazer = [];
    atualizarBotoesHist();
  }

  function desfazer() {
    if (!pilhaDesfazer.length) return;
    pilhaRefazer.push(instantaneo());
    restaurar(pilhaDesfazer.pop());
    depoisDoHistorico();
  }

  function refazer() {
    if (!pilhaRefazer.length) return;
    pilhaDesfazer.push(instantaneo());
    restaurar(pilhaRefazer.pop());
    depoisDoHistorico();
  }

  function depoisDoHistorico() {
    if (!estado.anotacoes.some(a => a.id === selecionado)) selecionado = null;
    if (lanceAberto && !estado.anotacoes.some(a => chaveLance(a.t) === lanceAberto)) lanceAberto = null;
    salvar();
    atualizarPainel();
    atualizarBotoesHist();
    assinatura = "";
    agendarRender();
  }

  function atualizarBotoesHist() {
    $("btDesfazer").disabled = !pilhaDesfazer.length;
    $("btRefazer").disabled = !pilhaRefazer.length;
  }

  // JSON nao tem Infinity; guardamos a tolerancia "sempre visivel" como a string "sempre".
  const serializar = (k, v) => (k === "tol" && v === Infinity) ? "sempre" : v;
  const desserializar = (k, v) => (k === "tol" && v === "sempre") ? Infinity : v;

  // ------------------------------------------------------------------ leitura de estado
  // Com um texto selecionado a barra mexe no corpo da fonte, que e um numero bem maior
  // que a espessura do traco; mostrar o valor de verdade evita a leitura errada.
  function atualizarRotuloEsp() {
    const a = estado.anotacoes.find(q => q.id === selecionado);
    $("lbEsp").textContent = (a && a.tipo === "texto")
      ? `${Math.round(a.esp)} u de fonte`
      : `${espessura} u`;
  }

  // Uma linha só, no alto: o que o usuario precisa saber sobre o video aberto sem tirar
  // espaco da imagem. O inventario de anotacoes vive na regua de tiques e na barra abaixo.
  function atualizarPainel() {
    const dur = estado.video && estado.video.duracao;
    const it = biblioteca.find(x => x.imp === impressao);
    // um vídeo passageiro ainda não está na lista: o rótulo dele vive na fonte que o abriu
    const passageira = fonteAtual && fonteAtual.fonte;
    const rotulo = (it && it.titulo) || (passageira && passageira.titulo)
      || (estado.video && estado.video.nome) || "";
    $("resumo").innerHTML = estado.video
      ? `<b>${escapar(rotulo)}</b> · ${vw}×${vh} · ${dur ? fmtTempo(dur) : "—"}` +
        ` · ${fps} q/s · <b>${estado.anotacoes.length}</b> anotação(ões)`
      : "";
    $("resumo").title = (it && it.descricao) || (passageira && passageira.descricao) || "";
    atualizarRotuloEsp();
    atualizarSelecao();
    desenharTiques();
    desenharLances();
  }

  // As acoes que eram os botoes de cada linha da tabela: aparecem so quando ha selecao,
  // e coladas no video, que e onde o olho ja esta.
  function atualizarSelecao() {
    const a = estado.anotacoes.find(q => q.id === selecionado);
    // classe, e nao hidden: a faixa continua reservando a altura dela (ver styles.css)
    $("selInfo").classList.toggle("vazia", !a);
    $("btIrSel").disabled = !a;
    if (!a) return;
    $("selCor").style.background = a.cor;
    $("selTipo").textContent = a.tipo;
    $("selTempo").textContent = `${fmtTempo(a.t)} · ${fmtTol(tolDe(a))}`;
  }

  // ------------------------------------------------------------------ lances
  // Um lance e tudo o que foi desenhado num mesmo instante: parar o video, marcar o passe,
  // o adversario e a zona e um lance so. A identidade dele e o proprio instante — a chave que
  // o comum.js calcula e o quadro de correcoes (kanban.html) usa para achar o mesmo lance.
  //
  // O que estado.lances guarda NAO sao os desenhos: e so o que o usuario escreveu ou moveu no
  // quadro (nota, estagio, prioridade). Por isso a entrada sobrevive a perda dos desenhos —
  // e o card orfao — e some sozinha quando fica sem nenhum desses tres.

  // O seek nao devolve o mesmo currentTime exato quando se sai de um quadro e se volta a ele,
  // e dois instantes separados por microssegundos virariam dois lances. Por isso um desenho
  // novo ADOTA o instante do vizinho mais proximo dentro de meio quadro: assim os desenhos de
  // um lance dividem literalmente o mesmo t, e a chave da nota nao escorrega.
  function instanteDoLance(t) {
    let melhor = t, dist = Infinity;
    for (const a of estado.anotacoes) {
      const d = Math.abs(a.t - t);
      if (d < dist) { dist = d; melhor = a.t; }
    }
    return dist <= 0.5 / fps ? melhor : t;
  }

  const entradaDe = (chave) => (estado.lances && estado.lances[chave]) || null;
  const notaDe = (chave) => (entradaDe(chave) || {}).nota || "";

  function gravarNota(chave, texto) {
    if (!estado.lances) estado.lances = {};
    const limpo = texto.trim();
    const e = estado.lances[chave] || {};
    if (limpo) e.nota = limpo; else delete e.nota;
    estado.lances[chave] = e;
    podarLances(estado.lances);       // sem nota, sem estagio e sem prioridade nao ha o que guardar
    salvar();
  }

  // A entrada e do instante, nao dos desenhos. Quando o ultimo desenho de um lance muda de
  // instante (o "Recolocar aqui"), o lance inteiro andou: a nota e o card do quadro vao junto.
  function migrarNota(de, para) {
    const vem = entradaDe(de);
    if (de === para || !vem) return;
    if (estado.anotacoes.some(a => chaveLance(a.t) === de)) return;   // a origem continua viva
    const fica = entradaDe(para);
    if (!fica) {
      estado.lances[para] = vem;
    } else {
      // o destino ja tinha card: as notas se juntam e o estagio de la manda, que e onde o
      // trabalho ja estava
      const juntas = [fica.nota, vem.nota].filter(Boolean).join("\n");
      if (juntas) fica.nota = juntas;
    }
    delete estado.lances[de];
  }

  function desenharLances() {
    const gs = agruparLances(estado.anotacoes);
    const cont = $("contLances");
    cont.textContent = String(gs.length);
    cont.hidden = gs.length === 0;

    const lista = $("listaLances");
    lista.textContent = "";
    for (const g of gs) lista.appendChild(montarLance(g));

    const dica = $("dicaLances");
    dica.hidden = gs.length > 0;
    dica.textContent = estado.recorte
      ? "Nenhum lance ainda. Pause o vídeo, desenhe sobre o campo e o instante aparece aqui."
      : "Abra um vídeo e defina o recorte do campo para começar a marcar lances.";

    lanceMarcado = "";
    marcarLanceAtual();
  }

  function montarLance(g) {
    const nota = notaDe(g.chave);
    const caixa = document.createElement("div");
    caixa.className = "entrada lance";
    caixa.dataset.lance = g.chave;

    const d = document.createElement("div");
    d.className = "item";

    const tipos = resumoTipos(g.itens);
    const abrir = document.createElement("button");
    abrir.className = "abrir";
    abrir.addEventListener("click", () => irLance(g.chave, g.t));

    const tempo = document.createElement("span");
    tempo.className = "l-tempo";
    tempo.textContent = fmtTempo(g.t);
    tempo.style.borderLeftColor = g.itens[0].cor;   // a cor do primeiro desenho identifica o lance

    // o carimbo de tempo e o inventario dos desenhos dividem a primeira linha; a nota fica
    // com a largura inteira da segunda, que e onde ha texto de verdade para ler
    const cabeca = document.createElement("span");
    cabeca.className = "l-linha";
    const nome = document.createElement("span");
    nome.className = "nome";
    nome.textContent = tipos;
    cabeca.append(tempo, nome);

    // um lance que já andou no quadro de correções diz onde parou, para não ser reanalisado à toa
    const fase = estagioDe(entradaDe(g.chave));
    if (fase !== ESTAGIO_PADRAO) {
      const chip = document.createElement("span");
      chip.className = "l-fase";
      chip.textContent = ESTAGIOS.find(x => x.chave === fase).nome;
      chip.title = "Estágio no quadro de correções";
      cabeca.appendChild(chip);
    }

    const escrita = document.createElement("span");
    escrita.className = "l-nota";
    abrir.append(cabeca, escrita);

    const ed = document.createElement("button");
    ed.className = "acao anotar";
    ed.textContent = "✎";

    // enquanto o editor esta aberto a linha acompanha a digitacao sem redesenhar a lista
    const vestir = (texto) => {
      const limpo = texto.trim();
      caixa.classList.toggle("tem-nota", !!limpo);
      escrita.textContent = limpo;
      escrita.hidden = !limpo;
      abrir.title = `Ir para ${fmtTempo(g.t)} · ${tipos}${limpo ? `\n\n${limpo}` : ""}`;
      ed.title = limpo ? "Ver e editar a anotação" : "Anotar este lance";
    };
    vestir(nota);

    ed.addEventListener("click", () => {
      lanceAberto = lanceAberto === g.chave ? null : g.chave;
      desenharLances();
      const campo = $("listaLances").querySelector(".editor textarea");
      if (campo) { campo.focus(); campo.setSelectionRange(campo.value.length, campo.value.length); }
    });

    const x = document.createElement("button");
    x.className = "acao fechar";
    x.textContent = "✕";
    x.title = "Apagar o lance inteiro (desenhos e anotação)";
    x.addEventListener("click", () => apagarLance(g));

    d.append(abrir, ed, x);
    caixa.appendChild(d);
    if (lanceAberto === g.chave) caixa.appendChild(montarNota(g, nota, vestir));
    return caixa;
  }

  function montarNota(g, nota, vestir) {
    const ed = document.createElement("div");
    ed.className = "editor";

    const ta = document.createElement("textarea");
    ta.rows = 3;
    ta.placeholder = "O que aconteceu neste lance?";
    ta.value = nota;
    // grava a cada tecla (salvar() ja junta as rajadas) e mexe so na linha de cima: redesenhar
    // a lista inteira aqui trocaria o textarea e tiraria o foco de quem esta escrevendo
    ta.addEventListener("input", () => { gravarNota(g.chave, ta.value); vestir(ta.value); });
    // o tique da regua so muda de aparencia quando ha nota ou nao; esperar o campo perder o
    // foco evita reconstruir a faixa a cada tecla
    ta.addEventListener("change", desenharTiques);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); fecharNota(); }
      e.stopPropagation();              // segura os atalhos globais (espaco, setas, Delete)
    });

    const fecharNota = () => { lanceAberto = null; desenharLances(); desenharTiques(); };
    const pronto = document.createElement("button");
    pronto.className = "compacto";
    pronto.textContent = "Pronto";
    // pointerdown, e nao click: o 'change' do textarea dispara no blur e refaz a faixa de
    // tiques, e um redesenho no meio do caminho comeria o clique
    pronto.addEventListener("pointerdown", (e) => { e.preventDefault(); fecharNota(); });

    ed.append(ta, pronto);
    return ed;
  }

  function apagarLance(g) {
    // aqui a exclusão é deliberada e leva tudo, inclusive o card no quadro de correções;
    // apagar os desenhos um a um é outra história — lá o card fica, órfão
    if (!confirm(`Apagar o lance de ${fmtTempo(g.t)} — ${resumoTipos(g.itens)}` +
                 `${entradaDe(g.chave) ? ", a anotação e o card dele no quadro" : ""}?` +
                 ` (dá para desfazer com Ctrl+Z)`)) return;
    empilhar();
    const fora = new Set(g.itens.map(a => a.id));
    estado.anotacoes = estado.anotacoes.filter(a => !fora.has(a.id));
    if (estado.lances) delete estado.lances[g.chave];
    apagarRetrato(impressao, g.chave);
    if (fora.has(selecionado)) selecionado = null;
    if (lanceAberto === g.chave) lanceAberto = null;
    salvar(); atualizarPainel(); assinatura = ""; agendarRender();
  }

  // Leva o video ao instante do lance e, se a guia estiver a vista, traz a linha dele junto.
  function irLance(chave, t) {
    irPara(t);
    retratarSeFaltar(chave, t);
    if (guia !== "lances" || $("app").classList.contains("recolhida")) return;
    const linha = $("listaLances").querySelector(`[data-lance="${chave}"]`);
    if (linha) linha.scrollIntoView({ block: "nearest" });
  }

  // Destaca o lance mais proximo do cursor do video — meio segundo de folga, o mesmo tamanho
  // da janela de visibilidade padrao. Roda a cada quadro, entao so toca no DOM quando muda.
  function marcarLanceAtual() {
    if (guia !== "lances") return;
    const t = $("video").currentTime || 0;
    let alvo = "";
    let dist = 0.5;
    for (const g of agruparLances(estado.anotacoes)) {
      const d = Math.abs(g.t - t);
      if (d <= dist) { dist = d; alvo = g.chave; }
    }
    if (alvo === lanceMarcado) return;
    lanceMarcado = alvo;
    for (const l of $("listaLances").children) {
      l.classList.toggle("atual", l.dataset.lance === alvo);
    }
  }

  // Um tique por lance, e nao por desenho: no mesmo instante eles ficariam empilhados.
  function desenharTiques() {
    const faixa = $("tiques");
    faixa.textContent = "";
    const dur = $("video").duration;
    if (!isFinite(dur) || dur <= 0) return;
    for (const g of agruparLances(estado.anotacoes)) {
      const nota = notaDe(g.chave);
      const s = document.createElement("span");
      s.className = "tique" + (nota ? " com-nota" : "");
      s.style.left = `${clamp(g.t / dur, 0, 1) * 100}%`;
      s.style.background = g.itens[0].cor;
      s.title = [fmtTempo(g.t), resumoTipos(g.itens), nota.split("\n")[0]].filter(Boolean).join(" · ");
      s.addEventListener("click", () => irLance(g.chave, g.t));
      faixa.appendChild(s);
    }
  }

  // ---------------------------------------------------------------- retrato do lance
  // O card do quadro de correções mostra uma foto do lance: o quadro do vídeo recortado no
  // campo, com os desenhos daquele instante por cima. Sai do <video> e do próprio SVG que já
  // está na tela, então não há nada novo para manter. Vídeo de outra origem sem CORS suja o
  // canvas e o toDataURL lança — nesse caso o lance fica sem retrato, e está tudo bem.
  const LARG_RETRATO = 320;

  // As cores dos desenhos são variáveis do CSS (var(--eu)); num SVG solto, fora da página,
  // elas não existem. Trocamos cada uma pelo valor que o tema está usando agora.
  function resolverCores(texto) {
    const raiz = getComputedStyle(document.documentElement);
    return String(texto).replace(/var\(--([\w-]+)\)/g,
      (_, nome) => raiz.getPropertyValue(`--${nome}`).trim() || "#888");
  }

  // O quadro do vídeo, recortado no campo. É síncrono de propósito: este é o único momento em
  // que temos certeza de estar no quadro certo — meio segundo depois o cursor já pode ter
  // andado. O resto (compor os desenhos, comprimir, gravar) pode acontecer com calma.
  function quadroDoCampo() {
    const v = $("video");
    if (!v.videoWidth || v.readyState < 2 || !estado.recorte) return null;
    const larg = LARG_RETRATO, alt = Math.max(1, Math.round(larg * RH() / RW()));
    const c = document.createElement("canvas");
    c.width = larg; c.height = alt;
    c.getContext("2d").drawImage(v, RX(), RY(), RW(), RH(), 0, 0, larg, alt);
    return c;
  }

  async function comporRetrato(c, itens) {
    try {
      const larg = c.width, alt = c.height;
      const ctx = c.getContext("2d");

      // o viewBox faz o recorte e a escala: o desenho cai exatamente sobre a imagem
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("xmlns", svgNS);
      svg.setAttribute("width", larg);
      svg.setAttribute("height", alt);
      svg.setAttribute("viewBox", `${RX()} ${RY()} ${RW()} ${RH()}`);
      for (const a of itens) if (a.tipo !== "texto") desenharAnotacao(svg, a, 1);

      const img = new Image();
      img.src = "data:image/svg+xml;charset=utf-8," +
                encodeURIComponent(resolverCores(new XMLSerializer().serializeToString(svg)));
      await img.decode();
      ctx.drawImage(img, 0, 0, larg, alt);

      // os rótulos de texto moram numa camada HTML, não no SVG: vão para o canvas na mão
      const k = larg / RW();
      for (const a of itens) {
        if (a.tipo !== "texto") continue;
        ctx.font = `600 ${Math.max(7, a.esp * esc() * k)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = resolverCores(a.cor);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(a.texto || "", (cx(a.pts[0][0]) - RX()) * k, (cy(a.pts[0][1]) - RY()) * k);
      }
      return c.toDataURL("image/jpeg", 0.72);
    } catch (err) { return null; }      // vídeo de outra origem sem CORS: canvas sujo
  }

  // Chamado a cada mudança num lance. Só fotografa o que está mesmo à vista: apagar um desenho
  // com o cursor longe dali não pode trocar a foto do lance por um quadro qualquer.
  function tirarRetrato(t) {
    if (!impressao || !estado.recorte) return;
    const v = $("video");
    if (Math.abs((v.currentTime || 0) - t) > 0.05) return;

    // HAVE_CURRENT_DATA. Com menos que isso o <video> tem tamanho e duração, mas nenhum quadro
    // decodificado: o drawImage não copia nada e a foto sairia só com os riscos, sobre o preto.
    // Acontece de verdade ao chegar num lance logo que o vídeo abre — o link vindo do quadro.
    if (v.readyState < 2) {
      const quandoTiver = () => { v.removeEventListener("loadeddata", quandoTiver); tirarRetrato(t); };
      v.addEventListener("loadeddata", quandoTiver);
      return;
    }

    const imp = impressao, chave = chaveLance(t);
    const itens = estado.anotacoes.filter(a => chaveLance(a.t) === chave);
    if (!itens.length) {
      // Sem desenhos, o lance virou card órfão — e aí o retrato é a única lembrança que sobrou
      // dele. Só quando nem card existe é que a foto deixa de servir a alguém.
      if (!entradaDe(chave)) apagarRetrato(imp, chave);
      return;
    }
    const c = quadroDoCampo();
    if (c) comporRetrato(c, itens).then((dados) => { if (dados) guardarRetrato(imp, chave, dados); });
  }

  // Lance feito antes desta versão — ou vindo de um JSON importado — não tem foto nenhuma.
  // Visitá-lo é o que a tira: ao chegar nele, o quadro certo está justamente na tela. Assim o
  // acervo antigo se preenche sozinho, à medida que os lances vão sendo revistos.
  function retratarSeFaltar(chave, t) {
    const imp = impressao;
    if (!imp || !estado.recorte) return;
    lerRetrato(imp, chave).then((tem) => {
      if (tem || impressao !== imp) return;
      // Duas condições, e nenhuma delas chega na hora: o vídeo precisa ter quadro decodificado
      // (pode estar abrindo agora) e estar parado no instante do lance (o salto está a
      // caminho). Esperamos as duas, com um teto de tentativas para nunca virar laço.
      const v = $("video");
      let restam = 8;
      const desistir = () => {
        v.removeEventListener("loadeddata", tentar);
        v.removeEventListener("seeked", tentar);
      };
      const tentar = () => {
        if (impressao !== imp || restam-- <= 0) return desistir();
        if (v.readyState < 2 || Math.abs((v.currentTime || 0) - t) > 0.05) return;
        desistir();
        tirarRetrato(t);
      };
      v.addEventListener("loadeddata", tentar);
      v.addEventListener("seeked", tentar);
      tentar();
    });
  }

  // ---------------------------------------------------------------- link vindo do quadro
  // O card do quadro de correções aponta para index.html#lance=<impressão>@<chave>. A âncora
  // vale também em file://, onde não há servidor para ler uma query string.
  const enderecoDoLance = (imp, chave) => `#lance=${encodeURIComponent(imp)}@${chave}`;

  function lerAlvoDoEndereco() {
    const m = /^#lance=(.+)@([\d.]+)$/.exec(location.hash || "");
    if (!m) return null;
    try {
      return { imp: decodeURIComponent(m[1]), chave: m[2], t: Number(m[2]) };
    } catch (err) { return null; }
  }

  // Chamado uma vez, ao abrir a página: descobre de qual vídeo é o lance pedido e o abre —
  // sozinho quando é um link, e por um convite quando é arquivo do disco, porque reabrir um
  // handle exige requestPermission, que só vale sob um gesto do usuário.
  function atenderAlvo() {
    const alvo = lerAlvoDoEndereco();
    if (!alvo || !isFinite(alvo.t)) return;
    // o link se esgota no primeiro uso: um F5 depois não deve arrastar o vídeo de volta
    try { history.replaceState(null, "", location.pathname + location.search); } catch (err) {}

    if (alvo.imp === impressao) { escolherGuia("lances"); irLance(alvo.chave, alvo.t); return; }

    const it = biblioteca.find(x => x.imp === alvo.imp);
    const s = lerEstado(alvo.imp);
    const info = (it && it.origem) ? it : (s && s.video) || null;
    if (!info) return nota("O lance pedido é de um vídeo que não está mais guardado aqui.", true);

    lanceAlvo = alvo;
    if (info.origem === "url" && info.url) return carregarVideoUrl(info.url, { titulo: it && it.titulo });
    convidar(alvo, it ? rotuloDe(it) : (s.video.nome || "o vídeo"));
  }

  // A faixa é o gesto que falta: o clique nela é o que autoriza o navegador a reabrir o arquivo.
  function convidar(alvo, rotulo) {
    $("txtConvite").textContent = `Lance de ${fmtTempo(alvo.t)} em “${rotulo}”.`;
    $("convite").hidden = false;
    $("btConvite").onclick = () => {
      $("convite").hidden = true;
      const it = biblioteca.find(x => x.imp === alvo.imp);
      if (it) abrirDaBiblioteca(it);
      else nota(`Abra “${rotulo}” para ver o lance de ${fmtTempo(alvo.t)}.`);
    };
    $("btDispensarConvite").onclick = () => { $("convite").hidden = true; lanceAlvo = null; };
  }

  function escolherGuia(nome) {
    guia = nome;
    for (const b of $("guias").children) b.classList.toggle("ativa", b.dataset.guia === nome);
    $("painelVideos").hidden = nome !== "videos";
    $("painelLances").hidden = nome !== "lances";
    try { localStorage.setItem(CHAVE_GUIA, nome); } catch (err) {}
    if (nome === "lances") desenharLances();
  }

  function nota(msg, ruim) {
    const s = $("statusArquivo");
    s.textContent = msg;
    s.className = ruim ? "rot aviso" : "rot bom";
  }

  // ------------------------------------------------------------------ persistencia
  // O atraso de 400 ms junta rajadas de edicao numa gravacao so, mas quem chama pode trocar
  // de video antes de o relogio tocar: por isso a chave e o objeto ficam presos AQUI, senao
  // o estado do video novo seria gravado sob a chave do antigo (ou vice-versa).
  function salvar() {
    if (!impressao) return;
    pendente = { chave: CHAVE + impressao, alvo: estado };
    clearTimeout(temporizadorSalvar);
    temporizadorSalvar = setTimeout(salvarPendente, 400);
  }

  function salvarPendente() {
    clearTimeout(temporizadorSalvar);
    temporizadorSalvar = 0;
    if (!pendente) return;
    try {
      localStorage.setItem(pendente.chave, JSON.stringify(pendente.alvo, serializar));
    } catch (err) {
      nota("Não consegui salvar no navegador (armazenamento cheio?). Use Exportar JSON.", true);
    }
    pendente = null;
  }

  function lerSalvo(imp) {
    try {
      const bruto = localStorage.getItem(CHAVE + imp);
      if (!bruto) return null;
      const s = JSON.parse(bruto, desserializar);
      if (!s || !Array.isArray(s.anotacoes)) return null;
      // gravacoes anteriores a guia de lances nao tem o campo; sem ele nada mais escreve nota
      if (!s.lances || typeof s.lances !== "object") s.lances = {};
      return s;
    } catch (err) { return null; }
  }

  // ------------------------------------------------------------------ biblioteca de videos
  // O navegador nao deixa um site guardar o caminho de um arquivo do disco: um File vindo de
  // <input type=file> morre junto com a aba. Quem sobrevive ao F5 e o FileSystemFileHandle
  // da File System Access API — e ele so cabe no IndexedDB, que guarda objetos, nao texto.
  // Onde essa API nao existe (Firefox, Safari) a lista continua valendo, mas reabrir um
  // arquivo pede que o usuario o localize de novo; as anotacoes voltam sozinhas porque a
  // chave delas e a impressao digital nome|tamanho|modificado, que nao muda.
  const MAX_BIB = 24;
  const temPicker = typeof window.showOpenFilePicker === "function";

  const guardarHandle = (imp, h) => comBanco("readwrite", (l) => l.put(h, imp));
  const lerHandle = (imp) => comBanco("readonly", (l) => l.get(imp)).catch(() => null);
  const apagarHandle = (imp) => comBanco("readwrite", (l) => l.delete(imp)).catch(() => {});

  // As miniaturas ficam no mesmo banco, e nao no localStorage: sao alguns KB cada uma e
  // disputariam com as anotacoes a cota de 5 MB, que e onde mora o trabalho do usuario.
  const guardarMini = (imp, d) => comBanco("readwrite", (l) => l.put(d, `mini:${imp}`));
  const lerMini = (imp) => comBanco("readonly", (l) => l.get(`mini:${imp}`)).catch(() => null);
  const apagarMini = (imp) => comBanco("readwrite", (l) => l.delete(`mini:${imp}`)).catch(() => {});

  // Um quadro do proprio <video> desenhado num canvas. Video de outra origem sem CORS suja
  // o canvas e toDataURL lanca: nesse caso ficamos sem miniatura, e esta tudo bem.
  function quadroAtual() {
    const v = $("video");
    if (!v.videoWidth) return null;
    try {
      const L = 192, A = Math.max(1, Math.round(L * v.videoHeight / v.videoWidth));
      const c = document.createElement("canvas");
      c.width = L; c.height = A;
      c.getContext("2d").drawImage(v, 0, 0, L, A);
      return c.toDataURL("image/jpeg", 0.62);
    } catch (err) { return null; }
  }

  // A miniatura da lista sai do quadro que JÁ está na tela — nunca de um salto próprio.
  //
  // Antes ela pulava até os 3 s (o começo costuma ser preto) e devolvia o cursor. Esse salto
  // brigava com todo mundo que também quer o cursor: o retrato de um lance, o link vindo do
  // quadro de correções, a primeira seta do usuário. Ora o salto alheio era desfeito, ora a
  // foto do lance saía do quadro errado. Agora ninguém mexe no vídeo por baixo de ninguém:
  // pegamos o primeiro quadro ao abrir e, na primeira vez que o usuário for a um ponto adiante
  // do primeiro segundo, trocamos por aquele — que é bem mais representativo da partida.
  function prepararMiniatura(exigirAdiante) {
    const imp = impressao;
    const it = biblioteca.find(x => x.imp === imp);
    if (!it || it.temMini) return;
    const v = $("video");
    if (v.readyState < 2) return;                       // sem quadro decodificado não há o que copiar
    if (exigirAdiante && v.currentTime < 1) return;

    const dados = quadroAtual();
    if (!dados) return;
    minis.set(imp, dados);
    desenharBiblioteca();
    // 'temMini' só depois do quadro adiante: até lá o retrato provisório pode ser melhorado
    guardarMini(imp, dados)
      .then(() => { if (exigirAdiante) { it.temMini = true; salvarBiblioteca(); } })
      .catch(() => {});
  }

  function salvarBiblioteca() {
    try { localStorage.setItem(CHAVE_BIB, JSON.stringify(biblioteca)); } catch (err) {}
  }

  // Registrado so depois que o video abriu de verdade, para link quebrado nao sujar a lista.
  function lembrarVideo() {
    if (!fonteAtual) return;
    const { fonte, handle } = fonteAtual;
    fonteAtual = null;
    const antigo = biblioteca.find(x => x.imp === fonte.impressao);
    const it = {
      imp: fonte.impressao,
      nome: fonte.videoInfo.nome,
      origem: fonte.videoInfo.origem,
      url: fonte.videoInfo.url || null,
      duracao: isFinite($("video").duration) ? $("video").duration : null,
      // o que o usuario escreveu e o retrato ja tirado sobrevivem a reabrir o mesmo video;
      // o rotulo vindo da busca de partidas so preenche o que ainda estiver vazio
      titulo: (antigo && antigo.titulo) || fonte.titulo || "",
      descricao: (antigo && antigo.descricao) || fonte.descricao || "",
      temMini: !!(antigo && antigo.temMini),
      comHandle: !!(antigo && antigo.comHandle)     // um handle ja guardado continua valendo
    };
    entrarNaLista(it);

    if (handle) {
      guardarHandle(it.imp, handle)
        .then(() => { it.comHandle = true; salvarBiblioteca(); desenharBiblioteca(); })
        .catch(() => {});
    }
  }

  // Entrar na lista e sempre pelo topo, e o que passar do teto sai levando handle e retrato:
  // sao eles que ocupam espaco de verdade no navegador.
  function entrarNaLista(it) {
    const sobra = [it, ...biblioteca.filter(x => x.imp !== it.imp)];
    for (const velho of sobra.slice(MAX_BIB)) { apagarHandle(velho.imp); apagarMini(velho.imp); }
    biblioteca = sobra.slice(0, MAX_BIB);
    salvarBiblioteca();
    desenharBiblioteca();
  }

  // Guardar a partida que ja esta aberta: aproveita a duracao e o quadro que o <video> tem.
  function guardarNaLista() {
    if (!impressao || biblioteca.some(x => x.imp === impressao)) return;
    lembrarVideo();
    const it = biblioteca.find(x => x.imp === impressao);
    if (!it) return;

    // O retrato sai do quadro que já está na tela: prepararMiniatura() daria um pulo até os
    // 3 s e voltaria, e no meio de uma análise essa piscada apareceria.
    const dados = it.temMini ? null : quadroAtual();
    if (dados) {
      minis.set(impressao, dados);
      desenharBiblioteca();
      guardarMini(impressao, dados)
        .then(() => { it.temMini = true; salvarBiblioteca(); })
        .catch(() => {});
    }
    atualizarPainel();
    nota(`"${rotuloDe(it)}" guardado na lista.`);
  }

  function alternarLateral(mostrar) {
    const recolher = mostrar === undefined ? !$("app").classList.contains("recolhida") : !mostrar;
    $("app").classList.toggle("recolhida", recolher);
    try { localStorage.setItem(CHAVE_LATERAL, recolher ? "1" : "0"); } catch (err) {}
    // a transicao da barra dispara o ResizeObserver quadro a quadro; isto e so o empurrao inicial
    ajustarPalco();
  }

  function esquecerVideo(it) {
    biblioteca = biblioteca.filter(x => x.imp !== it.imp);
    if (editando === it.imp) editando = null;
    minis.delete(it.imp);
    salvarBiblioteca();
    apagarHandle(it.imp);
    apagarMini(it.imp);
    desenharBiblioteca();
    nota(`"${rotuloDe(it)}" saiu da lista — as anotações dele continuam guardadas.`);
  }

  function desenharBiblioteca() {
    const faixa = $("biblio");
    faixa.textContent = "";
    $("painelBiblio").hidden = biblioteca.length === 0;
    for (const it of biblioteca) faixa.appendChild(montarEntrada(it));
    marcarPartidas();          // a mesma partida pode estar listada logo acima
  }

  function montarEntrada(it) {
    const caixa = document.createElement("div");
    caixa.className = "entrada" + (it.imp === impressao ? " atual" : "");

    const d = document.createElement("div");
    d.className = "item";

    const abrir = document.createElement("button");
    abrir.className = "abrir";
    abrir.title = [
      it.nome,
      it.origem === "url" ? "link" : "arquivo do disco",
      it.duracao ? fmtTempo(it.duracao) : null,
      it.origem === "url" || it.comHandle ? "abre direto" : "vai pedir para localizar o arquivo"
    ].filter(Boolean).join(" · ");
    abrir.addEventListener("click", () => abrirDaBiblioteca(it));

    // caixa vazia com cor de fundo enquanto nao ha retrato: nada de icone de imagem quebrada
    const mini = document.createElement("span");
    mini.className = "mini";
    if (minis.has(it.imp)) {
      mini.style.backgroundImage = `url(${minis.get(it.imp)})`;
    } else if (it.temMini) {
      lerMini(it.imp).then((dados) => {
        if (!dados) return;
        minis.set(it.imp, dados);
        mini.style.backgroundImage = `url(${dados})`;
      });
    }

    const txt = document.createElement("span");
    txt.className = "txt";
    const nome = document.createElement("span");
    nome.className = "nome";
    nome.textContent = rotuloDe(it);
    txt.appendChild(nome);
    if (it.descricao) {
      const desc = document.createElement("span");
      desc.className = "desc";
      desc.textContent = it.descricao;
      txt.appendChild(desc);
    }

    abrir.append(mini, txt);

    const ed = document.createElement("button");
    ed.className = "acao";
    ed.textContent = "✎";
    ed.title = "Título e descrição";
    ed.addEventListener("click", () => {
      editando = editando === it.imp ? null : it.imp;
      desenharBiblioteca();
      const campo = $("biblio").querySelector(".editor input");
      if (campo) campo.focus();
    });

    const x = document.createElement("button");
    x.className = "acao fechar";
    x.textContent = "✕";
    x.title = "Tirar da lista (as anotações continuam guardadas)";
    x.addEventListener("click", () => esquecerVideo(it));

    d.append(abrir, ed, x);
    caixa.appendChild(d);
    if (editando === it.imp) caixa.appendChild(montarEditor(it));
    return caixa;
  }

  function montarEditor(it) {
    const ed = document.createElement("div");
    ed.className = "editor";

    const ti = document.createElement("input");
    ti.type = "text";
    ti.placeholder = "Título";
    ti.value = it.titulo || "";

    const de = document.createElement("textarea");
    de.rows = 3;
    de.placeholder = "Descrição";
    de.value = it.descricao || "";

    const gravar = () => {
      it.titulo = ti.value.trim();
      it.descricao = de.value.trim();
      salvarBiblioteca();
      if (it.imp === impressao) atualizarPainel();   // o topo mostra o titulo do video aberto
    };
    ti.addEventListener("change", gravar);
    de.addEventListener("change", gravar);
    ti.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); de.focus(); }
      if (e.key === "Escape") { e.preventDefault(); editando = null; desenharBiblioteca(); }
    });

    const pronto = document.createElement("button");
    pronto.className = "compacto";
    pronto.textContent = "Pronto";
    pronto.addEventListener("click", () => { gravar(); editando = null; desenharBiblioteca(); });

    ed.append(ti, de, pronto);
    return ed;
  }

  async function abrirDaBiblioteca(it) {
    if (it.imp === impressao) return nota(`"${it.nome}" já está aberto.`);
    if (it.origem === "url" && it.url) return carregarVideoUrl(it.url);

    const h = it.comHandle ? await lerHandle(it.imp) : null;
    if (h) {
      try {
        // requestPermission exige gesto do usuario; o clique nesta lista serve como gesto
        let p = await h.queryPermission({ mode: "read" });
        if (p === "prompt") p = await h.requestPermission({ mode: "read" });
        if (p === "granted") return carregarVideo(await h.getFile(), h);
        return nota(`Sem permissão para reabrir "${it.nome}".`, true);
      } catch (err) {
        // arquivo movido, renomeado ou apagado desde a ultima vez
      }
    }
    aguardandoReabrir = it;
    nota(`Localize "${it.nome}" para reabrir.`);
    if (temPicker) abrirComPicker(); else $("arqVideo").click();
  }

  async function abrirComPicker() {
    try {
      const [h] = await window.showOpenFilePicker({
        multiple: false,
        types: [{
          description: "Vídeo",
          accept: {
            "video/mp4": [".mp4", ".m4v"], "video/webm": [".webm"], "video/ogg": [".ogv"],
            "video/x-matroska": [".mkv"], "video/quicktime": [".mov"]
          }
        }]
      });
      if (h) carregarVideo(await h.getFile(), h);
    } catch (err) {
      aguardandoReabrir = null;
      // AbortError e so o usuario fechando o seletor; o resto merece aparecer
      if (err && err.name !== "AbortError") nota(`Não consegui abrir o seletor: ${err.message}`, true);
    }
  }

  function exportar() {
    const nome = (estado.video && estado.video.nome || "partida").replace(/\.[^.]+$/, "");
    const blob = new Blob([JSON.stringify(estado, serializar, 1)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${nome}.anotacoes.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    nota(`Exportado ${estado.anotacoes.length} anotação(ões).`);
  }

  function importar(arq) {
    const fr = new FileReader();
    fr.onload = () => {
      let s;
      try { s = JSON.parse(String(fr.result), desserializar); } catch (err) { s = null; }
      if (!s || !Array.isArray(s.anotacoes)) { nota("JSON inválido.", true); return; }

      const antes = estado.video;
      estado = {
        versao: VERSAO, video: antes || s.video || null,
        recorte: s.recorte || null,
        tolPadrao: typeof s.tolPadrao === "number" ? s.tolPadrao : 0.5,
        anotacoes: s.anotacoes,
        lances: (s.lances && typeof s.lances === "object") ? s.lances : {}
      };
      seq = estado.anotacoes.reduce((m, a) => Math.max(m, a.id || 0), 0) + 1;
      selecionado = null; lanceAberto = null; pilhaDesfazer = []; pilhaRefazer = [];
      importadoPendente = !impressao;   // sem video ainda: guardar para o proximo que abrir
      $("selTol").value = isFinite(estado.tolPadrao) ? String(estado.tolPadrao) : "Infinity";

      const outro = antes && s.video && s.video.nome && s.video.nome !== antes.nome;
      nota(outro
        ? `Importado, mas o JSON é de "${s.video.nome}" e o vídeo aberto é "${antes.nome}".`
        : `${estado.anotacoes.length} anotação(ões) importada(s).`, !!outro);

      salvar(); atualizarBotoesHist(); atualizarRecorteUI(); atualizarPainel();
      assinatura = ""; agendarRender();
    };
    fr.readAsText(arq);
  }

  // ------------------------------------------------------------------ partidas do lugobots.ai
  // O site nao manda Access-Control-Allow-Origin, entao a pagina sozinha nao consegue le-lo:
  // quem raspa e o servidor local (servidor.js + lugo/partidas.js), e daqui so sai um fetch
  // para o proprio servidor. Aberto direto pelo file://, o /api/saude falha e o painel
  // simplesmente nao aparece — o resto do analisador continua igual.
  const RESULTADOS = { "vitória": "venceu", "empate": "empatou", "derrota": "perdeu" };
  let buscandoPartidas = false;

  async function ligarPainelBot() {
    try {
      const r = await fetch("api/saude", { cache: "no-store" });
      if (!r.ok) return;
    } catch (err) { return; }

    $("painelBot").hidden = false;
    let ultimo = "";
    try { ultimo = localStorage.getItem(CHAVE_BOT) || ""; } catch (err) {}
    $("txtBot").value = ultimo;
    // com um bot ja lembrado as partidas aparecem sozinhas: e essa a sugestao
    if (ultimo) buscarPartidas();
  }

  async function buscarPartidas() {
    const nome = $("txtBot").value.trim();
    if (!nome || buscandoPartidas) return;
    buscandoPartidas = true;
    $("btBuscarBot").disabled = true;
    $("listaPartidas").textContent = "";
    dicaPartidas(`Buscando as partidas de "${nome}"…`);

    let resp = null, dados = null;
    try {
      resp = await fetch(`api/partidas?bot=${encodeURIComponent(nome)}&n=5`, { cache: "no-store" });
      dados = await resp.json();
    } catch (err) {
      dados = { erro: "O servidor local não respondeu — ele ainda está no ar?" };
    }
    buscandoPartidas = false;
    $("btBuscarBot").disabled = false;

    if (dados && Array.isArray(dados.candidatos)) return desenharCandidatos(dados.candidatos);
    if (!resp || !resp.ok || !dados || !Array.isArray(dados.partidas)) {
      return dicaPartidas((dados && dados.erro) || "Não consegui buscar as partidas.", true);
    }
    // guardamos o nome canonico, nao o que foi digitado: na proxima vez a busca acerta de primeira
    try { localStorage.setItem(CHAVE_BOT, dados.bot.nome); } catch (err) {}
    desenharPartidas(dados);
  }

  function desenharPartidas({ bot, partidas }) {
    const lista = $("listaPartidas");
    lista.className = "partidas";
    lista.textContent = "";
    if (!partidas.length) return dicaPartidas(`${bot.nome} ainda não tem partidas por aqui.`);
    for (const p of partidas) lista.appendChild(montarPartida(p, bot));
    marcarPartidas();
    const semVideo = partidas.filter(p => !p.video).length;
    dicaPartidas(`Últimas ${partidas.length} partidas de ${bot.nome}.` +
      (semVideo ? ` ${semVideo} sem vídeo publicado.` : ""));
  }

  // o servidor devolve os candidatos quando o texto digitado bate com mais de um bot
  function desenharCandidatos(candidatos) {
    const lista = $("listaPartidas");
    lista.className = "partidas candidatos";
    lista.textContent = "";
    for (const c of candidatos) {
      const b = document.createElement("button");
      b.className = "compacto";
      b.textContent = c.nome;
      b.title = c.slug;
      b.addEventListener("click", () => { $("txtBot").value = c.slug; buscarPartidas(); });
      lista.appendChild(b);
    }
    dicaPartidas("Mais de um bot bate com esse nome — escolha um:");
  }

  const tituloPartida = (p) => `${p.casa.nome} ${p.golsCasa} × ${p.golsFora} ${p.fora.nome}`;
  const descricaoPartida = (p, bot) =>
    [fmtData(p.data), p.resultado, legenda(p.contexto, bot)].filter(Boolean).join(" · ");

  // A linha inteira abre a partida; o + que cobre o placar no hover e o que a guarda na lista
  // de videos. Sao dois botoes irmaos, e nao um dentro do outro, que o HTML nao permite.
  function montarPartida(p, bot) {
    const caixa = document.createElement("div");
    caixa.className = `partida ${RESULTADOS[p.resultado] || ""}`.trim();
    if (p.video) caixa.dataset.imp = `url|${p.video}`;

    const abrir = document.createElement("button");
    abrir.className = "p-abrir";
    abrir.disabled = !p.video;
    abrir.title = p.video
      ? `${tituloPartida(p)}\n${p.paginaUrl}`
      : `${tituloPartida(p)}\nSem vídeo publicado no lugobots.ai.`;

    const placar = document.createElement("span");
    placar.className = "p-placar";
    placar.textContent = `${p.golsPro} × ${p.golsContra}`;

    const txt = document.createElement("span");
    txt.className = "txt";
    const nome = document.createElement("span");
    nome.className = "nome";
    nome.textContent = p.adversario.nome;
    const desc = document.createElement("span");
    desc.className = "desc";
    desc.textContent = [fmtData(p.data), p.mando, legenda(p.contexto, bot)].filter(Boolean).join(" · ");
    txt.append(nome, desc);

    abrir.append(placar, txt);
    abrir.addEventListener("click", () => carregarVideoUrl(p.video, {
      titulo: tituloPartida(p),
      descricao: descricaoPartida(p, bot),
      temporario: true
    }));
    caixa.appendChild(abrir);

    if (p.video) {
      const mais = document.createElement("button");
      mais.className = "p-guardar";
      mais.textContent = "+";
      mais.title = `Guardar na lista de vídeos:\n${tituloPartida(p)}`;
      mais.addEventListener("click", () => guardarPartida(p, bot));
      caixa.appendChild(mais);
    }
    return caixa;
  }

  // Guardar não exige abrir: o item da lista sai do que a busca já sabe. Se a partida for
  // justamente a que está na tela, o caminho é outro — o <video> conhece a duração e o quadro.
  function guardarPartida(p, bot) {
    const imp = `url|${p.video}`;
    if (biblioteca.some(x => x.imp === imp)) return;
    if (imp === impressao) return guardarNaLista();

    entrarNaLista({
      imp,
      nome: p.video,
      origem: "url",
      url: p.video,
      duracao: null,
      titulo: tituloPartida(p),
      descricao: descricaoPartida(p, bot),
      temMini: false,
      comHandle: false
    });
    nota(`"${tituloPartida(p)}" guardado na lista.`);
  }

  // marca o que ja passou pelo analisador; roda junto com a lista de videos, que e quem sabe
  function marcarPartidas() {
    for (const b of $("listaPartidas").querySelectorAll("[data-imp]")) {
      b.classList.toggle("vista", biblioteca.some(x => x.imp === b.dataset.imp));
      b.classList.toggle("atual", b.dataset.imp === impressao);
    }
  }

  function dicaPartidas(msg, ruim) {
    const p = $("dicaPartidas");
    p.textContent = msg || "";
    p.hidden = !msg;
    p.className = ruim ? "rot dica aviso" : "rot dica";
  }

  function fmtData(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return "";
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  // O lugobots.ai responde em ingles. Quem desafiou e a unica parte que muda de linha para
  // linha, e "desafio de <o proprio bot>" em toda partida seria so barulho: vira "desafio meu".
  // O que nao for desafio (campeonato, por exemplo) passa direto, com o nome que o site deu.
  function legenda(contexto, bot) {
    const m = String(contexto || "").match(/^Challenged by (.+?) team$/i);
    if (!m) return String(contexto || "");
    const meu = bot && String(bot.nome).trim().toLowerCase() === m[1].trim().toLowerCase();
    return meu ? "desafio meu" : `desafiado por ${m[1]}`;
  }

  // ------------------------------------------------------------------ ligacoes
  function montarCores() {
    const barra = $("barraCores");
    for (const c of CORES) {
      const b = document.createElement("button");
      b.style.background = c;
      b.title = c;
      if (c === cor) b.className = "ativa";
      b.addEventListener("click", () => {
        cor = c;
        [...barra.children].forEach(x => x.className = "");
        b.className = "ativa";
        const a = estado.anotacoes.find(q => q.id === selecionado);
        if (a) { empilhar(); a.cor = c; salvar(); atualizarPainel(); }
        assinatura = ""; agendarRender();
      });
      barra.appendChild(b);
    }
  }

  function ligar() {
    const v = $("video");

    $("arqVideo").addEventListener("change", (e) => { carregarVideo(e.target.files[0]); e.target.value = ""; });
    // fechar o seletor sem escolher nada desarma o aviso de "arquivo diferente"
    $("arqVideo").addEventListener("cancel", () => { aguardandoReabrir = null; });
    $("btEscolher").addEventListener("click", abrirComPicker);
    $("btAbrirUrl").addEventListener("click", () => carregarVideoUrl($("txtVideoUrl").value));
    $("txtVideoUrl").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); carregarVideoUrl($("txtVideoUrl").value); }
    });
    $("btBuscarBot").addEventListener("click", buscarPartidas);
    $("txtBot").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); buscarPartidas(); }
    });
    $("btImportar").addEventListener("click", () => $("arqJson").click());
    $("arqJson").addEventListener("change", (e) => { if (e.target.files[0]) importar(e.target.files[0]); e.target.value = ""; });
    $("btExportar").addEventListener("click", exportar);

    v.addEventListener("loadedmetadata", aoCarregarMetadados);
    // loadeddata, e nao loadedmetadata: so aqui o primeiro quadro existe para ser desenhado
    v.addEventListener("loadeddata", () => prepararMiniatura(false));
    v.addEventListener("timeupdate", agendarRender);
    v.addEventListener("seeked", () => {
      prepararMiniatura(true);          // aproveita o quadro para onde o usuario foi
      assinatura = ""; agendarRender();
    });
    v.addEventListener("durationchange", () => {
      $("slTempo").max = String(isFinite(v.duration) ? v.duration : 0);
      desenharTiques();
    });
    v.addEventListener("play", () => {
      if (typeof v.requestVideoFrameCallback === "function") v.requestVideoFrameCallback(amostrarFps);
      agendarRender();
    });
    v.addEventListener("pause", agendarRender);
    v.addEventListener("error", () => {
      // Pode não ser o vídeo: um servidor sem Access-Control-Allow-Origin recusa o pedido que
      // saiu com crossorigin. Tentamos de novo sem ele — o vídeo abre, e o preço é o lance
      // desta partida ficar sem retrato, porque o canvas passa a sujar.
      //
      // Só na PRIMEIRA abertura, porém: se este vídeo já abriu com crossorigin, uma falha
      // depois é falha de verdade, e desistir do CORS aqui condenaria as fotos dele à toa.
      if (v.crossOrigin && !semCors && !jaAbriu) {
        semCors = true;
        v.crossOrigin = null;
        v.load();
        return;
      }
      nota("Não consegui abrir esse vídeo (formato não suportado pelo navegador).", true);
    });

    $("slTempo").addEventListener("input", (e) => { v.pause(); irPara(Number(e.target.value)); });
    $("btPlay").addEventListener("click", () => v.paused ? v.play() : v.pause());
    $("btQuadroAnt").addEventListener("click", () => passoQuadro(-1));
    $("btQuadroProx").addEventListener("click", () => passoQuadro(1));
    $("btSegAnt").addEventListener("click", () => { v.pause(); irPara(v.currentTime - 1); });
    $("btSegProx").addEventListener("click", () => { v.pause(); irPara(v.currentTime + 1); });
    $("selVel").addEventListener("change", (e) => { v.playbackRate = Number(e.target.value); });
    $("selFps").addEventListener("change", aplicarFps);

    $("btRecortar").addEventListener("click", entrarRecorte);
    $("btConfirmar").addEventListener("click", () => sairRecorte(true));
    $("btCancelarRec").addEventListener("click", () => sairRecorte(false));
    $("ckTrava").addEventListener("change", () => {
      if (!modoRecorte || !estado.recorte || !$("ckTrava").checked) return;
      const r = travar({ x: RX(), y: RY(), w: RW(), h: RH() }, "horizontal");
      gravarRecorte(r.x, r.y, r.w, r.h);
      assinatura = ""; agendarRender();
    });
    $("ckGrade").addEventListener("change", () => { assinatura = ""; agendarRender(); });

    $("barraFerr").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-ferr]");
      if (b) escolherFerramenta(b.getAttribute("data-ferr"));
    });

    $("slEsp").addEventListener("input", (e) => {
      espessura = Number(e.target.value);
      const a = estado.anotacoes.find(q => q.id === selecionado);
      if (a) { a.esp = a.tipo === "texto" ? corpoTexto(espessura) : espessura; salvar(); }
      atualizarRotuloEsp();
      assinatura = ""; agendarRender();
    });
    $("ckPreench").addEventListener("change", () => {
      const a = estado.anotacoes.find(q => q.id === selecionado);
      if (a) { empilhar(); a.preench = $("ckPreench").checked; salvar(); }
      assinatura = ""; agendarRender();
    });
    $("selTol").addEventListener("change", () => {
      estado.tolPadrao = tolAtual();
      const a = estado.anotacoes.find(q => q.id === selecionado);
      if (a) { empilhar(); a.tol = tolAtual(); }
      salvar(); atualizarPainel(); assinatura = ""; agendarRender();
    });

    $("btDesfazer").addEventListener("click", desfazer);
    $("btRefazer").addEventListener("click", refazer);
    $("btIrSel").addEventListener("click", () => {
      const a = estado.anotacoes.find(q => q.id === selecionado);
      if (a) irPara(a.t);
    });
    $("btRecolocar").addEventListener("click", () => {
      const a = estado.anotacoes.find(q => q.id === selecionado);
      if (!a) return;
      empilhar();
      const antes = chaveLance(a.t);
      a.t = instanteDoLance($("video").currentTime);
      migrarNota(antes, chaveLance(a.t));           // sozinha, a anotacao leva o lance inteiro
      // o lance de origem só perde o retrato quando não sobra desenho nenhum lá
      if (!estado.anotacoes.some(q => chaveLance(q.t) === antes)) apagarRetrato(impressao, antes);
      tirarRetrato(a.t);
      salvar(); atualizarPainel(); assinatura = ""; agendarRender();
    });
    $("btApagarSel").addEventListener("click", () => {
      if (selecionado !== null) remover(selecionado);
    });

    $("btAbrirLateral").addEventListener("click", () => alternarLateral());
    $("btFecharLateral").addEventListener("click", () => alternarLateral(false));
    $("guias").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-guia]");
      if (b) escolherGuia(b.dataset.guia);
    });
    $("btLimparTudo").addEventListener("click", () => {
      if (!estado.anotacoes.length) return;
      // some com os desenhos, não com o trabalho: um lance já anotado ou já movido no quadro
      // vira um card órfão, e só some de lá pela mão do usuário
      if (!confirm(`Apagar as ${estado.anotacoes.length} anotações?` +
                   ` Os lances que já têm anotação ou estágio ficam no quadro de correções,` +
                   ` marcados como órfãos. (dá para desfazer com Ctrl+Z)`)) return;
      empilhar();
      const eram = agruparLances(estado.anotacoes).map(g => g.chave);
      estado.anotacoes = [];
      podarLances(estado.lances);
      // o que não virou card órfão levou o retrato junto: ninguém mais o mostraria
      for (const chave of eram) if (!entradaDe(chave)) apagarRetrato(impressao, chave);
      selecionado = null; lanceAberto = null;
      salvar(); atualizarPainel(); assinatura = ""; agendarRender();
    });

    const tela = $("tela");
    tela.addEventListener("pointerdown", aoPressionar);
    tela.addEventListener("pointermove", aoMover);
    tela.addEventListener("pointerup", aoSoltar);
    tela.addEventListener("pointercancel", aoSoltar);
    tela.addEventListener("contextmenu", (e) => { if (modoRecorte) e.preventDefault(); });

    // observa a area, nao o palco: o palco e absoluto e nao influi no tamanho dela,
    // entao nao ha risco de laco entre medir e redimensionar
    new ResizeObserver(() => { ajustarPalco(); assinatura = ""; agendarRender(); }).observe($("grade"));

    document.addEventListener("dragover", (e) => e.preventDefault());
    document.addEventListener("drop", (e) => {
      e.preventDefault();
      const dt = e.dataTransfer;
      const arq = dt && dt.files && dt.files[0];
      if (!arq) return;
      if (/\.json$/i.test(arq.name) || arq.type === "application/json") { importar(arq); return; }
      if (!arq.type.startsWith("video/") && !/\.(mp4|webm|mkv|mov|m4v|ogv)$/i.test(arq.name)) {
        return nota("Arraste um vídeo ou um .json de anotações.", true);
      }
      // o handle tem de ser pedido AGORA: o dataTransfer e esvaziado no fim do evento
      const item = dt.items && dt.items[0];
      const pedido = item && typeof item.getAsFileSystemHandle === "function"
        ? item.getAsFileSystemHandle().catch(() => null)
        : Promise.resolve(null);
      pedido.then((h) => carregarVideo(arq, h && h.kind === "file" ? h : null));
    });

    document.addEventListener("keydown", (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;

      // a lateral recolhe mesmo sem video aberto, por isso vem antes da barreira do vw
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault(); alternarLateral(); return;
      }
      if (!vw) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); desfazer(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); refazer(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // sem recorte a barra de ferramentas nem esta na tela, e no modo recorte ela nao vale
      const atalho = ATALHOS[e.key.toLowerCase()];
      if (atalho && estado.recorte && !modoRecorte) { e.preventDefault(); escolherFerramenta(atalho); return; }

      if (e.key === "ArrowLeft")  { e.preventDefault(); e.shiftKey ? (v.pause(), irPara(v.currentTime - 1)) : passoQuadro(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); e.shiftKey ? (v.pause(), irPara(v.currentTime + 1)) : passoQuadro(1); }
      else if (e.key === " ") { e.preventDefault(); v.paused ? v.play() : v.pause(); }
      else if ((e.key === "Delete" || e.key === "Backspace") && selecionado !== null) { e.preventDefault(); remover(selecionado); }
      else if (e.key === "Escape") {
        if (modoRecorte) sairRecorte(false);
        else if (ferramenta !== "selecionar") voltarParaSelecao();
        else { selecionado = null; atualizarSelecao(); assinatura = ""; agendarRender(); }
      }
    });

    // fechar a aba nao pode comer a ultima edicao presa no atraso de 400 ms
    window.addEventListener("pagehide", salvarPendente);

    // O quadro de correções mexe no MESMO registro deste vídeo, de outra aba. Como aqui o
    // estado inteiro é regravado com 400 ms de atraso, sem isto a próxima gravação daqui
    // desfaria o que foi movido lá. Adotamos só o campo 'lances': os desenhos podem estar
    // sendo editados neste instante, e quem manda neles é esta página.
    window.addEventListener("storage", (e) => {
      if (!impressao || e.key !== CHAVE + impressao || !e.newValue) return;
      let novo = null;
      try { novo = JSON.parse(e.newValue); } catch (err) { return; }
      if (!novo || !novo.lances || typeof novo.lances !== "object") return;
      estado.lances = novo.lances;
      atualizarPainel();
      assinatura = ""; agendarRender();
    });

    // com o seletor da File System Access API o arquivo pode ser reaberto depois do F5;
    // sem ele, resta o <input type=file> de sempre
    $("btEscolher").hidden = !temPicker;
    $("arqVideo").hidden = temPicker;
    $("dicaBiblio").textContent = temPicker
      ? "Os vídeos abertos ficam nesta lista e sobrevivem ao F5. Na primeira vez depois de reabrir a página o navegador pede permissão para ler o arquivo de novo."
      : "Os vídeos abertos ficam nesta lista. Neste navegador o arquivo não pode ser reaberto sozinho: ao clicar, localize-o no disco — as anotações voltam sozinhas.";

    montarCores();
    biblioteca = lerBiblioteca();
    desenharBiblioteca();
    // sem nenhum vídeo salvo ainda, a lateral se abre já mostrando por onde começar
    let recolhida = false;
    try { recolhida = localStorage.getItem(CHAVE_LATERAL) === "1"; } catch (err) {}
    $("app").classList.toggle("recolhida", recolhida);
    $("menuAdd").open = biblioteca.length === 0;
    let guiaSalva = "videos";
    try { guiaSalva = localStorage.getItem(CHAVE_GUIA) || "videos"; } catch (err) {}
    escolherGuia(guiaSalva === "lances" ? "lances" : "videos");
    atenderAlvo();          // por último: precisa da biblioteca lida e das guias montadas
    atualizarRotuloEsp();
    atualizarBotoesHist();
    ligarPainelBot();
  }

  ligar();
})();
