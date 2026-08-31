// Secrets for API connectors (Plaid, Enable Banking). The registry file
// deliberately holds no credentials; connector adapters resolve theirs
// through a SecretStore at fetch time. The default store looks in the
// process environment first (FIN_SECRET_<service>_<account>, uppercased,
// non-alphanumerics -> _), then in the OS credential store: the macOS
// login Keychain (`security find-generic-password -s <service> -a
// <account> -w`, the same pattern the Anthropic key uses --
// docs/PACKAGING.md) or, on Windows, the Credential Manager stores in
// secrets-windows.ts. Tests and the GUI connect flows inject their own
// stores.

import { spawnSync } from "node:child_process";

import { windowsSecretStore, type WindowsSecretStoreOpts } from "./secrets-windows";

export interface SecretStore {
  /** Returns the secret, or null when absent. Must not throw for a missing secret. */
  get(service: string, account: string): string | null;
  /** Persist a secret (used by the GUI connect flows). Optional: read-only stores omit it. */
  set?(service: string, account: string, value: string): void;
  /** Remove a stored secret; returns whether one existed. Optional: read-only stores omit it. */
  delete?(service: string, account: string): boolean;
  /** List stored `service/account` names matching a glob (`fin-*`, the delete-all-data sweep). Optional: only stores that can enumerate implement it. */
  enumerate?(pattern: string): string[];
}

export function envKeyFor(service: string, account: string): string {
  const clean = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `FIN_SECRET_${clean(service)}_${clean(account)}`;
}

export function envSecretStore(env: Record<string, string | undefined> = process.env): SecretStore {
  return {
    get(service, account) {
      const v = env[envKeyFor(service, account)];
      return v === undefined || v === "" ? null : v;
    },
  };
}

// `security find-generic-password -w` prints multi-line values (a PEM
// private key, say) HEX-ENCODED instead of raw -- the write stores the
// real bytes, every read hands back gibberish, and the first symptom is
// OpenSSL's NO_START_LINE deep inside a connector. So: multi-line
// values are written base64 under a `b64:` tag, and reads decode both
// that tag and the legacy hex form (healing items stored before this).

/** Store multi-line values in a form the security CLI reads back intact. */
export function encodeKeychainValue(value: string): string {
  return /[\r\n]/.test(value) ? `b64:${Buffer.from(value, "utf8").toString("base64")}` : value;
}

/**
 * Undo encodeKeychainValue, and heal the legacy case: a raw multi-line
 * write that `security -w` now returns hex-encoded. Only an even-length
 * hex string that decodes to clean multi-line text is treated as such --
 * a genuine hex secret (single-line once decoded, or binary) passes
 * through untouched.
 */
export function decodeKeychainValue(raw: string): string {
  if (raw.startsWith("b64:")) return Buffer.from(raw.slice(4), "base64").toString("utf8");
  if (raw.length >= 16 && raw.length % 2 === 0 && /^[0-9a-f]+$/.test(raw)) {
    const decoded = Buffer.from(raw, "hex").toString("utf8");
    // eslint-disable-next-line no-control-regex
    if (decoded.includes("\n") && !/[^\t\n\r\x20-\x7E\u00A0-\uFFFF]/.test(decoded)) return decoded;
  }
  return raw;
}

/** macOS login Keychain. Writes use -U so a re-connect replaces the item. */
export function keychainSecretStore(): SecretStore {
  return {
    get(service, account) {
      if (process.platform !== "darwin") return null;
      const r = spawnSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
        encoding: "utf8",
      });
      if (r.status !== 0) return null;
      const v = r.stdout.replace(/\n$/, "");
      return v === "" ? null : decodeKeychainValue(v);
    },
    set(service, account, value) {
      if (process.platform !== "darwin") throw new Error("keychain store is macOS-only");
      const r = spawnSync("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w", encodeKeychainValue(value)], {
        encoding: "utf8",
      });
      if (r.status !== 0) throw new Error(`security add-generic-password failed: ${r.stderr.trim()}`);
    },
    delete(service, account) {
      if (process.platform !== "darwin") return false;
      const r = spawnSync("security", ["delete-generic-password", "-s", service, "-a", account], { encoding: "utf8" });
      return r.status === 0;
    },
  };
}

// The Windows store probes PowerShell once to pick W1/W2 (see
// secrets-windows.ts), so it is built once per process, not per
// adapter -- defaultSecretStore() is called by every connector.
let winStore: SecretStore | undefined;

/** The OS-native store for a platform: darwin -> Keychain, win32 -> Credential Manager (with the DPAPI fallback). Passing opts (tests) bypasses the process-wide memo. */
export function platformSecretStore(platform: NodeJS.Platform = process.platform, opts?: WindowsSecretStoreOpts): SecretStore {
  if (platform === "win32") {
    if (opts !== undefined) return windowsSecretStore(opts);
    return (winStore ??= windowsSecretStore());
  }
  return keychainSecretStore();
}

/** Environment first (explicit wins), then the OS store. Writes go to the OS store. */
export function defaultSecretStore(): SecretStore {
  const env = envSecretStore();
  const store = platformSecretStore();
  return {
    get(service, account) {
      return env.get(service, account) ?? store.get(service, account);
    },
    set(service, account, value) {
      store.set?.(service, account, value);
    },
    delete(service, account) {
      return store.delete?.(service, account) ?? false;
    },
    ...(store.enumerate !== undefined ? { enumerate: (pattern: string) => store.enumerate!(pattern) } : {}),
  };
}

/**
 * One user's slice of a shared store: every account is prefixed with
 * the user's scope, so two users' "anthropic" keys are different
 * Keychain items. The service names stay the same (they're the app's
 * identity); only the account carries the user.
 */
export function scopedSecretStore(base: SecretStore, scope: string): SecretStore {
  const acct = (account: string): string => `${scope}.${account}`;
  return {
    get: (service, account) => base.get(service, acct(account)),
    ...(base.set !== undefined ? { set: (service: string, account: string, value: string) => base.set!(service, acct(account), value) } : {}),
    ...(base.delete !== undefined ? { delete: (service: string, account: string) => base.delete!(service, acct(account)) } : {}),
  };
}

/** In-memory store for tests and for capturing tokens mid-connect-flow. */
export function memorySecretStore(initial: Record<string, string> = {}): SecretStore & { dump(): Record<string, string> } {
  const m = new Map(Object.entries(initial));
  const key = (s: string, a: string): string => `${s}/${a}`;
  return {
    get: (s, a) => m.get(key(s, a)) ?? null,
    set: (s, a, v) => void m.set(key(s, a), v),
    delete: (s, a) => m.delete(key(s, a)),
    dump: () => Object.fromEntries(m),
  };
}
