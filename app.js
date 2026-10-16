// app.js — os 8 testes. Nada de build, nada de framework.
import * as db from './db.js';

const ARQUIVO_AUDIO = 'audio/teste-27min.mp3';
const VAPID_PUBLICA = 'BLMugK-8Lz6T601482aaEd86Lb3rByJo6QJq3_pL53Wv25sAx-8v-NlORPrPv3LnttG3D46eejWIfMk5qGo-S_4';
const HB_INTERVALO_MS = 5000;     // heartbeat a cada 5 s
const GAP_MINIMO_S = 12;          // acima disso, consideramos que a página foi congelada
const BLOB_ID = 'audio-offline';
const MARCO_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------- estado

const est = {
  runId: null,
  run: null,
  wakeLockPedido: false,
  sentinel: null,
  hbTimer: null,
  ultimoHbAudio: -99,
  pararCota: false,
  blobURL: null,
  silencioso: null,   // o que o Eduardo declarou sobre o botão físico
};

const audio = () => document.getElementById('audio');
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- utilitários

const mmss = (s) => {
  if (s == null || !isFinite(s)) return '--:--';
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const mb = (b) => (b == null ? '?' : (b / 1024 / 1024).toFixed(1) + ' MB');
const hora = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour12: false });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function toast(msg, erro) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast visivel' + (erro ? ' erro' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, 4000);
}

function setTexto(id, txt, classe) {
  const el = $(id);
  if (!el) return;
  el.textContent = txt;
  if (classe !== undefined) el.className = 'estado ' + (classe || '');
}

async function log(teste, evento, detalhe) {
  const r = await db.logar(teste, evento, detalhe, est.runId || '-');
  return r;
}

// ---------------------------------------------------------------- dispositivo

function modoExibicao() {
  const modos = ['standalone', 'fullscreen', 'minimal-ui', 'browser'];
  const achado = modos.find((m) => window.matchMedia(`(display-mode: ${m})`).matches);
  const navStandalone = ('standalone' in navigator) ? navigator.standalone : null;
  return { displayMode: achado || 'desconhecido', navigatorStandalone: navStandalone };
}

function infoDispositivo() {
  const m = modoExibicao();
  return {
    ua: navigator.userAgent,
    plataforma: navigator.platform,
    idioma: navigator.language,
    tela: `${screen.width}x${screen.height} @${devicePixelRatio}x`,
    instalada: m.displayMode === 'standalone' || m.navigatorStandalone === true,
    displayMode: m.displayMode,
    navigatorStandalone: m.navigatorStandalone,
    seguro: window.isSecureContext,
    wakeLockAPI: 'wakeLock' in navigator,
    mediaSessionAPI: 'mediaSession' in navigator,
    storageEstimateAPI: !!(navigator.storage && navigator.storage.estimate),
    storagePersistAPI: !!(navigator.storage && navigator.storage.persist),
    serviceWorkerAPI: 'serviceWorker' in navigator,
    pushManagerAPI: 'PushManager' in window,
    notificationAPI: 'Notification' in window,
    permissaoNotificacao: ('Notification' in window) ? Notification.permission : 'n/d',
    backgroundSync: 'SyncManager' in window,
    getBatteryAPI: 'getBattery' in navigator,
    audioContextAPI: !!(window.AudioContext || window.webkitAudioContext),
  };
}

async function mostrarInfo() {
  const i = infoDispositivo();
  await db.setMeta('dispositivo', i);
  const linhas = [
    ['Contexto seguro (HTTPS)', i.seguro ? 'sim' : 'NÃO — service worker e Wake Lock não funcionam'],
    ['Instalada na tela de início', i.instalada ? 'SIM' : 'não (rodando no Safari) — teste 7 exige instalada'],
    ['display-mode', i.displayMode],
    ['Wake Lock API', i.wakeLockAPI ? 'disponível' : 'AUSENTE'],
    ['Media Session API', i.mediaSessionAPI ? 'disponível' : 'AUSENTE'],
    ['Service Worker', i.serviceWorkerAPI ? 'disponível' : 'AUSENTE'],
    ['Push Manager', i.pushManagerAPI ? 'disponível' : 'AUSENTE'],
    ['Notification', i.notificationAPI ? `disponível (permissão: ${i.permissaoNotificacao})` : 'AUSENTE'],
    ['Background Sync', i.backgroundSync ? 'disponível' : 'ausente (esperado no iOS)'],
    ['storage.estimate()', i.storageEstimateAPI ? 'disponível' : 'AUSENTE'],
    ['Battery API', i.getBatteryAPI ? 'disponível' : 'ausente (esperado no iOS) — anotar bateria à mão'],
    ['Tela', i.tela],
    ['User agent', i.ua],
  ];
  $('info-dispositivo').innerHTML = linhas
    .map(([k, v]) => `<div class="par"><span>${k}</span><b>${v}</b></div>`).join('');
  if (!i.instalada) $('aviso-instalar').classList.remove('oculto');
}

// ================================================================
// TESTES 1 e 2 — áudio longo com a tela bloqueada, sem e com Wake Lock
// ================================================================

function ligarListenersAudio() {
  const a = audio();
  const eventos = ['play', 'playing', 'pause', 'ended', 'stalled', 'suspend',
    'waiting', 'error', 'emptied', 'abort', 'ratechange', 'volumechange',
    'loadedmetadata', 'canplay', 'seeked', 'timeupdate'];
  eventos.forEach((ev) => a.addEventListener(ev, () => {
    if (ev === 'timeupdate') {
      // heartbeat guiado pelo próprio áudio: funciona mesmo se o timer for estrangulado
      if (a.currentTime - est.ultimoHbAudio >= HB_INTERVALO_MS / 1000) {
        est.ultimoHbAudio = a.currentTime;
        if (est.runId) db.gravarHb(est.runId, a.currentTime, a.paused, 'timeupdate');
      }
      atualizarPainelRun();
      return;
    }
    const det = { t: +a.currentTime.toFixed(2), pausado: a.paused, fim: a.ended };
    if (ev === 'error' && a.error) det.erro = { code: a.error.code, msg: a.error.message };
    log('audio', ev, det);
    atualizarPainelRun();
  }));

  // ciclo de vida da página — é aqui que se vê o iOS congelar a aba
  ['visibilitychange', 'freeze', 'resume', 'pagehide', 'pageshow'].forEach((ev) => {
    const alvo = (ev === 'visibilitychange') ? document : window;
    alvo.addEventListener(ev, async () => {
      const a2 = audio();
      await log('pagina', ev, {
        visibilidade: document.visibilityState,
        t: +a2.currentTime.toFixed(2),
        pausado: a2.paused,
      });
      if (ev === 'visibilitychange' && document.visibilityState === 'visible') {
        if (est.runId) {
          db.gravarHb(est.runId, a2.currentTime, a2.paused, 'retorno');
          // o Wake Lock é liberado pelo sistema quando a página fica oculta
          if (est.wakeLockPedido && (!est.sentinel || est.sentinel.released)) pedirWakeLock();
          renderRuns();
        }
      }
      atualizarPainelRun();
    });
  });
}

async function pedirWakeLock() {
  if (!('wakeLock' in navigator)) {
    setTexto('wl-estado', 'Wake Lock API não existe neste navegador', 'ruim');
    await log('wakelock', 'indisponivel');
    return false;
  }
  try {
    est.sentinel = await navigator.wakeLock.request('screen');
    setTexto('wl-estado', 'Wake Lock ATIVO (a tela não apaga sozinha)', 'bom');
    await log('wakelock', 'ativo');
    est.sentinel.addEventListener('release', async () => {
      setTexto('wl-estado', 'Wake Lock liberado pelo sistema', 'atencao');
      await log('wakelock', 'liberado', { visibilidade: document.visibilityState });
    });
    return true;
  } catch (e) {
    setTexto('wl-estado', 'Wake Lock recusado: ' + e.name + ' — ' + e.message, 'ruim');
    await log('wakelock', 'recusado', { nome: e.name, msg: e.message });
    return false;
  }
}

