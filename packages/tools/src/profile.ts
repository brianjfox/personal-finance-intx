// The shared `household_profile` tool: who the operator is, and the
// people an estate or tax plan must account for. Granted to every
// advisory agent that needs it (Strategist, Estate Planner) through the
// capability matrix like any other tool. The tax id NEVER reaches a
// model: the profile is redacted before it leaves the handler, with an
// explicit marker so the model knows the id exists but is withheld.

import { redactProfile } from "@fin/contracts";

import { OBJECT_SCHEMA, type FinTool } from "./bundle";

export const PROFILE_TOOL_NAME = "household_profile";

export const householdProfileTool: FinTool = {
  definition: {
    name: PROFILE_TOOL_NAME,
    description:
      "The household profile: the operator's legal name, date of birth, citizenship, country/state of residence, marital status, spouse, children, and other people who should appear in a will. The tax id is stored but withheld from you by design (only its last four digits appear). Returns null fields for anything not yet collected -- if what you need is missing, ask the operator to fill it in on the People page.",
    inputSchema: OBJECT_SCHEMA({}),
  },
  handler: async (_args, fin) => {
    const p = fin.profile();
    if (p === null) {
      return { result: { configured: false, note: "no profile yet -- ask the operator to fill in the People page" }, fact_ids: [] };
    }
    const redacted = redactProfile(p);
    return { result: { configured: true, ...redacted }, fact_ids: [] };
  },
};
