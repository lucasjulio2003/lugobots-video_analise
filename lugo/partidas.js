"use strict";

// Raspagem das últimas partidas de um bot no lugobots.ai.
//
// O site é renderizado no servidor (Laravel + Blade), então basta ler o HTML — não há API
// pública nem JSON embutido. Em compensação ele não manda Access-Control-Allow-Origin, e por
// isso este módulo roda no Node (via servidor.js), nunca no navegador.
//
// Três passos: achar o slug do bot pela busca, ler a primeira página dele (que já traz as 10
// partidas mais recentes, da mais nova para a mais velha) e confirmar o MP4 de cada partida.

const BASE = "https://lugobots.ai";
const VIDEOS = "https://storage.googleapis.com/lugobots-prod-videos";
const AGENTE = "analisador-video-lugo/1.0 (ferramenta local de análise de partidas)";
const TEMPO_LIMITE = 15000;

// ------------------------------------------------------------------ HTML cru
const ENTIDADES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  middot: "·", times: "×", ndash: "–", mdash: "—"
};

function decodificar(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (todo, ent) => {
    if (ent[0] === "#") {
      const n = ent[1].toLowerCase() === "x"
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : todo;
    }
    const t = ENTIDADES[ent.toLowerCase()];
    return t === undefined ? todo : t;
  });
}

const texto = (html) =>
  decodificar(String(html).replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

// nomes de bot chegam do usuário com acento, maiúscula e hífen à vontade
const normalizar = (s) => String(s || "")
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, "");

const primeiro = (html, re) => {
  const m = html.match(re);
  return m ? m[1] : null;
};

async function baixar(url) {
  let r;
  try {
    r = await fetch(url, {
      headers: { "User-Agent": AGENTE, "Accept-Language": "en" },
      redirect: "follow",
      signal: AbortSignal.timeout(TEMPO_LIMITE)
    });
  } catch (err) {
    throw new Error(`Não consegui falar com o lugobots.ai (${err.message}).`);
  }
  if (!r.ok) throw new Error(`O lugobots.ai respondeu ${r.status} em ${url}.`);
  return r.text();
}

// ------------------------------------------------------------------ achar o bot
// A própria lista de bots aceita ?bot_name=, e o filtro é por trecho do nome — "cor" já
// devolve COR-2012. Só a página do bot tem o histórico, então precisamos do slug antes.
async function procurarBots(consulta) {
  const html = await baixar(`${BASE}/bots?bot_name=${encodeURIComponent(consulta)}`);
  const achados = new Map();
  const re = /<a class="bot-link" href="[^"]*\/bots\/([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    if (!achados.has(m[1])) achados.set(m[1], { slug: m[1], nome: texto(m[2]) || m[1] });
  }
  return [...achados.values()];
}

class AmbiguoErro extends Error {
  constructor(candidatos) {
    super(`Mais de um bot bate com esse nome: ${candidatos.map(c => c.nome).join(", ")}.`);
    this.name = "AmbiguoErro";
    this.candidatos = candidatos;
  }
}

async function resolverBot(nome) {
  const alvo = normalizar(nome);
  if (!alvo) throw new Error("Informe o nome do bot.");

  const candidatos = await procurarBots(String(nome).trim());
  // um nome escrito por inteiro vence a busca por trecho: "gelado" não pode virar "gelado-2"
  const exato = candidatos.find(c => normalizar(c.nome) === alvo || normalizar(c.slug) === alvo);
  if (exato) return exato;
  if (candidatos.length === 1) return candidatos[0];
  if (candidatos.length > 1) throw new AmbiguoErro(candidatos);
  throw new Error(`Não achei nenhum bot chamado "${String(nome).trim()}" no lugobots.ai.`);
}

