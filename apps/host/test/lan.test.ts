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
