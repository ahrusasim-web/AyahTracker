// Offline support. The app shell is network-first (so updates arrive), everything else the app
// ships (scripts, fonts, the ONNX runtime) is cache-first. The 69 MB model and Quran data are
// cached by the recognition worker itself in "ayah-live-models-v1", which this worker leaves
// alone. Translation audio is never intercepted (media range requests pass straight through).
const SHELL = "ayah-live-shell-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["./", "manifest.webmanifest", "capture-worklet.js"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("ayah-live-shell-") && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.destination === "audio" || req.headers.has("range")) return;
  if (url.pathname.includes("/models/")) return; // handled by the worker's own cache

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("./", copy));
          return res;
        })
        .catch(() => caches.match("./")),
    );
    return;
  }
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
