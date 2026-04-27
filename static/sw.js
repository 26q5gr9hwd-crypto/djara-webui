/**
 * Hermes WebUI Service Worker (Джара)
 *
 * Strategy:
 *  - Navigations (HTML): network-first → cache fallback (so updates appear immediately
 *    on every reload when online, no manual cache refresh needed).
 *  - Same-origin assets (JS/CSS/icons): stale-while-revalidate — instant from cache,
 *    update in the background, so the next reload always shows fresh content.
 *  - API / SSE / health: bypass the SW entirely (always live network).
 *
 * On every deploy WEBUI_VERSION changes → CACHE_NAME changes → install pre-caches
 * the new shell, activate deletes old caches, clients.claim() takes over open tabs,
 * and the page-side controllerchange listener auto-reloads them.
 */

// Cache version is injected by the server at request time (routes.py /sw.js handler).
// Bumps automatically whenever the git commit changes — no manual edits needed.
const CACHE_NAME = 'djara-shell-__CACHE_VERSION__';

// Static assets that form the app shell
const SHELL_ASSETS = [
  './',
  './static/style.css',
  './static/boot.js',
  './static/ui.js',
  './static/messages.js',
  './static/sessions.js',
  './static/panels.js',
  './static/commands.js',
  './static/icons.js',
  './static/i18n.js',
  './static/djara.css',
  './static/workspace.js',
  './static/onboarding.js',
  './static/favicon.svg',
  './static/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(SHELL_ASSETS).catch((err) => {
        console.warn('[sw] Shell pre-cache partial failure:', err);
      })
    )
  );
  // Activate the new SW immediately, don't wait for old tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME && (k.startsWith('djara-shell-') || k.startsWith('hermes-shell-')))
            .map((k) => caches.delete(k))
        )
      ),
      // Take control of all open clients so the controllerchange listener fires
      // on the page side and reloads it with fresh content.
      self.clients.claim(),
    ])
  );
});

// Allow the page to ask the new SW to activate now (used after a sw update is detected).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept cross-origin requests.
  if (url.origin !== self.location.origin) return;

  // API, streaming, health, login, auth — always go to network, never cached.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.includes('/stream') ||
    url.pathname.startsWith('/health') ||
    url.pathname.startsWith('/login') ||
    url.pathname.startsWith('/sw.js') ||
    url.pathname.startsWith('/manifest')
  ) {
    return;
  }

  // Navigation requests (HTML page loads): network-first → cache fallback.
  // This is the key fix: every reload pulls fresh HTML when online,
  // so updates appear without users having to do a hard refresh.
  const isNavigation =
    req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');
  if (isNavigation) {
    event.respondWith(
      fetch(req)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('./', clone)).catch(() => {});
          }
          return response;
        })
        .catch(() =>
          caches.match('./').then(
            (cached) =>
              cached ||
              new Response(
                '<html><body style="font-family:sans-serif;padding:2rem;background:#1a1a1a;color:#ccc">' +
                  '<h2>Нет соединения</h2>' +
                  '<p>Чтобы Китёнок отвечал, нужен интернет. Проверьте подключение и обновите страницу.</p>' +
                  '</body></html>',
                { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
              )
          )
        )
    );
    return;
  }

  // Same-origin static assets: stale-while-revalidate.
  // Return cached copy immediately (fast), refresh in background, so the next
  // reload shows updated assets even if the user clicked refresh while still online.
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
          }
          return response;
        })
        .catch(() => null);
      return cached || networkFetch || fetch(req);
    })
  );
});

// Never intercept favicons/manifest — let the browser hit the network directly.
self.addEventListener('fetch', function (event) {
  var u = (event.request && event.request.url) || '';
  if (/(favicon|apple-touch-icon|manifest\.json)/.test(u)) {
    event.respondWith(fetch(event.request, { credentials: 'same-origin' }));
  }
}, { capture: true });
