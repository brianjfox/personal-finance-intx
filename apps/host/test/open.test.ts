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

import { createApp } from "../src/app";
import { openCommand, startIpc } from "../src/ipc";

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
});
