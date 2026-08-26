// The shared `save_draft` tool: a drafted document (sample will, memo
// for the accountant, letter of instruction) saved into the household's
// document vault, under the drafting agent's own name, so it shows up
// in the Documents panel and in the break-glass export. The disclaimer
// discipline lives in the agents' prompts; this tool just stores what
// was drafted, verbatim, content-addressed like every other document.

import { OBJECT_SCHEMA, type FinTool } from "./bundle";

export const DRAFT_TOOL_NAME = "save_draft";

export const saveDraftTool: FinTool = {
  definition: {
    name: DRAFT_TOOL_NAME,
    description:
      "Save a document you have drafted (sample will, memo, letter, outline) to the operator's document vault so it appears in their Documents panel. Pass the full markdown content INCLUDING the disclaimer header. Use a short, specific title (e.g. 'Sample will -- 2026-08-26').",
    inputSchema: OBJECT_SCHEMA({
      title: { type: "string", description: "short, specific title" },
      content: { type: "string", description: "the complete document, markdown, disclaimer included" },
    }),
  },
  handler: async (args, fin) => {
    const title = typeof args["title"] === "string" ? args["title"].trim() : "";
    const content = typeof args["content"] === "string" ? args["content"] : "";
    if (title === "" || content.trim() === "") {
      return { result: { saved: false, error: "save_draft needs both a title and the document content" }, fact_ids: [] };
    }
    const saved = fin.saveDocument({ title, content });
    return { result: { saved: true, ...saved }, fact_ids: [] };
  },
};
