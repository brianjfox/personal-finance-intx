// Agent drafts land in the vault as documents: the save_draft tool, the
// principal mapping, and the Documents-panel provenance (kind draft,
// source agent.<principal>, markdown mime).

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { saveDraftTool } from "@fin/tools";

import { createApp } from "../src/app";
import { saveDraftDocument } from "../src/fs-host/step-invoker";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fin-draft-"));

describe("agent drafts as documents", () => {
  test("saveDraftDocument stores markdown under the agent's principal; unknown agents are refused", () => {
    const app = createApp({ dataDir: tmp() });
    try {
      const clock = () => new Date("2026-08-26T12:00:00.000Z");
      const r = saveDraftDocument(app.vault, "estate-planner", "Sample will — 2026-08-26", "# Sample will\n\nThis sample will was written by a ML model...", clock);
      expect(r.filename).toBe("sample-will-2026-08-26-2026-08-26.md");
      const doc = app.ledger.listDocuments().find((d) => d.id === r.document_id)!;
      expect(doc).toMatchObject({ kind: "draft", mime: "text/markdown", source_id: "agent.estate_planner", ingested_by: "estate_planner" });
      const bytes = app.vault.read(doc.id, "operator");
      expect(new TextDecoder().decode(bytes)).toContain("written by a ML model");
      expect(() => saveDraftDocument(app.vault, "market-manager", "x", "y", clock)).toThrow(/may not save drafts/);
    } finally {
      app.close();
    }
  });

  test("the save_draft tool validates and passes through the env's saveDocument", async () => {
    const calls: Array<{ title: string; content: string }> = [];
    const fin = { saveDocument: (o: { title: string; content: string }) => { calls.push(o); return { document_id: "doc_1", filename: "f.md" }; } } as never;
    const ok = await saveDraftTool.handler({ title: "Sample will", content: "# will..." }, fin);
    expect(ok.result).toEqual({ saved: true, document_id: "doc_1", filename: "f.md" });
    expect(calls).toHaveLength(1);
    const bad = await saveDraftTool.handler({ title: "", content: "" }, fin);
    expect(bad.result["saved"]).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
