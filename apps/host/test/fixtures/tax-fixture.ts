// Shared fixture for the Phase 2 host tests: one bank, a year's income,
// a funded reserve, and the operator's tax profile. Figures chosen so
// the Q3 installment is 6,000.00 (min leg = 75% of the 8,000 safe
// harbour; payments zero) against a 9,000 reserve.

import fs from "node:fs";
import path from "node:path";

import type { SnapshotAccount } from "@fin/contracts";

export function taxProfileJson(): string {
  return JSON.stringify(
    {
      tax_year: 2026,
      ordinary_rate: "0.30",
      ltcg_rate: "0.15",
      prior_year_tax: "8000",
      prior_year_agi_over_150k: false,
      withholding_annual: "0",
      reserve_account: "acct.bank.savings",
    },
    null,
    2,
  );
}

export function writeTaxProfile(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "tax-profile.json"), taxProfileJson());
}

export function taxAccounts(now: Date): SnapshotAccount[] {
  const asOf = now.toISOString();
  return [
    {
      account_id: "acct.bank.checking",
      name: "Checking",
      type: "checking",
      currency: "USD",
      as_of: asOf,
      balances: [{ balance_type: "total", amount: "12000" }],
      transactions: [
        { txn_id: "pay-1", posted_at: "2026-01-15T00:00:00.000Z", amount: "50000", type: "income", description: "CONSULTING INCOME" },
      ],
    },
    {
      account_id: "acct.bank.savings",
      name: "Tax Reserve",
      type: "savings",
      currency: "USD",
      as_of: asOf,
      balances: [{ balance_type: "total", amount: "9000" }],
      transactions: [],
    },
  ];
}
