const CACHE = 'contak-shell-v3'

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

self.addEventListener('push', event => {
  let data = {}
  try { data = event.data?.json() || {} } catch { data = { body: event.data?.text() || '' } }
  const title = data.title || 'New Contak message'
  const options = {
    body: data.body || 'You received a new message.',
    tag: data.tag || 'contak-message',
    silent: Boolean(data.silent),
    data: { url: data.url || '/' },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      const existing = windowClients.find(client => client.url.startsWith(self.location.origin))
      if (existing) return existing.focus().then(() => existing.navigate(targetUrl))
      return clients.openWindow(targetUrl)
    }),
  )
})
