// Service worker for TræpillerDK - modtager rigtige Web Push-beskeder,
// selv når appen ikke er åben, og viser dem som en systemnotifikation.

self.addEventListener("install", (event) => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
    let data = { titel: "TræpillerDK", tekst: "Der er nyt i prisalarmen.", url: "./index.html" };
    if (event.data) {
        try { data = { ...data, ...event.data.json() }; }
        catch (e) { data.tekst = event.data.text(); }
    }
    event.waitUntil(
        self.registration.showNotification(data.titel, {
            body: data.tekst,
            icon: "icon-192.png",
            badge: "icon-192.png",
            data: { url: data.url || "./index.html" }
        })
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || "./index.html";
    event.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if (client.url.includes("index.html") && "focus" in client) return client.focus();
            }
            if (self.clients.openWindow) return self.clients.openWindow(url);
        })
    );
});
