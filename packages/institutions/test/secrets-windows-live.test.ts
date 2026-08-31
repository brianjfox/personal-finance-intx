// The real-PowerShell suite: runs only on Windows (the CI windows
// runner / a VM). Everything here typechecks everywhere but is
// skipped off win32. Uses fin-test-* services so a sweep of real
// fin-* credentials never touches user data.

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { credentialManagerSecretStore, dpapiFileSecretStore, windowsSecretStore } from "../src/index";

const win = process.platform === "win32";
const SERVICE = "fin-test-credman";
const PEM = "-----BEGIN FAKE KEY-----\nline-one\nline-two\n-----END FAKE KEY-----\n";

describe.skipIf(!win)("credential manager store (real PowerShell)", () => {
  afterAll(() => {
    const store = credentialManagerSecretStore();
    for (const target of store.enumerate!(`${SERVICE}*`)) {
      const [service, ...rest] = target.split("/");
      store.delete!(service!, rest.join("/"));
    }
  });

  test("set / get / enumerate / delete round-trip through the OS store", () => {
    const store = credentialManagerSecretStore();
    store.set!(SERVICE, "probe", PEM);
    expect(store.get(SERVICE, "probe")).toBe(PEM);
    // A fresh store has an empty cache: this read really hits CredRead.
    const fresh = credentialManagerSecretStore();
    expect(fresh.get(SERVICE, "probe")).toBe(PEM);
    expect(fresh.enumerate!(`${SERVICE}*`)).toContain(`${SERVICE}/probe`);
    expect(fresh.delete!(SERVICE, "probe")).toBe(true);
    expect(credentialManagerSecretStore().get(SERVICE, "probe")).toBeNull();
    expect(credentialManagerSecretStore().delete!(SERVICE, "probe")).toBe(false);
  }, 60_000);

  test("a re-set replaces the credential (CRED_PRESERVE not needed)", () => {
    const store = credentialManagerSecretStore();
    store.set!(SERVICE, "rotate", "v1");
    store.set!(SERVICE, "rotate", "v2");
    expect(credentialManagerSecretStore().get(SERVICE, "rotate")).toBe("v2");
    store.delete!(SERVICE, "rotate");
  }, 60_000);

  test("a value over CRED_MAX_CREDENTIAL_BLOB_SIZE (2560) chunks, round-trips, and deletes cleanly", () => {
    // The bug this pins: a 4096-bit RSA private key PEM (~3.2 KB) used to
    // fail CredWrite with Win32 error 1783. Make it comfortably 3 chunks.
    const bigPem = `-----BEGIN PRIVATE KEY-----\n${"MIIfakebase64line/0123456789+abcdefghijklmnopqrstuv\n".repeat(90)}-----END PRIVATE KEY-----\n`;
    expect(Buffer.byteLength(bigPem, "utf8")).toBeGreaterThan(2560);
    const store = credentialManagerSecretStore();
    store.set!(SERVICE, "big_key", bigPem);
    // A genuinely cold read reassembles from the OS store.
    expect(credentialManagerSecretStore().get(SERVICE, "big_key")).toBe(bigPem);
    // Chunk credentials are hidden from the sweep's enumerate.
    expect(credentialManagerSecretStore().enumerate!(`${SERVICE}*`)).toEqual([`${SERVICE}/big_key`]);
    expect(store.delete!(SERVICE, "big_key")).toBe(true);
    expect(credentialManagerSecretStore().get(SERVICE, "big_key")).toBeNull();
    // Every step above spawns a fresh PowerShell (~1s each on a CI
    // runner: Add-Type recompiles per spawn), and a 3-chunk value takes
    // ~16 spawns end to end -- far past bun's 5s default timeout.
  }, 120_000);
});

describe.skipIf(!win)("dpapi blob file store (real PowerShell)", () => {
  test("Protect/Unprotect round-trip; the file never holds the plaintext", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fin-credstore-")), "credstore.bin");
    const store = dpapiFileSecretStore({ file });
    store.set!(SERVICE, "probe", PEM);
    expect(fs.readFileSync(file, "utf8")).not.toContain("FAKE KEY");
    const fresh = dpapiFileSecretStore({ file });
    expect(fresh.get(SERVICE, "probe")).toBe(PEM);
    expect(fresh.enumerate!("fin-test-*")).toEqual([`${SERVICE}/probe`]);
    expect(fresh.delete!(SERVICE, "probe")).toBe(true);
    expect(dpapiFileSecretStore({ file }).get(SERVICE, "probe")).toBeNull();
  });
});

describe.skipIf(!win)("windowsSecretStore (real PowerShell)", () => {
  test("on a stock machine the probe picks W1 silently", () => {
    const notices: string[] = [];
    const store = windowsSecretStore({ log: (m) => void notices.push(m) });
    store.set!(SERVICE, "pick", "w1");
    expect(store.get(SERVICE, "pick")).toBe("w1");
    // Add-Type works on stock Windows: the fallback notice must not fire.
    expect(notices).toEqual([]);
    expect(store.enumerate!(`${SERVICE}*`)).toContain(`${SERVICE}/pick`);
    store.delete!(SERVICE, "pick");
  }, 60_000);
});
