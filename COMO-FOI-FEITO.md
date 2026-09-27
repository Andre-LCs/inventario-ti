# Inventário TI — como tudo foi feito

Relato completo, passo a passo, de como o app de inventário saiu do prompt original e virou o sistema que a equipe usa hoje: decisões, código, testes, importação da planilha, implantação e os problemas que apareceram no caminho.

## Ficha do projeto

| Item | Valor |
|---|---|
| App em produção | **https://inventario-ti-datenbomb.netlify.app** |
| Hospedagem | Netlify, equipe **Dataprev**, projeto **inventario-ti-datenbomb** (criado como `glittery-hamster-61e213` e renomeado) |
| Versão 1 (antiga, só local) | `calm-bonbon-a427dd.netlify.app` |
| Planilha da equipe | Google Sheets **"Inventário TI - Equipe"**, abas **Inventário**, **Excluídos** e **Revisar** |
| Back-end | Google Apps Script vinculado à planilha, publicado como **App da Web** (URL `https://script.google.com/macros/s/…/exec`, não publicada aqui) |
| Chave da equipe | definida pela equipe no `Codigo.gs` e no `config.js` de produção; **não** está neste repositório |
| Data da migração | 24/09/2026 (primeira sincronização às 11:23:35) |
| Custo | R$ 0 |

## Sumário

