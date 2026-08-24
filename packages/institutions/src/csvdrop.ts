// CSV export adapter.
//
// Brokerages and banks export positions and transactions as CSV. This
// adapter maps such files onto the snapshot contract through a small
// column map, so a real institution can be connected in Phase 1 with no
// API and no credential. Files live in `<dir>/`; the adapter reads the
// configured filenames and returns every file it read as raw evidence.

import fs from "node:fs";
import path from "node:path";

import type { AccountType, AssetClass, TransactionType } from "@fin/contracts";

import { validateDraftSnapshot, type FetchOutput, type InstitutionAdapter, type RawDocument } from "./adapter";
import { parseCsv, parseDate, parseMoney } from "./csv";

export const CSVDROP_VIA = "adapter.csvdrop@1";

export interface CsvPositionsMap {
  file: string;
  columns: {
    symbol: string;
    quantity: string;
    name?: string;
    price?: string;
    market_value?: string;
    cost_basis?: string;
    asset_class?: string;
  };
  default_asset_class?: AssetClass;
  /** Symbol(s) that represent the cash/sweep line, reported as a `cash` balance instead of a position. */
  cash_symbols?: string[];
}

export interface CsvTransactionsMap {
  file: string;
  columns: {
    date: string;
    amount: string;
    description: string;
    txn_id?: string;
    type?: string;
    symbol?: string;
    quantity?: string;
    category?: string;
  };
  /** Map the institution's type/category strings to canonical transaction types. */
  type_map?: Record<string, TransactionType>;
}

export interface CsvBalanceMap {
  file: string;
  /** Column holding the amount; the first data row is used unless `match` is given. */
  amount: string;
  match?: { column: string; equals: string };
  balance_type?: "total" | "available" | "cash" | "owed";
}

export interface CsvAccountConfig {
  account_id: string;
  name: string;
  type: AccountType;
  currency: string;
  masked_number?: string | null;
  /** As-of for the export. Default: the newest mtime among the account's files. */
  as_of?: string;
  positions?: CsvPositionsMap;
  transactions?: CsvTransactionsMap;
  balances?: CsvBalanceMap[];
  /** When true and no total balance file is given, total = sum of position market values (+ cash). */
  total_from_positions?: boolean;
}

export interface CsvDropOptions {
  institution_id: string;
  dir: string;
  accounts: CsvAccountConfig[];
}

