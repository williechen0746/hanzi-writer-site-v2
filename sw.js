// Service Worker：应用外壳 + 全量笔画数据预缓存 + 离线导航回退
//
// 缓存分层：
//   SHELL_CACHE —— 应用外壳（页面、vendor 库、图标、许可证），安装时预缓存
//   DATA_CACHE  —— 笔画数据分片（data-pack/），安装时按 manifest 全量预缓存
//
// 与上一版的区别：笔画数据已打包成数十个分片（整库 gzip 约 12 MB），
// 因此可以在安装阶段一次性全量预缓存，实现「任意汉字离线可用」。
// 旧版按需缓存单个 JSON 的做法，会导致离线时只有查过的字能用。
//
// 升级缓存时提升对应的版本号即可；activate 阶段会清掉不在保留列表中的旧缓存。

// 两个版本号刻意分开：
//   SHELL_VERSION —— 页面、样式、图标等变动时提升，触发外壳重新预缓存
//   DATA_VERSION  —— 仅当笔画分片的内容或打包格式变化时提升
// 这样改一次图标或样式，不会让用户白白重下约 12 MB 的字库。
const SHELL_VERSION = 'v4';
const DATA_VERSION = 'v3';
const SHELL_CACHE = `hanzi-shell-${SHELL_VERSION}`;
const DATA_CACHE = `hanzi-data-${DATA_VERSION}`;
const KEEP_CACHES = [SHELL_CACHE, DATA_CACHE];

// 页面外壳入口的绝对地址，用于离线导航回退
const SHELL_ENTRY = new URL('./index.html', self.location).href;
const PACK_MANIFEST = new URL('./data-pack/manifest.json', self.location).href;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './vendor/hanzi-writer.min.js',
  './vendor/cnchar.min.js',
  './vendor/cnchar.radical.min.js',
  './vendor/cnchar.words.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './hanzi-writer-data/ARPHICPL.TXT'
];

// 只补齐尚未缓存的部分；单个失败不影响整体
// （网络抖动或单个资源缺失不应导致安装失败）
async function addMissing(cache, urls) {
  const missing = [];
  for (const url of urls) {
    // 已缓存则跳过：外壳升级时不应把没变过的字库重下一遍
    const hit = await cache.match(url);
    if (!hit) missing.push(url);
  }
  if (missing.length === 0) return 0;

  const results = await Promise.allSettled(
    missing.map((url) => cache.add(new Request(url, { cache: 'reload' })))
  );
  const failed = results.filter((result) => result.status === 'rejected').length;
  if (failed > 0) console.warn(`[sw] ${failed}/${missing.length} 个资源预缓存失败`);
  return failed;
}

// 分批并发，避免一次性发起数十个请求把慢速网络打满
async function addInBatches(cache, urls, batchSize = 6) {
  let failed = 0;
  for (let i = 0; i < urls.length; i += batchSize) {
    failed += await addMissing(cache, urls.slice(i, i + batchSize));
  }
  return failed;
}

// 安装：先缓存应用外壳，再按 manifest 全量预缓存笔画数据分片
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shellCache = await caches.open(SHELL_CACHE);
      await addInBatches(shellCache, SHELL_ASSETS);

      try {
        const response = await fetch(new Request(PACK_MANIFEST, { cache: 'reload' }));
        if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);

        // 必须先 clone 再读取 body：Response 的 body 一旦被消费就无法再 clone
        const manifestResponse = response.clone();
        const manifest = await response.json();

        const dataCache = await caches.open(DATA_CACHE);
        await dataCache.put(PACK_MANIFEST, manifestResponse);

        const packUrls = [manifest.index, ...manifest.packs].map((name) =>
          new URL(`./data-pack/${name}`, self.location).href
        );
        const failed = await addInBatches(dataCache, packUrls);
        console.log(
          `[sw] 笔画数据预缓存完成：${packUrls.length - failed}/${packUrls.length} 个分片`
        );
      } catch (error) {
        // 数据预缓存失败不应阻断安装：应用在线仍可用，分片会在首次请求时按需落入缓存
        console.warn('[sw] 笔画数据预缓存未完成，将在使用时按需缓存：', error);
      }

      await self.skipWaiting();
    })()
  );
});

// 激活：清理旧版本缓存并立即接管页面
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => (KEEP_CACHES.includes(key) ? null : caches.delete(key)))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 只接管同源请求；跨域资源（如字体 CDN）完全交回浏览器处理
  if (url.origin !== self.location.origin) return;

  // 笔画数据分片：内容不变、体量大，缓存优先
  if (url.pathname.includes('/data-pack/')) {
    event.respondWith(cacheFirst(request, DATA_CACHE));
    return;
  }

  // 页面导航：网络优先；离线时回退到缓存的 index.html
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          cache.put(SHELL_ENTRY, response.clone());
          return response;
        } catch (error) {
          const cache = await caches.open(SHELL_CACHE);
          const cached = await cache.match(SHELL_ENTRY);
          if (cached) return cached;
          return new Response('离线且无可用缓存', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
      })()
    );
    return;
  }

  // 其余同源静态资源（vendor、图标、许可证等）：缓存优先
  event.respondWith(cacheFirst(request, SHELL_CACHE));
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    // 只缓存正常的同源响应，避免把 opaque / 错误响应写进缓存
    if (response && response.status === 200 && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    return cached || Response.error();
  }
}
