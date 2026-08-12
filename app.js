(() => {
  "use strict";

  // Medidas reais do campo do Lugo (espelham lugo4py/src/specs.py e o visualizador_campo.html).
  const MAX_X = 20000, MAX_Y = 10000, GOL_MIN_Y = 3500, GOL_MAX_Y = 6500;
  const RAIO_JOGADOR = 200;                 // PLAYER_SIZE / 2
  const RAZAO_CAMPO = MAX_X / MAX_Y;        // 2.0
  const LIM_MIN = -6000, LIM_MAX_X = MAX_X + 6000, LIM_MAX_Y = MAX_Y + 6000;
  const CHAVE = "analisador_video:v1:";
  const CHAVE_BIB = "analisador_video:v1:biblioteca";
  const CHAVE_LATERAL = "analisador_video:v1:lateral";
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

  function novoEstado() {
    return { versao: VERSAO, video: null, recorte: null, tolPadrao: 0.5, anotacoes: [] };
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

  function fmtTempo(t) {
    if (!isFinite(t)) return "0:00.000";
    const m = Math.floor(t / 60), s = Math.floor(t % 60), ms = Math.floor((t % 1) * 1000);
    return `${m}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
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
    pilhaDesfazer = []; pilhaRefazer = [];

    $("selTol").value = String(estado.tolPadrao);
    const v = $("video");
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

  function carregarVideoUrl(url) {
    const limpa = String(url || "").trim();
    if (!limpa) return nota("Informe um link de vídeo válido.", true);
    try { new URL(limpa); } catch (_) { return nota("O link do vídeo não parece ser uma URL válida.", true); }
    carregarVideoPorFonte({
      src: limpa,
      revogavel: false,
      nome: limpa,
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
    $("painelRecorte").hidden = false;
    $("grade").hidden = false;
    $("btExportar").disabled = false;
    ajustarPalco();                     // so depois de a area sair do hidden e ter tamanho

    amostrasFps = []; ultimoMediaTime = null; fpsDetectado = null;
    lembrarVideo();
    aplicarFps();
    atualizarRecorteUI();
    atualizarPainel();
    agendarRender();
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
    if (tipo === "mover" || tipo === "vertice" || tipo === "escala") { salvar(); atualizarPainel(); }
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
      id: seq++, t: a.t ?? $("video").currentTime, tol: a.tol ?? tolAtual(),
      tipo: a.tipo, cor: a.cor ?? cor, esp: a.esp ?? espessura,
      pts: a.pts, texto: a.texto, numero: a.numero,
      preench: a.preench ?? $("ckPreench").checked
    };
    estado.anotacoes.push(nova);
    selecionado = nova.id;
    salvar();
    atualizarPainel();
    assinatura = "";
    agendarRender();
  }

  function remover(id) {
    empilhar();
    estado.anotacoes = estado.anotacoes.filter(a => a.id !== id);
    if (selecionado === id) selecionado = null;
    salvar();
    atualizarPainel();
    assinatura = "";
    agendarRender();
  }

  function empilhar() {
    pilhaDesfazer.push(JSON.stringify(estado.anotacoes, serializar));
    if (pilhaDesfazer.length > 50) pilhaDesfazer.shift();
    pilhaRefazer = [];
    atualizarBotoesHist();
  }

  function desfazer() {
    if (!pilhaDesfazer.length) return;
    pilhaRefazer.push(JSON.stringify(estado.anotacoes, serializar));
    estado.anotacoes = JSON.parse(pilhaDesfazer.pop(), desserializar);
    depoisDoHistorico();
  }

  function refazer() {
    if (!pilhaRefazer.length) return;
    pilhaDesfazer.push(JSON.stringify(estado.anotacoes, serializar));
    estado.anotacoes = JSON.parse(pilhaRefazer.pop(), desserializar);
    depoisDoHistorico();
  }

  function depoisDoHistorico() {
    if (!estado.anotacoes.some(a => a.id === selecionado)) selecionado = null;
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
    $("resumo").innerHTML = estado.video
      ? `<b>${escapar(estado.video.nome)}</b> · ${vw}×${vh} · ${dur ? fmtTempo(dur) : "—"}` +
        ` · ${fps} q/s · <b>${estado.anotacoes.length}</b> anotação(ões)`
      : "";
    atualizarRotuloEsp();
    atualizarSelecao();
    desenharTiques();
  }

  // As acoes que eram os botoes de cada linha da tabela: aparecem so quando ha selecao,
  // e coladas no video, que e onde o olho ja esta.
  function atualizarSelecao() {
    const a = estado.anotacoes.find(q => q.id === selecionado);
    $("selInfo").hidden = !a;
    $("btIrSel").disabled = !a;
    if (!a) return;
    $("selCor").style.background = a.cor;
    $("selTipo").textContent = a.tipo;
    $("selTempo").textContent = `${fmtTempo(a.t)} · ${fmtTol(tolDe(a))}`;
  }

  function desenharTiques() {
    const faixa = $("tiques");
    faixa.textContent = "";
    const dur = $("video").duration;
    if (!isFinite(dur) || dur <= 0) return;
    for (const a of estado.anotacoes) {
      const s = document.createElement("span");
      s.className = "tique";
      s.style.left = `${clamp(a.t / dur, 0, 1) * 100}%`;
      s.style.background = a.cor;
      s.title = `${fmtTempo(a.t)} · ${a.tipo}`;
      s.addEventListener("click", () => {
        selecionado = a.id; irPara(a.t); atualizarPainel(); assinatura = ""; agendarRender();
      });
      faixa.appendChild(s);
    }
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
      return (s && Array.isArray(s.anotacoes)) ? s : null;
    } catch (err) { return null; }
  }

  // ------------------------------------------------------------------ biblioteca de videos
  // O navegador nao deixa um site guardar o caminho de um arquivo do disco: um File vindo de
  // <input type=file> morre junto com a aba. Quem sobrevive ao F5 e o FileSystemFileHandle
  // da File System Access API — e ele so cabe no IndexedDB, que guarda objetos, nao texto.
  // Onde essa API nao existe (Firefox, Safari) a lista continua valendo, mas reabrir um
  // arquivo pede que o usuario o localize de novo; as anotacoes voltam sozinhas porque a
  // chave delas e a impressao digital nome|tamanho|modificado, que nao muda.
  const BD = "analisador_video", LOJA = "handles", MAX_BIB = 24;
  const temPicker = typeof window.showOpenFilePicker === "function";

  function comBanco(modo, fn) {
    return new Promise((ok, falha) => {
      const req = indexedDB.open(BD, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(LOJA);
      req.onerror = () => falha(req.error);
      req.onsuccess = () => {
        const bd = req.result;
        try {
          const tx = bd.transaction(LOJA, modo);
          const p = fn(tx.objectStore(LOJA));
          tx.oncomplete = () => { bd.close(); ok(p ? p.result : undefined); };
          tx.onerror = () => { bd.close(); falha(tx.error); };
        } catch (err) { bd.close(); falha(err); }
      };
    });
  }

  const guardarHandle = (imp, h) => comBanco("readwrite", (l) => l.put(h, imp));
  const lerHandle = (imp) => comBanco("readonly", (l) => l.get(imp)).catch(() => null);
  const apagarHandle = (imp) => comBanco("readwrite", (l) => l.delete(imp)).catch(() => {});

  function lerBiblioteca() {
    try {
      const b = JSON.parse(localStorage.getItem(CHAVE_BIB) || "[]");
      return Array.isArray(b) ? b.filter(x => x && x.imp && x.nome) : [];
    } catch (err) { return []; }
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
      comHandle: !!(antigo && antigo.comHandle)     // um handle ja guardado continua valendo
    };
    const sobra = [it, ...biblioteca.filter(x => x.imp !== it.imp)];
    for (const velho of sobra.slice(MAX_BIB)) apagarHandle(velho.imp);
    biblioteca = sobra.slice(0, MAX_BIB);
    salvarBiblioteca();
    desenharBiblioteca();

    if (handle) {
      guardarHandle(it.imp, handle)
        .then(() => { it.comHandle = true; salvarBiblioteca(); desenharBiblioteca(); })
        .catch(() => {});
    }
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
    salvarBiblioteca();
    apagarHandle(it.imp);
    desenharBiblioteca();
    nota(`"${it.nome}" saiu da lista — as anotações dele continuam guardadas.`);
  }

  function desenharBiblioteca() {
    const faixa = $("biblio");
    faixa.textContent = "";
    $("painelBiblio").hidden = biblioteca.length === 0;
    for (const it of biblioteca) {
      const d = document.createElement("div");
      d.className = "item" + (it.imp === impressao ? " atual" : "");

      const b = document.createElement("button");
      b.textContent = it.nome;          // o corte fica com o CSS, que sabe a largura real
      b.title = [
        it.nome,
        it.origem === "url" ? "link" : "arquivo do disco",
        it.duracao ? fmtTempo(it.duracao) : null,
        it.origem === "url" || it.comHandle ? "abre direto" : "vai pedir para localizar o arquivo"
      ].filter(Boolean).join(" · ");
      b.addEventListener("click", () => abrirDaBiblioteca(it));

      const x = document.createElement("button");
      x.className = "fechar";
      x.textContent = "✕";
      x.title = "Tirar da lista (as anotações continuam guardadas)";
      x.addEventListener("click", () => esquecerVideo(it));

      d.append(b, x);
      faixa.appendChild(d);
    }
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
        anotacoes: s.anotacoes
      };
      seq = estado.anotacoes.reduce((m, a) => Math.max(m, a.id || 0), 0) + 1;
      selecionado = null; pilhaDesfazer = []; pilhaRefazer = [];
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
    $("btImportar").addEventListener("click", () => $("arqJson").click());
    $("arqJson").addEventListener("change", (e) => { if (e.target.files[0]) importar(e.target.files[0]); e.target.value = ""; });
    $("btExportar").addEventListener("click", exportar);

    v.addEventListener("loadedmetadata", aoCarregarMetadados);
    v.addEventListener("timeupdate", agendarRender);
    v.addEventListener("seeked", () => { assinatura = ""; agendarRender(); });
    v.addEventListener("durationchange", () => {
      $("slTempo").max = String(isFinite(v.duration) ? v.duration : 0);
      desenharTiques();
    });
    v.addEventListener("play", () => {
      if (typeof v.requestVideoFrameCallback === "function") v.requestVideoFrameCallback(amostrarFps);
      agendarRender();
    });
    v.addEventListener("pause", agendarRender);
    v.addEventListener("error", () => nota("Não consegui abrir esse vídeo (formato não suportado pelo navegador).", true));

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
      a.t = $("video").currentTime;
      salvar(); atualizarPainel(); assinatura = ""; agendarRender();
    });
    $("btApagarSel").addEventListener("click", () => {
      if (selecionado !== null) remover(selecionado);
    });

    $("btAbrirLateral").addEventListener("click", () => alternarLateral());
    $("btFecharLateral").addEventListener("click", () => alternarLateral(false));
    $("btLimparTudo").addEventListener("click", () => {
      if (!estado.anotacoes.length) return;
      if (!confirm(`Apagar as ${estado.anotacoes.length} anotações? (dá para desfazer com Ctrl+Z)`)) return;
      empilhar();
      estado.anotacoes = []; selecionado = null;
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
    atualizarRotuloEsp();
    atualizarBotoesHist();
  }

  ligar();
})();
