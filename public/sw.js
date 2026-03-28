const CACHE_NAME = 'byegg-cache-v1';
const ASSETS = [
    '/',
    '/index.html',
    '/manifest.json'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    // We only cache the UI, we don't intercept /api/ or large /files/ requests
    if (e.request.url.includes('/api/') || e.request.url.includes('/files/')) {
        return;
    }

    e.respondWith(
        caches.match(e.request).then(res => {
            return res || fetch(e.request);
        }).catch(() => caches.match('/index.html'))
    );
});
