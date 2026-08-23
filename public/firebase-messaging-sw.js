// public/firebase-messaging-sw.js
// Phase 3A-1: messaging-only service worker. Deliberately has NO fetch event handler and
// never touches the Cache API — background push/notification handling only. Every
// navigation and asset request continues to hit the network exactly as it does without this
// worker, so it can never serve a stale application bundle. Do not add caching here without
// re-evaluating that tradeoff explicitly.
importScripts('https://www.gstatic.com/firebasejs/12.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.7.0/firebase-messaging-compat.js');

// Namespaced/compat SDK loaded via importScripts, not the modular SDK — the modular SDK
// requires the service worker file itself to be bundled (ES modules aren't usable in a
// classic worker), and this project has no worker-bundling pipeline. The app's own
// foreground code uses the modular SDK normally, since Vite already bundles that.
firebase.initializeApp({
  apiKey: 'AIzaSyBlNWkezjbXlOZ7SQCuN9FWO0ScV4zuTc8',
  authDomain: 'neuroactivehealth.com',
  projectId: 'neuroactive',
  storageBucket: 'neuroactive.firebasestorage.app',
  messagingSenderId: '1010503840940',
  appId: '1:1010503840940:web:90874fb37a70c9c7115b09',
});

const messaging = firebase.messaging();

// Phase 3A-1: intentionally boring, fixed payload — no personalization, no lesson/medical
// content. A real send-side Function does not exist yet (out of scope this phase).
//
// A message that carries a `notification` field (this is what Firebase Console's "Send test
// message" sends, and what a typical notification-payload send looks like) is ALREADY
// auto-displayed by Firebase's own SW machinery — onBackgroundMessage still fires for it, but
// calling showNotification() again in here would duplicate that auto-display, not replace it
// (confirmed against current Firebase Web Messaging behavior/known SDK issue reports; the
// handler does not suppress the automatic display the way one might expect). Only a
// data-only payload (no `notification` field) needs to be displayed manually here, since
// there's nothing for Firebase to auto-display in that case.
messaging.onBackgroundMessage((payload) => {
  if (payload && payload.notification) return;
  self.registration.showNotification('NeuroActive', {
    body: 'Push notifications are working.',
    icon: '/icons/icon-192.png',
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Prefer the actual app root over an arbitrary same-origin window (e.g. the standalone
      // /privacy or /terms pages) — falls back to any open client, then to a fresh window.
      const appRoot = clientList.find((client) => {
        try {
          return new URL(client.url).pathname === '/';
        } catch {
          return false;
        }
      });
      if (appRoot && 'focus' in appRoot) return appRoot.focus();
      const anyClient = clientList.find((client) => 'focus' in client);
      if (anyClient) return anyClient.focus();
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});

// No skipWaiting()/clients.claim(): this worker has no fetch handler, so it never needs to
// "control" an already-open tab's network requests, and push events are delivered to this
// worker's registration regardless of whether it's controlling any client — so there's
// nothing to gain by forcing early activation, and the default (safer) update lifecycle is
// left alone.
