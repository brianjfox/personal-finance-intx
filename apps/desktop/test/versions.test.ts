// "Check for Updates…" compares the newest published tag with the version
// the app was built as (tauri.conf.json).

import { describe, expect, test } from "bun:test";

import { compareVersions } from "../src/api";

describe("compareVersions", () => {
  test("numeric triples, with or without the v", () => {
    expect(compareVersions("0.5.0", "0.4.4")).toBeGreaterThan(0);
    expect(compareVersions("v0.5.0", "0.5.0")).toBe(0);
    expect(compareVersions("0.5.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });
  test("a pre-release sorts before its release", () => {
    expect(compareVersions("0.6.0-rc.1", "0.6.0")).toBeLessThan(0);
    expect(compareVersions("0.6.0", "0.6.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("0.6.0-rc.1", "0.5.0")).toBeGreaterThan(0);
  });
});
