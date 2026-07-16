# 13 — SSE clients accumulate forever, write errors unhandled

**Severity:** Low · **Effort:** Small
**Read [README.md](README.md) ground rules first.**

## Files you may touch

- `services/node-backend/src/routes/alerts.js`

Nothing else.

## The problem

`services/node-backend/src/routes/alerts.js`:

```js
const clients = new Set();

router.get('/stream', requireClinicalSse, (req, res) => {
  res.writeHead(200, { ... });
  res.write('data: {"type":"connected"}\n\n');

  clients.add(res);
  req.on('close', () => clients.delete(res));
});

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(msg);
  }
}
```

Three defects, all the same shape — nothing ever notices a connection has died:

1. **No keepalive.** An idle SSE connection sits behind nginx (`proxy_read_timeout 3600s`)
   and any intermediate NAT / load balancer. Those silently drop idle TCP connections
   after a few minutes. The client sees a dead stream; the server still holds the `res`.
2. **`client.write(msg)` is unguarded.** Writing to a destroyed socket emits an `error`
   on the response stream. With no `error` listener attached, Node treats it as an
   unhandled `'error'` event and **crashes the process**.
3. **`req.on('close')` is the only removal path.** It does fire on a clean disconnect,
   but not on a half-open connection the OS has not yet reaped.

Nothing in the frontend currently opens this stream (`grep EventSource` finds nothing),
so this is latent. It becomes a crash the moment the nursing-station UI is built.

## Decisions (already made — do not deviate)

1. **Send an SSE comment (`: ping\n\n`) every 25 seconds** as a keepalive. A comment line
   is ignored by `EventSource` and does not fire a message event, so no client-side change
   is needed. 25s is under the typical 30–60s idle-timeout floor.
2. **One shared interval for all clients**, created at module load, not one per client.
   Call `.unref()` on it so the timer never holds the process open.
3. **Wrap every write in `try/catch` and attach an `error` listener** to the response.
   Any failure removes the client from the set. Never let a dead socket take down the process.
4. **Do not add a client-count cap or a reconnect protocol.** Out of scope.
5. **Do not change `requireClinicalSse`** or the auth behaviour — that was fixed already.
6. Keep `broadcast` un-exported as it is today (it is used only by `subscribeRedis`).

## Required change

Replace everything from `const clients = new Set();` down to the end of `broadcast()`
with:

```js
// Connected SSE clients
const clients = new Set();

// Drop a client and stop tracking it. Safe to call more than once.
function removeClient(res) {
  clients.delete(res);
  try { res.end(); } catch { /* already destroyed */ }
}

// Write to one client, evicting it if the socket is gone. An unguarded write to a
// destroyed socket emits an 'error' on the response stream — with no listener that is
// an unhandled 'error' event, which crashes the process.
function safeWrite(res, msg) {
  try {
    res.write(msg);
  } catch (err) {
    removeClient(res);
  }
}

// SSE endpoint for nursing station alerts
router.get('/stream', requireClinicalSse, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('data: {"type":"connected"}\n\n');

  clients.add(res);

  // A half-open connection (NAT timeout, laptop lid closed) never fires 'close'. The
  // error listener is what actually reaps those, and it must exist regardless — see
  // safeWrite above.
  res.on('error', () => removeClient(res));
  req.on('close', () => removeClient(res));
  req.on('error', () => removeClient(res));
});

// Keepalive. An idle SSE stream is dropped by nginx / NAT / load balancers after a few
// minutes; a periodic comment line keeps it alive AND surfaces dead sockets (the write
// fails, safeWrite evicts them). ': ...' is an SSE comment — EventSource ignores it, so
// no client-side handling is needed.
const SSE_KEEPALIVE_MS = 25000;
const keepalive = setInterval(() => {
  for (const client of [...clients]) safeWrite(client, ': ping\n\n');
}, SSE_KEEPALIVE_MS);
keepalive.unref();   // never hold the process open just for this timer

// Broadcast alert to all connected SSE clients
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of [...clients]) safeWrite(client, msg);
}
```

Note `[...clients]` — `safeWrite` can delete from `clients` mid-iteration, and mutating a
`Set` while iterating it skips entries.

## Acceptance criteria

- [ ] Every `res.write` to a client goes through `safeWrite`.
- [ ] A write failure removes the client rather than throwing.
- [ ] `res.on('error')` and `req.on('error')` both remove the client.
- [ ] A single shared `setInterval`, `.unref()`ed, sends `: ping\n\n` every 25s.
- [ ] Both loops iterate a copy (`[...clients]`), not the live `Set`.
- [ ] Killing a connected client mid-stream does not crash node-backend.
- [ ] `clients.size` returns to 0 after all clients disconnect.
- [ ] The auth gate `requireClinicalSse` is unchanged.

## How to verify

```powershell
cd services\node-backend
node --check src\routes\alerts.js
```

With the stack up and a doctor token in `$d`, open a stream and watch the keepalive:

```powershell
curl.exe -N -H "Authorization: Bearer $d" http://localhost/api/alerts/stream
# expect: data: {"type":"connected"}
# then, every ~25s: ": ping"
# leave it running for a minute, then Ctrl+C
```

Crash-resistance — the important one. Open a stream, kill it abruptly, then force a
broadcast and confirm the process survives:

```powershell
# terminal 1
curl.exe -N -H "Authorization: Bearer $d" http://localhost/api/alerts/stream
# ...then kill the terminal window outright (do not Ctrl+C — you want a half-open socket)

# terminal 2: publish a fake alert on the redis channel the router subscribes to
docker compose exec redis redis-cli PUBLISH triage_alerts '{"session_id":"x","level":"RED"}'

docker compose ps node-backend
# expect: still Up, NOT restarting

docker compose logs --tail=20 node-backend
# expect no unhandled 'error' event / no crash trace
```

Repeat the publish a few times. Before this fix, the abandoned socket causes an
unhandled `error` and the container restarts.

## Done when

The `: ping` lines appear on a live stream, and killing a client then broadcasting leaves
`node-backend` `Up` with no crash in the logs.
