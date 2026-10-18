/*
 * 오프라인 사용을 위한 서비스 워커
 * - 앱 파일을 미리 저장해 두고, 인터넷이 없어도 저장된 파일로 화면을 연다.
 * - 인터넷이 있으면 저장본을 먼저 보여 주고 뒤에서 새 파일로 갱신한다 (다음에 열 때 반영).
 * - AI(제미나이) 요청은 저장하지 않고 항상 네트워크로 보낸다.
 * 앱 파일 목록이 바뀌면 VERSION 을 올린다.
 */
const VERSION = 'kkumdi-v1';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './css/style.css',
  './js/data.js',
  './js/data-more.js',
  './js/certs.js',
  './js/lessons.js',
  './js/engine.js',
  './js/gemini.js',
  './js/app.js',
];
// 글꼴(Pretendard)도 저장해 오프라인에서 같은 모양으로 보이게 한다
const CACHEABLE_HOSTS = ['cdn.jsdelivr.net'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !CACHEABLE_HOSTS.includes(url.hostname)) return; // AI 요청 등은 그대로 네트워크로

  // 저장본을 먼저 돌려주고, 네트워크에서 받은 새 파일로 저장본을 갱신
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const key = sameOrigin ? url.pathname.replace(/\/$/, '/index.html') : req;
    const cached = await cache.match(key, { ignoreSearch: sameOrigin }) || await cache.match(req, { ignoreSearch: sameOrigin });
    const network = fetch(req).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { e.waitUntil(network); return cached; }
    const res = await network;
    return res || new Response('오프라인 상태예요. 인터넷에 연결한 뒤 다시 열어 주세요.', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }));
});