async function soltarWakeLock() {
  if (est.sentinel && !est.sentinel.released) {
    try { await est.sentinel.release(); } catch (e) { /* ignora */ }
  }
  est.sentinel = null;
}

// O iOS só autoriza play() dentro do gesto que o usuário acabou de fazer. Um
// único await antes de play() já derruba a permissão — por isso a reprodução
// (e o Wake Lock) saem primeiro, e a escrituração no IndexedDB vem depois.
function prepararFonte(fonte) {
  const a = audio();
  if (fonte === 'blob') {
    if (!est.blobURL) return false;           // URL pré-criada no carregamento
    if (a.src !== est.blobURL) a.src = est.blobURL;
    return true;
  }
  if (a.src !== new URL(ARQUIVO_AUDIO, location.href).href) a.src = ARQUIVO_AUDIO;
  return true;
}

async function iniciarRun(opcoes) {
  const { comWakeLock, rotulo, fonte } = opcoes;
  const a = audio();

  // ---- parte síncrona: dentro do gesto do usuário ----
  if (!prepararFonte(fonte || 'rede')) {
    toast('Nenhum áudio baixado. Rode o teste 6 primeiro.', true);
    return;
  }
  const runAnterior = est.runId;
  clearInterval(est.hbTimer);
  est.hbTimer = null;
  est.runId = 'r' + Date.now();
  est.wakeLockPedido = !!comWakeLock;
  est.ultimoHbAudio = -99;
  try { a.currentTime = 0; } catch (e) { /* ainda não seekable; play começa do zero */ }
  const promessaPlay = a.play();
  const promessaWL = comWakeLock ? pedirWakeLock() : null;
  setTexto('run-estado', `Rodando: ${rotulo}`, 'bom');

  // ---- daqui em diante, trabalho assíncrono ----
  if (runAnterior) await encerrarRunNoBanco(runAnterior, 'nova run iniciada');

  est.run = {
    runId: est.runId,
    inicio: Date.now(),
    rotulo,
    comWakeLock: !!comWakeLock,
    fonte: fonte || 'rede',
    silenciosoDeclarado: est.silencioso,
    instalada: infoDispositivo().instalada,
    bateriaAntes: numeroOuNull($('bateria-antes').value),
    bateriaDepois: null,
    fim: null,
  };
  await db.salvarRun(est.run);
  await log('run', 'inicio', est.run);
  db.gravarHb(est.runId, a.currentTime, a.paused, 'inicio');

  if (!comWakeLock) {
    await soltarWakeLock();
    setTexto('wl-estado', 'Wake Lock não solicitado (baseline)', '');
  } else if (promessaWL) {
    await promessaWL;
  }

  try {
    await promessaPlay;
    await log('run', 'play-ok', { t: +a.currentTime.toFixed(2) });
  } catch (e) {
    await log('run', 'play-falhou', { nome: e.name, msg: e.message });
    setTexto('run-estado', 'play() falhou: ' + e.name, 'ruim');
    toast('play() falhou: ' + e.message, true);
  }

  aplicarMediaSession();
  est.hbTimer = setInterval(() => {
    const a2 = audio();
    if (est.runId) db.gravarHb(est.runId, a2.currentTime, a2.paused, 'timer');
    atualizarPainelRun();
  }, HB_INTERVALO_MS);

  atualizarPainelRun();
  renderRuns();
}

// Fecha a run no banco: usado tanto pelo botão Parar quanto ao iniciar outra.
async function encerrarRunNoBanco(runId, motivo) {
  const a = audio();
  db.gravarHb(runId, a.currentTime, a.paused, 'parada');
  await db.logar('run', 'fim', { motivo, t: +a.currentTime.toFixed(2) }, runId);
  const run = await db.lerRun(runId);
  if (run) {
    run.fim = Date.now();
    run.posicaoFinal = a.currentTime;
    run.bateriaDepois = numeroOuNull($('bateria-depois').value);
    await db.salvarRun(run);
  }
}

async function pararRun(motivo) {
  const a = audio();
  const runId = est.runId;
  clearInterval(est.hbTimer);
  est.hbTimer = null;
  a.pause();
  est.runId = null;
  est.run = null;
  if (runId) await encerrarRunNoBanco(runId, motivo);
  await soltarWakeLock();
  setTexto('run-estado', 'Parado', '');
  atualizarPainelRun();
  renderRuns();
}

function numeroOuNull(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}

function atualizarPainelRun() {
  const a = audio();
  $('run-posicao').textContent =
    `${mmss(a.currentTime)} / ${mmss(a.duration)}  ·  ${a.paused ? 'PAUSADO' : 'tocando'}`;
}

// Análise: a run tocou até o fim? Se parou, em que segundo?
export async function analisarRun(runId) {
  const run = await db.lerRun(runId);
  const hbs = await db.lerHb(runId);
  if (!run || hbs.length < 2) return { runId, veredito: 'sem dados suficientes', hbs: hbs.length };

  const primeiro = hbs[0];
  const ultimo = hbs[hbs.length - 1];
  const lacunas = [];
  for (let i = 1; i < hbs.length; i++) {
    const dw = (hbs[i].ts - hbs[i - 1].ts) / 1000;         // segundos de relógio
    const da = hbs[i].audioTime - hbs[i - 1].audioTime;     // segundos de áudio
    if (dw >= GAP_MINIMO_S) {
      lacunas.push({
        emSegundoDoAudio: +hbs[i - 1].audioTime.toFixed(1),
        relogioParado: +dw.toFixed(1),
        audioAvancou: +da.toFixed(1),
        proporcao: dw > 0 ? +(da / dw).toFixed(3) : 0,
        parouEm: +(hbs[i - 1].audioTime + Math.max(0, da)).toFixed(1),
        voltouEm: +hbs[i].audioTime.toFixed(1),
        pausadoNoRetorno: hbs[i].pausado,
      });
    }
  }

  const duracaoAudio = +(ultimo.audioTime - primeiro.audioTime).toFixed(1);
  const duracaoRelogio = +((ultimo.ts - primeiro.ts) / 1000).toFixed(1);
  const proporcaoGeral = duracaoRelogio > 0 ? +(duracaoAudio / duracaoRelogio).toFixed(3) : 0;

  let veredito;
  if (!lacunas.length) {
    veredito = proporcaoGeral > 0.9
      ? 'áudio avançou de ponta a ponta — a página nunca foi congelada (nenhuma lacuna > 12 s)'
      : 'página ficou viva o tempo todo, mas o áudio avançou menos que o relógio (pausas registradas)';
  } else {
    const piores = lacunas.filter((l) => l.proporcao < 0.9);
    if (!piores.length) {
      veredito = `SOBREVIVEU: a página foi congelada ${lacunas.length}x e o áudio continuou tocando em todas`;
    } else {
      const p = piores[0];
      // o que decide a frase é quanto o áudio andou, não a proporção:
      // 42 s de 1200 é proporção baixa, mas não é "não avançou nada"
      if (p.audioAvancou < 3) {
        veredito = `PAROU em ${mmss(p.parouEm)} (${p.parouEm} s) — morreu no bloqueio, não avançou nada nos ${p.relogioParado} s seguintes`;
      } else {
        veredito = `PAROU em ${mmss(p.parouEm)} (${p.parouEm} s) — ainda tocou ${p.audioAvancou} s depois do bloqueio e então morreu (${p.relogioParado} s de tela apagada)`;
      }
    }
  }

  return {
    runId, rotulo: run.rotulo, comWakeLock: run.comWakeLock, fonte: run.fonte,
    silenciosoDeclarado: run.silenciosoDeclarado, instalada: run.instalada,
    inicio: run.inicio, fim: run.fim,
    bateriaAntes: run.bateriaAntes, bateriaDepois: run.bateriaDepois,
    bateriaGasta: (run.bateriaAntes != null && run.bateriaDepois != null)
      ? +(run.bateriaAntes - run.bateriaDepois).toFixed(1) : null,
    posicaoFinal: +(ultimo.audioTime).toFixed(1),
    duracaoAudio, duracaoRelogio, proporcaoGeral,
    heartbeats: hbs.length, lacunas, veredito,
  };
}

