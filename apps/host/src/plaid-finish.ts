// The "Stripe checkout" ending for Plaid Hosted Link. Plaid never needs
// to reach this machine -- an OAuth redirect is just the user's own
// browser navigating -- so a FIXED loopback listener can be the
// completion redirect: register http://localhost:7787/plaid/done once
// in the Plaid dashboard, and finishing the bank login lands the
// browser here, which tells the host to exchange the tokens. No coming
// back to click Finish.
//
// The port is fixed because Plaid matches registered redirect URIs
// exactly, port included. If something else owns the port, the flow
// simply falls back to the manual Finish button.

const PLAID_FINISH_PORT = 7787;
export const PLAID_FINISH_URI = `http://localhost:${PLAID_FINISH_PORT}/plaid/done`;

const DONE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Connected</title>
<style>body{font-family:-apple-system,sans-serif;background:#0f2233;color:#e8eef2;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
main{text-align:center}h1{font-size:1.6em}p{color:#9db4c0}</style></head>
<body><main><h1>✅ You're connected</h1><p>Corbits Personal Finance is fetching your accounts.<br>You can close this tab and go back to the app.</p></main></body></html>`;

const subscribers = new Set<() => void>();
let server: ReturnType<typeof Bun.serve> | null = null;

/** Start (or reuse) the fixed-port listener. False when the port is taken: fall back to manual finish. */
export function ensurePlaidFinishListener(): boolean {
  if (server !== null) return true;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: PLAID_FINISH_PORT,
      fetch(req) {
        if (new URL(req.url).pathname === "/plaid/done") {
          for (const cb of [...subscribers]) cb();
          return new Response(DONE_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    server.unref();
    return true;
  } catch {
    return false;
  }
}

/** Be told when the browser lands on /plaid/done. Returns the unsubscribe. */
export function onPlaidReturn(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/** Tests: stop the listener and drop subscribers. */
export function stopPlaidFinishListener(): void {
  server?.stop(true);
  server = null;
  subscribers.clear();
}
