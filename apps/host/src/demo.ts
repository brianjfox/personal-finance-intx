// Demo seed: two FICTIONAL institutions as JSON drop-folder inboxes, so the
// vertical slice (fetch -> normalise -> reconcile -> commit -> display)
// can be seen end to end with no real account. `seedDemo(dataDir, night)`
// writes the inbox files for night 1 (clean) or night 2 (with an injected
// duplicate transfer and a corrected 1099). Nothing here is real money.

import fs from "node:fs";
import path from "node:path";

import { defaultInbox } from "@fin/institutions";

const ASOF1 = "2026-08-22T00:00:00.000Z";
const ASOF2 = "2026-08-23T00:00:00.000Z";

export function seedDemo(dataDir: string, night: 1 | 2 = 1): string[] {
  const written: string[] = [];
  const registry = path.join(dataDir, "institutions.json");
  if (!fs.existsSync(registry)) {
    fs.writeFileSync(
      registry,
      JSON.stringify(
        {
          institutions: [
            { institution_id: "inst.demobank", name: "Demo Bank (fictional)", adapter: "jsondrop" },
            { institution_id: "inst.demobroker", name: "Demo Brokerage (fictional)", adapter: "jsondrop" },
          ],
        },
        null,
        2,
      ),
    );
    written.push(registry);
  }
  const asOf = night === 1 ? ASOF1 : ASOF2;
  const day = night === 1 ? "2026-08-22" : "2026-08-23";

  const bankTx = [
    { txn_id: "dbk-1001", posted_at: "2026-08-15T00:00:00.000Z", amount: "6250.00", type: "credit", description: "PAYROLL ACME CORP", raw_category: "Income" },
    { txn_id: "dbk-1002", posted_at: "2026-08-18T00:00:00.000Z", amount: "-2400.00", type: "debit", description: "MORTGAGE PAYMENT", raw_category: "Housing" },
    { txn_id: "dbk-1003", posted_at: "2026-08-20T00:00:00.000Z", amount: "-5000.00", type: "debit", description: "ONLINE TRANSFER TO BROKERAGE", raw_category: "Transfer" },
    { txn_id: "dbk-1004", posted_at: "2026-08-21T00:00:00.000Z", amount: "-84.12", type: "debit", description: "GROCERY MART", raw_category: "Food" },
  ];
  if (night === 2) {
    // The aggregator books the transfer twice under a new id.
    bankTx.push({ txn_id: "dbk-1003-dup", posted_at: "2026-08-20T00:00:00.000Z", amount: "-5000.00", type: "debit", description: "ONLINE TRANSFER TO BROKERAGE", raw_category: "Transfer" });
    bankTx.push({ txn_id: "dbk-1005", posted_at: "2026-08-22T00:00:00.000Z", amount: "-39.99", type: "debit", description: "STREAMING SERVICE", raw_category: "Entertainment" });
  }
  const bank = {
    accounts: [
      {
        account_id: "acct.demobank.checking",
        name: "Everyday Checking",
        type: "checking",
        currency: "USD",
        masked_number: "••••4411",
        as_of: asOf,
        balances: [{ balance_type: "total", amount: night === 1 ? "8765.88" : "8725.89" }, { balance_type: "available", amount: night === 1 ? "8765.88" : "8725.89" }],
        transactions: bankTx,
      },
      {
        account_id: "acct.demobank.savings",
        name: "Rainy Day Savings",
        type: "savings",
        currency: "USD",
        masked_number: "••••4429",
        // Night 2: the savings feed stopped updating (as-of frozen at the 18th).
        as_of: night === 1 ? ASOF1 : "2026-08-18T00:00:00.000Z",
        balances: [{ balance_type: "total", amount: "25000.00" }],
        transactions: [],
      },
      {
        account_id: "acct.demobank.visa",
        name: "Rewards Visa",
        type: "credit_card",
        currency: "USD",
        masked_number: "••••9012",
        as_of: asOf,
        balances: [{ balance_type: "owed", amount: night === 1 ? "1320.45" : "1402.77" }, { balance_type: "credit_limit", amount: "15000" }],
        transactions: [],
      },
    ],
  };

  const broker = {
    accounts: [
      {
        account_id: "acct.demobroker.taxable",
        name: "Taxable Brokerage",
        type: "brokerage",
        currency: "USD",
        masked_number: "••••7788",
        as_of: asOf,
        balances: [{ balance_type: "total", amount: night === 1 ? "61212.40" : "61480.10" }, { balance_type: "cash", amount: "5212.40" }],
        positions: [
          { instrument: { symbol: "VTI", name: "Total Stock Market ETF", asset_class: "etf" }, quantity: "120", price: night === 1 ? "249.10" : "250.35", market_value: night === 1 ? "29892.00" : "30042.00", cost_basis: "24300.00", lots: [{ lot_id: "vti-2021", quantity: "80", acquired_at: "2021-03-10", cost_basis: "15200.00" }, { lot_id: "vti-2023", quantity: "40", acquired_at: "2023-06-01", cost_basis: "9100.00" }] },
          { instrument: { symbol: "BND", name: "Total Bond Market ETF", asset_class: "etf" }, quantity: "200", price: night === 1 ? "72.54" : "72.70", market_value: night === 1 ? "14508.00" : "14540.00", cost_basis: "15100.00" },
          { instrument: { symbol: "AAPL", name: "Apple Inc", asset_class: "equity" }, quantity: "50", price: night === 1 ? "232.00" : "233.72", market_value: night === 1 ? "11600.00" : "11686.00", cost_basis: null, lots: [{ lot_id: "aapl-xfer", quantity: "50", acquired_at: "2019-09-10", cost_basis: null, transferred_in: true }] },
        ],
        transactions: [
          { txn_id: "dbr-501", posted_at: "2026-08-21T00:00:00.000Z", amount: "5000.00", type: "income", description: "FUNDS RECEIVED", raw_category: "Income" },
          { txn_id: "dbr-502", posted_at: "2026-08-19T00:00:00.000Z", amount: "41.50", type: "dividend", description: "BND DIVIDEND", instrument: { symbol: "BND", asset_class: "etf" }, raw_category: "Dividend" },
        ],
        tax_documents:
          night === 1
            ? [{ tax_year: 2025, form: "1099-DIV", corrected: false, issued_at: "2026-02-01", totals: { "1a": "1312.40", "1b": "1290.00" } }]
            : [{ tax_year: 2025, form: "1099-DIV", corrected: true, issued_at: "2026-03-15", totals: { "1a": "1538.90", "1b": "1290.00" } }],
      },
      {
        account_id: "acct.demobroker.ira",
        name: "Rollover IRA",
        type: "ira",
        currency: "USD",
        masked_number: "••••7801",
        as_of: asOf,
        balances: [{ balance_type: "total", amount: night === 1 ? "88400.00" : "88910.00" }, { balance_type: "cash", amount: "400.00" }],
        positions: [{ instrument: { symbol: "VT", name: "Total World Stock ETF", asset_class: "etf" }, quantity: "700", price: night === 1 ? "125.714285" : "126.442857", market_value: night === 1 ? "88000.00" : "88510.00", cost_basis: "61000.00" }],
        transactions: [],
      },
    ],
  };

  for (const [inst, body] of [["inst.demobank", bank], ["inst.demobroker", broker]] as const) {
    const inbox = defaultInbox(dataDir, inst);
    fs.mkdirSync(inbox, { recursive: true });
    const file = path.join(inbox, `${day}.json`);
    fs.writeFileSync(file, JSON.stringify({ institution_id: inst, ...body }, null, 2));
    written.push(file);
  }
  return written;
}
