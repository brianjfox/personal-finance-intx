// Issue #38: the auditor's intake must survive what real models emit --
// prose and code fences around the JSON, and gpt-oss "harmony" channel
// scaffolding leaked by local servers.

import { describe, expect, test } from "bun:test";

import { parseDraft } from "../src/index";

const DRAFT = {
  from: "market_manager",
  subject: "acct.kraken.spot",
  candidate_index: 0,
  action: { verb: "SELL", instrument: "ETH", quantity: "10", amount: { amount: "35000", currency: "USD" }, detail: "trim crypto toward target" },
  thesis: "crypto is 45pp over its 30% target",
  evidence: ["fact_01HXAMPLEXXXXXXXXXXXXXXXXX"],
  confidence: 0.8,
  requires: [],
  expires: "2026-09-08T00:00:00.000Z",
  as_of: "2026-09-01T00:00:00.000Z",
};

describe("parseDraft", () => {
  test("plain JSON, prose-wrapped, and code-fenced replies parse", () => {
    const j = JSON.stringify(DRAFT);
    expect(parseDraft(j).thesis).toBe(DRAFT.thesis);
    expect(parseDraft(`Here is the draft you asked for:\n\`\`\`json\n${j}\n\`\`\`\nLet me know.`).action.instrument).toBe("ETH");
  });

  test("harmony channel scaffolding is healed before the hunt for the object", () => {
    const j = JSON.stringify(DRAFT);
    const leaked = `<|channel|>analysis<|message|>The user wants a rebalance. I should trim ETH.<|end|><|start|>assistant<|channel|>final<|message|>${j}<|end|>`;
    expect(parseDraft(leaked).action.verb).toBe("SELL");
    // Analysis-channel braces must not win over the final channel.
    const trap = `<|channel|>analysis<|message|>{"not":"the draft"}<|end|><|channel|>final<|message|>${j}<|end|>`;
    expect(parseDraft(trap).candidate_index).toBe(0);
  });

  test("a reply with no JSON at all refuses with guidance, not a stack of confusion", () => {
    expect(() => parseDraft("I am unable to produce a rebalancing draft right now.")).toThrow(/no JSON object.*stronger provider/s);
  });
});