1. [Créditos](#1-créditos)
2. [Ponto de partida: o prompt original e a versão 1](#2-ponto-de-partida-o-prompt-original-e-a-versão-1)
3. [O problema: cada um com seus dados](#3-o-problema-cada-um-com-seus-dados)
4. [A decisão de arquitetura (e o que foi descartado)](#4-a-decisão-de-arquitetura-e-o-que-foi-descartado)
5. [Como o back-end funciona (Apps Script)](#5-como-o-back-end-funciona-apps-script)
6. [Como o app funciona (sincronização e offline)](#6-como-o-app-funciona-sincronização-e-offline)
7. [Como foi testado](#7-como-foi-testado)
8. [Importação da planilha antiga](#8-importação-da-planilha-antiga)
9. [Implantação real, passo a passo](#9-implantação-real-passo-a-passo)
10. [Problemas que apareceram e como foram resolvidos](#10-problemas-que-apareceram-e-como-foram-resolvidos)
11. [Os pedidos feitos à IA, em ordem](#11-os-pedidos-feitos-à-ia-em-ordem)
12. [Prompt consolidado para recriar do zero](#12-prompt-consolidado-para-recriar-do-zero)
13. [Limitações e próximos passos](#13-limitações-e-próximos-passos)

---

## 1. Créditos

| Parte | Origem |
|---|---|
| Ideia, requisitos e prompt original | [`docs/prompt-original.txt`](docs/prompt-original.txt) (1.046 linhas, 36 seções) |
| Uso em campo, dados e testes reais | Equipe Dataprev: Gabriel, Katharina, Daniel e André no inventário de 2026 |
| Versões 2 em diante, importação e documentação.

---

## 2. Ponto de partida: o prompt original e a versão 1

O prompt original (36 seções) pedia um PWA para Android com:

- leitor de código de barras pela câmera para patrimônio e número de série, sempre com opção de digitar;
- formulário com marca, modelo, estado (OK/Defeito), situação (não formatado / em formatação / formatado), componentes (SSD, HD, RAM) e laudo;
- funcionamento offline com IndexedDB e sincronização com o **Google Sheets via API oficial + OAuth**;
- custo zero: sem servidor, banco ou domínio pago;
- README completo para iniciantes.

A **versão 1** gerada a partir dele entregou bem a parte de cadastro e o leitor (API `BarcodeDetector`), além de uma regra útil que não estava no prompt: **patrimônio lido com 8 dígitos vira os 6 últimos** (a etiqueta traz o prefixo `39`). Mas ela simplificou a parte de dados:

- guardava tudo no `localStorage` do navegador;
- **não tinha sincronização nenhuma**: a "integração" com planilha era um botão de exportar CSV.

Ela foi publicada no Netlify por Netlify Drop (arrastar a pasta), no endereço `calm-bonbon-a427dd.netlify.app`, e já funcionava como app instalável (botão "Instalar" no cabeçalho). O cabeçalho dizia **"CONTROLE LOCAL"**, os contadores diziam **"neste aparelho"** e o rodapé avisava: *"Seus dados ficam neste navegador. Exporte a planilha regularmente."*

Arquivos da versão 1: `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, `icon.svg` e `README.md`. Os dados ficavam na chave `inventario-ti-registros-v1` do `localStorage`.

---

## 3. O problema: cada um com seus dados

Com várias pessoas fazendo o inventário ao mesmo tempo, cada celular tinha **a sua própria lista**. Na prática isso significava:

- juntar CSVs de todo mundo no fim do dia;
- duplicidade que só aparecia depois: o app só conferia a lista **daquele aparelho**;
- risco de perder dados ao limpar o navegador ou trocar de celular;
- contadores que mostravam só o que cada um fez.

O pedido foi: **"A aplicação deverá utilizar uma arquitetura centralizada em nuvem, evitando que os dados e processos sejam mantidos exclusivamente de forma local. As informações necessárias ao funcionamento do sistema deverão ser armazenadas e processadas em um ambiente compartilhado, permitindo o acesso consistente pelos diferentes usuários e dispositivos. A solução deverá priorizar praticidade, escalabilidade, disponibilidade e facilidade de manutenção, adotando a abordagem de infraestrutura em nuvem mais adequada às necessidades do aplicativo."**.

---

## 4. A decisão de arquitetura (e o que foi descartado)

Foi avaliado a opcão, dentro da regra do custo zero:

✅ **Google Sheets + Google Apps Script como "App da Web"** | Escolhida. O script roda na conta de quem criou a planilha e vira um endereço (`.../exec`) que o app chama. Ninguém da equipe precisa de login nem de permissão na planilha, não há projeto no Google Cloud e é grátis. A planilha continua sendo uma planilha: dá para abrir, filtrar e baixar em .xlsx. |

Arquitetura final:

```
Celular (PWA, Netlify)
   │  salva primeiro no aparelho (fila offline)
   ▼
fetch POST  ──►  Google Apps Script (App da Web, "Executar como: Eu")
                     │  LockService + upsert por ID
                     ▼
               Planilha Google: abas "Inventário" e "Excluídos"
```

Segurança adotada, proporcional ao risco (patrimônio, série e laudo técnico, sem dados pessoais):

- a planilha fica **privada**, e só quem for convidado a abre;
- o script só aceita gravação com a **chave da equipe**. Como o site é público, ela é um filtro contra uso indevido, não uma senha forte;
- a chave **não vai para o GitHub** (o `config.js` do repositório é vazio).

---

## 5. Como o back-end funciona (Apps Script)

Arquivo: [`apps-script/Codigo.gs`](apps-script/Codigo.gs). Pontos importantes:

**Estrutura da planilha**, criada pela função `configurar()`, que é executada uma vez à mão:

| Aba | Colunas |
|---|---|
| Inventário | ID, Patrimônio, Número de série, Marca, Modelo, Estado, Situação, SSD, HD, Memória RAM, Observações / laudo, Registrado por, Criado em, Última atualização |
| Excluídos | as mesmas + Excluído em, Excluído por |

Patrimônio e série ficam formatados como **texto** (para não perder zeros à esquerda, como em `00351241`), e o fuso é `America/Sao_Paulo`.

**Um único endpoint (`doPost`)** recebe `{ key, upserts, deletes }` e devolve `{ ok, results, records, sheetUrl }`, ou seja, envia as pendências e recebe a lista completa numa ida só.

**Regras aplicadas no servidor:**

1. **Trava (`LockService`)**: se dois celulares sincronizam juntos, um espera o outro, e ninguém sobrescreve ninguém.
2. **Upsert por ID**: se o ID existe, atualiza a linha; se não existe, cria. Sincronizar duas vezes **nunca duplica**.
3. **Conflito de edição**: compara `Última atualização`, e a versão mais nova vence.
4. **Duplicidade na equipe**: recusa patrimônio ou série que já existam em outro registro e devolve a mensagem *"Patrimônio X já está na planilha (registrado por Fulano)"*.
5. **Exclusão com histórico**: a linha é copiada para "Excluídos" com data e autor, e só então removida.
6. **Registro já excluído** que chega de um celular desatualizado não "ressuscita".
7. **Linhas coladas à mão sem ID** (importação) ganham um UUID automaticamente.
8. **Leitura tolerante**: aceita "Funcionando"/"Com defeito" e "Sim"/"S"/"X".
9. **Proteção contra fórmula**: textos começando com `= + - @` recebem `'` na frente para não virarem fórmula.

**Funções do `Codigo.gs` (311 linhas):**

| Função | O que faz |
|---|---|
| `configurar()` | executada uma vez à mão; cria as abas e ajusta o fuso |
| `doGet()` | responde `{"ok":true,"message":"API do Inventário TI funcionando…"}`, útil para testar a URL no navegador |
| `doPost(e)` | confere a chave, pega a trava, aplica exclusões e depois upserts, e devolve a lista completa |
| `abaInventario_()` / `abaExcluidos_()` | criam as abas com cabeçalho (fundo `#092b38`, texto branco, linha 1 congelada) se ainda não existirem |
| `lerTudo_()` | lê a aba Inventário, gera ID para linhas sem ID e monta o índice por ID |
| `lerIdsExcluidos_()` | lista os IDs já excluídos (para não "ressuscitar") |
| `deLinha_()` / `paraLinha_()` | convertem linha da planilha ↔ objeto do app |
| `limpar_()` / `validar_()` | normalizam e conferem os campos obrigatórios; laudo limitado a 2.000 caracteres, nome a 80 |
| `texto_`, `iso_`, `data_`, `estado_`, `sim_`, `igual_`, `seguro_`, `json_` | utilitários (texto, datas, "Sim/Não", comparação sem maiúsculas, anti-fórmula, resposta JSON) |

A trava espera até **20 segundos** (`tryLock(20000)`); se não conseguir, responde *"Planilha ocupada. Tente de novo em instantes."*

Exemplo de requisição e resposta:

```json
// enviado pelo app
{ "key": "…", "upserts": [ { "id": "b61f9ca6-…", "assetTag": "277921", "serialNumber": "4A3520B6T",
    "brand": "Positivo", "model": "MASTER D610", "state": "OK", "status": "Formatado",
    "components": ["SSD","HD","Memória RAM"], "notes": "…", "registeredBy": "Katharina",
    "createdAt": "2026-09-17T…", "updatedAt": "2026-09-17T…" } ],
  "deletes": [ { "id": "…", "by": "Gabriel" } ] }

// resposta do script
{ "ok": true,
  "results": { "b61f9ca6-…": { "status": "ok" } },   // ok | stale | error | deleted
  "records": [ …lista completa… ],
  "sheetUrl": "https://docs.google.com/spreadsheets/d/…",
  "serverTime": "2026-09-24T14:23:35.000Z" }
```

**Publicação:** Implantar → Nova implantação → App da Web → *Executar como: Eu* → *Quem pode acessar: Qualquer pessoa*. Ao alterar o código depois, use **Gerenciar implantações → editar → Nova versão**, que mantém a mesma URL.

---

## 6. Como o app funciona (sincronização e offline)

| Arquivo | Linhas | Papel |
|---|---|---|
| `index.html` | 208 | telas: cadastro, lista, leitor, caixa de status e janela de Configurações |
| `app.js` | 581 | toda a lógica: cadastro, leitor, fila offline, sincronização |
| `styles.css` | 150 | visual mobile first, tons da caixa de status |
| `config.js` | 9 | URL do script e chave (vazio neste repositório) |
| `sw.js` | 25 | service worker, cache `inventario-ti-v5` |
| `manifest.webmanifest` | 19 | nome, cores (`#092b38`) e ícones do app instalável |
| `icon.svg`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | — | ícones |

Funções principais do `app.js`: `readConfig`, `sync`, `callApi`, `mergeServer`, `toPayload`, `migrate`, `visibleRecords`, `renderSyncStatus`, `openSettings`, `duplicateOf`, `getFormRecord`, `editRecord`, `deleteRecord`, `exportCsv` e `formatAssetTag` (a regra dos 8 → 6 dígitos).

O que fica guardado em cada aparelho (`localStorage`):

| Chave | Conteúdo |
|---|---|
| `inventario-ti-registros-v1` | cópia de trabalho dos registros, com o estado de sincronização (mesma chave da versão 1, por isso a migração é automática) |
| `inventario-ti-config-v1` | nome da pessoa, URL e chave (quando configuradas no aparelho) |
| `inventario-ti-ultima-sync` | data/hora da última sincronização |
| `inventario-ti-url-planilha` | link da planilha, para o botão "Abrir planilha" |

### O truque de CORS
O Apps Script não responde à "verificação prévia" (preflight) que o navegador faz para `Content-Type: application/json`. A solução é enviar JSON **como texto puro**:

```js
fetch(apiUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // sem preflight
  body: JSON.stringify({ key, upserts, deletes }),
  redirect: 'follow'
});
```

### Estados de cada registro no aparelho
| Estado | Significado |
|---|---|
| `pending` | salvo no aparelho, falta enviar (aparece "Aguardando envio") |
| `synced` | igual ao que está na planilha |
| `error` | a planilha recusou; o motivo aparece no cartão |
| `_deleted` | excluído aqui, falta avisar a planilha |

### Quando sincroniza
Ao abrir o app, ao salvar ou excluir, quando a internet volta (evento `online`), quando a pessoa volta para a tela do app (`visibilitychange`), a cada 60 segundos e pelo botão **Sincronizar agora**. Se uma sincronização é pedida enquanto outra está em andamento, ela é enfileirada e roda logo depois. Cada chamada tem limite de **30 segundos**.

### Mensagens que aparecem na caixa de status
| Situação | Texto |
|---|---|
| sem planilha configurada | "Planilha da equipe não configurada." |
| sincronizando | "Sincronizando com a planilha…" |
| sem internet | "Sem internet." + "N registros serão enviados quando a conexão voltar." |
| falha de comunicação | "Não foi possível sincronizar." + motivo |
| recusas | "N registros recusados pela planilha." |
| pendências | "N registros aguardando envio." |
| tudo certo | "Planilha da equipe em dia." + "Última sincronização: …" |

### A mesclagem (parte mais delicada)
Depois de cada resposta do servidor, o app **relê o que está no aparelho** (a pessoa pode ter cadastrado algo enquanto o envio acontecia) e junta tudo com estas regras:

- o que veio do servidor substitui a cópia local, **exceto** se houver uma edição local mais nova ainda não enviada;
- registro que estava sincronizado e sumiu do servidor foi excluído por outra pessoa, e sai do aparelho;
- pendências que ainda não foram enviadas continuam na fila.

### Outras regras
- **Nome obrigatório**: sem nome configurado, o app baixa a planilha mas **não envia** nada, para não criar registros sem "Registrado por". A janela de nome abre sozinha no primeiro acesso.
- **Migração automática**: registros da versão 1 (só no navegador) entram na fila e sobem na primeira sincronização.
- **Configuração em três camadas**: `config.js` (vale para todos) → tela Configurar (vale para o aparelho) → **link de acesso** `?api=...&chave=...`, que configura o aparelho e some da barra de endereço.
- **Service worker**: guarda só os arquivos do próprio site, e as chamadas ao Google vão sempre direto à rede.
- **Ícones PNG** 192/512 e *maskable*, que o Android precisa para gerar um ícone de app de verdade.

---

## 7. Como foi testado

Antes de mexer em qualquer coisa real, tudo foi testado num ambiente simulado:

1. **Apps Script simulado em Node.js** (`fakegas.js`, porta 8801): imita `SpreadsheetApp`, `LockService`, `Utilities` e `ContentService` e roda o `Codigo.gs` **sem nenhuma alteração**. Ele também **recusa qualquer requisição de preflight**, para provar que o truque do `text/plain` funciona.
2. **App servido localmente** (`python3 -m http.server`, porta 8800).
3. **Dois navegadores reais** (Playwright + Chromium, script `e2e.py`) simulando dois celulares, "Ana" e "Bruno", cada um com seu próprio armazenamento. O modo offline foi simulado desligando a rede de um dos navegadores.
4. Por fim, as **139 linhas da importação** foram carregadas no simulador para confirmar leitura, contagem e bloqueio de duplicidade.

Cenários verificados:

| Cenário | Resultado |
|---|---|
| Chave errada | recusado ("Chave da equipe incorreta") |
| Registro antigo só no navegador | subiu na primeira sincronização |
| Salvar sem nome | abre Configurações pedindo o nome |
| Segundo aparelho abre o app | já vê os registros do primeiro |
| Cadastrar patrimônio que outra pessoa já cadastrou | bloqueado, mostrando quem cadastrou |
| Cadastrar sem internet | fica "Aguardando envio" e sobe quando a conexão volta |
| Conflito offline (os dois cadastram o mesmo patrimônio) | o segundo é recusado, com motivo no cartão |
| Excluir registro de outra pessoa | vai para "Excluídos" com autor e some dos outros aparelhos |
| Editar e sincronizar várias vezes | continua **uma** linha, com o dado atualizado |
| Linha colada sem ID | recebe ID automaticamente |

**Bug encontrado no teste e corrigido:** registros antigos subiam com "Registrado por" vazio quando o nome ainda não tinha sido preenchido. A correção foi só enviar depois que o nome existir.

---

## 8. Importação da planilha antiga

A planilha "Máquinas formatadas na DATAPREV" (Excel, 5 abas) foi analisada por script Python (`openpyxl`).

### O que se descobriu
A aba **ESTOQUE DE PC** continha **dois levantamentos diferentes** na mesma lista:

| Faixa | O que é | Qtde |
|---|---|---|
| Linhas 2–237 | Formatação de nov/dez de 2024, com chamado PTI, "Atribuído", destinação para doação (ONG, CUFA, PMDF) | 236 (bate com o total da aba de resumo) |
| Linhas 239 em diante | Inventário atual, de 16 a 23/09/2026 | 139 |

**42 máquinas** aparecem nos dois levantamentos (foram formatadas em 2024 e continuam no estoque).

### Decisão
- Só o **inventário atual** entrou no app (a formatação de 2024 inclui máquinas já doadas e distorceria os totais).
- 2024 virou uma aba de consulta ("Histórico 2024"), fora do app.
- As 42 máquinas repetidas receberam nas Observações: *"Também na formatação de 2024 (chamado, técnico, data)"*.

### Regras de limpeza
| Campo original | Tratamento |
|---|---|
| PIB | vira texto; `232.093` (digitado com ponto) → `232093` |
| Nº de série | remove espaços (inclusive no meio: `4A351YK 78` → `4A351YK78`); números viram texto; comparação ignora zeros à esquerda |
| Atribuído | vira "Registrado por", com nomes padronizados (`GABRIEL` → `Gabriel`, `ANDRE` → `André`) |
| Marca | `POSITIVO` → Positivo, `HPCOMPAQ` → HP etc. |
| Status | `Formatada`/`FORMATADA`/`Formatado` → Formatado; variações de "NÃO FORMATADA" → Não formatado |
| Estado | "Defeito" se a coluna dizia DEFEITO ou o laudo falava em defeito; senão "OK" |
| Laudo | mantido em Observações e **lido** para marcar SSD/HD/Memória: "Possui memória, ssd 256gb e hd de 1 tb" → Sim/Sim/Sim; "sem SSD" / "não possui HD" → Não; laudo genérico ("Testada e Laudada") → em branco |
| Linha 238 | só tinha PIB e destinação: era continuação da linha 180 e foi unida a ela |

### Resultado
- **139 máquinas: 131 OK, 8 com defeito**, iguais aos números da planilha original.
- Arquivo `importacao_inventario_TI.xlsx` com três abas: **Inventário** (pronta para colar), **Histórico 2024** e **Revisar**.
- A importação foi **validada rodando o Codigo.gs** sobre os dados: as 139 aparecem no app e recadastrar um PIB existente é bloqueado.

### Abas da planilha antiga
| Aba | Conteúdo | Uso |
|---|---|---|
| ESTOQUE DE PC | 376 linhas com dados: Quant., Número (chamado), Atribuído, Assunto, PIB, Nº de Série, Modelo, Marca, Estado, Data, Status, Laudo, Destinação | fonte da importação |
| MAQUINAS FORMATADAS NO DF | resumo de 2024: 236 máquinas, 221 formatadas, 15 não formatadas, 8 "HD formatadas", 2 sem HD, 3 sem HD e memória, 1 sem HD/memória/DVD com fonte queimada, 1 com HD com defeito | conferência dos totais |
| MONITORES | 121 monitores | fora do escopo por enquanto |
| LAUDOS DOS MONITORES e LAUDOS | textos-padrão de laudo | não usadas |

### Distribuição do inventário importado
| Campo | Valores |
|---|---|
| Marca / modelo | Positivo 120 (todos MASTER D610); Daten 12 (10 DC1B-T, 1 DT02BV1, 1 DT02BV2); Dell 7 (sem modelo) |
| Registrado por | Gabriel, Katharina, Daniel, André |
| Estado | 131 OK, 8 Defeito |
| Datas | 16/09/2026 a 23/09/2026 |

### O que a aba Revisar apontou
**Patrimônio repetido no inventário atual**
- PIB **275626**: série 4A351X51Y (Daniel) e série 4A3520X6N (Gabriel), ambos em 22/09/2026.

**Número de série diferente entre 2024 e 2026 no mesmo patrimônio**
| PIB | 2024 | 2026 | Tipo provável de erro |
|---|---|---|---|
| 275615 | 4A351XC08 | 4A351XC68 | 0 ↔ 6 |
| 276997 | 4A351YZ2S | 4A351ZYZ2S | letra a mais |
| 277678 | 4A351YD00 | 4A351D0O | letra faltando, 0 ↔ O |
| 277015 | 4A351YK9L | 4A351YK9I | L ↔ I |
| 277121 | 4A351XXW2C | 4A351XW2C | letra dobrada |
| 277069 | 4A351ZB9Y | 4A351Z89Y | B ↔ 8 |
| 277027 | 4A351ZN2Z | 4A351ZN27 | Z ↔ 7 |

**Patrimônio fora do padrão**
- PIB **27612** (série 4A351XG7P, 17/09/2026): 5 dígitos, falta um número.

**Sem modelo**
- 7 Dell cadastrados em 16/09/2026: PIB **269842, 269838, 269724, 281810, 269737, 281822, 269712**.

**Só em 2024 (histórico)**
- PIB **209467** aparece com duas máquinas diferentes (uma HP e uma Itautec).

Esses erros são exatamente o que o **leitor de código de barras** evita: é o melhor argumento para escanear em vez de digitar.

---

## 9. Implantação real, passo a passo

Na ordem em que foi feito:

1. **Criar a planilha** no Google Sheets: "Inventário TI - Equipe".
2. **Abrir o editor de script**: menu **Extensões → Apps Script** (na barra de menus da planilha, entre "Ferramentas" e "Ajuda").
3. **Colar o `Codigo.gs`** inteiro no lugar do `function myFunction() {}`. O projeto abriu com o nome "Projeto sem título" (pode ser renomeado para "Inventário TI").
4. **Trocar a chave**: na linha `const CHAVE_EQUIPE = '...'`, colocar uma senha inventada pela equipe (só letras, números e hífen) e anotá-la.
5. **Executar `configurar`**: escolher a função na caixinha do topo → Executar → autorizar. A tela "O Google não verificou este app" é normal para script próprio: **Avançado → Acessar (não seguro) → Permitir**. Resultado: abas "Inventário" e "Excluídos" criadas.
6. **Publicar**: Implantar → Nova implantação → ⚙️ App da Web → *Executar como: Eu* → *Quem pode acessar: Qualquer pessoa* → Implantar → copiar a URL `.../exec`. Para testar, basta abrir a URL no navegador: deve aparecer `{"ok":true,...}`.
7. **Importar as máquinas**: o `importacao_inventario_TI.xlsx` foi aberto no próprio Google Planilhas. Na aba Inventário dele, seleção das linhas **2 a 140** (clique no número 2 e Shift + clique no 140; 14 colunas, A a N), Ctrl + C. Na planilha da equipe, **aba Inventário**, clique no número da linha 2 e Ctrl + V.
8. **Configurar o app**: `config.js` preenchido com a URL e a chave (nessa cópia, que **não** vai para o GitHub).
9. **Publicar no Netlify**: Netlify Drop na conta da equipe **Daten-Bomb**, arrastando a pasta do projeto (a que tem o `index.html` na primeira camada). Foram enviados 11 arquivos e o projeto nasceu como **glittery-hamster-61e213**, às 11:16. Depois de aparecer "Published", clique em **Make public** (o projeto começa privado).
10. **Dar um nome ao site**: Project configuration → General → Project details → **Change project name** → `inventario-ti-datenbomb` (às 11:46). Isso deve ser feito **antes** de a equipe instalar, porque trocar depois quebra o app instalado. O endereço antigo deixa de funcionar na hora.
11. **Primeiro acesso**: abrir https://inventario-ti-datenbomb.netlify.app, digitar o nome, **Salvar e sincronizar**. Conferido em 24/09/2026, 11:23:35: **139 no total, 131 funcionando, 8 com defeito, "Planilha da equipe em dia"**.
12. **Distribuir**: link pelo Teams; no celular, Chrome → ⋮ → **Instalar app**; na primeira vez que usar Escanear, permitir a câmera.
13. **Aba Revisar**: copiada do arquivo de importação para a planilha da equipe (botão direito na aba → Copiar para → Planilha existente → "Inventário TI - Equipe"), renomeada de "Cópia de Revisar" para "Revisar". A aba vazia "Página1" foi apagada.
14. **(Opcional)** Compartilhar a planilha como **Leitor** com a equipe, para quem quiser consultar pelo link "Abrir planilha". Pedidos de acesso chegam no Gmail da conta dona da planilha. Para usar o app, ninguém precisa de permissão na planilha.
15. **Reinstalar nos celulares** que tinham instalado o endereço antigo: desinstalar (segurar o ícone → Desinstalar), abrir o endereço novo no Chrome e ⋮ → Instalar app.

---

## 10. Prompt consolidado para recriar do zero

Cole numa conversa nova para gerar a versão atual de uma vez:

```text
Você é um desenvolvedor full-stack experiente em PWAs, JavaScript puro e Google Apps Script.

Crie um sistema de inventário de computadores para uso principalmente em celular Android,
usado por uma EQUIPE (várias pessoas ao mesmo tempo, cada uma no seu celular).
Restrição fundamental: CUSTO ZERO. Sem servidor pago, banco pago, domínio ou assinatura.
Ninguém da equipe deve precisar fazer login no Google para usar o app.

ARQUITETURA
- Front-end: HTML + CSS + JavaScript puro (sem framework), PWA instalável
  (manifest com ícones PNG 192/512 e maskable, service worker que só cacheia o próprio site).
- Hospedagem estática gratuita (Netlify ou GitHub Pages).
- "Nuvem": planilha do Google Sheets + Google Apps Script publicado como App da Web
  ("Executar como: Eu", "Quem pode acessar: Qualquer pessoa").
- O app fala com o script via fetch POST com Content-Type text/plain (evita preflight CORS).
- "Chave da equipe" no corpo da requisição, conferida pelo script.
- Configuração: config.js (URL + chave) → sobrescrita pela tela Configurações →
  ou por link ?api=...&chave=... (salva no aparelho e remove da URL).
- Botão "Copiar link de acesso para a equipe" na tela de Configurações.

DADOS DE CADA COMPUTADOR
ID (UUID), Patrimônio, Número de série, Marca, Modelo, Estado (OK/Defeito),
Situação (Não formatado / Em formatação / Formatado), Componentes (SSD, HD, Memória RAM),
Observações/laudo, Registrado por, Criado em, Última atualização.

REGRAS
- Patrimônio lido com 8 dígitos (ex.: 39289751) → guardar os 6 últimos (289751).
- Patrimônio e número de série únicos NA EQUIPE TODA (checar no app e no servidor).
- "Registrado por" = nome pedido na primeira abertura; ao editar, manter o registrador original.
- Marcas: Positivo, Daten, Dell, Itautec, HP, Lenovo, Acer, Asus, Samsung, Outra.
- Sugestões de modelo (datalist): MASTER D610, DC1B-T, DT02BV1, DT02BV2, OptiPlex 5050.

LEITOR
- Botão "Escanear" em Patrimônio e Número de série com BarcodeDetector
  (code_128, code_39, ean_13, ean_8, itf, codabar, qr_code), câmera traseira.
- Fechar a câmera ao ler; sempre oferecer "Digitar manualmente".

OFFLINE E SINCRONIZAÇÃO
- Salvar primeiro no aparelho (localStorage) como "pendente".
- Sincronizar ao abrir, ao salvar/excluir, no evento online, ao voltar à tela,
  a cada 60 s e pelo botão "Sincronizar agora".
- Uma chamada envia pendências (upserts e deletes) e recebe a lista completa.
- Depois da resposta, reler o armazenamento local antes de mesclar (pode ter havido
  cadastro durante o envio); edição local mais nova e não enviada vence.
- Registro sincronizado que sumiu do servidor = excluído por outra pessoa → remover local.
- Recusa do servidor → marcar erro e mostrar o motivo no cartão.
- Registros antigos sem status entram na fila na primeira sincronização.
- Sem nome configurado: só baixar, não enviar.

APPS SCRIPT
- configurar(): cria "Inventário" e "Excluídos" com cabeçalho, patrimônio/série como texto,
  datas dd/MM/yyyy HH:mm:ss, fuso America/Sao_Paulo.
- doPost com LockService; upsert por ID; vence o updatedAt mais novo; recusa duplicidade
  informando quem cadastrou; exclusão move a linha para "Excluídos" (data e autor);
  ID excluído não volta; linhas coladas sem ID ganham UUID;
  aceitar "Funcionando/Com defeito" e "Sim/S/X"; prefixar ' em textos que começam com = + - @;
  devolver a URL da planilha.

INTERFACE
- Mobile first, botões grandes, cards (sem tabelas largas).
- Topo: total (dizendo "na planilha da equipe" ou "neste aparelho"), funcionando, com defeito.
- Caixa de status: em dia / sincronizando / sem internet / X aguardando envio / erro,
  com a última sincronização e o link "Abrir planilha".
- Aba Equipamentos: busca (patrimônio, série, marca, modelo), editar, excluir,
  exibir quem registrou e "Aguardando envio".
- Exportar CSV (UTF-8 com BOM, separador ;), funcionando offline.

ENTREGA
- Todos os arquivos, apps-script/Codigo.gs, config.js vazio, .gitignore
  e README.md em português para iniciantes: criar planilha, colar script, trocar chave,
  executar configurar(), publicar App da Web, preencher config.js, publicar no Netlify,
  instalar no Android, importar planilha antiga, solução de problemas e limitações.
```

---

## 11. Limitações e próximos passos

**Limitações atuais**
- O leitor de código de barras depende do `BarcodeDetector` (Chrome/Edge no Android). **No iPhone não há leitura automática**; a digitação manual funciona.
- A chave da equipe fica no site publicado: é um filtro, não uma senha forte.
- Em duas edições simultâneas do mesmo registro, vence a última salva.
- O Apps Script tem cotas diárias gratuitas, com folga para o volume de um inventário.

**Ideias levantadas para as próximas versões**
- **Modo inventário:** manter marca, modelo e situação após salvar, para lotes iguais.
- **Painel** por marca, situação e registrador.
- Campos de **capacidade** (GB) para SSD, HD e memória.
- Leitor alternativo (biblioteca ZXing) para funcionar no iPhone.
