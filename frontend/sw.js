// OpenWrite Mobile Service Worker
// 缓存名必须跟着版本走：静态资源是 cache-first，缓存名不变的话，
// 用户发版后仍在用旧 JS，而界面上显示的版本号已经是新的，排查时会一路被带偏。
// CI（.github/workflows/build.yml）构建前会把这里改写成 package.json 的版本，不要手改。
const CACHE_NAME = 'openwrite-mobile-v2.20.0';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/css/style.css',
    '/js/app.js',
    '/js/skills.js',
    '/js/distill.js',
    '/js/export.js',
    '/js/research.js',
    '/js/listen.js',
    '/js/sync.js',
    '/manifest.json',
    '/favicon.png',
    '/images/apple-touch-icon.png',
    '/images/icon-72.png',
    '/images/icon-96.png',
    '/images/icon-128.png',
    '/images/icon-144.png',
    '/images/icon-152.png',
    '/images/icon-192.png',
    '/images/icon-384.png',
    '/images/icon-512.png'
];

// Install - cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate - clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            );
        })
    );
    self.clients.claim();
});

// Fetch - network first, fallback to cache for API; cache first for static
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);
    
    // API requests - network first
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    return response;
                })
                .catch(() => {
                    return caches.match(request);
                })
        );
        return;
    }
    
    // Static assets - cache first
    event.respondWith(
        caches.match(request).then((cached) => {
            if (cached) {
                return cached;
            }
            return fetch(request).then((response) => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(request, clone);
                });
                return response;
            });
        })
    );
});
