import http from "node:http";
import { request } from "./supervisor/client.mjs";

export async function startDashboard({ socketPath, authKey, port = 7071, refreshSeconds = 10, host = "127.0.0.1" } = {}) {
  if (typeof socketPath !== "string" || socketPath.length === 0) throw new TypeError("socketPath is required");
  if (!Buffer.isBuffer(authKey) || authKey.length < 32) throw new TypeError("authKey must be a Buffer of at least 32 bytes");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError("port must be an integer 0..65535");
  if (!Number.isSafeInteger(refreshSeconds) || refreshSeconds < 1 || refreshSeconds > 300) throw new TypeError("refreshSeconds must be an integer 1..300");
  // The dashboard must never be reachable from outside the local machine: refuse anything but the
  // loopback address rather than trusting a caller-supplied host.
  if (host !== "127.0.0.1") throw new TypeError("host must be 127.0.0.1");

  // Generate static HTML once
  const html = generateHTML(refreshSeconds);

  // Clone the auth key so the dashboard owns its own lifetime and can zero it on close without
  // depending on (or mutating) the caller's buffer.
  let keyCleared = false;
  const keyBuffer = Buffer.from(authKey);

  // Single response helper so every reply — 200/404/405/403/503 alike — always carries
  // cache-control: no-store, with no route able to slip through and skip it.
  const send = (res, statusCode, body, contentType = "text/plain") => {
    res.writeHead(statusCode, { "content-type": contentType, "cache-control": "no-store" });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    // Reject any request whose Host header doesn't exactly match one of the loopback addresses
    // we're bound to. The server only binds 127.0.0.1, but Host is client-supplied and unrelated
    // to the socket it connected on, so without this check a DNS-rebinding attacker can point a
    // public hostname at 127.0.0.1 and reach this server from a browser tab. `localhost` is
    // accepted alongside the bound IP because it's RFC-6761 reserved to resolve to loopback (and
    // is what a user will naturally type in a browser) — both are equally rebinding-safe. Applies
    // to every route, checked before any routing decision.
    const boundPort = server.address().port;
    if (req.headers.host !== `${host}:${boundPort}` && req.headers.host !== `localhost:${boundPort}`) {
      send(res, 403, "Forbidden");
      return;
    }

    // Only allow GET
    if (req.method !== "GET") {
      send(res, 405, "Method not allowed");
      return;
    }

    // Route handlers
    if (req.url === "/" || req.url === "") {
      send(res, 200, html, "text/html; charset=utf-8");
      return;
    }

    if (req.url === "/metrics") {
      try {
        const metrics = await request({ socketPath, authKey: keyBuffer, method: "metrics", params: {} });
        send(res, 200, JSON.stringify(metrics), "application/json");
      } catch {
        // Never surface the RPC error, socket path, or key material to an HTTP client.
        send(res, 503, JSON.stringify({ error: "service unavailable" }), "application/json");
      }
      return;
    }

    // Unknown path
    send(res, 404, "Not found");
  });

  return new Promise((resolve, reject) => {
    const onListenError = (error) => {
      // listen() failed: the dashboard never came up, so zero the cloned key before rejecting
      // rather than leaving it live in memory with nothing left to close it.
      keyBuffer.fill(0);
      keyCleared = true;
      reject(error);
    };
    server.listen(port, host, () => {
      // Listen succeeded: detach the failure handler so a later, post-bind server error can't
      // zero the now-live key out from under a running dashboard.
      server.off("error", onListenError);
      const addr = server.address();
      const url = `http://${addr.address}:${addr.port}`;
      // Concurrent/repeat close() calls share one promise so they all resolve after the single
      // real server.close() + key-zero, and close() itself never throws.
      let closePromise = null;
      const close = () => {
        if (!closePromise) {
          closePromise = new Promise((resolveClose) => {
            // Drop idle keep-alive sockets (and any still-open ones) so shutdown doesn't stall
            // up to keepAliveTimeout waiting on a browser tab's lingering connection.
            server.closeIdleConnections();
            server.closeAllConnections();
            server.close(() => {
              keyBuffer.fill(0);
              keyCleared = true;
              resolveClose();
            });
          });
        }
        return closePromise;
      };
      resolve({
        url,
        port: addr.port,
        address: addr.address,
        close,
        get authKeyCleared() { return keyCleared; },
      });
    }).once("error", onListenError);
  });
}