export function csvDropAdapter(opts: CsvDropOptions): InstitutionAdapter {
  return {
    institution_id: opts.institution_id,
    via: CSVDROP_VIA,
    async fetch(ctx): Promise<FetchOutput> {
      const raw: RawDocument[] = [];
      const seen = new Set<string>();
      const readFile = (name: string, accountId: string): string => {
        const p = path.join(opts.dir, name);
        if (!fs.existsSync(p)) throw new Error(`csvdrop ${opts.institution_id}: missing ${p}`);
        const bytes = fs.readFileSync(p);
        if (!seen.has(p)) {
          seen.add(p);
          raw.push({ bytes: new Uint8Array(bytes), filename: name, mime: "text/csv", kind: "export", account_id: accountId });
        }
        return new TextDecoder().decode(bytes);
      };
      const mtimeOf = (name: string): number => fs.statSync(path.join(opts.dir, name)).mtimeMs;

      const accounts = opts.accounts.map((a) => {
        const files = [a.positions?.file, a.transactions?.file, ...(a.balances ?? []).map((b) => b.file)].filter(
          (f): f is string => f !== undefined,
        );
        const asOf = a.as_of ?? new Date(Math.max(0, ...files.map(mtimeOf))).toISOString();
        const positions: Array<Record<string, unknown>> = [];
        const balances: Array<{ balance_type: string; amount: string }> = [];
        let cashFromPositions: string | null = null;

        if (a.positions !== undefined) {
          const rows = parseCsv(readFile(a.positions.file, a.account_id));
          const c = a.positions.columns;
          for (const r of rows) {
            const symbol = (r[c.symbol] ?? "").trim();
            if (symbol === "") continue;
            const qty = parseMoney(r[c.quantity]);
            const mv = c.market_value !== undefined ? parseMoney(r[c.market_value]) : null;
            if ((a.positions.cash_symbols ?? []).includes(symbol)) {
              cashFromPositions = mv ?? qty;
              continue;
            }
            if (qty === null) continue;
            positions.push({
              instrument: {
                symbol,
                name: c.name !== undefined ? r[c.name] || null : null,
                asset_class:
                  (c.asset_class !== undefined ? normaliseAssetClass(r[c.asset_class]) : null) ??
                  a.positions.default_asset_class ??
                  "equity",
              },
              quantity: qty,
              price: c.price !== undefined ? parseMoney(r[c.price]) : null,
              market_value: mv,
              // A blank/"--" basis stays null. Never "0".
              cost_basis: c.cost_basis !== undefined ? parseMoney(r[c.cost_basis]) : null,
            });
          }
        }
        if (cashFromPositions !== null) balances.push({ balance_type: "cash", amount: cashFromPositions });

        for (const b of a.balances ?? []) {
          const rows = parseCsv(readFile(b.file, a.account_id));
          const row =
            b.match === undefined ? rows[0] : rows.find((r) => (r[b.match!.column] ?? "") === b.match!.equals);
          const amt = row === undefined ? null : parseMoney(row[b.amount]);
          if (amt !== null) balances.push({ balance_type: b.balance_type ?? "total", amount: amt });
        }
        if (!balances.some((b) => b.balance_type === "total") && a.total_from_positions === true) {
          let acc = 0n;
          const scale = 10n ** 10n;
          const toBig = (s: string): bigint => {
            const [w, f = ""] = s.replace("-", "").split(".");
            const v = BigInt(w ?? "0") * scale + BigInt((f + "0000000000").slice(0, 10));
            return s.startsWith("-") ? -v : v;
          };
          for (const p of positions) if (typeof p["market_value"] === "string") acc += toBig(p["market_value"]);
          if (cashFromPositions !== null) acc += toBig(cashFromPositions);
          const neg = acc < 0n;
          const abs = neg ? -acc : acc;
          const whole = abs / scale;
          const frac = (abs % scale).toString().padStart(10, "0").replace(/0+$/, "");
          balances.push({ balance_type: "total", amount: `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}` });
        }

        const transactions: Array<Record<string, unknown>> = [];
        if (a.transactions !== undefined) {
          const rows = parseCsv(readFile(a.transactions.file, a.account_id));
          const c = a.transactions.columns;
          rows.forEach((r, i) => {
            const posted = parseDate(r[c.date]);
            const amount = parseMoney(r[c.amount]);
            if (posted === null || amount === null) return;
            const rawType = c.type !== undefined ? (r[c.type] ?? "") : "";
            const rawCat = c.category !== undefined ? (r[c.category] ?? "") : "";
            const mapped =
              a.transactions!.type_map?.[rawType] ?? a.transactions!.type_map?.[rawCat] ?? inferType(rawType, amount);
            const symbol = c.symbol !== undefined ? (r[c.symbol] ?? "").trim() : "";
            transactions.push({
              txn_id:
                c.txn_id !== undefined && (r[c.txn_id] ?? "") !== ""
                  ? (r[c.txn_id] as string)
                  : `${posted.slice(0, 10)}:${amount}:${i}`,
              posted_at: posted,
              amount,
              type: mapped,
              description: r[c.description] ?? "",
              instrument: symbol === "" ? null : { symbol, asset_class: a.positions?.default_asset_class ?? "equity" },
              quantity: c.quantity !== undefined ? parseMoney(r[c.quantity]) : null,
              raw_category: rawCat !== "" ? rawCat : rawType !== "" ? rawType : null,
            });
          });
        }

        return {
          account_id: a.account_id,
          name: a.name,
          type: a.type,
          currency: a.currency,
          masked_number: a.masked_number ?? null,
          as_of: asOf,
          balances,
          positions,
          transactions,
        };
      });

      const snapshot = validateDraftSnapshot(
        { institution_id: opts.institution_id, fetched_at: ctx.now.toISOString(), via: CSVDROP_VIA, accounts },
        `csvdrop ${opts.institution_id}`,
      );
      return { raw, snapshot };
    },
  };
}

function normaliseAssetClass(s: string | undefined): AssetClass | null {
  const t = (s ?? "").toLowerCase();
  if (t === "") return null;
  if (t.includes("etf")) return "etf";
  if (t.includes("mutual") || t.includes("fund")) return "mutual_fund";
  if (t.includes("bond") || t.includes("fixed")) return "bond";
  if (t.includes("cash") || t.includes("money market")) return "cash";
  if (t.includes("crypto")) return "crypto";
  if (t.includes("option")) return "option";
  if (t.includes("equity") || t.includes("stock")) return "equity";
  return "other";
}

function inferType(raw: string, amount: string): TransactionType {
  const t = raw.toLowerCase();
  if (t.includes("dividend")) return "dividend";
  if (t.includes("interest")) return "interest";
  if (t.includes("fee")) return "fee";
  if (t.includes("buy") || t.includes("purchase")) return "buy";
  if (t.includes("sell") || t.includes("sale")) return "sell";
  if (t.includes("transfer") || t.includes("wire") || t.includes("ach")) {
    return amount.startsWith("-") ? "transfer_out" : "transfer_in";
  }
  if (t.includes("swap") || t.includes("convert")) return "swap";
  return amount.startsWith("-") ? "debit" : "credit";
}
