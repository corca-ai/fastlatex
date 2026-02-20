const CACHE_NAME = 'texlive-cache-v1'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name.startsWith('texlive-cache-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      ),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  const base = new URL(self.registration.scope).pathname

  // Only intercept texlive requests (base-path aware)
  if (!url.pathname.startsWith(`${base}texlive/`)) return

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(event.request).then((cached) => {
        if (cached) return cached

        return fetch(event.request).then((response) => {
          // Only cache successful (200) responses
          // 301 = texlive-ondemand "not found" — don't cache (package may be added later)
          if (response.status === 200) {
            cache.put(event.request, response.clone())
          }
          return response
        })
      }),
    ),
  )
})
