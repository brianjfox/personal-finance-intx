// LAN exposure guardrail: when an allowlist is given, only requests that
// name this host are served — the DNS-rebinding shape (a hostile page's
// own hostname resolving here) arrives with the wrong Host and gets 403.

import { describe, expect, test } from "bun:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApp } from "../src/app";
import { startIpc } from "../src/ipc";

describe("host allowlist", () => {
  test("recognized Hosts are served, strangers get 403, ports are ignored", async () => {
    const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "fin-lan-")) });
    const server = startIpc({ app, port: 0, allowedHosts: new Set(["127.0.0.1", "localhost", "192.168.7.50"]) });
    try {
      const ok = await fetch(new URL("/api/health", server.url));
      expect(ok.status).toBe(200);
      const lanHost = await fetch(new URL("/api/health", server.url), { headers: { host: "192.168.7.50:7777" } });
      expect(lanHost.status).toBe(200);
      const spoofed = await fetch(new URL("/api/health", server.url), { headers: { host: "evil.example" } });
      expect(spoofed.status).toBe(403);
    } finally {
      await server.stop();
      app.close();
    }
  });

  test("no allowlist: behavior unchanged (loopback callers just work)", async () => {
    const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "fin-lan-")) });
    const server = startIpc({ app, port: 0 });
    try {
      const ok = await fetch(new URL("/api/health", server.url));
      expect(ok.status).toBe(200);
    } finally {
      await server.stop();
      app.close();
    }
  });
});

describe("/api/lan control", () => {
  test("GET reports state; POST flips via the hook; a refused flip is a 400 with the reason", async () => {
    const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "fin-lan-")) });
    let enabled = false;
    const server = startIpc({
      app,
      port: 0,
      lan: {
        get: () => ({ enabled, addresses: ["demo.local:7777", "192.168.7.50:7777"] }),
        set: (e) => {
          if (e) throw new Error("Every person needs a password before the host faces the network -- missing: Primary.");
          enabled = e;
        },
      },
    });
    try {
      const st = (await (await fetch(new URL("/api/lan", server.url))).json()) as { enabled: boolean; addresses: string[] };
      expect(st.enabled).toBe(false);
      expect(st.addresses[0]).toBe("demo.local:7777");
      const refused = await fetch(new URL("/api/lan", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain("needs a password");
    } finally {
      await server.stop();
      app.close();
    }
  });

  test("without the hook (tests, embedded), GET says disabled and POST refuses plainly", async () => {
    const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "fin-lan-")) });
    const server = startIpc({ app, port: 0 });
    try {
      const st = (await (await fetch(new URL("/api/lan", server.url))).json()) as { enabled: boolean };
      expect(st.enabled).toBe(false);
      const r = await fetch(new URL("/api/lan", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(r.status).toBe(400);
    } finally {
      await server.stop();
      app.close();
    }
  });
});
