# Analisador de vídeo da partida

Ferramenta local para desenhar sobre o vídeo de uma partida do Lugo. As anotações ficam em
unidades reais do campo (`0..20000 × 0..10000`), presas ao instante em que foram feitas, e são
guardadas no próprio navegador — nada sobe para lugar nenhum.

## Como abrir

São duas formas, e elas não entregam a mesma coisa.

**No site publicado** (GitHub Pages, ou o `index.html` aberto direto do disco) — abrir o vídeo,
desenhar, exportar e importar anotações funciona tudo. O painel **"Partidas do bot" não
aparece**: ele depende de um servidor, e o Pages serve só arquivo estático.

**Na sua máquina, com o servidor** — é o único jeito de ter as partidas:

```
node servidor.js            # http://127.0.0.1:4173
node servidor.js --porta 8080
```

Deixe o terminal aberto enquanto usa e abra o endereço que ele imprimir. O `servidor.js` roda
**local**, no seu computador: não há nada para publicar nem para hospedar, e ele não é usado
pela versão que está no ar.

## Partidas do bot

Digite o nome do bot na barra lateral e as cinco partidas mais recentes dele aparecem com
placar, adversário e data. Um clique abre a gravação — de forma **passageira**: a partida não
entra na lista de vídeos. Para guardá-la, passe o mouse pela linha e clique no **+** azul que
cobre o placar (funciona mesmo sem abrir a partida). As anotações, essas ficam guardadas de
qualquer jeito e voltam sozinhas quando a mesma partida for aberta de novo, porque a chave
delas é a URL do MP4.

Quem faz a raspagem é o Node, não a página: o lugobots.ai não manda
`Access-Control-Allow-Origin`, então um `fetch` do navegador para lá seria bloqueado. É por isso
que o painel não vai junto para o Pages — sem um processo Node de pé, não há de onde os dados
virem. A página sonda `api/saude` ao abrir; quando não encontra, esconde o painel e segue sem
reclamar. O servidor guarda cada resposta por 60 segundos para não bater no site a cada F5.

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
| `index.html`, `styles.css`, `app.js` | o analisador — não tem build nem dependência; é isto que vai para o Pages |
| `servidor.js` | só local: serve esta pasta e expõe `/api/partidas?bot=NOME&n=5` |
| `lugo/partidas.js` | só local: a raspagem do lugobots.ai; também roda sozinho pelo terminal |
