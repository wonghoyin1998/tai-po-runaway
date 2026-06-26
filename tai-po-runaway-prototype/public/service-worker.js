const CACHE_NAME = "tai-po-runaway-v1.4.0";
const SHELL = [
  "/",
  "/index.html",
  "/public/styles.css",
  "/public/app.js?v=1.4.0",
  "/public/manifest.json",
  "/public/icon.svg",
  "/public/assets/chip-locations/chip-01-jasmine.jpg",
  "/public/assets/chip-locations/chip-02-viewpoint-board.jpg",
  "/public/assets/chip-locations/chip-03-lifebuoy.jpg",
  "/public/assets/chip-locations/chip-04-white-wall.jpg",
  "/public/assets/chip-locations/chip-05-bird-statue.jpg",
  "/public/assets/chip-locations/chip-06-pole-46.jpg",
  "/public/assets/chip-locations/chip-07-banyan-sign.jpg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.protocol.startsWith("ws") || event.request.headers.get("upgrade") === "websocket") return;
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request).then((response) => {
        if (response && response.ok && url.origin === location.origin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
