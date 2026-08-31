// The Windows stores, exercised on any platform through an injected
// CommandRunner that plays PowerShell: it parses the generated scripts
// the same way the real interpreter would (base64 payloads out of the
// script text) and keeps credentials in a Map. The real-PowerShell
// suite lives in secrets-windows-live.test.ts, gated to win32.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { credentialManagerSecretStore, dpapiFileSecretStore, platformSecretStore, windowsSecretStore, type CommandRunner } from "../src/index";

const PEM = "-----BEGIN FAKE KEY-----\nline-one\nline-two\n-----END FAKE KEY-----\n";
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const fromB64 = (s: string): string => Buffer.from(s, "base64").toString("utf8");
const B64_RE = "([A-Za-z0-9+/=]+)";

/** `fin-*`-style matching, as CredEnumerateW filters (trailing `*`). */
const globMatch = (pattern: string, target: string): boolean =>
  new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`))}$`).test(target);

interface FakeShell {
  run: CommandRunner;
  /** Target -> blob as base64: the real store holds BYTES, and a chunk may not be valid UTF-8 on its own. */
  creds: Map<string, string>;
  /** The blob at `target`, decoded as UTF-8 text (for whole-value assertions). */
  text: (target: string) => string | undefined;
  /** Every script handed to "PowerShell", in order. */
  scripts: string[];
}

