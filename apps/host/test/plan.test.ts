// Issue #31: the investment plan is written in the GUI, through the host.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { memorySecretStore } from "@fin/institutions";

import { createApp } from "../src/app";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-plan-"));

describe("savePlan", () => {
  test("a valid plan round-trips through plan.json and planStatus", () => {
    const dataDir = tmp();
    const app = createApp({ dataDir, connectors: { secrets: memorySecretStore() } });
    try {
      const saved = app.savePlan({
        band: "0.05",
        targets: [
          { asset_class: "etf", weight: "0.6" },
          { asset_class: "bond", weight: "0.4" },
        ],
        constraints: { do_not_sell: ["AAPL"], max_position_weight: "0.25" },
        notes: "boring on purpose",
      });
      expect(saved.targets).toHaveLength(2);
      expect(saved.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, "plan.json"), "utf8")).notes).toBe("boring on purpose");
      const status = app.planStatus();
      expect(status.plan?.band).toBe("0.05");
      expect(status.plan?.constraints.do_not_sell).toEqual(["AAPL"]);
    } finally {
      app.close();
    }
  });

  test("refusals are plain words: weights off 100%, duplicate classes, zero band, junk classes", () => {
    const app = createApp({ dataDir: tmp(), connectors: { secrets: memorySecretStore() } });
    try {
      const base = { band: "0.05", targets: [{ asset_class: "etf", weight: "0.6" }] };
      expect(() => app.savePlan(base)).toThrow(/add up to 100%.*60\.0%/);
      expect(() =>
        app.savePlan({ band: "0.05", targets: [{ asset_class: "etf", weight: "0.5" }, { asset_class: "etf", weight: "0.5" }] }),
      ).toThrow(/listed twice/);
      expect(() =>
        app.savePlan({ band: "0", targets: [{ asset_class: "etf", weight: "1" }] }),
      ).toThrow(/band must be above 0%/);
      expect(() =>
        app.savePlan({ band: "0.05", targets: [{ asset_class: "beanie_babies", weight: "1" }] }),
      ).toThrow(/investment plan/);
      expect(app.planStatus().plan).toBeNull(); // nothing was written
    } finally {
      app.close();
    }
  });
});
