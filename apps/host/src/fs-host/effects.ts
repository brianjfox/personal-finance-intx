// File-backed `EffectLedger`: the exactly-once substrate for action
// effects. Deliberately NOT the run event log (the contract in
// `@intx/workflow`'s env.ts: recording an effect must not enter the
// run-log commit chain, and must be durable on return so a dropped
// run-log buffer never takes the ledger with it).
//
// One file per effect key under `<dataDir>/effects/<sha256(key)>.json`,
// written atomically. `record` returns only after fsync + rename.

import fs from "node:fs";
import path from "node:path";

import type { EffectLedger } from "@intx/workflow";

import { fileExists, sha256Hex, writeFileAtomic, type HostPaths } from "./paths";

export interface FsEffectLedger extends EffectLedger {
  /** Every recorded effect key, for tests and the audit view. */
  keys(): string[];
}

type Record_ = { effectKey: string; output: unknown; recordedAt: string };

export function createFsEffectLedger(
  paths: HostPaths,
  clock: () => Date = () => new Date(),
): FsEffectLedger {
  function fileFor(effectKey: string): string {
    return path.join(paths.effectsDir, `${sha256Hex(effectKey)}.json`);
  }
  return {
    async lookup(effectKey) {
      const file = fileFor(effectKey);
      if (!fileExists(file)) return undefined;
      const rec = JSON.parse(fs.readFileSync(file, "utf8")) as Record_;
      if (rec.effectKey !== effectKey) {
        throw new Error(
          `effect ledger hash collision or corruption for key ${effectKey}`,
        );
      }
      return { output: rec.output };
    },
    async record(effectKey, output) {
      const rec: Record_ = {
        effectKey,
        output,
        recordedAt: clock().toISOString(),
      };
      writeFileAtomic(fileFor(effectKey), JSON.stringify(rec));
    },
    keys() {
      if (!fileExists(paths.effectsDir)) return [];
      return fs
        .readdirSync(paths.effectsDir)
        .filter((f) => f.endsWith(".json"))
        .map(
          (f) =>
            (
              JSON.parse(
                fs.readFileSync(path.join(paths.effectsDir, f), "utf8"),
              ) as Record_
            ).effectKey,
        )
        .sort();
    },
  };
}
