const CACHE = 'contak-shell-v2'

self.addEventListener('install', event => {
  self.skipWaiting()
  event.waitUntil(caches.open(CACHE))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return

  const requestUrl = new URL(event.request.url)
  const isNavigation = event.request.mode === 'navigate' || requestUrl.pathname === '/' || requestUrl.pathname === '/index.html'

  if (isNavigation) {
    event.respondWith(fetch(event.request).catch(() => caches.match('/')))
    return
  }

  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)))
})
