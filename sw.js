const CACHE_NAME = 'scandroid-v3';
const ASSETS = [
    './',
    './index.html',
    './style.css?v=3',
    './app.js?v=3',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
];

const CDN_ASSETS = [
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
    'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS).then(() => {
                return Promise.allSettled(
                    CDN_ASSETS.map((url) => cache.add(url))
                );
            });
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((k) => k !== CACHE_NAME)
                    .map((k) => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

// Network-first for own files, cache-first for CDN
self.addEventListener('fetch', (e) => {
    const url = e.request.url;
    const isCDN = url.includes('cdnjs.cloudflare.com') || url.includes('unpkg.com');

    if (isCDN) {
        // Cache-first for CDN (they never change)
        e.respondWith(
            caches.match(e.request).then((cached) => {
                if (cached) return cached;
                return fetch(e.request).then((resp) => {
                    if (resp && resp.status === 200) {
                        const clone = resp.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
                    }
                    return resp;
                });
            })
        );
    } else {
        // Network-first for our own files (always get latest)
        e.respondWith(
            fetch(e.request).then((resp) => {
                if (resp && resp.status === 200) {
                    const clone = resp.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
                }
                return resp;
            }).catch(() => caches.match(e.request))
        );
    }
});
