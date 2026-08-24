// Shared fixture for the Phase 3 tests: the slide-19 household -- a
// checking account with 2027 payroll, a savings reserve, and a rental
// property titled in a trust; a 2027 tax profile; an estate plan with
// one honest gap (an unlinked will). Figures match the hand-computed
// scenario in packages/actions/test/projections.test.ts.

import fs from "node:fs";
import path from "node:path";

import type { SnapshotAccount } from "@fin/contracts";
import { fixtureAdapter, type InstitutionAdapter } from "@fin/institutions";

export const RENTAL = "acct.prop.rental";

export function writePhase3Config(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "tax-profile.json"),
    JSON.stringify({
      tax_year: 2027,
      ordinary_rate: "0.30",
      ltcg_rate: "0.15",
      prior_year_tax: "20000",
      prior_year_agi_over_150k: true,
      withholding_annual: "0",
      reserve_account: "acct.bank.savings",
    }),
  );
  fs.writeFileSync(
    path.join(dataDir, "estate.json"),
    JSON.stringify({
      entities: [
        { entity_id: "ent.person", kind: "person", name: "Fixture Person" },
        { entity_id: "ent.trust", kind: "trust", name: "Fixture Trust" },
      ],
      plan: {
        titling: [
          { account_id: "acct.bank.checking", owner: "ent.person" },
          { account_id: "acct.bank.savings", owner: "ent.person" },
          { account_id: RENTAL, owner: "ent.trust", in_trust: "ent.trust" },
        ],
        documents: [{ kind: "will", description: "Pour-over will" }],
        executors: ["Fixture Executor"],
        digital_access: "fixture safe",
      },
      observed: {
        titling: [
          { account_id: "acct.bank.checking", owner: "ent.person", verified_at: "2026-07-01" },
          { account_id: "acct.bank.savings", owner: "ent.person", verified_at: "2026-07-01" },
          { account_id: RENTAL, owner: "ent.trust", in_trust: "ent.trust", verified_at: "2026-06-15" },
        ],
      },
    }),
  );
}

export function phase3Adapters(now: Date): InstitutionAdapter[] {
  const asOf = now.toISOString();
  const bank: SnapshotAccount[] = [
    {
      account_id: "acct.bank.checking",
      name: "Checking",
      type: "checking",
      currency: "USD",
      as_of: asOf,
      balances: [{ balance_type: "total", amount: "12000" }],
      transactions: [1, 2, 3, 4, 5].map((m) => ({
        txn_id: `pay-27-${String(m)}`,
        posted_at: `2027-0${String(m)}-15T00:00:00.000Z`,
        amount: "8000",
        type: "credit" as const,
        description: "PAYROLL",
        raw_category: "Income",
      })),
    },
    {
      account_id: "acct.bank.savings",
      name: "Savings",
      type: "savings",
      currency: "USD",
      as_of: asOf,
      balances: [{ balance_type: "total", amount: "25000" }],
      transactions: [],
    },
  ];
  const property: SnapshotAccount[] = [
    {
      account_id: RENTAL,
      name: "Rental property",
      type: "other",
      currency: "USD",
      as_of: asOf,
      balances: [{ balance_type: "total", amount: "480000.00" }],
      transactions: [],
    },
  ];
  return [fixtureAdapter("inst.bank", { accounts: bank }), fixtureAdapter("inst.prop", { accounts: property })];
}
