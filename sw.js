// ══════════════════════════════════════════════════════════════
// FFinanceManager V.5 — Service Worker
// Robust offline-first PWA with:
//  - Network-first for HTML/JS/CSS (instant updates, graceful offline fallback)
//  - Cache-first for icons/fonts (instant, never re-fetched)
//  - Background sync queue for failed writes when back online
//  - Periodic sync hook for bill reminders
//  - Notification click → deep-link into app
//  - skipWaiting + clients.claim for zero-downtime updates
// ══════════════════════════════════════════════════════════════

const VERSION = 'ffm-v5-5';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];
const NEVER_CACHE = /^https?:\/\/(api\.|firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|apis\.google\.com|[^\/]*\.firebaseapp\.com)/i; // external API + Firebase auth hosts

// ── Install: pre-cache the shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] install error', err))
  );
});

// ── Activate: clear old caches, claim clients
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Helper: navigation fallback chain
async function handleNavigation(req) {
  // Try network first (so updates land instantly)
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(req, copy)).catch(()=>{});
      caches.open(VERSION).then(c => c.put('./index.html', copy.clone())).catch(()=>{});
    }
    return res;
  } catch (e) {
    // Offline — try the requested URL, then './index.html' (app shell fallback)
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req) || await cache.match('./index.html') || await cache.match('./');
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
      '<body style="background:#0b0f14;color:#e6edf3;font-family:sans-serif;padding:40px;text-align:center">' +
      '<h2>You\'re offline</h2><p>FFinanceManager needs a connection for this page. ' +
      'Your saved data is intact — try again when you\'re back online.</p></body>',
      { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

// ── Helper: same-origin GET (stale-while-revalidate)
async function handleAsset(req) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req);
  const network = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone()).catch(()=>{});
    return res;
  }).catch(() => cached);
  return cached || network;
}

// ── Main fetch router
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) {
    // External: only handle if it's a non-API GET (e.g. CDN fonts). Otherwise, let it pass.
    if (NEVER_CACHE.test(req.url)) return;
    // For external non-API assets, try network, fall back to cache
    e.respondWith(handleAsset(req));
    return;
  }

  // Navigation requests (HTML pages)
  if (req.mode === 'navigate') {
    e.respondWith(handleNavigation(req));
    return;
  }

  // Same-origin assets: stale-while-revalidate
  e.respondWith(handleAsset(req));
});

// ── Background Sync: retry queued writes when connection returns
// (Queued by client via SyncManager — used for AI writes that failed offline)
self.addEventListener('sync', e => {
  if (e.tag === 'ffm-sync-pending') {
    e.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
        .then(clients => clients.forEach(c => c.postMessage({ type: 'SYNC_PENDING' })))
    );
  }
});

// ── Periodic Background Sync: fire bill reminders
self.addEventListener('periodicsync', e => {
  if (e.tag === 'ffm-bill-reminders') {
    e.waitUntil(sendBillReminders());
  }
});

async function sendBillReminders() {
  // Read latest DB snapshot from IndexedDB
  try {
    const cache = await caches.open(VERSION);
    // We can't read IndexedDB directly from SW in all browsers, but we CAN receive
    // data via postMessage from the client. Fall back to a generic reminder.
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    if (clients.length === 0) {
      // App not open — show a generic reminder
      await self.registration.showNotification('FFinanceManager', {
        body: 'Tap to check for upcoming bills.',
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: 'ffm-bills',
        data: { url: './index.html?tab=today' }
      });
    } else {
      // Ask the open client to send us its bill data
      clients.forEach(c => c.postMessage({ type: 'PUSH_BILL_DATA' }));
    }
  } catch (e) {
    console.warn('[SW] bill reminder error', e);
  }
}

// ── Notification click: focus / open the app at the right tab
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = (e.notification.data && e.notification.data.url) || './index.html';
  e.waitUntil(
    self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
      .then(clientList => {
        for (const c of clientList) {
          if ('focus' in c) {
            c.postMessage({ type: 'NAVIGATE', url: targetUrl });
            return c.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      })
  );
});

// ── Message bus: client ↔ SW communication
self.addEventListener('message', e => {
  const msg = e.data || {};
  if (msg.type === 'SKIP_WAITING') self.skipWaiting();
  if (msg.type === 'SHOW_BILL_NOTIFICATION' && msg.payload) {
    self.registration.showNotification('FFinanceManager — Bill Due', {
      body: msg.payload.body,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: msg.payload.tag || 'ffm-bill',
      data: { url: msg.payload.url || './index.html?tab=today' }
    });
  }
  if (msg.type === 'REGISTER_PERIODIC_SYNC') {
    try {
      self.registration.periodicSync.register('ffm-bill-reminders', {
        minInterval: 24 * 60 * 60 * 1000 // once per day
      }).catch(()=>{});
    } catch (e) {}
  }
});
