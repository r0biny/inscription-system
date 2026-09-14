/* Static-only offline cache. Never store API responses or submissions here. */
const BASE = new URL("./", self.location.href).pathname;
const CACHE = `paper1_lab:${BASE}:offline-static-v1`;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || !url.pathname.startsWith(BASE) || url.pathname.startsWith(BASE + "api/")) return;
  const navigation = request.mode === "navigate" && url.pathname === BASE;
  const asset = url.pathname.startsWith(BASE + "study-data/") || /\.(js|css|woff2|png|jpg|svg)$/.test(url.pathname);
  if (!navigation && !asset) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Versioned materials and build assets are immutable. HTML remains network-first.
    if (!navigation) { const hit = await cache.match(request); if (hit) return hit; }
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch (error) {
      const hit = await cache.match(navigation ? BASE : request);
      if (hit) return hit;
      throw error;
    }
  })());
});