async function renderRuns() {
  const runs = await db.lerRuns();
  if (!runs.length) { $('runs-lista').innerHTML = '<p class="vazio">Nenhuma run ainda.</p>'; return; }
  const analises = await Promise.all(runs.slice(0, 12).map((r) => analisarRun(r.runId)));
  $('runs-lista').innerHTML = analises.map((a) => {
    const cls = /SOBREVIVEU|ponta a ponta/.test(a.veredito) ? 'bom'
      : /PAROU/.test(a.veredito) ? 'ruim' : 'atencao';
    const bat = a.bateriaGasta != null ? ` · bateria −${a.bateriaGasta}%` : '';
    return `<div class="run ${cls}">
      <div class="run-top"><b>${a.rotulo || a.runId}</b><span>${hora(a.inicio)}</span></div>
      <div class="run-meta">Wake Lock: ${a.comWakeLock ? 'SIM' : 'não'} · fonte: ${a.fonte}
        · áudio ${mmss(a.posicaoFinal)} em ${mmss(a.duracaoRelogio)} de relógio${bat}</div>
      <div class="run-veredito">${a.veredito}</div>
      ${a.lacunas && a.lacunas.length ? `<div class="run-lacunas">${a.lacunas.map((l) =>
        `tela apagada em ${mmss(l.emSegundoDoAudio)} → ${l.relogioParado}s fora, áudio andou ${l.audioAvancou}s (${Math.round(l.proporcao * 100)}%)`
      ).join('<br>')}</div>` : ''}
    </div>`;
  }).join('');
}

// ================================================================
// TESTE 3 — botão físico de silencioso
// ================================================================

function declararSilencioso(ligado) {
  est.silencioso = ligado ? 'ligado' : 'desligado';
  setTexto('silencioso-estado', `Declarado: botão de silencioso ${est.silencioso.toUpperCase()}`, '');
  log('silencioso', 'declarado', { estado: est.silencioso });
  toast(`Anotado: silencioso ${est.silencioso}`);
}

async function silenciosoOuvi(ouviu, via) {
  const a = audio();
  await log('silencioso', ouviu ? 'ouviu-som' : 'nao-ouviu-som', {
    via,
    silencioso: est.silencioso,
    t: +a.currentTime.toFixed(2),
    pausado: a.paused,
    volume: a.volume,
    mudo: a.muted,
    avancando: a.currentTime > 0 && !a.paused,
  });
  const r = await db.getMeta('silencioso') || {};
  r[`${via}_${est.silencioso || 'nao-declarado'}`] = ouviu ? 'ouviu' : 'não ouviu';
  await db.setMeta('silencioso', r);
  toast(ouviu ? 'Anotado: ouviu som' : 'Anotado: não ouviu som');
  mostrarResultadoSilencioso();
}

async function mostrarResultadoSilencioso() {
  const r = await db.getMeta('silencioso') || {};
  const chaves = Object.keys(r);
  $('silencioso-resultado').innerHTML = chaves.length
    ? chaves.map((k) => `<div class="par"><span>${k.replace('_', ' / silencioso ')}</span><b>${r[k]}</b></div>`).join('')
    : '<p class="vazio">Nada anotado ainda.</p>';
}

// Alternativa: rotear o áudio pela Web Audio API, que em alguns casos ignora o
// botão de silencioso. Se funcionar, é uma mitigação real para o produto.
let ctxWeb = null;
async function tocarTomWebAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!ctxWeb) ctxWeb = new AC();
    await ctxWeb.resume();
    const osc = ctxWeb.createOscillator();
    const g = ctxWeb.createGain();
    osc.frequency.value = 440;
    g.gain.value = 0.15;
    osc.connect(g).connect(ctxWeb.destination);
    osc.start();
    setTimeout(() => { osc.stop(); osc.disconnect(); }, 3000);
    await log('silencioso', 'webaudio-tom-disparado', { estado: ctxWeb.state, silencioso: est.silencioso });
    toast('Tom de 3 s pela Web Audio. Ouviu?');
  } catch (e) {
    await log('silencioso', 'webaudio-falhou', { nome: e.name, msg: e.message });
    toast('Web Audio falhou: ' + e.message, true);
  }
}

// ================================================================
// TESTE 4 — Media Session API
// ================================================================