/** A PowerShell that answers the shim scripts from a Map. failAddType simulates the no-compiler box (W2 territory). */
function fakePowerShell(opts: { failAddType?: boolean; initial?: Record<string, string> } = {}): FakeShell {
  const creds = new Map(Object.entries(opts.initial ?? {}).map(([t, v]) => [t, b64(v)]));
  const scripts: string[] = [];
  const run: CommandRunner = (command, args) => {
    expect(command).toBe("powershell");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    const script = args[3]!;
    scripts.push(script);
    if (script.includes("Add-Type -TypeDefinition") && opts.failAddType === true) {
      return { status: 1, stdout: "", stderr: "Add-Type : Cannot add type. Compiler executable file csc.exe cannot be found.\n" };
    }
    if (script.includes("'fin-credman-ok'")) return { status: 0, stdout: "fin-credman-ok", stderr: "" };
    if (script.includes("[FinCred]::Write(")) {
      const m = script.match(new RegExp(`FromBase64String\\('${B64_RE}'\\)`));
      const v = script.match(new RegExp(`::Write\\(\\$t,'${B64_RE}'\\)`));
      creds.set(fromB64(m![1]!), v![1]!);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (script.includes("[FinCred]::Read(")) {
      const m = script.match(new RegExp(`FromBase64String\\('${B64_RE}'\\)`));
      const v = creds.get(fromB64(m![1]!));
      if (v === undefined) return { status: 3, stdout: "", stderr: "" };
      return { status: 0, stdout: v, stderr: "" };
    }
    if (script.includes("[FinCred]::Delete(")) {
      const m = script.match(new RegExp(`FromBase64String\\('${B64_RE}'\\)`));
      return { status: creds.delete(fromB64(m![1]!)) ? 0 : 3, stdout: "", stderr: "" };
    }
    if (script.includes("[FinCred]::List(")) {
      const m = script.match(new RegExp(`FromBase64String\\('${B64_RE}'\\)`));
      const pattern = fromB64(m![1]!);
      const names = [...creds.keys()].filter((t) => globMatch(pattern, t));
      return { status: 0, stdout: names.map((t) => `${b64(t)}\r\n`).join(""), stderr: "" };
    }
    if (script.includes("ProtectedData]::Protect(")) {
      const m = script.match(new RegExp(`FromBase64String\\('${B64_RE}'\\)`));
      return { status: 0, stdout: b64(`dpapi:${fromB64(m![1]!)}`), stderr: "" };
    }
    if (script.includes("ProtectedData]::Unprotect(")) {
      const m = script.match(new RegExp(`FromBase64String\\('${B64_RE}'\\)`));
      const plain = fromB64(m![1]!);
      if (!plain.startsWith("dpapi:")) return { status: 1, stdout: "", stderr: "Unprotect failed" };
      return { status: 0, stdout: b64(plain.slice("dpapi:".length)), stderr: "" };
    }
    throw new Error(`fake PowerShell got an unrecognized script:\n${script}`);
  };
  return { run, creds, text: (t) => (creds.has(t) ? fromB64(creds.get(t)!) : undefined), scripts };
}

const tmpFile = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fin-credstore-")), "credstore.bin");

describe("credential manager store (W1, fake PowerShell)", () => {
  test("targets are ${service}/${account} -- no extra fin- prefix -- and multi-line values round-trip", () => {
    const shell = fakePowerShell();
    const store = credentialManagerSecretStore({ run: shell.run });
    store.set!("fin-plaid", "client_id", "cid-123");
    store.set!("fin-enablebanking", "private_key", PEM);
    expect([...shell.creds.keys()]).toEqual(["fin-plaid/client_id", "fin-enablebanking/private_key"]);
    expect(shell.text("fin-enablebanking/private_key")).toBe(PEM);
    expect(store.get("fin-enablebanking", "private_key")).toBe(PEM);
    expect(store.get("fin-plaid", "nope")).toBeNull();
  });

  test("secrets never appear raw in a script: every payload crosses base64-encoded", () => {
    const shell = fakePowerShell();
    const store = credentialManagerSecretStore({ run: shell.run });
    const spicy = `pass'word"$(& rm -rf); \`n${PEM}`;
    store.set!("fin-kraken", "private_key:inst.k", spicy);
    expect(store.get("fin-kraken", "private_key:inst.k")).toBe(spicy);
    for (const script of shell.scripts) {
      expect(script).not.toContain(spicy);
      expect(script).not.toContain("pass'word");
    }
    const write = shell.scripts.find((s) => s.includes("::Write("))!;
    expect(write).toMatch(new RegExp(`::Write\\(\\$t,'${B64_RE}'\\)`));
  });

  test("reads are cached per target; set writes through; delete invalidates", () => {
    const shell = fakePowerShell({ initial: { "fin-plaid/secret": "s3cret" } });
    const store = credentialManagerSecretStore({ run: shell.run });
    expect(store.get("fin-plaid", "secret")).toBe("s3cret");
    expect(store.get("fin-plaid", "secret")).toBe("s3cret");
    expect(shell.scripts).toHaveLength(1); // second get answered from cache
    store.set!("fin-plaid", "secret", "rotated");
    expect(store.get("fin-plaid", "secret")).toBe("rotated"); // cache write-through, no read spawn
    expect(shell.scripts).toHaveLength(3); // the write + the stale-chunk probe
    expect(store.delete!("fin-plaid", "secret")).toBe(true);
    expect(store.get("fin-plaid", "secret")).toBeNull(); // cache invalidated: re-reads the OS
    expect(shell.scripts).toHaveLength(6); // + bare delete, chunk probe, re-read
    expect(store.delete!("fin-plaid", "secret")).toBe(false); // already gone
  });

  test("misses are cached too, and a set replaces the cached miss", () => {
    const shell = fakePowerShell();
    const store = credentialManagerSecretStore({ run: shell.run });
    expect(store.get("fin-plaid", "client_id")).toBeNull();
    expect(store.get("fin-plaid", "client_id")).toBeNull();
    expect(shell.scripts).toHaveLength(1);
    store.set!("fin-plaid", "client_id", "cid");
    expect(store.get("fin-plaid", "client_id")).toBe("cid");
  });

  test("a status-1 read (transient failure) is not cached: the second read re-spawns", () => {
    const shell = fakePowerShell({ initial: { "fin-plaid/secret": "s3cret" } });
    let calls = 0;
    const run: CommandRunner = (command, args) => {
      calls += 1;
      if (calls === 1) return { status: 1, stdout: "", stderr: "PowerShell stalled" };
      return shell.run(command, args);
    };
    const store = credentialManagerSecretStore({ run });
    expect(store.get("fin-plaid", "secret")).toBeNull(); // the failure surfaces as null...
    expect(store.get("fin-plaid", "secret")).toBe("s3cret"); // ...but was not cached
    expect(calls).toBe(2);
    expect(store.get("fin-plaid", "secret")).toBe("s3cret"); // the hit IS cached
    expect(calls).toBe(2);
  });

  test("enumerate('fin-*') lists the app's targets for the delete-all-data sweep", () => {
    const shell = fakePowerShell({
      initial: { "fin-plaid/client_id": "a", "fin-kraken/api_key:inst.k": "b", "other-app/token": "c" },
    });
    const store = credentialManagerSecretStore({ run: shell.run });
    expect(store.enumerate!("fin-*").sort()).toEqual(["fin-kraken/api_key:inst.k", "fin-plaid/client_id"]);
    expect(store.enumerate!("nomatch-*")).toEqual([]);
  });
});

// A generic credential's blob is capped at CRED_MAX_CREDENTIAL_BLOB_SIZE
// (2560 bytes); CredWrite fails an oversized blob with Win32 error 1783.
// The Enable Banking RSA private key PEM (~3.2 KB at 4096 bits) does not
// fit, so oversized values are chunked across `<target>#1..#N` behind a
// sentinel at the bare target.
describe("credential manager store: values over the 2560-byte blob cap", () => {
  const SENTINEL = "\u0000fin-chunks:";
  // ~4.7 KB of PEM-looking text: 3 chunks at 2048 bytes each.
  const BIG = `-----BEGIN PRIVATE KEY-----\n${"MIIfakebase64line/0123456789+abcdefghijklmnopqrstuv\n".repeat(90)}-----END PRIVATE KEY-----\n`;

  test("an oversized value is chunked, round-trips, and reads are cached", () => {
    expect(Buffer.byteLength(BIG, "utf8")).toBeGreaterThan(2560);
    const shell = fakePowerShell();
    const store = credentialManagerSecretStore({ run: shell.run });
    store.set!("fin-enablebanking", "u.bfox.private_key", BIG);
    const t = "fin-enablebanking/u.bfox.private_key";
    const n = Math.ceil(Buffer.byteLength(BIG, "utf8") / 2048);
    expect(shell.text(t)).toBe(`${SENTINEL}${n}`);
    expect([...shell.creds.keys()].filter((k) => k.startsWith(`${t}#`)).sort()).toEqual(
      Array.from({ length: n }, (_, i) => `${t}#${i + 1}`).sort(),
    );
    // No chunk exceeds the cap, and no script carries the raw key.
    for (const [k, v] of shell.creds) {
      if (k.startsWith(`${t}#`)) expect(Buffer.from(v, "base64").length).toBeLessThanOrEqual(2560);
    }
    for (const script of shell.scripts) expect(script).not.toContain("BEGIN PRIVATE KEY");
    // Write-through cache, then a genuinely cold reassembling read.
    expect(store.get("fin-enablebanking", "u.bfox.private_key")).toBe(BIG);
    const fresh = credentialManagerSecretStore({ run: shell.run });
    expect(fresh.get("fin-enablebanking", "u.bfox.private_key")).toBe(BIG);
    const spawns = shell.scripts.length;
    expect(fresh.get("fin-enablebanking", "u.bfox.private_key")).toBe(BIG); // cached
    expect(shell.scripts).toHaveLength(spawns);
  });

  test("a chunk boundary that cuts a UTF-8 code point still round-trips", () => {
    // "€" is 3 bytes; 2048 % 3 != 0, so the first boundary lands mid-char.
    const euros = "€".repeat(1000); // 3000 bytes -> 2 chunks
    const shell = fakePowerShell();
    credentialManagerSecretStore({ run: shell.run }).set!("fin-test", "wide", euros);
    expect(credentialManagerSecretStore({ run: shell.run }).get("fin-test", "wide")).toBe(euros);
  });

  test("enumerate hides chunk targets; delete removes the whole chain", () => {
    const shell = fakePowerShell();
    const store = credentialManagerSecretStore({ run: shell.run });
    store.set!("fin-enablebanking", "u.bfox.private_key", BIG);
    store.set!("fin-plaid", "client_id", "cid");
    expect(store.enumerate!("fin-*").sort()).toEqual(["fin-enablebanking/u.bfox.private_key", "fin-plaid/client_id"]);
    expect(store.delete!("fin-enablebanking", "u.bfox.private_key")).toBe(true);
    expect([...shell.creds.keys()]).toEqual(["fin-plaid/client_id"]); // no orphaned chunks
    expect(store.get("fin-enablebanking", "u.bfox.private_key")).toBeNull();
  });

  test("rotation cleans up: big -> small leaves no chunks, big -> smaller-big trims the tail", () => {
    const shell = fakePowerShell();
    const store = credentialManagerSecretStore({ run: shell.run });
    store.set!("fin-test", "key", BIG); // 3 chunks
    store.set!("fin-test", "key", "small-now");
    expect([...shell.creds.keys()]).toEqual(["fin-test/key"]);
    expect(shell.text("fin-test/key")).toBe("small-now");
    const medium = "x".repeat(3000); // back up to 2 chunks...
    store.set!("fin-test", "key", medium);
    store.set!("fin-test", "key", BIG); // ...and 3 again
    store.set!("fin-test", "key", medium); // down to 2: #3 must go
    expect([...shell.creds.keys()].sort()).toEqual(["fin-test/key", "fin-test/key#1", "fin-test/key#2"]);
    expect(credentialManagerSecretStore({ run: shell.run }).get("fin-test", "key")).toBe(medium);
  });

  test("a missing chunk reads as null without caching, so a later repair is picked up", () => {
    const shell = fakePowerShell();
    credentialManagerSecretStore({ run: shell.run }).set!("fin-test", "key", BIG);
    shell.creds.delete("fin-test/key#2"); // simulate a half-deleted chain
    const store = credentialManagerSecretStore({ run: shell.run });
    expect(store.get("fin-test", "key")).toBeNull();
    store.set!("fin-test", "key", BIG); // repair
    expect(store.get("fin-test", "key")).toBe(BIG);
    expect(credentialManagerSecretStore({ run: shell.run }).get("fin-test", "key")).toBe(BIG);
  });
});

describe("dpapi blob file store (W2, fake PowerShell)", () => {
  test("one Protect(CurrentUser) blob per service/account in credstore.bin; values round-trip", () => {
    const shell = fakePowerShell();
    const file = tmpFile();
    const store = dpapiFileSecretStore({ file, run: shell.run });
    store.set!("fin-plaid", "client_id", "cid-123");
    store.set!("fin-enablebanking", "private_key", PEM);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
    expect(Object.keys(onDisk).sort()).toEqual(["fin-enablebanking/private_key", "fin-plaid/client_id"]);
    // The file holds DPAPI blobs, not values -- even base64-decoded.
    for (const blob of Object.values(onDisk)) {
      expect(blob).not.toContain("cid-123");
      expect(fromB64(blob)).not.toBe("cid-123");
    }
    // A fresh store (empty cache) reads back through Unprotect.
    const fresh = dpapiFileSecretStore({ file, run: shell.run });
    expect(fresh.get("fin-plaid", "client_id")).toBe("cid-123");
    expect(fresh.get("fin-enablebanking", "private_key")).toBe(PEM);
    expect(fresh.get("fin-plaid", "nope")).toBeNull();
  });

  test("reads are cached; set writes through; delete invalidates and reports existence", () => {
    const shell = fakePowerShell();
    const file = tmpFile();
    const store = dpapiFileSecretStore({ file, run: shell.run });
    store.set!("fin-plaid", "secret", "v1");
    const spawnsAfterSet = shell.scripts.length;
    expect(store.get("fin-plaid", "secret")).toBe("v1");
    expect(store.get("fin-plaid", "secret")).toBe("v1");
    expect(shell.scripts).toHaveLength(spawnsAfterSet); // both gets from cache
    expect(store.delete!("fin-plaid", "secret")).toBe(true);
    expect(store.get("fin-plaid", "secret")).toBeNull();
    expect(store.delete!("fin-plaid", "secret")).toBe(false);
  });

  test("an Unprotect failure is not cached; a genuinely missing key is (no spawn at all)", () => {
    const shell = fakePowerShell();
    const file = tmpFile();
    dpapiFileSecretStore({ file, run: shell.run }).set!("fin-plaid", "secret", "v1");
    let fail = true;
    const run: CommandRunner = (command, args) => (fail ? { status: 1, stdout: "", stderr: "PowerShell stalled" } : shell.run(command, args));
    const store = dpapiFileSecretStore({ file, run });
    expect(store.get("fin-plaid", "secret")).toBeNull(); // transient: surfaces as null...
    fail = false;
    expect(store.get("fin-plaid", "secret")).toBe("v1"); // ...not cached, so the retry recovers
    const spawns = shell.scripts.length;
    expect(store.get("fin-plaid", "nope")).toBeNull(); // missing entry: cached, never spawns
    expect(store.get("fin-plaid", "nope")).toBeNull();
    expect(shell.scripts).toHaveLength(spawns);
  });

  test("enumerate matches the sweep pattern against stored targets", () => {
    const shell = fakePowerShell();
    const store = dpapiFileSecretStore({ file: tmpFile(), run: shell.run });
    store.set!("fin-plaid", "client_id", "a");
    store.set!("fin-inference", "key:openai", "b");
    expect(store.enumerate!("fin-*").sort()).toEqual(["fin-inference/key:openai", "fin-plaid/client_id"]);
    expect(store.enumerate!("fin-plaid/*")).toEqual(["fin-plaid/client_id"]);
  });

  test("a missing or unreadable credstore.bin means empty, not a crash", () => {
    const shell = fakePowerShell();
    const file = tmpFile();
    fs.writeFileSync(file, "not json");
    const store = dpapiFileSecretStore({ file, run: shell.run });
    expect(store.get("fin-plaid", "client_id")).toBeNull();
    expect(store.enumerate!("fin-*")).toEqual([]);
  });
});

describe("windowsSecretStore: the one-time W1/W2 pick", () => {
  test("when the Add-Type shim compiles, W1 (Credential Manager) wins and nothing is logged", () => {
    const shell = fakePowerShell();
    const notices: string[] = [];
    const store = windowsSecretStore({ run: shell.run, log: (m) => void notices.push(m) });
    store.set!("fin-plaid", "client_id", "cid");
    expect(shell.text("fin-plaid/client_id")).toBe("cid");
    expect(notices).toEqual([]);
  });

  test("when Add-Type fails, W2 (DPAPI file) is selected once, with a logged notice", () => {
    const shell = fakePowerShell({ failAddType: true });
    const file = tmpFile();
    const notices: string[] = [];
    const store = windowsSecretStore({ run: shell.run, file, log: (m) => void notices.push(m) });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("falling back to the DPAPI blob store");
    // The probe ran exactly once; operations go straight to the file store.
    const probes = shell.scripts.filter((s) => s.includes("'fin-credman-ok'"));
    expect(probes).toHaveLength(1);
    store.set!("fin-plaid", "client_id", "cid");
    expect(store.get("fin-plaid", "client_id")).toBe("cid");
    expect(shell.creds.size).toBe(0); // never touched the Credential Manager path
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("platformSecretStore pick", () => {
  test("darwin gets the Keychain (no enumerate); win32 gets a Windows store (enumerate present)", () => {
    expect(platformSecretStore("darwin").enumerate).toBeUndefined();
    const win = platformSecretStore("win32", { run: fakePowerShell().run, log: () => {} });
    expect(win.enumerate).toBeDefined();
  });
});