function generateHTML(refreshSeconds) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Compass Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background: #f5f5f5; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); padding: 20px; }
        h1 { color: #333; margin-bottom: 20px; }
        .status { font-weight: 600; padding: 8px 0; }
        .status.ok { color: #2e7d32; }
        .status.error { color: #d32f2f; }
        .metrics { background: #f9f9f9; border: 1px solid #ddd; border-radius: 4px; padding: 15px; margin-top: 20px; }
        .metric-heading { font-weight: 700; color: #333; margin-top: 12px; text-transform: capitalize; }
        .metric-heading:first-child { margin-top: 0; }
        .metric-subheading { font-weight: 600; color: #555; margin: 6px 0 0 12px; }
        .metric-row { display: flex; justify-content: space-between; padding: 4px 0 4px 12px; border-bottom: 1px solid #eee; }
        .metric-row:last-child { border-bottom: none; }
        .metric-label { font-weight: 600; color: #666; }
        .metric-value { color: #333; }
        .loading { color: #999; font-style: italic; }
        .timestamp { color: #999; font-size: 0.9em; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Compass Dashboard</h1>
        <div id="status" class="status">Connecting...</div>
        <div id="metrics-container" class="metrics">
            <p class="loading">Loading metrics...</p>
        </div>
        <div class="timestamp" id="update-time"></div>
    </div>

    <script>
        const refreshInterval = ${refreshSeconds * 1000};

        function row(label, value) {
            const r = document.createElement('div');
            r.className = 'metric-row';
            const l = document.createElement('span');
            l.className = 'metric-label';
            l.textContent = label;
            const v = document.createElement('span');
            v.className = 'metric-value';
            v.textContent = String(value);
            r.append(l, v);
            return r;
        }

        // Recursively flattens the metadata-only metrics object into labeled rows, one heading
        // per nested object (window, platforms, eventTypes, grounding + its matchReasons
        // breakdown, coalescing, dlp), so nested structures render instead of "[object Object]".
        function renderSection(container, key, value, depth) {
            if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                const heading = document.createElement('div');
                heading.className = depth === 0 ? 'metric-heading' : 'metric-subheading';
                heading.textContent = key;
                container.appendChild(heading);
                for (const [childKey, childValue] of Object.entries(value)) {
                    renderSection(container, childKey, childValue, depth + 1);
                }
            } else {
                container.appendChild(row(key, value));
            }
        }

        function renderMetrics(data) {
            const container = document.getElementById('metrics-container');
            container.innerHTML = '';
            if (typeof data !== 'object' || data === null) return;
            for (const [key, value] of Object.entries(data)) {
                renderSection(container, key, value, 0);
            }
        }

        function setStatus(reachable) {
            const status = document.getElementById('status');
            status.textContent = reachable ? 'Supervisor: reachable' : 'Supervisor: unreachable';
            status.className = 'status ' + (reachable ? 'ok' : 'error');
        }

        // Single timer handle + single in-flight guard so toggling the tab hidden<->visible
        // can never spawn overlapping poll chains: at most one pending timer and at most one
        // in-flight fetch exist at any time.
        let pendingTimer = null;
        let inFlight = false;

        function clearPendingTimer() {
            if (pendingTimer !== null) {
                clearTimeout(pendingTimer);
                pendingTimer = null;
            }
        }

        function updateMetrics() {
            if (document.hidden || inFlight) return;
            inFlight = true;

            fetch('/metrics')
                .then(response => {
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    return response.json();
                })
                .then(data => {
                    setStatus(true);
                    renderMetrics(data);
                    document.getElementById('update-time').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
                })
                .catch(() => {
                    setStatus(false);
                })
                .finally(() => {
                    inFlight = false;
                    clearPendingTimer();
                    if (!document.hidden) {
                        pendingTimer = setTimeout(updateMetrics, refreshInterval);
                    }
                });
        }

        document.addEventListener('visibilitychange', () => {
            clearPendingTimer();
            if (!document.hidden) {
                pendingTimer = setTimeout(updateMetrics, 0);
            }
        });

        updateMetrics();
    </script>
</body>
</html>`;
}
