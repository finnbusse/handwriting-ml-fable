// Service worker: precaches the app shell under a versioned cache so the app
// starts offline. Only same-origin GET requests are handled; Hugging Face
// (and every other cross-origin request) is never touched or cached.
importScripts('config.js');

const VERSION = self.HW_CONFIG.version;
const CACHE = `hw-shell-${VERSION}`;
const SHELL = [
  './', 'index.html', 'styles.css', 'config.js', 'manifest.webmanifest',
  'js/main.js', 'js/writer.js', 'js/hf.js', 'js/store.js', 'js/outbox.js', 'js/preview.js', 'js/prompts.js',
  'js/capture/recorder.js', 'js/capture/hwline.js', 'js/capture/qa.js', 'js/capture/view.js',
  'js/engine/engine.js', 'js/engine/worker.js',
  'js/generate/layout.js', 'js/generate/page-writer.js', 'js/generate/render.js',
  'js/generate/model-store.js', 'js/generate/engine-client.js', 'js/generate/view.js',
  'js/generate/document.js', 'js/generate/pdf.js', 'js/generate/page-view.js', 'js/generate/paint-worker.js', 'js/generate/pen.js',
  'js/generate/markup.js', 'js/generate/unwrap.js', 'js/generate/decor.js', 'js/generate/format-help.js', 'js/generate/editor-tools.js',
  'js/capture/ink.js', 'js/capture/look.js',
  'js/library.js', 'library.css',
  'training.css', 'js/training/view.js', 'js/training/state.js', 'js/training/github.js', 'js/training/github-settings.js', 'js/training/curve.js',
  'fonts/instrument-sans-latin-wght.woff2',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];
const OPTIONAL = ['prompts/de-core.json'];   // may not exist yet

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // './' answers with a redirect on the static Space host; store index.html for it instead.
    await cache.addAll(SHELL.filter((u) => u !== './').map((u) => new Request(u, { cache: 'reload' })));
    for (const u of OPTIONAL) {
      try {
        const res = await fetch(new Request(u, { cache: 'reload' }));
        if (res.ok) await cache.put(u, res);
      } catch (_) {}
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('hw-shell-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // Hugging Face etc.: straight to the network
  if (url.pathname.includes('/model/')) return;               // model files: never through the service worker (the model lives in IndexedDB)

  // Navigations (including "/" and "/index.html?code=..." after sign-in): the cached shell.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match('index.html');
      if (hit) return hit;
      return fetch(req);
    })());
    return;
  }

  // Prompts: network first (they may be updated), cache as fallback.
  if (url.pathname.endsWith('/prompts/de-core.json')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) cache.put('prompts/de-core.json', res.clone());
        return res;
      } catch (_) {
        return (await cache.match('prompts/de-core.json')) || new Response('', { status: 504 });
      }
    })());
    return;
  }

  // Everything else of the shell: cache first.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    return hit || fetch(req);
  })());
});