function aplicarMediaSession() {
  if (!('mediaSession' in navigator)) {
    setTexto('ms-estado', 'Media Session API ausente', 'ruim');
    return;
  }
  const a = audio();
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Teste de áudio — 27 min',
      artist: 'Validação técnica iOS',
      album: 'Protocolo de 21 dias',
      artwork: [
        { src: 'icone-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icone-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
    const acoes = {
      play: () => { a.play(); },
      pause: () => { a.pause(); },
      stop: () => { a.pause(); },
      seekbackward: (d) => { a.currentTime = Math.max(0, a.currentTime - (d.seekOffset || 15)); },
      seekforward: (d) => { a.currentTime = Math.min(a.duration || 1e9, a.currentTime + (d.seekOffset || 15)); },
      seekto: (d) => { if (d.seekTime != null) a.currentTime = d.seekTime; },
      previoustrack: () => { a.currentTime = 0; },
      nexttrack: () => { a.currentTime = Math.min(a.duration || 1e9, a.currentTime + 60); },
    };
    const aceitas = [];
    Object.entries(acoes).forEach(([nome, fn]) => {
      try {
        navigator.mediaSession.setActionHandler(nome, (d) => {
          log('mediasession', 'acao:' + nome, { t: +a.currentTime.toFixed(2), detalhe: d ? { ...d } : null });
          registrarAcaoMS(nome);
          fn(d || {});
        });
        aceitas.push(nome);
      } catch (e) { /* ação não suportada */ }
    });
    navigator.mediaSession.playbackState = a.paused ? 'paused' : 'playing';
    try {
      if (a.duration && isFinite(a.duration)) {
        navigator.mediaSession.setPositionState({
          duration: a.duration, position: a.currentTime, playbackRate: a.playbackRate,
        });
      }
    } catch (e) { /* setPositionState pode não existir */ }
    setTexto('ms-estado', `Metadados e ${aceitas.length} ações registradas: ${aceitas.join(', ')}`, 'bom');
    log('mediasession', 'registrado', { acoes: aceitas, setPositionState: 'setPositionState' in navigator.mediaSession });
  } catch (e) {
    setTexto('ms-estado', 'Falhou: ' + e.message, 'ruim');
    log('mediasession', 'falhou', { nome: e.name, msg: e.message });
  }
}

async function registrarAcaoMS(nome) {
  const r = await db.getMeta('mediasession-acoes') || {};
  r[nome] = (r[nome] || 0) + 1;
  await db.setMeta('mediasession-acoes', r);
  mostrarAcoesMS();
}

async function mostrarAcoesMS() {
  const r = await db.getMeta('mediasession-acoes') || {};
  const ks = Object.keys(r);
  $('ms-eventos').innerHTML = ks.length
    ? ks.map((k) => `<div class="par"><span>${k}</span><b>${r[k]}x</b></div>`).join('')
    : '<p class="vazio">Nenhum controle da tela de bloqueio foi acionado ainda.</p>';
}

// ================================================================
// TESTE 5 — cota real de armazenamento
// ================================================================

async function estimativa() {
  if (!(navigator.storage && navigator.storage.estimate)) return null;
  try {
    const e = await navigator.storage.estimate();
    return { quota: e.quota, uso: e.usage, detalhes: e.usageDetails || null };
  } catch (err) { return { erro: err.message }; }
}

async function mostrarEstimativa() {
  const e = await estimativa();
  if (!e) { setTexto('cota-estado', 'storage.estimate() não existe neste navegador', 'ruim'); return; }
  if (e.erro) { setTexto('cota-estado', 'estimate() falhou: ' + e.erro, 'ruim'); return; }
  const persistido = (navigator.storage && navigator.storage.persisted)
    ? await navigator.storage.persisted() : null;
  await db.setMeta('estimativa', { ...e, persistido, ts: Date.now() });
  await log('cota', 'estimate', { ...e, persistido });
  const livre = e.quota - e.uso;
  $('cota-numeros').innerHTML = [
    ['Cota informada pelo navegador', mb(e.quota)],
    ['Em uso agora', mb(e.uso)],
    ['Livre (pela estimativa)', mb(livre)],
    ['Armazenamento persistente', persistido === null ? 'API ausente' : (persistido ? 'SIM' : 'não')],
    ['Detalhes por tipo', e.detalhes ? JSON.stringify(e.detalhes) : 'não informado (Safari não informa)'],
  ].map(([k, v]) => `<div class="par"><span>${k}</span><b>${v}</b></div>`).join('');
  setTexto('cota-estado', `Cota informada: ${mb(e.quota)} · livre ${mb(livre)}`, 'bom');
}

async function pedirPersistencia() {
  if (!(navigator.storage && navigator.storage.persist)) {
    toast('storage.persist() não existe', true);
    await log('cota', 'persist-indisponivel');
    return;
  }
  const ok = await navigator.storage.persist();
  await log('cota', 'persist', { concedido: ok });
  toast(ok ? 'Armazenamento persistente CONCEDIDO' : 'Armazenamento persistente NEGADO', !ok);
  mostrarEstimativa();
}

// Grava blocos até falhar. O número que sai daqui é o limite de verdade.
async function encherArmazenamento() {
  est.pararCota = false;
  $('b-cota-encher').disabled = true;
  $('b-cota-parar').disabled = false;

  const tetoMB = numeroOuNull($('cota-teto').value) || 2000;
  const tetoBytes = tetoMB * 1024 * 1024;
  let bloco = 5 * 1024 * 1024;
  const existente = await db.contarBlocos();
  let total = existente.bytes;
  let n = existente.n;
  const antes = await estimativa();
  await log('cota', 'encher:inicio', { tetoMB, blocoMB: bloco / 1048576, jaGravado: total, antes });

  let erroFinal = null;
  const t0 = Date.now();

  while (!est.pararCota) {
    if (total + bloco > tetoBytes) {
      erroFinal = { tipo: 'teto', msg: `teto do teste (${tetoMB} MB) alcançado antes de qualquer erro` };
      break;
    }
    try {
      await db.gravarBloco(bloco);
      total += bloco; n += 1;
    } catch (e) {
      await log('cota', 'erro-ao-gravar', { nome: e.name, msg: e.message, blocoMB: +(bloco / 1048576).toFixed(2), totalMB: +(total / 1048576).toFixed(1) });
      if (bloco > 1024 * 1024) { bloco = 1024 * 1024; continue; }       // refina para 1 MB
      if (bloco > 256 * 1024) { bloco = 256 * 1024; continue; }          // refina para 256 KB
      erroFinal = { tipo: 'erro', nome: e.name, msg: e.message };
      break;
    }
    if (n % 5 === 0) {
      const e2 = await estimativa();
      await log('cota', 'progresso', { n, totalMB: +(total / 1048576).toFixed(1), estimate: e2 });
    }
    $('cota-progresso').textContent =
      `${n} blocos · ${mb(total)} gravados · bloco atual ${mb(bloco)} · ${Math.round((Date.now() - t0) / 1000)}s`;
    await dormir(0);
  }

  const depois = await estimativa();
  const resultado = {
    bytesGravados: total,
    mbGravados: +(total / 1048576).toFixed(1),
    blocos: n,
    encerradoPor: est.pararCota ? 'interrompido à mão' : (erroFinal ? erroFinal.tipo : 'desconhecido'),
    erro: erroFinal,
    estimateAntes: antes,
    estimateDepois: depois,
    ts: Date.now(),
  };
  await db.setMeta('cota-medida', resultado);
  await log('cota', 'encher:fim', resultado);

  $('b-cota-encher').disabled = false;
  $('b-cota-parar').disabled = true;
  const limitePor = resultado.encerradoPor === 'teto'
    ? `no mínimo ${mb(total)} (bateu no teto do teste, não no limite do sistema)`
    : resultado.encerradoPor === 'erro'
      ? `${mb(total)} — falhou com ${erroFinal.nome}: ${erroFinal.msg}`
      : `${mb(total)} até a interrupção`;
  setTexto('cota-estado', 'Limite medido: ' + limitePor, resultado.encerradoPor === 'erro' ? 'atencao' : 'bom');
  mostrarEstimativa();
  mostrarSessoesQueCabem();
}

async function limparArmazenamento() {
  await db.limparFill();
  await log('cota', 'fill-limpo');
  $('cota-progresso').textContent = '';
  toast('Blocos do teste de cota apagados');
  mostrarEstimativa();
}

const BYTES_SESSAO_25MIN = Math.round(25 * 60 * 96000 / 8); // 96 kbps mono = 18.000.000 bytes

async function mostrarSessoesQueCabem() {
  const medida = await db.getMeta('cota-medida');
  const e = await estimativa();
  const limite = medida ? medida.bytesGravados : (e ? e.quota - e.uso : null);
  if (limite == null) { $('cota-sessoes').textContent = ''; return; }
  const n = Math.floor(limite / BYTES_SESSAO_25MIN);
  const fonte = medida
    ? (medida.encerradoPor === 'teto' ? 'medido, limitado pelo teto do teste' : 'medido até o erro de cota')
    : 'estimativa do navegador, não medido';
  $('cota-sessoes').innerHTML =
    `<b>${n} sessões de 25 min</b> cabem offline (${mb(limite)} ÷ ${mb(BYTES_SESSAO_25MIN)} por sessão) — ${fonte}`;
}

// ================================================================
// TESTE 6 — baixar para IndexedDB como Blob e tocar do blob sem rede
// ================================================================

async function baixarAudio() {
  $('b-dl-baixar').disabled = true;
  setTexto('dl-estado', 'Baixando...', '');
  await log('offline', 'download:inicio', { url: ARQUIVO_AUDIO });
  const t0 = Date.now();
  try {
    const resp = await fetch(ARQUIVO_AUDIO, { cache: 'no-store' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const total = +(resp.headers.get('content-length') || 0);
    const partes = [];
    let lidos = 0;
    if (resp.body && resp.body.getReader) {
      const leitor = resp.body.getReader();
      for (;;) {
        const { done, value } = await leitor.read();
        if (done) break;
        partes.push(value);
        lidos += value.byteLength;
        $('dl-progresso').textContent = total
          ? `${mb(lidos)} de ${mb(total)} (${Math.round(lidos / total * 100)}%)`
          : mb(lidos);
      }
    } else {
      const b = await resp.blob();
      partes.push(b); lidos = b.size;
    }
    const blob = new Blob(partes, { type: 'audio/mpeg' });
    await db.salvarBlob(BLOB_ID, blob, 'teste 27 min');
    const seg = ((Date.now() - t0) / 1000).toFixed(1);
    await log('offline', 'download:ok', { bytes: blob.size, segundos: +seg });
    setTexto('dl-estado', `Guardado no IndexedDB: ${mb(blob.size)} em ${seg}s`, 'bom');
    await db.setMeta('offline-download', { bytes: blob.size, segundos: +seg, ts: Date.now() });
  } catch (e) {
    await log('offline', 'download:falhou', { nome: e.name, msg: e.message });
    setTexto('dl-estado', 'Download falhou: ' + e.message, 'ruim');
  }
  $('b-dl-baixar').disabled = false;
  mostrarBlobGuardado();
}

async function mostrarBlobGuardado() {
  const reg = await db.lerBlob(BLOB_ID);
  // cria a URL do blob agora: no clique não há tempo de ler o IndexedDB
  if (reg) {
    if (est.blobURL) URL.revokeObjectURL(est.blobURL);
    est.blobURL = URL.createObjectURL(reg.blob);
  }
  $('dl-guardado').innerHTML = reg
    ? `<div class="par"><span>Blob no IndexedDB</span><b>${mb(reg.bytes)} · ${reg.tipo} · ${new Date(reg.salvoEm).toLocaleString('pt-BR')}</b></div>`
    : '<p class="vazio">Nenhum áudio baixado.</p>';
  $('b-dl-tocar-blob').disabled = !reg;
}

// Toca a partir do blob e testa o que o produto precisa: duração legível e seek.
async function tocarDoBlob() {
  const online = navigator.onLine;
  // iniciarRun toca a partir de est.blobURL, já criada no carregamento da página,
  // para não gastar o gesto do usuário lendo o IndexedDB antes do play()
  const p = iniciarRun({
    comWakeLock: false,
    rotulo: 'teste 6 — tocando do blob' + (online ? ' (rede ligada)' : ' (OFFLINE)'),
    fonte: 'blob',
  });
  const reg = await db.lerBlob(BLOB_ID);
  if (!reg) { toast('Baixe o áudio primeiro', true); return; }
  await log('offline', 'tocar-blob:inicio', { bytes: reg.bytes, navigatorOnLine: online });
  await p;

  const a = audio();
  await dormir(1500);
  const duracaoOK = isFinite(a.duration) && a.duration > 1000;
  // seek: o produto precisa retomar a sessão no meio
  let seekOK = false;
  try {
    const alvo = 600;
    a.currentTime = alvo;
    await dormir(1200);
    seekOK = Math.abs(a.currentTime - alvo) < 30;
  } catch (e) { /* alguns navegadores lançam em blob URL */ }

  const r = {
    navigatorOnLine: online,
    tocou: !a.paused && a.currentTime > 0,
    duracaoLegivel: duracaoOK,
    duracao: isFinite(a.duration) ? +a.duration.toFixed(1) : null,
    seekFunciona: seekOK,
    posicaoDepoisDoSeek: +a.currentTime.toFixed(1),
    ts: Date.now(),
  };
  await db.setMeta('offline-reproducao', r);
  await log('offline', 'tocar-blob:resultado', r);
  setTexto('dl-estado',
    `Do blob: ${r.tocou ? 'TOCOU' : 'não tocou'} · duração ${r.duracaoLegivel ? 'legível (' + mmss(r.duracao) + ')' : 'NÃO legível'} · seek ${r.seekFunciona ? 'funciona' : 'FALHOU'} · rede ${online ? 'ligada' : 'desligada'}`,
    r.tocou && r.seekFunciona ? 'bom' : 'atencao');
}

// ================================================================
// TESTE 7 — notificação e assinatura de web push em PWA instalada
// ================================================================

async function registrarSW() {
  if (!('serviceWorker' in navigator)) { await log('push', 'sw-indisponivel'); return null; }
  try {
    const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    await log('push', 'sw-registrado', { scope: reg.scope });
    return reg;
  } catch (e) {
    await log('push', 'sw-falhou', { nome: e.name, msg: e.message });
    return null;
  }
}

async function pedirPermissaoNotificacao() {
  const i = infoDispositivo();
  if (!i.instalada) {
    toast('No iOS isso só funciona na PWA instalada na tela de início', true);
    await log('push', 'permissao:nao-instalada', i);
  }
  if (!('Notification' in window)) {
    setTexto('push-estado', 'Notification API ausente', 'ruim');
    await log('push', 'notification-api-ausente');
    return;
  }
  try {
    const p = await Notification.requestPermission();
    await log('push', 'permissao', { resultado: p, instalada: i.instalada });
    setTexto('push-estado', 'Permissão: ' + p, p === 'granted' ? 'bom' : 'ruim');
    await db.setMeta('push-permissao', { resultado: p, instalada: i.instalada, ts: Date.now() });
  } catch (e) {
    await log('push', 'permissao-falhou', { nome: e.name, msg: e.message });
    setTexto('push-estado', 'requestPermission falhou: ' + e.message, 'ruim');
  }
}

async function notificacaoLocal(atrasoSegundos) {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) { toast('Service worker não registrado', true); return; }
  if (Notification.permission !== 'granted') { toast('Permissão de notificação não concedida', true); return; }
  const disparar = async () => {
    try {
      await reg.showNotification('Sua prática de hoje', {
        body: atrasoSegundos
          ? `Lembrete agendado ${atrasoSegundos}s atrás — se chegou, o agendamento sobreviveu`
          : 'Notificação imediata — 10 min, Dia 1 do protocolo',
        icon: 'icone-192.png',
        badge: 'icone-192.png',
        tag: 'teste-lembrete',
        data: { criadoEm: Date.now(), atraso: atrasoSegundos || 0 },
      });
      await log('push', 'notificacao-exibida', { atraso: atrasoSegundos || 0 });
      await db.setMeta('push-local', { funcionou: true, atraso: atrasoSegundos || 0, ts: Date.now() });
      if (!atrasoSegundos) toast('Notificação disparada — veja na tela');
    } catch (e) {
      await log('push', 'notificacao-falhou', { nome: e.name, msg: e.message, atraso: atrasoSegundos || 0 });
      toast('showNotification falhou: ' + e.message, true);
    }
  };
  if (atrasoSegundos) {
    await log('push', 'notificacao-agendada', { atraso: atrasoSegundos });
    toast(`Agendada para ${atrasoSegundos}s. Saia do app e espere.`);
    setTimeout(disparar, atrasoSegundos * 1000);
  } else {
    await disparar();
  }
}

function base64UrlParaUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const bruto = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...bruto].map((c) => c.charCodeAt(0)));
}

