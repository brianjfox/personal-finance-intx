// /api/open must never hand a URL to a shell. The OpenBody regex admits
// cmd.exe metacharacters (& | ^ % " < > ( )) inside an https URL, and
// cmd's `start` parses them out of the argument string — so a URL like
// https://x.com/&calc.exe would execute calc. Every platform's opener is
// real argv with the URL as a single element; win32 uses rundll32's
// FileProtocolHandler, which no shell re-parses.

import { describe, expect, test } from "bun:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { memorySecretStore } from "@fin/institutions";

import { createApp } from "../src/app";
import { win32StoreCrypt } from "../src/crypt";
import { openCommand, startIpc } from "../src/ipc";
import { createUserManager } from "../src/users";

const META_URL = "https://x.com/&calc.exe";

describe("/api/open", () => {
  test("win32 opener is rundll32 argv — never cmd.exe, URL as one element", () => {
    const argv = openCommand("win32", META_URL);
    expect(argv).toEqual(["rundll32", "url.dll,FileProtocolHandler", META_URL]);
    for (const el of argv) expect(el.toLowerCase()).not.toMatch(/(^|[\\/])cmd(\.exe)?$/);
    expect(argv.filter((el) => el.includes("calc.exe"))).toEqual([META_URL]);
  });

  test("darwin and linux openers are unchanged", () => {
    expect(openCommand("darwin", "https://example.com/x")).toEqual(["open", "https://example.com/x"]);
    expect(openCommand("linux", "https://example.com/x")).toEqual(["xdg-open", "https://example.com/x"]);
  });

  test("the endpoint hands the metacharacter URL to the spawner unmangled, as openCommand argv", async () => {
    const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "fin-open-")) });
    const spawned: string[][] = [];
    const server = startIpc({
      app,
      port: 0,
      openSpawner: (argv) => {
        spawned.push([...argv]);
        return Promise.resolve(0);
      },
    });
    try {
      const r = await fetch(new URL("/api/open", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: META_URL }),
      });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ opened: true });
      expect(spawned).toEqual([openCommand(process.platform, META_URL)]);
      expect(spawned[0]).toContain(META_URL); // one argv element, never a shell string
    } finally {
      await server.stop();
      app.close();
    }
  });

  test("a mailto: link is opened like any other (the About dialog's author link)", async () => {
    const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "fin-open-")) });
    const spawned: string[][] = [];
    const server = startIpc({ app, port: 0, openSpawner: (argv) => { spawned.push([...argv]); return Promise.resolve(0); } });
    try {
      const r = await fetch(new URL("/api/open", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "mailto:bfox@brianjfox.com" }),
      });
      expect(r.status).toBe(200);
      expect(spawned).toEqual([openCommand(process.platform, "mailto:bfox@brianjfox.com")]);
    } finally {
      await server.stop();
      app.close();
    }
  });

  test("a javascript: or file: URL is still refused", async () => {
    const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "fin-open-")) });
    const spawned: string[][] = [];
    const server = startIpc({ app, port: 0, openSpawner: (argv) => { spawned.push([...argv]); return Promise.resolve(0); } });
    try {
      for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ftp://x.com/"]) {
        const r = await fetch(new URL("/api/open", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        });
        expect(r.status).toBe(400);
      }
      expect(spawned).toEqual([]);
    } finally {
      await server.stop();
      app.close();
    }
  });

  test("in users mode, a loopback caller opens a link with nobody signed in (About on the sign-in screen)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fin-open-users-"));
    const users = createUserManager({ rootDir: root, secrets: memorySecretStore(), crypt: win32StoreCrypt(() => "none") });
    const spawned: string[][] = [];
    const server = startIpc({ users, port: 0, openSpawner: (argv) => { spawned.push([...argv]); return Promise.resolve(0); } });
    try {
      users.add("Alice", "alice-pw");
      const url = "https://github.com/brianjfox/personal-finance-intx/issues/new";
      const r = await fetch(`http://127.0.0.1:${server.port}/api/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      expect(r.status).toBe(200);
      expect(spawned).toEqual([openCommand(process.platform, url)]);
      // Everything else under /api/ still wants a session.
      expect((await fetch(`http://127.0.0.1:${server.port}/api/me`)).status).toBe(401);
    } finally {
      await server.stop();
      users.closeAll();
    }
  });
});
