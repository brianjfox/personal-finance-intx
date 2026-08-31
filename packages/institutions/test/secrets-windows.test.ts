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
  creds: Map<string, string>;
  /** Every script handed to "PowerShell", in order. */
  scripts: string[];
}

/** A PowerShell that answers the shim scripts from a Map. failAddType simulates the no-compiler box (W2 territory). */
function fakePowerShell(opts: { failAddType?: boolean; initial?: Record<string, string> } = {}): FakeShell {
  const creds = new Map(Object.entries(opts.initial ?? {}));
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
      creds.set(fromB64(m![1]!), fromB64(v![1]!));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (script.includes("[FinCred]::Read(")) {
      const m = script.match(new RegExp(`FromBase64String\\('${B64_RE}'\\)`));
      const v = creds.get(fromB64(m![1]!));
      if (v === undefined) return { status: 3, stdout: "", stderr: "" };
      return { status: 0, stdout: b64(v), stderr: "" };
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
  return { run, creds, scripts };
}

const tmpFile = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fin-credstore-")), "credstore.bin");

describe("credential manager store (W1, fake PowerShell)", () => {
  test("targets are ${service}/${account} -- no extra fin- prefix -- and multi-line values round-trip", () => {
    const shell = fakePowerShell();
    const store = credentialManagerSecretStore({ run: shell.run });
    store.set!("fin-plaid", "client_id", "cid-123");
    store.set!("fin-enablebanking", "private_key", PEM);
    expect([...shell.creds.keys()]).toEqual(["fin-plaid/client_id", "fin-enablebanking/private_key"]);
    expect(shell.creds.get("fin-enablebanking/private_key")).toBe(PEM);
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
    expect(shell.scripts).toHaveLength(2);
    expect(store.delete!("fin-plaid", "secret")).toBe(true);
    expect(store.get("fin-plaid", "secret")).toBeNull(); // cache invalidated: re-reads the OS
    expect(shell.scripts).toHaveLength(4);
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

  test("enumerate('fin-*') lists the app's targets for the delete-all-data sweep", () => {
    const shell = fakePowerShell({
      initial: { "fin-plaid/client_id": "a", "fin-kraken/api_key:inst.k": "b", "other-app/token": "c" },
    });
    const store = credentialManagerSecretStore({ run: shell.run });
    expect(store.enumerate!("fin-*").sort()).toEqual(["fin-kraken/api_key:inst.k", "fin-plaid/client_id"]);
    expect(store.enumerate!("nomatch-*")).toEqual([]);
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
    expect(shell.creds.get("fin-plaid/client_id")).toBe("cid");
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