async function inscreverPush() {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) { toast('Service worker não registrado', true); return; }
  if (!('PushManager' in window)) {
    setTexto('push-estado', 'PushManager ausente', 'ruim');
    await log('push', 'pushmanager-ausente');
    return;
  }
  try {
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlParaUint8(VAPID_PUBLICA),
      });
    }
    const j = sub.toJSON();
    await db.setMeta('push-inscricao', { json: j, endpoint: sub.endpoint, ts: Date.now() });
    await log('push', 'inscricao-ok', { endpoint: sub.endpoint });
    $('push-inscricao').textContent = JSON.stringify(j, null, 2);
    setTexto('push-estado', 'Inscrição de push CRIADA — o iPhone aceita web push nesta PWA', 'bom');
  } catch (e) {
    await log('push', 'inscricao-falhou', { nome: e.name, msg: e.message });
    setTexto('push-estado', 'subscribe() falhou: ' + e.name + ' — ' + e.message, 'ruim');
    $('push-inscricao').textContent = '';
  }
}

// ================================================================
// TESTE 8 — o armazenamento sobrevive a 7 dias de inatividade?
// Instrumentado agora, conferido depois: cria marcos no IndexedDB E no
// Cache Storage (é do Cache Storage que vem a alegação dos 7 dias).
// ================================================================

