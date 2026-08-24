// The env key the @fin tool bundles require beyond BaseEnv.
//
// `defineTool({ requires: ["fin"] })` -- the agent runtime's validateEnv
// checks presence at instantiation. The host owns the lifetime; tools
// only read. `evidence` and `journal` are per-turn collectors the host
// resets before each send and reads after the reply: they are how a
// tool result's figures (with their fact ids) travel out of the
// conversation and onto the recorded ChatTurn, which is what makes the
// GUI's numbers clickable and the reply auditable.

import type { ChatEvidence, EstateFile, InvestmentPlan, TaxProfile } from "@fin/contracts";
import type { Ledger } from "@fin/ledger";

export interface FinToolEnv {
  ledger: Ledger;
  taxProfile: () => TaxProfile | null;
  estateFile: () => EstateFile | null;
  plan: () => InvestmentPlan | null;
  clock: () => Date;
  /** Record one tool result as turn evidence (figures + fact ids). */
  evidence: (e: ChatEvidence) => void;
  /** Record a journal entry id written during this turn. */
  journal: (id: string) => void;
}

/** The env shape the @fin bundles are constructed against. */
export interface FinAgentEnvExtras {
  fin: FinToolEnv;
}
