// ============================================================
// NigerShop — Service Worker
// Gère le cache et le mode hors ligne
// ============================================================

const CACHE_NAME = 'nigershop-v1';
const URLS_A_CACHER = [
  '/',
  '/index.html',
  '/admin.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/uploads/icon-192.png',
  '/uploads/icon-512.png'
];

// Installation : mise en cache des ressources de base
self.addEventListener('install', event => {
  console.log('🔧 Service Worker : installation');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('📦 Mise en cache des ressources');
        return cache.addAll(URLS_A_CACHER);
      })
      .catch(err => console.log('⚠️ Erreur cache:', err))
  );
  self.skipWaiting();
});

// Activation : nettoyage des anciens caches
self.addEventListener('activate', event => {
  console.log('✅ Service Worker : activé');
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME)
            .map(k => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// Interception des requêtes
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Ne jamais mettre en cache les appels API (toujours frais)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Stratégie : Cache First, puis Network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        // Ressource en cache → on la renvoie, mais on met à jour en arrière-plan
        fetch(event.request).then(fresh => {
          if (fresh && fresh.status === 200) {
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, fresh.clone()));
          }
        }).catch(() => {});
        return cached;
      }

      // Sinon → réseau
      return fetch(event.request).then(response => {
        // Mettre en cache les nouvelles ressources statiques
        if (response && response.status === 200 && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Hors ligne → renvoyer l'index pour les navigations
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