async function criarMarco() {
  const bytes = MARCO_BYTES;
  const blob = new Blob([new Uint8Array(bytes)]);
  const agora = Date.now();
  try {
    await db.salvarBlob('marco7', blob, 'marco de 7 dias');
    let cacheOK = false;
    if ('caches' in window) {
      const c = await caches.open('marco-7-dias');
      await c.put('marco-7-dias-sonda', new Response(blob.slice(0), { headers: { 'content-type': 'application/octet-stream' } }));
      cacheOK = true;
    }
    const persistido = (navigator.storage && navigator.storage.persist)
      ? await navigator.storage.persist() : null;
    const marco = { criadoEm: agora, bytes, cacheCriado: cacheOK, persistidoNaCriacao: persistido };
    await db.setMeta('marco7', marco);
    await log('marco7', 'criado', marco);
    setTexto('marco-estado', `Marco criado agora (${mb(bytes)} no IndexedDB${cacheOK ? ' e no Cache Storage' : ''}). Volte em 8 dias e toque em Verificar.`, 'bom');
  } catch (e) {
    await log('marco7', 'falhou', { nome: e.name, msg: e.message });
    setTexto('marco-estado', 'Falhou: ' + e.message, 'ruim');
  }
  verificarMarco();
}

async function verificarMarco() {
  const marco = await db.getMeta('marco7');
  if (!marco) { setTexto('marco-estado', 'Nenhum marco criado ainda.', ''); $('marco-detalhe').innerHTML = ''; return; }
  const dias = (Date.now() - marco.criadoEm) / 86400000;
  const reg = await db.lerBlob('marco7');
  const idbOK = !!reg && reg.bytes === marco.bytes;
  let cacheBytes = null;
  let cacheOK = false;
  if ('caches' in window) {
    try {
      const c = await caches.open('marco-7-dias');
      const r = await c.match('marco-7-dias-sonda');
      if (r) { const b = await r.blob(); cacheBytes = b.size; cacheOK = b.size === marco.bytes; }
    } catch (e) { /* cache sumiu */ }
  }
  const persistido = (navigator.storage && navigator.storage.persisted)
    ? await navigator.storage.persisted() : null;
  const r = {
    criadoEm: marco.criadoEm, dias: +dias.toFixed(2), bytesEsperados: marco.bytes,
    indexedDBIntacto: idbOK, indexedDBBytes: reg ? reg.bytes : null,
    cacheStorageIntacto: cacheOK, cacheStorageBytes: cacheBytes,
    persistido, verificadoEm: Date.now(),
  };
  await db.setMeta('marco7-verificacao', r);
  await log('marco7', 'verificado', r);

  const classe = dias < 7 ? '' : (idbOK && cacheOK ? 'bom' : 'ruim');
  setTexto('marco-estado',
    `Marco tem ${dias.toFixed(1)} dia(s). IndexedDB: ${idbOK ? 'INTACTO' : 'PERDIDO'} · Cache Storage: ${cacheOK ? 'INTACTO' : 'PERDIDO'}`
    + (dias < 7 ? ' — ainda sem valor: o teste só conta depois de 7 dias sem abrir o app.' : ''),
    classe);
  $('marco-detalhe').innerHTML = [
    ['Criado em', new Date(marco.criadoEm).toLocaleString('pt-BR')],
    ['Dias sem abrir até agora', dias.toFixed(2)],
    ['IndexedDB (blob de 4 MB)', idbOK ? 'intacto' : (reg ? `alterado: ${mb(reg.bytes)}` : 'desapareceu')],
    ['Cache Storage (sonda de 4 MB)', cacheOK ? 'intacto' : (cacheBytes != null ? `alterado: ${mb(cacheBytes)}` : 'desapareceu')],
    ['Armazenamento persistente agora', persistido === null ? 'API ausente' : (persistido ? 'sim' : 'não')],
  ].map(([k, v]) => `<div class="par"><span>${k}</span><b>${v}</b></div>`).join('');
}

// ================================================================
// LOG e RESUMO
// ================================================================

async function renderLog() {
  const regs = await db.lerLog(400);
  $('log-contagem').textContent = `${regs.length} registros mais recentes`;
  $('log').textContent = regs.map((r) =>
    `${hora(r.ts)}  [${r.teste}] ${r.evento}` +
    (r.detalhe ? '  ' + JSON.stringify(r.detalhe) : '')
  ).join('\n') || '(vazio)';
}

