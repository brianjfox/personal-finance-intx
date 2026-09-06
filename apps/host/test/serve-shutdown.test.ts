// `fin-host serve` stops when told (issue #104): SIGTERM ends the process
// within seconds even with the scheduler's timers armed and a client
// holding a connection open, and a host whose parent has gone follows
// it out instead of living on as an orphan.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const CLI = path.resolve(import.meta.dir, "../src/cli.ts");
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-serve-"));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      srv.close(() => (typeof a === "object" && a !== null ? resolve(a.port) : reject(new Error("no port"))));
    });
  });
}

const running: Array<ReturnType<typeof Bun.spawn>> = [];
afterEach(() => {
  for (const p of running) {
    try {
      p.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
  running.length = 0;
});

async function serve(env: Record<string, string> = {}): Promise<{ proc: ReturnType<typeof Bun.spawn>; port: number; out: () => string }> {
  const port = await freePort();
  const proc = Bun.spawn(["bun", CLI, "serve", "--data", tmp(), "--port", String(port)], {
    env: { ...process.env, FIN_ANTHROPIC_API_KEY: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  running.push(proc);
  let text = "";
  const reader = (async () => {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) text += new TextDecoder().decode(chunk);
  })();
  void reader;
  const deadline = Date.now() + 20_000;
  while (!text.includes('"listening"')) {
    if (Date.now() > deadline) throw new Error(`serve did not start:\n${text}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return { proc, port, out: () => text };
}

async function exitWithin(proc: ReturnType<typeof Bun.spawn>, ms: number): Promise<number | null> {
  const timer = new Promise<null>((r) => setTimeout(() => r(null), ms));
  return Promise.race([proc.exited, timer]);
}

describe("fin-host serve stops when told (issue #104)", () => {
  // Windows has no signals: `kill("SIGTERM")` there is TerminateProcess, which
  // ends the process without running a handler (and without exit code 0), so
  // the signal path is macOS/Linux-only. The parent watch below runs everywhere.
  test.skipIf(process.platform === "win32")("SIGTERM ends the process within seconds, even with a client holding a connection open", async () => {
    const { proc, port, out } = await serve({ FIN_PARENT_WATCH: "0" });
    // A client that never finishes reading: the graceful stop used to wait for it.
    const sock = net.connect(port, "127.0.0.1");
    sock.write("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    await new Promise((r) => setTimeout(r, 200));
    proc.kill("SIGTERM");
    const code = await exitWithin(proc, 8000);
    sock.destroy();
    expect(code).toBe(0);
    expect(out()).toContain('"stopping":"SIGTERM"');
  });

  test(
    "a host whose parent has gone follows it out",
    async () => {
      // Stand in for the shell: a process the host is told is its parent (bun, so it exists on every runner).
      const parent = Bun.spawn(["bun", "-e", "setTimeout(() => {}, 60000)"]);
      running.push(parent);
      const { proc, out } = await serve({ FIN_PARENT_PID: String(parent.pid) });
      expect(out()).toContain(`"parent":${String(parent.pid)}`);
      parent.kill("SIGKILL");
      await parent.exited;
      const code = await exitWithin(proc, 10_000);
      expect(code).toBe(0);
      expect(out()).toContain(`parent process ${String(parent.pid)} is gone`);
    },
    30_000, // startup + a 2 s probe + shutdown: past bun's 5 s default on a slow runner
  );
});
