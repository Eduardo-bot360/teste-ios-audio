// db.js — armazenamento persistente dos testes.
// Tudo que os testes medem vai para o IndexedDB com timestamp, para sobreviver
// ao bloqueio de tela, ao descarte da aba pelo iOS e ao fechamento do app.

const DB_NOME = 'teste-ios-audio';
const DB_VERSAO = 1;

let _db = null;

export function abrirDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NOME, DB_VERSAO);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('log')) {
        const s = db.createObjectStore('log', { keyPath: 'id', autoIncrement: true });
        s.createIndex('runId', 'runId');
        s.createIndex('ts', 'ts');
      }
      if (!db.objectStoreNames.contains('hb')) {
        // heartbeat: posição do áudio x relógio de parede, a cada poucos segundos
        const s = db.createObjectStore('hb', { keyPath: 'id', autoIncrement: true });
        s.createIndex('runId', 'runId');
      }
      if (!db.objectStoreNames.contains('runs')) {
        db.createObjectStore('runs', { keyPath: 'runId' });
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('fill')) {
        // blocos do teste de cota
        db.createObjectStore('fill', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
      if (ev.oldVersion === 0) { /* criação inicial */ }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, modo) {
  return abrirDB().then((db) => db.transaction(store, modo).objectStore(store));
}

function pedido(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- log de eventos ---

export async function logar(teste, evento, detalhe, runId) {
  const reg = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    teste: teste || '-',
    evento,
    detalhe: detalhe === undefined ? null : detalhe,
    runId: runId || '-',
  };
  try {
    const s = await tx('log', 'readwrite');
    await pedido(s.add(reg));
  } catch (e) {
    console.error('falha ao gravar log', e, reg);
  }
  return reg;
}

export async function lerLogPorRun(runId) {
  const s = await tx('log', 'readonly');
  const todos = await pedido(s.index('runId').getAll(runId));
  return todos.sort((a, b) => a.ts - b.ts);
}

export async function lerLog(limite) {
  const s = await tx('log', 'readonly');
  const todos = await pedido(s.getAll());
  todos.sort((a, b) => b.ts - a.ts);
  return limite ? todos.slice(0, limite) : todos;
}

// --- heartbeats ---

export async function gravarHb(runId, audioTime, pausado, origem) {
  try {
    const s = await tx('hb', 'readwrite');
    await pedido(s.add({ runId, ts: Date.now(), audioTime, pausado, origem }));
  } catch (e) { /* silencioso: heartbeat não pode derrubar a reprodução */ }
}

export async function lerHb(runId) {
  const s = await tx('hb', 'readonly');
  const todos = await pedido(s.index('runId').getAll(runId));
  return todos.sort((a, b) => a.ts - b.ts);
}

// --- runs (uma execução de teste de áudio) ---

export async function salvarRun(run) {
  const s = await tx('runs', 'readwrite');
  await pedido(s.put(run));
  return run;
}

export async function lerRuns() {
  const s = await tx('runs', 'readonly');
  const todos = await pedido(s.getAll());
  return todos.sort((a, b) => b.inicio - a.inicio);
}

export async function lerRun(runId) {
  const s = await tx('runs', 'readonly');
  return pedido(s.get(runId));
}

// --- blobs de áudio ---

export async function salvarBlob(id, blob, rotulo) {
  const s = await tx('blobs', 'readwrite');
  await pedido(s.put({ id, blob, bytes: blob.size, tipo: blob.type, salvoEm: Date.now(), rotulo }));
}

export async function lerBlob(id) {
  const s = await tx('blobs', 'readonly');
  return pedido(s.get(id));
}

export async function listarBlobs() {
  const s = await tx('blobs', 'readonly');
  return pedido(s.getAll());
}

export async function apagarBlob(id) {
  const s = await tx('blobs', 'readwrite');
  return pedido(s.delete(id));
}

// --- teste de cota (store fill) ---

export async function gravarBloco(bytes) {
  const db = await abrirDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('fill', 'readwrite');
    const req = t.objectStore('fill').add({ dados: new Blob([new Uint8Array(bytes)]), bytes });
    let chave = null;
    req.onsuccess = () => { chave = req.result; };
    t.oncomplete = () => resolve(chave);
    t.onerror = () => reject(t.error || new Error('erro na transação'));
    t.onabort = () => reject(t.error || new Error('transação abortada'));
  });
}

export async function contarBlocos() {
  const s = await tx('fill', 'readonly');
  const todos = await pedido(s.getAll());
  return { n: todos.length, bytes: todos.reduce((a, b) => a + (b.bytes || 0), 0) };
}

export async function limparFill() {
  const s = await tx('fill', 'readwrite');
  return pedido(s.clear());
}

// --- meta (pares chave/valor: bateria, marcos, assinatura push, etc.) ---

export async function setMeta(k, v) {
  const s = await tx('meta', 'readwrite');
  await pedido(s.put({ k, v, ts: Date.now() }));
}

export async function getMeta(k) {
  const s = await tx('meta', 'readonly');
  const r = await pedido(s.get(k));
  return r ? r.v : undefined;
}

export async function getMetaCompleto(k) {
  const s = await tx('meta', 'readonly');
  return pedido(s.get(k));
}

export async function lerTodoMeta() {
  const s = await tx('meta', 'readonly');
  return pedido(s.getAll());
}

export async function apagarTudo() {
  const db = await abrirDB();
  const nomes = ['log', 'hb', 'runs', 'blobs', 'fill', 'meta'];
  return new Promise((resolve, reject) => {
    const t = db.transaction(nomes, 'readwrite');
    nomes.forEach((n) => t.objectStore(n).clear());
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