// ------------------------------------------------------------------ ler as partidas
// Cada partida é um <div class="matche-items ...> com o time da casa, o placar, o time de
// fora e um rodapé com a data. Cortar o HTML nesse marcador é o que mantém cada campo preso
// à partida certa — uma varredura de regex sobre a página inteira embaralharia tudo.
function partirBlocos(html) {
  return html.split(/<div class="matche-items\s/).slice(1);
}

function botDe(html) {
  const m = html.match(/<a class="bot-link" href="[^"]*\/bots\/([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/i);
  return m ? { slug: m[1], nome: texto(m[2]) || m[1] } : null;
}

function lerBloco(bloco) {
  const iFora = bloco.indexOf("matche-items__team--away");
  if (iFora < 0) return null;
  const casa = botDe(bloco.slice(0, iFora));
  const fora = botDe(bloco.slice(iFora));
  if (!casa || !fora) return null;

  const assistir = primeiro(bloco, /href="([^"]*\/matches\/[0-9a-f-]{36}\/watch)"/i);
  const id = primeiro(bloco, /data-match-id="([0-9a-f-]{36})"/i)
    || (assistir && primeiro(assistir, /\/matches\/([0-9a-f-]{36})\//i));
  if (!id) return null;

  const placar = texto(primeiro(bloco, /matche-items__score-value"[^>]*>([\s\S]*?)<\/p>/i) || "");
  const gols = placar.match(/(\d+)\D+(\d+)/);

  return {
    id,
    data: primeiro(bloco, /display_local_datetime"[^>]*>([\s\S]*?)</i),
    casa,
    fora,
    golsCasa: gols ? Number(gols[1]) : null,
    golsFora: gols ? Number(gols[2]) : null,
    situacao: texto(primeiro(bloco, /matche-items__status-pill[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || ""),
    // "Challenged by COR-2012 team" ou o nome do campeonato, conforme o tipo do jogo
    contexto: decodificar(primeiro(bloco, /<!-- Game type -->[\s\S]{0,400}?<p title="([^"]*)"/i) || "") || null,
    paginaUrl: assistir || `${BASE}/matches/${id}/watch`
  };
}

// Com o bot como referência: quem é o adversário, quantos gols saíram de cada lado e no que deu.
function orientar(p, slug) {
  const emCasa = p.casa.slug === slug;
  const pro = emCasa ? p.golsCasa : p.golsFora;
  const contra = emCasa ? p.golsFora : p.golsCasa;
  return {
    ...p,
    mando: emCasa ? "casa" : "fora",
    adversario: emCasa ? p.fora : p.casa,
    golsPro: pro,
    golsContra: contra,
    resultado: pro === null || contra === null ? null
      : pro > contra ? "vitória" : pro < contra ? "derrota" : "empate"
  };
}

// ------------------------------------------------------------------ o vídeo da partida
// O MP4 é público e o nome do arquivo é o id da partida — dá para montar a URL sem abrir a
// página. Confirmamos com um HEAD porque nem toda partida tem gravação; se o palpite falhar,
// aí sim vale abrir a página e ler o <video src>.
async function acharVideo(p) {
  const palpite = `${VIDEOS}/${p.id}.mp4`;
  try {
    const r = await fetch(palpite, { method: "HEAD", signal: AbortSignal.timeout(TEMPO_LIMITE) });
    if (r.ok) return { video: palpite, bytes: Number(r.headers.get("content-length")) || null };
  } catch (err) { /* rede instável ou arquivo ausente: cai para a página da partida */ }

  try {
    const html = await baixar(p.paginaUrl);
    const src = primeiro(html, /<video[^>]*\ssrc="([^"]+)"/i)
      || primeiro(html, /<source[^>]*\ssrc="([^"]+)"/i);
    if (src) return { video: decodificar(src), bytes: null };
  } catch (err) { /* idem */ }

  return { video: null, bytes: null };
}

/**
 * Últimas partidas de um bot.
 * @param {string} nome        nome ou slug do bot ("COR-2012", "cor2012")
 * @param {object} [opcoes]
 * @param {number} [opcoes.limite=5]        quantas partidas devolver
 * @param {boolean} [opcoes.comVideo=true]  confirmar o MP4 de cada partida
 * @returns {Promise<{bot:object, partidas:object[]}>}
 */
async function ultimasPartidas(nome, opcoes = {}) {
  const limite = Math.max(1, Math.min(10, Number(opcoes.limite) || 5));
  const comVideo = opcoes.comVideo !== false;

  const bot = await resolverBot(nome);
  const html = await baixar(`${BASE}/bots/${bot.slug}`);
  // a página já vem da partida mais recente para a mais antiga
  const partidas = partirBlocos(html)
    .map(lerBloco)
    .filter(Boolean)
    .map(p => orientar(p, bot.slug))
    .slice(0, limite);

  if (comVideo) {
    const videos = await Promise.all(partidas.map(acharVideo));
    partidas.forEach((p, i) => Object.assign(p, videos[i]));
  }

  return { bot: { ...bot, url: `${BASE}/bots/${bot.slug}` }, partidas };
}

module.exports = { ultimasPartidas, procurarBots, resolverBot, AmbiguoErro, BASE };

// ------------------------------------------------------------------ linha de comando
// node lugo/partidas.js COR-2012 [quantas] [--json]
if (require.main === module) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const livres = args.filter(a => !a.startsWith("--"));
  const nome = livres[0];

  if (!nome) {
    console.error("uso: node lugo/partidas.js <nome-do-bot> [quantas=5] [--json]");
    process.exit(2);
  }

  ultimasPartidas(nome, { limite: Number(livres[1]) || 5 }).then(({ bot, partidas }) => {
    if (json) return console.log(JSON.stringify({ bot, partidas }, null, 2));
    console.log(`${bot.nome} · ${bot.url}`);
    for (const p of partidas) {
      const dia = p.data ? new Date(p.data).toLocaleString("pt-BR") : "sem data";
      console.log(
        `\n  ${p.casa.nome} ${p.golsCasa} × ${p.golsFora} ${p.fora.nome}  (${p.resultado || "?"})` +
        `\n  ${dia}${p.contexto ? ` · ${p.contexto}` : ""}` +
        `\n  ${p.video || "sem vídeo"}`
      );
    }
  }).catch((err) => {
    console.error(err.message);
    if (err.candidatos) console.error(err.candidatos.map(c => `  ${c.nome} (${c.slug})`).join("\n"));
    process.exit(1);
  });
}
