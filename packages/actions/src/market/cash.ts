// Cash on hand for the drift report (issue #55): the household's cash is
// mostly account BALANCES -- checking and savings totals, the `cash`
// balance of a brokerage or exchange account -- not `cash`-class
// positions, which is all computeDrift used to see. Open accounts only
// (#47). A balance in another currency is never face-value-summed or
// silently dropped: it is reported as excluded, and the page says so.

import { LIABILITY_ACCOUNT_TYPES, POSITION_ACCOUNT_TYPES, decimal, type AccountType } from "@fin/contracts";
import { views, type Ledger } from "@fin/ledger";

/** Accounts whose whole balance IS cash. */
export const CASH_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set<AccountType>(["checking", "savings", "money_market"]);

export interface CashOnHand {
  /** Cash in `currency`, summed exactly. */
  amount: string;
  /** Cash held in other currencies, per currency, left out of `amount`. */
  excluded: { currency: string; amount: string }[];
  /** Balance fact ids behind `amount` and `excluded`. */
  evidence: string[];
}

export function cashOnHand(ledger: Ledger, currency = "USD"): CashOnHand {
  const accounts = views.accounts(ledger).filter((a) => a.closed_at === null && !LIABILITY_ACCOUNT_TYPES.has(a.type));
  const balances = views.balances(ledger);
  let amount = "0";
  const excluded = new Map<string, string>();
  const evidence: string[] = [];
  for (const a of accounts) {
    const mine = balances.filter((b) => b.account_id === a.account_id);
    let b: (typeof mine)[number] | undefined;
    if (CASH_ACCOUNT_TYPES.has(a.type)) b = mine.find((x) => x.balance_type === "total") ?? mine.find((x) => x.balance_type === "available");
    else if (POSITION_ACCOUNT_TYPES.has(a.type)) b = mine.find((x) => x.balance_type === "cash");
    if (b === undefined || decimal.isZero(b.amount)) continue;
    const ccy = b.currency || a.currency;
    evidence.push(b.fact_id);
    if (ccy === currency) amount = decimal.add(amount, b.amount);
    else excluded.set(ccy, decimal.add(excluded.get(ccy) ?? "0", b.amount));
  }
  return {
    amount: decimal.round(amount, 2),
    excluded: [...excluded.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([c, v]) => ({ currency: c, amount: decimal.round(v, 2) })),
    evidence,
  };
}
