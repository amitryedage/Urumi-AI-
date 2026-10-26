const net = require("net");

function proxy(listenPort, listenHost, targetPort, targetHost) {
  const server = net.createServer((c) => {
    const target = net.connect(targetPort, targetHost);
    c.pipe(target).pipe(c);
    c.on("error", () => {});
    target.on("error", () => {});
  });
  server.listen(listenPort, listenHost, () => {
    console.log(`SUCCESS: proxying [${listenHost}]:${listenPort} -> ${targetHost}:${targetPort}`);
  });
  server.on("error", (err) => {
    console.error(`ERROR on [${listenHost}]:${listenPort}:`, err.message);
  });
  return server;
}

// 1. IPv6 -> IPv4 proxy for ports 80 and 443 (for browsers resolving ::1 on Windows)
proxy(80, "::1", 80, "127.0.0.1");
proxy(443, "::1", 443, "127.0.0.1");

// 2. Forward port 8080 to port 80 (handles any cached or explicit :8080 requests)
proxy(8080, "0.0.0.0", 80, "127.0.0.1");
proxy(8080, "::1", 80, "127.0.0.1");