async function gerarResumo() {
  const info = await db.getMeta('dispositivo') || infoDispositivo();
  const runs = await db.lerRuns();
  const analises = await Promise.all(runs.map((r) => analisarRun(r.runId)));
  const semWL = analises.filter((a) => !a.comWakeLock && a.fonte === 'rede');
  const comWL = analises.filter((a) => a.comWakeLock);
  const cota = await db.getMeta('cota-medida');
  const estim = await db.getMeta('estimativa');
  const sil = await db.getMeta('silencioso') || {};
  const msAcoes = await db.getMeta('mediasession-acoes') || {};
  const dl = await db.getMeta('offline-download');
  const rep = await db.getMeta('offline-reproducao');
  const perm = await db.getMeta('push-permissao');
  const local = await db.getMeta('push-local');
  const insc = await db.getMeta('push-inscricao');
  const marcoV = await db.getMeta('marco7-verificacao');
  const todoLog = await db.lerLog();

  const L = [];
  const p = (s) => L.push(s == null ? '' : s);
  const cab = (s) => { p(''); p('— '.repeat(2) + s.toUpperCase()); };

  p('RESUMO DO TESTE DE ÁUDIO LONGO EM WEB APP — iOS');
  p('Gerado em ' + new Date().toLocaleString('pt-BR'));
  p('');
  p('APARELHO E CONTEXTO');
  p(`  User agent: ${info.ua}`);
  p(`  HTTPS (contexto seguro): ${info.seguro ? 'sim' : 'NÃO'}`);
  p(`  Rodando como PWA instalada: ${info.instalada ? 'SIM' : 'não (Safari) — testes 7 e 4 pedem instalada'}`);
  p(`  APIs presentes: Wake Lock ${info.wakeLockAPI ? 'sim' : 'NÃO'} · Media Session ${info.mediaSessionAPI ? 'sim' : 'NÃO'}`
    + ` · Push ${info.pushManagerAPI ? 'sim' : 'NÃO'} · Background Sync ${info.backgroundSync ? 'sim' : 'não (esperado)'}`
    + ` · Battery ${info.getBatteryAPI ? 'sim' : 'não (esperado)'}`);

  cab('1. áudio de 25+ min com a tela bloqueada, SEM wake lock (baseline)');
  if (!semWL.length) p('  NÃO TESTADO.');
  semWL.forEach((a) => {
    p(`  [${new Date(a.inicio).toLocaleString('pt-BR')}] ${a.rotulo}`);
    p(`    Veredito: ${a.veredito}`);
    p(`    Áudio avançou ${mmss(a.duracaoAudio)} em ${mmss(a.duracaoRelogio)} de relógio (${Math.round(a.proporcaoGeral * 100)}%)`);
    a.lacunas.forEach((l) => p(`    Tela apagada no segundo ${l.emSegundoDoAudio} (${mmss(l.emSegundoDoAudio)}): ficou ${l.relogioParado}s fora,`
      + ` o áudio andou ${l.audioAvancou}s → ${l.audioAvancou < 3 ? 'PAROU no bloqueio' : l.proporcao > 0.9 ? 'continuou tocando' : 'tocou mais ' + l.audioAvancou + 's e parou'}`
      + ` · no retorno estava ${l.pausadoNoRetorno ? 'PAUSADO' : 'tocando'} em ${mmss(l.voltouEm)}`));
  });

  cab('2. o mesmo COM wake lock ativo');
  if (!comWL.length) p('  NÃO TESTADO.');
  comWL.forEach((a) => {
    p(`  [${new Date(a.inicio).toLocaleString('pt-BR')}] ${a.rotulo}`);
    p(`    Veredito: ${a.veredito}`);
    p(`    Áudio avançou ${mmss(a.duracaoAudio)} em ${mmss(a.duracaoRelogio)} de relógio (${Math.round(a.proporcaoGeral * 100)}%)`);
    p(`    Bateria: ${a.bateriaAntes != null ? a.bateriaAntes + '%' : '(não anotada)'} → ${a.bateriaDepois != null ? a.bateriaDepois + '%' : '(não anotada)'}`
      + (a.bateriaGasta != null ? ` = ${a.bateriaGasta}% gastos em ${mmss(a.duracaoRelogio)}` : ''));
    a.lacunas.forEach((l) => p(`    Lacuna no segundo ${l.emSegundoDoAudio}: ${l.relogioParado}s fora, áudio andou ${l.audioAvancou}s (${Math.round(l.proporcao * 100)}%)`));
  });
  const wlEventos = todoLog.filter((r) => r.teste === 'wakelock');
  if (wlEventos.length) {
    p(`    Eventos de Wake Lock: ${wlEventos.slice(0, 8).map((r) => r.evento).join(', ')}`);
    p('    Observação: o Wake Lock impede a tela de apagar sozinha. Ele NÃO impede o');
    p('    botão lateral de bloquear à mão — e o sistema libera o sentinel quando a');
    p('    página fica oculta.');
  }
  const compBat = comWL.filter((a) => a.bateriaGasta != null);
  const baseBat = semWL.filter((a) => a.bateriaGasta != null);
  if (compBat.length || baseBat.length) {
    p(`    Custo de bateria — com Wake Lock: ${compBat.map((a) => a.bateriaGasta + '%').join(', ') || 'n/d'}`
      + ` · sem Wake Lock: ${baseBat.map((a) => a.bateriaGasta + '%').join(', ') || 'n/d'}`);
  }

  cab('3. botão físico de silencioso');
  const ks = Object.keys(sil);
  if (!ks.length) p('  NÃO TESTADO.');
  ks.forEach((k) => p(`  ${k.replace('_', ' com silencioso ')}: ${sil[k]}`));
  if (ks.length) p('  (JS não lê o estado do botão físico — isso é declaração do operador do teste.)');

  cab('4. media session api — controles na tela de bloqueio');
  const msReg = todoLog.find((r) => r.teste === 'mediasession' && r.evento === 'registrado');
  p(`  Metadados registrados: ${msReg ? 'sim (' + (msReg.detalhe.acoes || []).length + ' ações)' : 'não'}`);
  p(`  setPositionState: ${msReg && msReg.detalhe.setPositionState ? 'disponível' : 'ausente'}`);
  const msk = Object.keys(msAcoes);
  p(`  Controles acionados da tela de bloqueio: ${msk.length ? msk.map((k) => k + ' ' + msAcoes[k] + 'x').join(', ') : 'NENHUM — ou não apareceram, ou não responderam'}`);

  cab('5. cota real de armazenamento');
  if (estim) {
    p(`  navigator.storage.estimate(): cota ${mb(estim.quota)} · uso ${mb(estim.uso)}`);
    p(`  usageDetails: ${estim.detalhes ? JSON.stringify(estim.detalhes) : 'não informado'}`);
    p(`  Armazenamento persistente: ${estim.persistido === null ? 'API ausente' : (estim.persistido ? 'sim' : 'não')}`);
  } else p('  estimate() não coletado.');
  if (cota) {
    p(`  Gravação incremental em IndexedDB: ${mb(cota.bytesGravados)} em ${cota.blocos} blocos`);
    p(`  Encerrou por: ${cota.encerradoPor}${cota.erro ? ' — ' + [cota.erro.nome, cota.erro.msg].filter(Boolean).join(' ') : ''}`);
    if (cota.encerradoPor === 'teto') p('  ATENÇÃO: bateu no teto do próprio teste. O limite real do sistema é MAIOR que esse número.');
    const n = Math.floor(cota.bytesGravados / BYTES_SESSAO_25MIN);
    p(`  >>> CABEM ${n} SESSÕES DE 25 MIN OFFLINE (${mb(cota.bytesGravados)} ÷ ${mb(BYTES_SESSAO_25MIN)} por sessão a 96 kbps mono)`);
    if (cota.encerradoPor === 'teto') p(`  >>> leia como "no mínimo ${n} sessões"`);
  } else {
    p('  Gravação incremental NÃO RODADA — sem limite medido.');
    if (estim) {
      const n = Math.floor((estim.quota - estim.uso) / BYTES_SESSAO_25MIN);
      p(`  Só pela estimativa do navegador caberiam ~${n} sessões de 25 min — número não confirmado por gravação real.`);
    }
  }

  cab('6. download para indexeddb e reprodução do blob sem rede');
  p(`  Download: ${dl ? mb(dl.bytes) + ' em ' + dl.segundos + 's' : 'NÃO RODADO'}`);
  if (rep) {
    p(`  Reprodução a partir do blob: ${rep.tocou ? 'TOCOU' : 'NÃO TOCOU'}`);
    p(`  Rede no momento do teste: ${rep.navigatorOnLine ? 'LIGADA (teste não vale como offline)' : 'desligada — offline de verdade'}`);
    p(`  Duração legível do blob: ${rep.duracaoLegivel ? 'sim (' + mmss(rep.duracao) + ')' : 'NÃO — o player não sabe o tamanho da sessão'}`);
    p(`  Seek (retomar no meio): ${rep.seekFunciona ? 'funciona' : 'FALHOU — não dá para retomar a sessão onde parou'}`);
  } else p('  Reprodução do blob NÃO TESTADA.');

  cab('7. web push em pwa instalada');
  p(`  Rodando instalada: ${info.instalada ? 'sim' : 'NÃO — no iOS, push exige instalada na tela de início'}`);
  p(`  Permissão de notificação: ${perm ? perm.resultado : 'não pedida'}`);
  p(`  Notificação local exibida: ${local ? 'sim' : 'não'}`);
  const agendada = todoLog.find((r) => r.teste === 'push' && r.evento === 'notificacao-agendada');
  const agendadaOK = todoLog.find((r) => r.teste === 'push' && r.evento === 'notificacao-exibida' && r.detalhe && r.detalhe.atraso);
  if (agendada) p(`  Notificação agendada em segundo plano: ${agendadaOK ? 'CHEGOU' : 'NÃO CHEGOU (esperado — setTimeout morre quando o app congela; lembrete diário precisa de push do servidor)'}`);
  p(`  Inscrição de push (pushManager.subscribe): ${insc ? 'CRIADA — o aparelho aceita web push' : 'não criada'}`);
  if (insc) p(`  Endpoint: ${insc.endpoint.slice(0, 70)}...`);
  p('  Nota: a inscrição prova que o iPhone aceita push. Entregar o lembrete diário');
  p('  de verdade depende do backend disparar com as chaves VAPID.');

  cab('8. o armazenamento sobrevive a 7 dias de inatividade?');
  if (!marcoV) p('  Marco não criado. Toque em "Criar marco" e volte depois de 8 dias sem abrir o app.');
  else {
    p(`  Marco criado em ${new Date(marcoV.criadoEm).toLocaleString('pt-BR')} — ${marcoV.dias} dia(s) atrás`);
    p(`  IndexedDB (4 MB): ${marcoV.indexedDBIntacto ? 'INTACTO' : 'PERDIDO'}`);
    p(`  Cache Storage (4 MB): ${marcoV.cacheStorageIntacto ? 'INTACTO' : 'PERDIDO'}`);
    p(`  Persistente: ${marcoV.persistido === null ? 'API ausente' : (marcoV.persistido ? 'sim' : 'não')}`);
    if (marcoV.dias < 7) p('  AINDA NÃO CONCLUSIVO: precisa de mais de 7 dias sem abrir o app.');
  }

  cab('o que isso decide no produto');
  const baseParou = semWL.some((a) => /PAROU/.test(a.veredito));
  const wlResolveu = comWL.some((a) => /SOBREVIVEU|ponta a ponta/.test(a.veredito));
  if (semWL.length) p(`  Tela de sessão: sem Wake Lock o áudio ${baseParou ? 'PAROU' : 'sobreviveu'} ao bloqueio.`);
  if (comWL.length) p(`  Com Wake Lock ${wlResolveu ? 'sobreviveu — a tela de sessão precisa manter o Wake Lock ativo' : 'ainda não resolveu — ver as lacunas acima'}.`);
  if (cota) {
    const n = Math.floor(cota.bytesGravados / BYTES_SESSAO_25MIN);
    p(`  Offline: dá para prometer ${n} ${n === 1 ? 'sessão' : 'sessões'} de 25 min baixadas${cota.encerradoPor === 'teto' ? ' (no mínimo)' : ''}.`);
  }
  if (rep && !rep.seekFunciona) p('  Offline: sem seek no blob, o player offline não retoma no meio — tratar isso no desenho.');
  if (perm && perm.resultado === 'granted' && insc) p('  Retenção: lembrete diário por push é viável — falta o disparo no backend.');
  else p('  Retenção: lembrete diário por push AINDA NÃO confirmado neste aparelho.');
  p('');
  p(`(${todoLog.length} registros no log. Página de teste: ${location.href})`);

  const txt = L.join('\n');
  $('resumo').textContent = txt;
  return txt;
}

