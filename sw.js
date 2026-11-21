const CACHE_NAME = 'share-secure-v18';
const ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './tailwind.css',
    './fuentes/cuprum-latin-400-normal.woff2',
    './fuentes/cuprum-latin-600-normal.woff2',
    './fuentes/cuprum-latin-700-normal.woff2',
    './fuentes/rajdhani-latin-400-normal.woff2',
    './fuentes/rajdhani-latin-500-normal.woff2',
    './fuentes/rajdhani-latin-600-normal.woff2',
    './fuentes/rajdhani-latin-700-normal.woff2',
    './icon.svg',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-512.png',
    './icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.map((k) => k !== CACHE_NAME ? caches.delete(k) : null))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    e.respondWith(caches.match(e.request).then((res) => res || fetch(e.request)));
});
