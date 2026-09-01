// Prompt rule 4's decline, as the Auditor's intake reads it (issue #45):
// the bare word, the word with a reason, and the things that are NOT a
// decline (a draft with a preamble that happens to start with "Nothing").

import { describe, expect, test } from "bun:test";

import { declinedReason, isDeclinedReply } from "../src/market/handlers";

describe("declinedReason", () => {
  test("the bare word, any case and punctuation, is a decline with no reason", () => {
    for (const r of ["NOTHING", "nothing", "NOTHING.", "Nothing!", "  NOTHING\n"]) {
      expect(declinedReason(r)).toBe("");
      expect(isDeclinedReply(r)).toBe(true);
    }
  });
  test("NOTHING plus a sentence carries the sentence, whitespace collapsed", () => {
    expect(declinedReason("NOTHING: the only candidate sells 70% of the bitcoin at once.")).toBe("the only candidate sells 70% of the bitcoin at once.");
    expect(declinedReason("NOTHING -- unknown tax lots\n  on the sole candidate")).toBe("unknown tax lots on the sole candidate");
    expect(declinedReason("Nothing. Every class is inside the band.")).toBe("Every class is inside the band.");
  });
  test("a draft is never a decline, even with a preamble starting with the word", () => {
    expect(declinedReason('{"kind":"proposal"}')).toBeNull();
    expect(declinedReason('Nothing else applies; here is the draft: {"kind":"proposal"}')).toBeNull();
    expect(declinedReason("NOTHINGNESS is not a reply")).toBeNull();
    expect(isDeclinedReply("I propose nothing")).toBe(false);
  });
  test("gpt-oss harmony scaffolding is healed before the check", () => {
    expect(declinedReason("<|channel|>analysis<|message|>thinking...<|end|><|start|>assistant<|channel|>final<|message|>NOTHING: too big")).toBe("too big");
  });
});
