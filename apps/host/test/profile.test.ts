// The household profile: saved from the GUI, redacted everywhere else.
// The tax id round-trips through storage but never appears in what the
// IPC surface or the agents' household_profile tool returns.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { householdProfileTool } from "@fin/tools";

import { createApp } from "../src/app";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-prof-"));

describe("household profile", () => {
  test("save -> redacted get; empty ssn keeps the stored one; clear_ssn removes it", () => {
    const app = createApp({ dataDir: tmp() });
    try {
      expect(app.getProfile()).toEqual({ configured: false });

      app.saveProfile({
        person: { legal_name: "Brian J. Fox", date_of_birth: "1959-12-21", ssn: "123-45-6789", citizenship: "US", country_of_residence: "US", state_or_province: "CA", marital_status: "married" },
        spouse: { legal_name: "Spouse Example" },
        children: [{ legal_name: "Child One", relationship: "daughter" }],
        others: [{ legal_name: "Old Friend", relationship: "friend" }],
      });
      const got = app.getProfile();
      expect(got.configured).toBe(true);
      if (!got.configured) throw new Error("unreachable");
      expect(got.person.ssn_last4).toBe("6789");
      expect(JSON.stringify(got)).not.toContain("123-45");
      expect((got.person as Record<string, unknown>)["ssn"]).toBeUndefined();
      expect(got.spouse?.legal_name).toBe("Spouse Example");
      expect(got.children).toHaveLength(1);

      // A save with no ssn typed keeps the stored one.
      app.saveProfile({ person: { legal_name: "Brian J. Fox" }, spouse: null, children: [], others: [] });
      const kept = app.getProfile();
      if (!kept.configured) throw new Error("unreachable");
      expect(kept.person.ssn_last4).toBe("6789");
      expect(kept.spouse ?? null).toBeNull();

      // clear_ssn actually removes it.
      app.saveProfile({ person: { legal_name: "Brian J. Fox" }, children: [], others: [], clear_ssn: true });
      const cleared = app.getProfile();
      if (!cleared.configured) throw new Error("unreachable");
      expect(cleared.person.ssn_last4).toBeNull();
    } finally {
      app.close();
    }
  });

  test("the household_profile tool redacts the tax id and says when nothing is collected", async () => {
    const evidence: unknown[] = [];
    const fin = {
      profile: () => ({
        person: { legal_name: "Brian J. Fox", ssn: "123-45-6789", marital_status: "married" as const },
        spouse: { legal_name: "Spouse Example" },
        children: [],
        others: [],
      }),
      clock: () => new Date(),
      evidence: (e: unknown) => evidence.push(e),
    } as never;
    const r = await householdProfileTool.handler({}, fin);
    const text = JSON.stringify(r.result);
    expect(r.result["configured"]).toBe(true);
    expect(text).not.toContain("123-45");
    expect(text).toContain("6789"); // last four only
    expect(text).toContain("Spouse Example");

    const empty = await householdProfileTool.handler({}, { profile: () => null } as never);
    expect(empty.result["configured"]).toBe(false);
    expect(JSON.stringify(empty.result)).toContain("Profile page");
  });
});
