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

## Lances

Tudo o que é desenhado num mesmo instante do vídeo é **um lance** — parar no quadro e marcar o
passe, o adversário e a zona são três desenhos e um lance só. A guia **Lances**, no alto da barra
lateral, reúne todos eles em ordem: cada linha mostra a hora, o que há ali e leva o vídeo de
volta àquele momento com um clique. O **✎** abre uma anotação escrita para o lance, que aparece
na própria linha e vai junto no `Exportar JSON`. Na régua abaixo do vídeo cada tique passa a ser
um lance, e os que têm anotação ganham um anel em volta.

Um lance não é um registro à parte: ele nasce do primeiro desenho daquele instante e some com o
último. Por isso um desenho novo que caia a menos de meio quadro de outro adota o instante dele —
sem isso, a imprecisão do `seek` partiria o mesmo quadro em dois lances.

## Quadro de correções

Todo lance é uma melhoria em potencial no bot. A página `kanban.html` — o link **Quadro** no
alto do analisador — junta os lances de **todas as partidas** guardadas e os organiza em cinco
colunas: **Análise**, **Desenvolvimento**, **Testes**, **Resolvido** e **Arquivados**.

Cada card traz o instante, a partida, a anotação e o que foi desenhado ali. Dá para arrastá-lo
entre as colunas (ou usar as setas `◀ ▶`, que funcionam no toque e no teclado), marcar a
**prioridade**, escrever a anotação sem sair do quadro e voltar ao vídeo naquele exato instante
pelo `↗`. O filtro de cima abre mostrando só o que já tem trabalho — anotação, prioridade ou
estágio; desligue-o para ver também os rabiscos de análise.

Cada card mostra uma **foto do lance**: o quadro do vídeo recortado no campo, com os desenhos
daquele instante por cima. Ela é tirada pelo analisador na hora em que você desenha — sai do
`<video>` e do próprio SVG que já está na tela, custa ~8 KB e mora no IndexedDB, ao lado das
miniaturas.

Lance marcado **antes desta versão** não tem foto: ela é tirada quando o lance é criado ou
alterado, e ninguém volta no tempo. O acervo antigo se preenche à medida que você o revisita —
abra o vídeo e clique no lance (na guia Lances, na régua de tiques ou pelo `↗` do card): ao
chegar nele, o analisador vê que falta foto e espera as duas condições que ela exige (quadro já
decodificado e cursor parado no instante do lance) antes de disparar. Um lance que o navegador
não deixa fotografar aparece sem imagem, e o card continua inteiro.

É por isso, também, que a **miniatura da lista de vídeos** não dá mais o pulo até os 3 s que
dava: ela mexia no cursor por baixo de quem estava usando o vídeo — inclusive da foto do lance,
que saía do quadro errado ou nem saía. Agora ela sai do quadro que já está na tela, e melhora
sozinha na primeira vez que você vai a um ponto adiante do primeiro segundo.

O empecilho é o CORS: um `<canvas>` que recebe um quadro de vídeo de outra origem fica "sujo" e
não pode mais ser lido. Por isso o vídeo aberto por link é pedido com `crossorigin`, e, se o
servidor dele não mandar `Access-Control-Allow-Origin`, o analisador refaz o pedido sem o
atributo: a partida abre igual, só fica sem foto (e o navegador registra no console o primeiro
pedido recusado). Vídeo do disco vem por `blob:`, é sempre da mesma origem e nunca cai nisso.

Um card **órfão** é um lance cujos desenhos foram apagados no analisador. Ele fica, marcado,
até você arquivá-lo ou descartá-lo: o que já foi escrito e movido não some sozinho. O `✕` da
guia Lances, esse sim, apaga o lance inteiro de propósito — desenhos, anotação e card.

Não há banco novo. O quadro é uma leitura transversal do que cada vídeo já guarda em
`localStorage`, e mover um card só reescreve o campo `lances` daquele vídeo — por isso tudo
continua viajando no `Exportar JSON`. As duas páginas podem ficar abertas lado a lado: elas
ouvem o evento `storage` e uma adota o que a outra mudou, sem gravar por cima.

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

As cinco primeiras linhas são o site inteiro: sem build e sem dependência, é o que vai para o
Pages. As duas últimas só existem na sua máquina.

| | |
|---|---|
| `index.html`, `app.js` | o analisador de vídeo |
| `kanban.html`, `kanban.js` | o quadro de correções, que lê os lances de todas as partidas |
| `comum.js`, `styles.css` | o que as duas páginas dividem: chaves do armazenamento, a identidade de um lance, o vocabulário do quadro e a folha de estilo |
| `servidor.js` | só local: serve esta pasta e expõe `/api/partidas?bot=NOME&n=5` |
| `lugo/partidas.js` | só local: a raspagem do lugobots.ai; também roda sozinho pelo terminal |
