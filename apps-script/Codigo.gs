/**
 * Inventário TI — backend gratuito da planilha compartilhada.
 *
 * Como usar (resumo; o passo a passo completo está no README):
 *  1. Crie uma planilha no Google Sheets (ex.: "Inventário TI - Equipe").
 *  2. Menu Extensões > Apps Script. Apague o conteúdo e cole este arquivo inteiro.
 *  3. Troque a CHAVE_EQUIPE abaixo por uma frase só da equipe.
 *  4. Selecione a função "configurar" e clique em Executar (autorize quando pedir).
 *  5. Implantar > Nova implantação > Tipo "App da Web":
 *       Executar como: Eu | Quem pode acessar: Qualquer pessoa
 *  6. Copie a URL que termina em /exec e coloque no app (Configurar) ou no config.js.
 *
 * Todo mundo grava na mesma planilha. O LockService garante que dois celulares
 * salvando ao mesmo tempo não sobrescrevam um ao outro.
 */

const CHAVE_EQUIPE = 'troque-por-uma-chave-da-equipe';

const ABA_INVENTARIO = 'Inventário';
const ABA_EXCLUIDOS = 'Excluídos';
const COMPONENTES = ['SSD', 'HD', 'Memória RAM'];
const CABECALHO = [
  'ID', 'Patrimônio', 'Número de série', 'Marca', 'Modelo', 'Estado', 'Situação',
  ...COMPONENTES,
  'Observações / laudo', 'Registrado por', 'Criado em', 'Última atualização'
];
const N = COMPONENTES.length;
const COL = {
  id: 0, assetTag: 1, serialNumber: 2, brand: 3, model: 4, state: 5, status: 6,
  comp: 7, notes: 7 + N, registeredBy: 8 + N, createdAt: 9 + N, updatedAt: 10 + N
};

/** Rode uma vez pelo editor para criar as abas e autorizar o script. */
function configurar() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone('America/Sao_Paulo');
  abaInventario_();
  abaExcluidos_();
  Logger.log('Pronto. Agora publique em Implantar > Nova implantação > App da Web.');
}

function doGet() {
  return json_({ ok: true, message: 'API do Inventário TI funcionando. Use o aplicativo para sincronizar.' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Requisição inválida.' });
  }
  if (String(body.key || '') !== CHAVE_EQUIPE) {
    return json_({ ok: false, error: 'Chave da equipe incorreta.' });
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return json_({ ok: false, error: 'Planilha ocupada. Tente de novo em instantes.' });
  }

  try {
    const sheet = abaInventario_();
    const trash = abaExcluidos_();
    const results = {};

    // 1) Exclusões: a linha vai para a aba "Excluídos" (fica o histórico) e sai do inventário.
    const deletes = Array.isArray(body.deletes) ? body.deletes : [];
    if (deletes.length) {
      const data = lerTudo_(sheet);
      const agora = new Date();
      const remover = [];
      deletes.forEach((item) => {
        const id = texto_(item && item.id);
        if (!id) return;
        const idx = data.indexById.get(id);
        if (idx !== undefined) remover.push({ linha: idx + 2, valores: data.rows[idx], por: texto_(item.by) });
        results[id] = { status: 'deleted' };
      });
      if (remover.length) {
        const linhasLixo = remover.map((r) => r.valores.concat([agora, r.por]));
        trash.getRange(trash.getLastRow() + 1, 1, linhasLixo.length, linhasLixo[0].length).setValues(linhasLixo);
        remover.sort((a, b) => b.linha - a.linha).forEach((r) => sheet.deleteRow(r.linha));
      }
    }

    // 2) Inclusões e alterações (upsert pelo ID — nunca duplica a linha).
    const upserts = Array.isArray(body.upserts) ? body.upserts : [];
    if (upserts.length) {
      const excluidos = new Set(lerIdsExcluidos_(trash));
      const data = lerTudo_(sheet);
      const todos = data.records.slice();
      const novos = [];

      upserts.forEach((raw) => {
        const rec = limpar_(raw);
        const erro = validar_(rec);
        if (erro) { results[rec.id || '?'] = { status: 'error', message: erro }; return; }
        if (excluidos.has(rec.id)) { results[rec.id] = { status: 'deleted' }; return; }

        const dup = todos.find((r) => r.id !== rec.id && (igual_(r.assetTag, rec.assetTag) || igual_(r.serialNumber, rec.serialNumber)));
        if (dup) {
          const campo = igual_(dup.assetTag, rec.assetTag) ? `Patrimônio ${rec.assetTag}` : `Série ${rec.serialNumber}`;
          results[rec.id] = {
            status: 'error',
            message: `${campo} já está na planilha (registrado por ${dup.registeredBy || 'outra pessoa'}).`
          };
          return;
        }

        const idx = data.indexById.get(rec.id);
        if (idx !== undefined) {
          const atual = data.byRow[idx];
          if (atual.updatedAt && rec.updatedAt && atual.updatedAt > rec.updatedAt) {
            results[rec.id] = { status: 'stale' }; // a versão da planilha é mais nova: ela vence
            return;
          }
          rec.createdAt = atual.createdAt || rec.createdAt;
          rec.registeredBy = atual.registeredBy || rec.registeredBy;
          sheet.getRange(idx + 2, 1, 1, CABECALHO.length).setValues([paraLinha_(rec)]);
          todos[todos.findIndex((r) => r.id === rec.id)] = rec;
        } else {
          novos.push(paraLinha_(rec));
          todos.push(rec);
        }
        results[rec.id] = { status: 'ok' };
      });

      if (novos.length) {
        sheet.getRange(sheet.getLastRow() + 1, 1, novos.length, CABECALHO.length).setValues(novos);
      }
    }

    SpreadsheetApp.flush();
    const final = lerTudo_(sheet);
    return json_({
      ok: true,
      results,
      records: final.records,
      sheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
      serverTime: new Date().toISOString()
    });
  } catch (err) {
    return json_({ ok: false, error: 'Erro na planilha: ' + err.message });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Abas ---------- */

function abaInventario_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(ABA_INVENTARIO);
  if (!sh) sh = ss.insertSheet(ABA_INVENTARIO, 0);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, CABECALHO.length).setValues([CABECALHO]).setFontWeight('bold').setBackground('#092b38').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.getRange(2, 1, sh.getMaxRows() - 1, COL.registeredBy + 1).setNumberFormat('@'); // texto: preserva zeros à esquerda
    sh.getRange(2, COL.createdAt + 1, sh.getMaxRows() - 1, 2).setNumberFormat('dd/MM/yyyy HH:mm:ss');
    sh.setColumnWidth(1, 90);
    sh.setColumnWidth(COL.notes + 1, 280);
  }
  return sh;
}

