# Analisador de vídeo da partida

Ferramenta local para desenhar sobre o vídeo de uma partida do Lugo. As anotações ficam em
unidades reais do campo (`0..20000 × 0..10000`), presas ao instante em que foram feitas, e são
guardadas no próprio navegador — nada sobe para lugar nenhum.

## Como abrir

**Com as partidas do lugobots.ai** (recomendado):

```
node servidor.js            # http://127.0.0.1:4173
node servidor.js --porta 8080
```

**Sem elas:** abra o `index.html` direto no navegador. Tudo funciona igual; só o painel
"Partidas do bot" não aparece.

## Partidas do bot

Digite o nome do bot na barra lateral e as cinco partidas mais recentes dele aparecem com
placar, adversário e data. Um clique abre a gravação da partida no analisador — e as anotações
voltam sozinhas quando a mesma partida for aberta de novo, porque a chave delas é a URL do MP4.

Quem faz a raspagem é o Node, não a página: o lugobots.ai não manda
`Access-Control-Allow-Origin`, então um `fetch` do navegador para lá seria bloqueado. O servidor
guarda cada resposta por 60 segundos para não bater no site a cada F5.

O mesmo módulo funciona pela linha de comando:

```
node lugo/partidas.js COR-2012          # as 5 últimas, legíveis
node lugo/partidas.js COR-2012 10 --json
```

Se o texto digitado bater com mais de um bot, os dois lados devolvem a lista de candidatos em
vez de escolher por conta própria.

## Arquivos

| | |
|---|---|
| `index.html`, `styles.css`, `app.js` | o analisador — não tem build nem dependência |
| `servidor.js` | serve esta pasta e expõe `/api/partidas?bot=NOME&n=5` |
| `lugo/partidas.js` | a raspagem do lugobots.ai; também roda sozinho pelo terminal |
