// Fixture institutions shared by the host tests (same shapes as the demo seed).
import type { SnapshotAccount } from "@fin/contracts";

export interface DemoInstitution {
  id: string;
  snapshot: { accounts: SnapshotAccount[] };
}

export function demoAdapters(night: 1 | 2 | 3): DemoInstitution[] {
  const asOf = `2026-08-2${String(night + 1)}T00:00:00.000Z`;
  const bankTx: NonNullable<SnapshotAccount["transactions"]> = [
    { txn_id: "dbk-1001", posted_at: "2026-08-15T00:00:00.000Z", amount: "6250.00", type: "credit", description: "PAYROLL ACME CORP" },
    { txn_id: "dbk-1003", posted_at: "2026-08-20T00:00:00.000Z", amount: "-5000.00", type: "debit", description: "ONLINE TRANSFER TO BROKERAGE" },
  ];
  if (night === 2) bankTx.push({ txn_id: "dbk-1003-dup", posted_at: "2026-08-20T00:00:00.000Z", amount: "-5000.00", type: "debit", description: "ONLINE TRANSFER TO BROKERAGE" });
  return [
    {
      id: "inst.bank",
      snapshot: {
        accounts: [
          { account_id: "acct.bank.checking", name: "Checking", type: "checking", currency: "USD", as_of: asOf, balances: [{ balance_type: "total", amount: night === 1 ? "8765.88" : "8725.89" }], transactions: bankTx },
          { account_id: "acct.bank.visa", name: "Visa", type: "credit_card", currency: "USD", as_of: asOf, balances: [{ balance_type: "owed", amount: "1320.45" }], transactions: [] },
        ],
      },
    },
    {
      id: "inst.broker",
      snapshot: {
        accounts: [
          {
            account_id: "acct.broker.taxable",
            name: "Taxable",
            type: "brokerage",
            currency: "USD",
            as_of: asOf,
            balances: [{ balance_type: "total", amount: "35104.00" }, { balance_type: "cash", amount: "5212.00" }],
            positions: [{ instrument: { symbol: "VTI", asset_class: "etf" }, quantity: "120", price: "249.10", market_value: "29892.00", cost_basis: "24300.00" }],
            transactions: [{ txn_id: "dbr-501", posted_at: "2026-08-21T00:00:00.000Z", amount: "5000.00", type: "transfer_in", description: "FUNDS RECEIVED" }],
          },
        ],
      },
    },
  ];
}

/**
 * A clock pinned a few hours after the night's fixture as-of. The
 * fixtures carry absolute dates, so tests must not read the real clock:
 * the staleness detector would (correctly) start flagging the fixtures
 * a few days after they were written.
 */
export const demoClock = (night: 1 | 2 | 3) => (): Date => new Date(`2026-08-2${String(night + 1)}T06:00:00.000Z`);
