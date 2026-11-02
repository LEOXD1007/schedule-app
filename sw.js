/* 日程 PWA service worker: network-first with cache fallback for offline use */
var CACHE = 'schedule-app-v2';
var ASSETS = ['./', './index.html', './manifest.json', './apple-touch-icon.png', './icon-512.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return res;
    }).catch(function () {
      return caches.match(e.request, { ignoreSearch: true }).then(function (r) { return r || caches.match('./index.html'); });
    })
  );
});
self.addEventListener('push', function (e) {
  e.waitUntil(Promise.resolve().then(function () {
    if (!e.data) return {};
    try { return Promise.resolve(e.data.json()); }
    catch (err) {
      try { return Promise.resolve(e.data.text()); }
      catch (err2) { return {}; }
    }
  }).then(function (payload) {
    var data = payload && typeof payload === 'object' ? payload : { title: '日程', body: String(payload || '') };
    return self.registration.showNotification(data.title || '日程', {
      body: data.body || '',
      tag: data.tag || 'schedule-reminder',
      icon: 'icon-512.png',
      data: { url: data.url || './index.html' }
    });
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var target = (e.notification.data && e.notification.data.url) || './index.html';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    var scope = self.registration.scope;
    for (var i = 0; i < cs.length; i++) {
      if (cs[i].url.indexOf(scope) === 0 && 'focus' in cs[i]) return cs[i].focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  }));
});
