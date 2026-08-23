// File-backed `BlobSubstrate`. Small outputs ride inline in the ref
// (`inline:<json>`), exactly as the runLocal substrate does; larger ones
// are content-addressed under `<dataDir>/blobs/<sha256>.json` and the
// ref is `blob:sha256:<hex>`. `ephemeral: false` -- a resumed run finds
// the refs its previous process minted.

import fs from "node:fs";
import path from "node:path";

import type { BlobSubstrate } from "@intx/workflow";

import { fileExists, sha256Hex, writeFileAtomic, type HostPaths } from "./paths";

const ONE_MIB = 1024 * 1024;

export interface FsBlobOptions {
  inlineMaxBytes?: number;
}

export function createFsBlobSubstrate(
  paths: HostPaths,
  opts: FsBlobOptions = {},
): BlobSubstrate {
  const inlineMax = opts.inlineMaxBytes ?? ONE_MIB;
  return {
    ephemeral: false,
    async recordOutput(stepId, attempt, value) {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) {
        throw new Error(
          `step ${stepId} attempt ${String(attempt)} produced an output the blob substrate cannot serialize (typeof ${typeof value})`,
        );
      }
      if (encoded.length <= inlineMax) {
        return { ref: `inline:${encoded}` };
      }
      const hex = sha256Hex(encoded);
      const file = path.join(paths.blobsDir, `${hex}.json`);
      if (!fileExists(file)) writeFileAtomic(file, encoded);
      return { ref: `blob:sha256:${hex}` };
    },
    async resolveRef(ref) {
      if (ref.startsWith("inline:")) {
        return JSON.parse(ref.slice("inline:".length));
      }
      if (ref.startsWith("blob:sha256:")) {
        const hex = ref.slice("blob:sha256:".length);
        if (!/^[0-9a-f]{64}$/.test(hex)) {
          throw new Error(`malformed blob ref ${ref}`);
        }
        const file = path.join(paths.blobsDir, `${hex}.json`);
        if (!fileExists(file)) throw new Error(`unknown blob ref ${ref}`);
        return JSON.parse(fs.readFileSync(file, "utf8"));
      }
      throw new Error(`unrecognized ref ${ref}`);
    },
  };
}
