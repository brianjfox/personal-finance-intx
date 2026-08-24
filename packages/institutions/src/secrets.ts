// Secrets for API connectors (Plaid, Enable Banking). The registry file
// deliberately holds no credentials; connector adapters resolve theirs
// through a SecretStore at fetch time. The default store looks in the
// process environment first (FIN_SECRET_<service>_<account>, uppercased,
// non-alphanumerics -> _), then in the macOS login Keychain
// (`security find-generic-password -s <service> -a <account> -w`) --
// the same pattern the Anthropic key uses (docs/PACKAGING.md). Tests and
// the GUI connect flows inject their own stores.

import { spawnSync } from "node:child_process";

export interface SecretStore {
  /** Returns the secret, or null when absent. Must not throw for a missing secret. */
  get(service: string, account: string): string | null;
  /** Persist a secret (used by the GUI connect flows). Optional: read-only stores omit it. */
  set?(service: string, account: string, value: string): void;
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
      return v === "" ? null : v;
    },
    set(service, account, value) {
      if (process.platform !== "darwin") throw new Error("keychain store is macOS-only");
      const r = spawnSync("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w", value], {
        encoding: "utf8",
      });
      if (r.status !== 0) throw new Error(`security add-generic-password failed: ${r.stderr.trim()}`);
    },
  };
}

/** Environment first (explicit wins), then the Keychain. Writes go to the Keychain. */
export function defaultSecretStore(): SecretStore {
  const env = envSecretStore();
  const chain = keychainSecretStore();
  return {
    get(service, account) {
      return env.get(service, account) ?? chain.get(service, account);
    },
    set(service, account, value) {
      chain.set?.(service, account, value);
    },
  };
}

/** In-memory store for tests and for capturing tokens mid-connect-flow. */
export function memorySecretStore(initial: Record<string, string> = {}): SecretStore & { dump(): Record<string, string> } {
  const m = new Map(Object.entries(initial));
  const key = (s: string, a: string): string => `${s}/${a}`;
  return {
    get: (s, a) => m.get(key(s, a)) ?? null,
    set: (s, a, v) => void m.set(key(s, a), v),
    dump: () => Object.fromEntries(m),
  };
}