function abaExcluidos_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(ABA_EXCLUIDOS);
  if (!sh) sh = ss.insertSheet(ABA_EXCLUIDOS);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, CABECALHO.length + 2).setValues([CABECALHO.concat(['Excluído em', 'Excluído por'])]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/* ---------- Leitura / escrita ---------- */

function lerTudo_(sheet) {
  const last = sheet.getLastRow();
  const vazio = { records: [], rows: [], byRow: [], indexById: new Map() };
  if (last < 2) return vazio;

  const rows = sheet.getRange(2, 1, last - 1, CABECALHO.length).getValues();
  const byRow = [];    // mesma posição de rows (inclui linhas vazias)
  const records = [];  // só linhas válidas
  const indexById = new Map();

  rows.forEach((row, i) => {
    // Linhas coladas manualmente (ex.: importadas da planilha antiga) ganham um ID automaticamente.
    if (!texto_(row[COL.id]) && texto_(row[COL.assetTag])) {
      row[COL.id] = Utilities.getUuid();
      sheet.getRange(i + 2, COL.id + 1).setValue(row[COL.id]);
    }
    const rec = deLinha_(row);
    byRow.push(rec);
    if (!rec.id) return;
    indexById.set(rec.id, i);
    records.push(rec);
  });

  return { records, rows, byRow, indexById };
}

function lerIdsExcluidos_(trash) {
  const last = trash.getLastRow();
  if (last < 2) return [];
  return trash.getRange(2, 1, last - 1, 1).getValues().map((r) => texto_(r[0])).filter(String);
}

function deLinha_(row) {
  return {
    id: texto_(row[COL.id]),
    assetTag: texto_(row[COL.assetTag]),
    serialNumber: texto_(row[COL.serialNumber]),
    brand: texto_(row[COL.brand]),
    model: texto_(row[COL.model]),
    state: estado_(row[COL.state]),
    status: texto_(row[COL.status]),
    components: COMPONENTES.filter((c, i) => sim_(row[COL.comp + i])),
    notes: texto_(row[COL.notes]),
    registeredBy: texto_(row[COL.registeredBy]),
    createdAt: iso_(row[COL.createdAt]),
    updatedAt: iso_(row[COL.updatedAt])
  };
}

function paraLinha_(rec) {
  return [
    rec.id, seguro_(rec.assetTag), seguro_(rec.serialNumber), seguro_(rec.brand), seguro_(rec.model),
    rec.state, rec.status,
    ...COMPONENTES.map((c) => (rec.components.indexOf(c) >= 0 ? 'Sim' : 'Não')),
    seguro_(rec.notes), seguro_(rec.registeredBy),
    data_(rec.createdAt), data_(rec.updatedAt)
  ];
}

function limpar_(raw) {
  raw = raw || {};
  return {
    id: texto_(raw.id),
    assetTag: texto_(raw.assetTag),
    serialNumber: texto_(raw.serialNumber),
    brand: texto_(raw.brand),
    model: texto_(raw.model),
    state: estado_(raw.state),
    status: texto_(raw.status),
    components: Array.isArray(raw.components) ? raw.components.map(texto_) : [],
    notes: texto_(raw.notes).slice(0, 2000),
    registeredBy: texto_(raw.registeredBy).slice(0, 80),
    createdAt: iso_(raw.createdAt) || new Date().toISOString(),
    updatedAt: iso_(raw.updatedAt) || new Date().toISOString()
  };
}

function validar_(rec) {
  if (!rec.id) return 'Registro sem ID.';
  if (!rec.assetTag) return 'Patrimônio não informado.';
  if (!rec.serialNumber) return 'Número de série não informado.';
  if (!rec.brand || !rec.model) return 'Marca e modelo são obrigatórios.';
  if (!rec.state || !rec.status) return 'Estado e situação são obrigatórios.';
  return '';
}

/* ---------- Utilidades ---------- */

function texto_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

function iso_(v) {
  if (v instanceof Date) return isNaN(v) ? '' : v.toISOString();
  const s = texto_(v);
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d) ? '' : d.toISOString();
}

function data_(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d;
}

function estado_(v) {
  const s = texto_(v).toLowerCase();
  if (s === 'ok' || s.indexOf('funcion') === 0) return 'OK';
  if (s.indexOf('defeito') >= 0) return 'Defeito';
  return texto_(v);
}

function sim_(v) {
  const s = texto_(v).toLowerCase();
  return v === true || s === 'sim' || s === 's' || s === 'x' || s === 'true';
}

function igual_(a, b) {
  return texto_(a).toLowerCase() !== '' && texto_(a).toLowerCase() === texto_(b).toLowerCase();
}

/** Impede que um texto começando com = + - @ vire fórmula na planilha. */
function seguro_(v) {
  const s = texto_(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
