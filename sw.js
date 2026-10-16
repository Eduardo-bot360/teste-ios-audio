// sw.js — service worker mínimo: cuida só do shell.
// O áudio NÃO passa por aqui de propósito: ele vive no IndexedDB como Blob,
// que é o padrão do plano para offline no iOS.
const CACHE = 'shell-v1';
const SHELL = [
  './', 'index.html', 'app.js', 'db.js', 'manifest.json',
  'icone-192.png', 'icone-512.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== 'marco-7-dias').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // o áudio fica fora do cache do SW — é o ponto do teste 6
  if (url.pathname.endsWith('.mp3')) return;
  ev.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp && resp.ok) {
          const copia = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copia)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
  );
});

// Teste 7: recebe o push do servidor e mostra a notificação.
self.addEventListener('push', (ev) => {
  let dados = {};
  try { dados = ev.data ? ev.data.json() : {}; } catch (e) { dados = { body: ev.data ? ev.data.text() : '' }; }
  ev.waitUntil(self.registration.showNotification(dados.title || 'Sua prática de hoje', {
    body: dados.body || 'Push recebido do servidor',
    icon: 'icone-192.png',
    badge: 'icone-192.png',
    tag: 'teste-push',
    data: { recebidoEm: Date.now() },
  }));
});

self.addEventListener('notificationclick', (ev) => {
  ev.notification.close();
  ev.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    const c = cs.find((x) => 'focus' in x);
    return c ? c.focus() : self.clients.openWindow('./');
  }));
});
