// Anthropic's identity-linked API keys demand an `anthropic-workspace-id`
// header on every request; without it the API answers 400. The pinned
// interchange runtime's Anthropic adapter builds its headers itself and
// accepts no extensions -- so instead of touching every caller, the host
// runs a tiny loopback forwarder: point the source's baseURL here, and
// every request (chat runtime, profile intake, the Test button) goes out
// with the workspace header added. The API key still travels only in the
// caller's own headers; the proxy adds nothing secret.

const proxies = new Map<string, { port: number; server: ReturnType<typeof Bun.serve> }>();

/** A loopback base URL that forwards to `upstream` with the workspace header set. */
export function anthropicProxyBaseURL(workspaceId: string, upstream = "https://api.anthropic.com"): string {
  const key = `${workspaceId}|${upstream}`;
  const existing = proxies.get(key);
  if (existing !== undefined) return `http://127.0.0.1:${existing.port}`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 240,
    async fetch(req) {
      const url = new URL(req.url);
      const headers = new Headers(req.headers);
      headers.set("anthropic-workspace-id", workspaceId);
      headers.delete("host");
      return fetch(`${upstream}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        ...(req.method !== "GET" && req.method !== "HEAD" ? { body: req.body } : {}),
      });
    },
  });
  server.unref(); // never keep the process alive on our account
  const port = Number(server.port);
  proxies.set(key, { port, server });
  return `http://127.0.0.1:${port}`;
}

/** Tests: stop every forwarder. */
export function stopAnthropicProxies(): void {
  for (const p of proxies.values()) p.server.stop(true);
  proxies.clear();
}
