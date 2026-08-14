"use strict";

// Servidor local do analisador. Faz duas coisas:
//
//   1. serve os arquivos desta pasta (index.html, app.js, styles.css);
//   2. expõe /api/partidas?bot=NOME, que é a raspagem do lugo/partidas.js.
//
// O passo 2 é o motivo de existir: o lugobots.ai não manda Access-Control-Allow-Origin, então
// a página sozinha não consegue ler o site — quem lê é o Node, aqui. Abrir o index.html direto
// pelo file:// continua funcionando; só o painel "Partidas do bot" some.
//
//   node servidor.js [--porta 4173]

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { ultimasPartidas } = require("./lugo/partidas");

const RAIZ = __dirname;
const PADRAO = 4173;
const VALIDADE_CACHE = 60_000;   // o histórico do bot muda em minutos, não em segundos

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const cache = new Map();         // "slug|n" -> { quando, dados }

function responder(res, status, dados) {
  const corpo = JSON.stringify(dados);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(corpo),
    "Cache-Control": "no-store"
  });
  res.end(corpo);
}

async function apiPartidas(url, res) {
  const bot = (url.searchParams.get("bot") || "").trim();
  const limite = Math.max(1, Math.min(10, Number(url.searchParams.get("n")) || 5));
  if (!bot) return responder(res, 400, { erro: "Informe o nome do bot." });

  const chave = `${bot.toLowerCase()}|${limite}`;
  const guardado = cache.get(chave);
  if (guardado && Date.now() - guardado.quando < VALIDADE_CACHE) {
    return responder(res, 200, guardado.dados);
  }

  try {
    const dados = await ultimasPartidas(bot, { limite });
    cache.set(chave, { quando: Date.now(), dados });
    responder(res, 200, dados);
  } catch (err) {
    // vários bots batendo com o texto digitado não é erro de verdade: a página mostra a lista
    if (err.candidatos) return responder(res, 409, { erro: err.message, candidatos: err.candidatos });
    console.error(`[api] ${bot}: ${err.message}`);
    responder(res, 502, { erro: err.message });
  }
}

function servirArquivo(caminhoUrl, res) {
  const relativo = decodeURIComponent(caminhoUrl === "/" ? "/index.html" : caminhoUrl);
  const alvo = path.resolve(RAIZ, "." + relativo);
  // ninguém sai desta pasta por ../ nem por caminho absoluto
  if (alvo !== RAIZ && !alvo.startsWith(RAIZ + path.sep)) {
    res.writeHead(403).end("403");
    return;
  }
  fs.readFile(alvo, (err, dados) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Não encontrado"); return; }
    res.writeHead(200, {
      "Content-Type": TIPOS[path.extname(alvo).toLowerCase()] || "application/octet-stream",
      "Content-Length": dados.length,
      "Cache-Control": "no-cache"
    });
    res.end(dados);
  });
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, "http://local");
  if (req.method !== "GET") { res.writeHead(405).end(); return; }
  if (url.pathname === "/api/saude") return responder(res, 200, { ok: true });
  if (url.pathname === "/api/partidas") return void apiPartidas(url, res);
  servirArquivo(url.pathname, res);
});

const i = process.argv.indexOf("--porta");
const porta = Number(i > -1 && process.argv[i + 1]) || Number(process.env.PORT) || PADRAO;

servidor.listen(porta, "127.0.0.1", () => {
  console.log(`Analisador em http://127.0.0.1:${porta}  (Ctrl+C para parar)`);
});

servidor.on("error", (err) => {
  console.error(err.code === "EADDRINUSE"
    ? `A porta ${porta} já está ocupada — tente: node servidor.js --porta ${porta + 1}`
    : err.message);
  process.exit(1);
});
