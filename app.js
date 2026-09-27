(() => {
  'use strict';

  const STORAGE_KEY = 'inventario-ti-registros-v1';
  const CONFIG_KEY = 'inventario-ti-config-v1';
  const LAST_SYNC_KEY = 'inventario-ti-ultima-sync';
  const SHEET_URL_KEY = 'inventario-ti-url-planilha';
  const AUTO_SYNC_MS = 60000;
  const defaults = window.INVENTARIO_CONFIG || {};
  const form = document.querySelector('#inventoryForm');
  const recordList = document.querySelector('#recordList');
  const emptyState = document.querySelector('#emptyState');
  const searchInput = document.querySelector('#searchInput');
  const toast = document.querySelector('#toast');
  const scannerDialog = document.querySelector('#scannerDialog');
  const scannerVideo = document.querySelector('#scannerVideo');
  const scannerMessage = document.querySelector('#scannerMessage');
  let scanTarget = null;
  let cameraStream = null;
  let scanFrame = null;
  let installPrompt = null;
  let syncing = false;
  let syncAgain = false;
  let lastError = '';

  const clean = (value) => String(value ?? '').trim();

  const readJson = (key, fallback) => {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch { return fallback; }
  };

  // Registros antigos (versão só local) entram na fila para subir à planilha na primeira sincronização.
  const migrate = (record) => ({
    ...record,
    components: Array.isArray(record.components) ? record.components : [],
    createdAt: record.createdAt || record.updatedAt,
    _sync: record._sync || 'pending'
  });

  const readRecords = () => {
    const list = readJson(STORAGE_KEY, []);
    return Array.isArray(list) ? list.map(migrate) : [];
  };

  const storeRecords = (records) => localStorage.setItem(STORAGE_KEY, JSON.stringify(records));

  const writeRecords = (records) => {
    storeRecords(records);
    refresh();
  };

  // Excluídos aguardando envio continuam guardados, mas não aparecem na tela.
  const visibleRecords = (records = readRecords()) => records.filter((record) => !record._deleted);

  function readConfig() {
    const saved = readJson(CONFIG_KEY, {});
    return {
      apiUrl: clean(saved.apiUrl ?? defaults.apiUrl),
      teamKey: clean(saved.teamKey ?? defaults.teamKey),
      registeredBy: clean(saved.registeredBy)
    };
  }

  const saveConfig = (config) => localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  const isShared = () => { const config = readConfig(); return Boolean(config.apiUrl && config.teamKey); };

  // Link de acesso: ?api=...&chave=... configura o aparelho de quem abrir e some da barra de endereço.
  (function configFromLink() {
    const params = new URLSearchParams(window.location.search);
    const api = params.get('api');
    const key = params.get('chave');
    if (!api && !key) return;
    const config = readConfig();
    saveConfig({ ...config, apiUrl: clean(api) || config.apiUrl, teamKey: clean(key) || config.teamKey });
    window.history.replaceState(null, '', window.location.pathname);
  })();
  const normalized = (value) => clean(value).toLocaleLowerCase('pt-BR');
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));

  const formatAssetTag = (value) => {
    const raw = clean(value);
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 8) {
      return digits.slice(-6);
    }
    if (digits.length === 6) {
      return digits;
    }
    return raw;
  };

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function switchView(id) {
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === id));
    document.querySelectorAll('.view').forEach((view) => {
      const active = view.id === id;
      view.classList.toggle('active', active);
      view.hidden = !active;
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function updateSummary(records) {
    const shared = isShared();
    document.querySelector('#modeLabel').textContent = shared ? 'PLANILHA DA EQUIPE' : 'CONTROLE LOCAL';
    document.querySelector('#listEyebrow').textContent = shared ? 'PLANILHA DA EQUIPE' : 'ARQUIVO LOCAL';
    document.querySelector('#scopeLabel').textContent = shared ? 'na planilha da equipe' : 'neste aparelho';
    document.querySelector('#totalCount').textContent = records.length;
    document.querySelector('#okCount').textContent = records.filter((r) => r.state === 'OK').length;
    document.querySelector('#faultCount').textContent = records.filter((r) => r.state === 'Defeito').length;
    document.querySelector('#tabCount').textContent = records.length;
  }

  function renderRecords(records) {
    const shared = isShared();
    const query = normalized(searchInput.value);
    const filtered = records.filter((record) => [record.assetTag, record.serialNumber, record.brand, record.model]
      .some((value) => normalized(value).includes(query)));

    emptyState.hidden = filtered.length > 0;
    if (!records.length) {
      emptyState.querySelector('strong').textContent = 'Nenhum computador registrado';
      emptyState.querySelector('p').textContent = 'Cadastre o primeiro equipamento para começar o inventário.';
    } else if (!filtered.length) {
      emptyState.querySelector('strong').textContent = 'Nenhum resultado';
      emptyState.querySelector('p').textContent = 'Tente pesquisar por outro patrimônio, série, marca ou modelo.';
    }

    recordList.innerHTML = filtered.map((record) => `
      <article class="record-card">
        <div class="record-top">
          <div>
            <h3>${escapeHtml(record.brand)} ${escapeHtml(record.model)}</h3>
            <p>Patrimônio ${escapeHtml(record.assetTag)} · Série ${escapeHtml(record.serialNumber)}</p>
          </div>
          <div class="record-actions">
            <button type="button" data-edit="${escapeHtml(record.id)}">Editar</button>
            <button type="button" class="delete" data-delete="${escapeHtml(record.id)}">Excluir</button>
          </div>
        </div>
        <div class="record-meta">
          <span class="pill ${record.state === 'OK' ? 'ok' : 'fault'}">${escapeHtml(record.state)}</span>
          <span class="pill">${escapeHtml(record.status)}</span>
          ${record.registeredBy ? `<span class="pill who">${escapeHtml(record.registeredBy)}</span>` : ''}
          ${record.updatedAt ? `<span class="pill">${escapeHtml(new Date(record.updatedAt).toLocaleString('pt-BR'))}</span>` : ''}
          ${shared && record._sync === 'pending' ? '<span class="pill wait">Aguardando envio</span>' : ''}
        </div>
        ${record._sync === 'error' ? `<p class="record-error">Não entrou na planilha: ${escapeHtml(record._error || 'recusado.')} Edite e salve de novo, ou exclua.</p>` : ''}
      </article>`).join('');
  }

  function refresh() {
    const records = visibleRecords();
    updateSummary(records);
    renderRecords(records);
    renderSyncStatus();
  }

  function renderSyncStatus() {
    const all = readRecords();
    const pending = all.filter((r) => r._sync === 'pending').length;
    const rejected = all.filter((r) => r._sync === 'error').length;
    const last = localStorage.getItem(LAST_SYNC_KEY);
    const sheetUrl = localStorage.getItem(SHEET_URL_KEY);
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    let tone; let title; let detail;

    if (!isShared()) {
      tone = 'local';
      title = 'Planilha da equipe não configurada.';
      detail = 'Os registros estão só neste aparelho. Toque em Configurar para ligar à planilha compartilhada.';
    } else if (syncing) {
      tone = 'busy'; title = 'Sincronizando com a planilha…'; detail = 'Pode continuar cadastrando.';
    } else if (!navigator.onLine) {
      tone = 'offline'; title = 'Sem internet.';
      detail = pending ? `${plural(pending, 'registro será enviado', 'registros serão enviados')} quando a conexão voltar.` : 'Pode continuar cadastrando; tudo fica guardado aqui.';
    } else if (lastError) {
      tone = 'error'; title = 'Não foi possível sincronizar.';
      detail = `${lastError}${pending ? ` ${plural(pending, 'registro aguardando', 'registros aguardando')} envio.` : ''}`;
    } else if (rejected) {
      tone = 'error'; title = `${plural(rejected, 'registro recusado', 'registros recusados')} pela planilha.`;
      detail = 'Veja o motivo na aba Equipamentos, corrija e salve de novo.';
    } else if (pending && !readConfig().registeredBy) {
      tone = 'busy'; title = `${plural(pending, 'registro aguardando', 'registros aguardando')} envio.`; detail = 'Informe seu nome em Configurar para enviar.';
    } else if (pending) {
      tone = 'busy'; title = `${plural(pending, 'registro aguardando', 'registros aguardando')} envio.`; detail = 'Toque em Sincronizar agora.';
    } else {
      tone = 'ok'; title = 'Planilha da equipe em dia.';
      detail = last ? `Última sincronização: ${new Date(last).toLocaleString('pt-BR')}.` : '';
    }

    const panel = document.querySelector('#syncPanel');
    panel.dataset.tone = tone;
    document.querySelector('#syncTitle').textContent = title;
    document.querySelector('#syncDetail').textContent = detail;
    const syncButton = document.querySelector('#syncNow');
    syncButton.textContent = isShared() ? 'Sincronizar agora' : 'Configurar';
    syncButton.disabled = syncing;
    const link = document.querySelector('#openSheet');
    link.hidden = !(isShared() && sheetUrl);
    if (sheetUrl) link.href = sheetUrl;
  }

  function getFormRecord() {
    const data = new FormData(form);
    return {
      id: clean(data.get('recordId')) || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
      assetTag: formatAssetTag(data.get('assetTag')),
      serialNumber: clean(data.get('serialNumber')),
      brand: clean(data.get('brand')),
      model: clean(data.get('model')),
      state: clean(data.get('state')),
      status: clean(data.get('status')),
      components: data.getAll('components').map(clean),
      notes: clean(data.get('notes')),
      updatedAt: new Date().toISOString()
    };
  }

  function duplicateOf(candidate, records) {
    return records.find((record) => record.id !== candidate.id && (
      normalized(record.assetTag) === normalized(candidate.assetTag) ||
      normalized(record.serialNumber) === normalized(candidate.serialNumber)
    ));
  }

  function resetForm() {
    form.reset();
    document.querySelector('#recordId').value = '';
    document.querySelector('#formEyebrow').textContent = 'CADASTRO';
    document.querySelector('#formTitle').textContent = 'Novo computador';
    document.querySelector('#saveButton').textContent = 'Salvar computador';
    document.querySelector('#cancelEdit').hidden = true;
    document.querySelector('#duplicateWarning').hidden = true;
  }

  function editRecord(id) {
    const record = visibleRecords().find((item) => item.id === id);
    if (!record) return;
    resetForm();
    ['id', 'assetTag', 'serialNumber', 'brand', 'model', 'notes'].forEach((key) => {
      const element = document.querySelector(`#${key === 'id' ? 'recordId' : key}`);
      if (element) element.value = record[key] || '';
    });
    form.querySelector(`[name="state"][value="${CSS.escape(record.state)}"]`).checked = true;
    form.querySelector(`[name="status"][value="${CSS.escape(record.status)}"]`).checked = true;
    form.querySelectorAll('[name="components"]').forEach((input) => { input.checked = record.components.includes(input.value); });
    document.querySelector('#formEyebrow').textContent = 'EDIÇÃO';
    document.querySelector('#formTitle').textContent = 'Editar computador';
    document.querySelector('#saveButton').textContent = 'Salvar alterações';
    document.querySelector('#cancelEdit').hidden = false;
    switchView('formView');
  }

  function deleteRecord(id) {
    const record = visibleRecords().find((item) => item.id === id);
    if (!record || !window.confirm(`Tem certeza que deseja excluir o patrimônio ${record.assetTag}?${record._remote ? ' Ele sai da planilha da equipe.' : ''}`)) return;
    const records = readRecords();
    if (record._remote) {
      // Já está na planilha: marca para excluir lá também.
      const index = records.findIndex((item) => item.id === id);
      records[index] = { ...record, _deleted: true, _sync: 'pending', _deletedBy: readConfig().registeredBy };
      writeRecords(records);
    } else {
      writeRecords(records.filter((item) => item.id !== id));
    }
    showToast('Registro excluído.');
    if (record._remote) sync();
  }

  function csvCell(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
  }

  function exportCsv() {
    const records = visibleRecords();
    if (!records.length) return showToast('Cadastre ao menos um computador antes de exportar.');
    const date = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR') : '');
    const headers = ['ID', 'Patrimônio', 'Número de série', 'Marca', 'Modelo', 'Estado', 'Situação', 'Componentes', 'Observações / laudo', 'Registrado por', 'Criado em', 'Última atualização'];
    const rows = records.map((r) => [r.id, r.assetTag, r.serialNumber, r.brand, r.model, r.state, r.status, r.components.join(', '), r.notes, r.registeredBy, date(r.createdAt), date(r.updatedAt)]);
    const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `estoque_computadores_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('Planilha exportada.');
  }

  async function closeScanner() {
    if (scanFrame) cancelAnimationFrame(scanFrame);
    scanFrame = null;
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    scannerVideo.srcObject = null;
    scannerDialog.hidden = true;
  }

  async function openScanner(targetId) {
    scanTarget = document.querySelector(`#${targetId}`);
    scannerDialog.hidden = false;
    scannerMessage.textContent = 'Aponte a câmera para o código de barras.';
    if (!('BarcodeDetector' in window)) {
      scannerMessage.textContent = 'Este navegador não oferece leitura automática. Use a digitação manual.';
      return;
    }
    try {
      const detector = new BarcodeDetector({ formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'itf', 'codabar', 'qr_code'] });
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      scannerVideo.srcObject = cameraStream;
      await scannerVideo.play();
      const scan = async () => {
        if (!cameraStream) return;
        try {
          const codes = await detector.detect(scannerVideo);
          if (codes.length) {
            let scannedValue = codes[0].rawValue;
            if (scanTarget?.id === 'assetTag') {
              scannedValue = formatAssetTag(scannedValue);
            }
            scanTarget.value = scannedValue;
            scanTarget.dispatchEvent(new Event('input', { bubbles: true }));
            scanTarget.dispatchEvent(new Event('change', { bubbles: true }));
            await closeScanner();
            scanTarget.focus();
            showToast('Código lido com sucesso.');
            return;
          }
        } catch { /* continue scanning */ }
        scanFrame = requestAnimationFrame(scan);
      };
      scan();
    } catch {
      scannerMessage.textContent = 'Não foi possível abrir a câmera. Verifique a permissão ou digite manualmente.';
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const config = readConfig();
    if (!config.registeredBy) {
      openSettings('Informe seu nome antes de salvar. Ele vai na coluna "Registrado por".');
      return;
    }
    const records = readRecords();
    const candidate = getFormRecord();
    const duplicate = duplicateOf(candidate, visibleRecords(records));
    const warning = document.querySelector('#duplicateWarning');
    if (duplicate) {
      warning.textContent = `Este computador já está cadastrado (patrimônio ${duplicate.assetTag}, série ${duplicate.serialNumber}${duplicate.registeredBy ? `, por ${duplicate.registeredBy}` : ''}).`;
      warning.hidden = false;
      return;
    }
    const index = records.findIndex((record) => record.id === candidate.id);
    const existing = index >= 0 ? records[index] : null;
    const record = {
      ...candidate,
      createdAt: existing?.createdAt || candidate.updatedAt,
      registeredBy: existing?.registeredBy || config.registeredBy,
      _remote: Boolean(existing?._remote),
      _sync: 'pending'
    };
    if (index >= 0) records[index] = record; else records.unshift(record);
    writeRecords(records);
    resetForm();
    let message = index >= 0 ? 'Alterações salvas' : 'Computador salvo com sucesso';
    if (!isShared()) message += ' neste aparelho.';
    else if (!navigator.onLine) message += '. Será enviado quando a internet voltar.';
    else message += '. Enviando para a planilha…';
    showToast(message);
    sync();
  });

  /* ---------- Sincronização com a planilha da equipe ---------- */

  const toPayload = (record, config) => ({
    id: record.id, assetTag: record.assetTag, serialNumber: record.serialNumber, brand: record.brand,
    model: record.model, state: record.state, status: record.status, components: record.components,
    notes: record.notes, registeredBy: record.registeredBy || config.registeredBy,
    createdAt: record.createdAt, updatedAt: record.updatedAt
  });

  async function callApi(config, payload) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30000);
    let response;
    try {
      // text/plain evita a verificação prévia (preflight) de CORS, que o Apps Script não responde.
      response = await fetch(config.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ key: config.teamKey, ...payload }),
        redirect: 'follow',
        signal: controller.signal
      });
    } catch (error) {
      throw new Error(error.name === 'AbortError' ? 'A planilha demorou demais para responder.' : 'Não foi possível falar com a planilha. Confira o endereço configurado.');
    } finally {
      window.clearTimeout(timer);
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error('Resposta inesperada. Confira se o Apps Script está publicado com acesso "Qualquer pessoa".'); }
    if (!data.ok) throw new Error(data.error || 'A planilha recusou a sincronização.');
    return data;
  }

  function mergeServer(data, sentVersions, sentDeletes) {
    const results = data.results || {};
    const fresh = readRecords(); // relê: pode ter havido cadastro durante o envio
    const localById = new Map(fresh.map((record) => [record.id, record]));
    const resolved = (local) => {
      const result = results[local.id];
      if (!result) return false;
      if (local._deleted) return sentDeletes.has(local.id);
      return sentVersions.get(local.id) === local.updatedAt && (result.status === 'ok' || result.status === 'stale');
    };
    const withResult = (local) => {
      const result = results[local.id];
      if (result?.status === 'error' && sentVersions.get(local.id) === local.updatedAt) return { ...local, _sync: 'error', _error: result.message };
      return local;
    };

    const merged = [];
    const seen = new Set();
    (data.records || []).forEach((server) => {
      seen.add(server.id);
      const local = localById.get(server.id);
      if (local && local._sync !== 'synced' && !resolved(local)) merged.push(withResult(local));
      else merged.push({ ...server, components: server.components || [], _sync: 'synced', _remote: true });
    });
    fresh.forEach((local) => {
      if (seen.has(local.id)) return;
      if (local._sync === 'synced') return;                       // excluído por outra pessoa
      if (results[local.id]?.status === 'deleted') return;          // já excluído na planilha
      if (local._deleted && sentDeletes.has(local.id)) return;
      merged.push(withResult(local));
    });
    merged.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    storeRecords(merged);
    if (data.sheetUrl) localStorage.setItem(SHEET_URL_KEY, data.sheetUrl);
    return Object.values(results).filter((result) => result.status === 'error').length;
  }

  async function sync({ manual = false } = {}) {
    if (!isShared()) { if (manual) openSettings(); renderSyncStatus(); return; }
    if (!navigator.onLine) {
      renderSyncStatus();
      if (manual) showToast('Sem internet. Os registros ficam guardados neste aparelho.');
      return;
    }
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    renderSyncStatus();

    const config = readConfig();
    const snapshot = readRecords();
    // Sem nome configurado, só baixa a planilha; o envio espera o nome (coluna "Registrado por").
    const upserts = snapshot.filter((r) => r._sync === 'pending' && !r._deleted && (r.registeredBy || config.registeredBy)).map((r) => toPayload(r, config));
    const deletes = snapshot.filter((r) => r._sync === 'pending' && r._deleted).map((r) => ({ id: r.id, by: r._deletedBy || config.registeredBy }));
    try {
      const data = await callApi(config, { upserts, deletes });
      const rejected = mergeServer(data, new Map(upserts.map((r) => [r.id, r.updatedAt])), new Set(deletes.map((d) => d.id)));
      localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
      lastError = '';
      if (rejected) showToast(`${rejected === 1 ? '1 registro não foi aceito' : `${rejected} registros não foram aceitos`} pela planilha.`);
      else if (manual || upserts.length || deletes.length) showToast('Sincronização concluída.');
    } catch (error) {
      lastError = error.message;
      if (manual) showToast(lastError);
    } finally {
      syncing = false;
      refresh();
      if (syncAgain) { syncAgain = false; sync(); }
    }
  }

  /* ---------- Configurações ---------- */

  const settingsDialog = document.querySelector('#settingsDialog');

  function openSettings(message = '') {
    const config = readConfig();
    document.querySelector('#cfgName').value = config.registeredBy;
    document.querySelector('#cfgApi').value = config.apiUrl;
    document.querySelector('#cfgKey').value = config.teamKey;
    const note = document.querySelector('#settingsMessage');
    note.textContent = message;
    note.hidden = !message;
    settingsDialog.hidden = false;
    document.querySelector(config.registeredBy ? '#cfgApi' : '#cfgName').focus();
  }

  const closeSettings = () => { settingsDialog.hidden = true; };

  document.querySelector('#settingsForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const apiUrl = clean(document.querySelector('#cfgApi').value);
    if (apiUrl && !/^https:\/\/script\.google(usercontent)?\.com\//.test(apiUrl) && !window.confirm('Esse endereço não parece um Apps Script do Google. Salvar mesmo assim?')) return;
    saveConfig({ registeredBy: clean(document.querySelector('#cfgName').value), apiUrl, teamKey: clean(document.querySelector('#cfgKey').value) });
    lastError = '';
    closeSettings();
    refresh();
    showToast('Configurações salvas.');
    sync({ manual: isShared() });
  });

  document.querySelector('#copyTeamLink').addEventListener('click', async () => {
    const apiUrl = clean(document.querySelector('#cfgApi').value);
    const teamKey = clean(document.querySelector('#cfgKey').value);
    if (!apiUrl || !teamKey) return showToast('Preencha o endereço e a chave da equipe primeiro.');
    const link = `${window.location.origin}${window.location.pathname}?api=${encodeURIComponent(apiUrl)}&chave=${encodeURIComponent(teamKey)}`;
    try { await navigator.clipboard.writeText(link); showToast('Link copiado. Envie para a equipe pelo Teams.'); }
    catch { window.prompt('Copie o link:', link); }
  });

  document.querySelector('#settingsButton').addEventListener('click', () => openSettings());
  document.querySelector('#closeSettings').addEventListener('click', closeSettings);
  document.querySelector('#syncNow').addEventListener('click', () => sync({ manual: true }));
  window.addEventListener('online', () => sync());
  window.addEventListener('offline', renderSyncStatus);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  window.setInterval(() => { if (document.visibilityState === 'visible') sync(); }, AUTO_SYNC_MS);

  const assetTagInput = document.querySelector('#assetTag');
  if (assetTagInput) {
    assetTagInput.addEventListener('change', () => {
      assetTagInput.value = formatAssetTag(assetTagInput.value);
    });
  }

  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.view)));
  document.querySelectorAll('[data-scan-target]').forEach((button) => button.addEventListener('click', () => openScanner(button.dataset.scanTarget)));
  document.querySelector('#closeScanner').addEventListener('click', closeScanner);
  document.querySelector('#manualEntry').addEventListener('click', async () => { await closeScanner(); scanTarget?.focus(); });
  document.querySelector('#cancelEdit').addEventListener('click', resetForm);
  document.querySelector('#exportCsv').addEventListener('click', exportCsv);
  searchInput.addEventListener('input', refresh);
  recordList.addEventListener('click', (event) => {
    const edit = event.target.closest('[data-edit]');
    const remove = event.target.closest('[data-delete]');
    if (edit) editRecord(edit.dataset.edit);
    if (remove) deleteRecord(remove.dataset.delete);
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); installPrompt = event; document.querySelector('#installButton').hidden = false;
  });
  document.querySelector('#installButton').addEventListener('click', async () => {
    if (!installPrompt) return;
    await installPrompt.prompt(); installPrompt = null; document.querySelector('#installButton').hidden = true;
  });

  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));

  const modelContext = document.modelContext;
  if (modelContext?.registerTool) {
    const schema = { type: 'object', properties: {}, additionalProperties: false };
    Promise.resolve(modelContext.registerTool({
      name: 'list_inventory_records', title: 'Listar inventário',
      description: 'Lista os computadores do inventário (planilha da equipe, se configurada).', inputSchema: schema,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: () => { const records = visibleRecords(); return { count: records.length, records }; }
    })).catch(() => {});
  }

  refresh();
  if (isShared() && !readConfig().registeredBy) openSettings('Bem-vindo! Informe seu nome para registrar computadores na planilha da equipe.');
  sync();
})();