// ================================================================
// Ligação com a interface
// ================================================================

function ligar(id, fn) {
  const el = $(id);
  if (el) el.addEventListener('click', fn);
}

async function iniciar() {
  await db.abrirDB();
  await mostrarInfo();
  ligarListenersAudio();
  await registrarSW();
  await log('app', 'aberto', { url: location.href, ...modoExibicao() });

  // testes 1 e 2
  ligar('b-start-sem-wl', () => iniciarRun({ comWakeLock: false, rotulo: 'teste 1 — SEM Wake Lock' }));
  ligar('b-start-com-wl', () => iniciarRun({ comWakeLock: true, rotulo: 'teste 2 — COM Wake Lock' }));
  ligar('b-pausar', () => { const a = audio(); a.paused ? a.play() : a.pause(); });
  ligar('b-parar', () => pararRun('botão parar'));
  ligar('b-bateria-salvar', async () => {
    const r = { antes: numeroOuNull($('bateria-antes').value), depois: numeroOuNull($('bateria-depois').value), ts: Date.now() };
    const runs = await db.lerRuns();
    if (runs[0]) {
      runs[0].bateriaAntes = r.antes ?? runs[0].bateriaAntes;
      runs[0].bateriaDepois = r.depois ?? runs[0].bateriaDepois;
      await db.salvarRun(runs[0]);
    }
    await log('bateria', 'anotada', r);
    toast('Bateria anotada na última run');
    renderRuns();
  });

  // teste 3
  ligar('b-sil-ligado', () => declararSilencioso(true));
  ligar('b-sil-desligado', () => declararSilencioso(false));
  ligar('b-sil-ouvi', () => silenciosoOuvi(true, 'elemento-audio'));
  ligar('b-sil-nao-ouvi', () => silenciosoOuvi(false, 'elemento-audio'));
  ligar('b-sil-webaudio', () => tocarTomWebAudio());
  ligar('b-sil-webaudio-ouvi', () => silenciosoOuvi(true, 'web-audio'));
  ligar('b-sil-webaudio-nao-ouvi', () => silenciosoOuvi(false, 'web-audio'));

  // teste 4
  ligar('b-ms-aplicar', () => { aplicarMediaSession(); mostrarAcoesMS(); });

  // teste 5
  ligar('b-cota-estimar', () => mostrarEstimativa());
  ligar('b-cota-persistir', () => pedirPersistencia());
  ligar('b-cota-encher', () => encherArmazenamento());
  ligar('b-cota-parar', () => { est.pararCota = true; toast('Parando...'); });
  ligar('b-cota-limpar', () => limparArmazenamento());

  // teste 6
  ligar('b-dl-baixar', () => baixarAudio());
  ligar('b-dl-tocar-blob', () => tocarDoBlob());
  ligar('b-dl-apagar', async () => {
    await db.apagarBlob(BLOB_ID);
    if (est.blobURL) { URL.revokeObjectURL(est.blobURL); est.blobURL = null; }
    await log('offline', 'blob-apagado');
    mostrarBlobGuardado();
    toast('Blob apagado');
  });

  // teste 7
  ligar('b-push-permissao', () => pedirPermissaoNotificacao());
  ligar('b-push-local', () => notificacaoLocal(0));
  ligar('b-push-local-30s', () => notificacaoLocal(30));
  ligar('b-push-inscrever', () => inscreverPush());

  // teste 8
  ligar('b-marco-criar', () => criarMarco());
  ligar('b-marco-verificar', () => verificarMarco());

  // log e resumo
  ligar('b-log-atualizar', () => renderLog());
  ligar('b-resumo-gerar', () => gerarResumo());
  ligar('b-resumo-copiar', async () => {
    const t = $('resumo').textContent || await gerarResumo();
    try { await navigator.clipboard.writeText(t); toast('Resumo copiado'); }
    catch (e) { toast('Clipboard bloqueado — selecione o texto à mão', true); }
  });
  ligar('b-resumo-baixar', async () => {
    const t = $('resumo').textContent || await gerarResumo();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([t], { type: 'text/plain' }));
    a.download = 'resumo-teste-ios.txt';
    a.click();
  });
  ligar('b-apagar-tudo', async () => {
    if (!confirm('Apagar TODOS os dados do teste (log, runs, blobs, marco)?')) return;
    await db.apagarTudo();
    if ('caches' in window) { try { await caches.delete('marco-7-dias'); } catch (e) { /* ignora */ } }
    toast('Tudo apagado');
    location.reload();
  });

  // abas
  document.querySelectorAll('.aba').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.aba').forEach((x) => x.classList.remove('ativa'));
    document.querySelectorAll('.painel').forEach((x) => x.classList.add('oculto'));
    b.classList.add('ativa');
    $(b.dataset.alvo).classList.remove('oculto');
    if (b.dataset.alvo === 'p-log') renderLog();
    if (b.dataset.alvo === 'p-resumo') gerarResumo();
  }));

  await mostrarEstimativa();
  await mostrarSessoesQueCabem();
  await mostrarBlobGuardado();
  await mostrarResultadoSilencioso();
  await mostrarAcoesMS();
  await verificarMarco();
  await renderRuns();
  await renderLog();
  setInterval(atualizarPainelRun, 1000);
}

iniciar().catch((e) => {
  document.body.insertAdjacentHTML('afterbegin',
    `<pre class="erro-fatal">Falhou ao iniciar: ${e.name} — ${e.message}\n${e.stack || ''}</pre>`);
});
