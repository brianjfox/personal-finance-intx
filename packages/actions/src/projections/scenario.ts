// The scenario engine (Phase 3): the deterministic half of the slide-19
// question -- "If I sell the rental next spring, what does that do to
// the Q2 estimate and the trust schedule?"
//
// `sell_asset` computes, from ledger facts and the operator's tax
// profile and estate registry:
//   - the gain split: depreciation recapture (taxed at min(ordinary,
//     25%)) and the remaining long-term gain (taxed at the LTCG rate);
//   - the estimated-tax impact on the quarter the sale date falls in:
//     that quarter's installment recomputed with the sale's gains added
//     to the year's figures (the same math the Tax Engine runs);
//   - the trust-schedule impact from the OBSERVED titling facts, with
//     the slide-18 action list when the asset sits in a trust.
//
// Every figure carries the fact ids it came from; a missing basis is a
// caveat and a null tax impact, never a guessed zero (deck slide 10,
// error 4 -- the same rule as the Tax Engine's lots).

import {
  decimal,
  type BalancePayload,
  type EstateFile,
  type LotPayload,
  type ScenarioRequest,
  type ScenarioResult,
  type ScenarioTaxImpact,
  type TaxProfile,
  type TitlingPayload,
  type TransactionPayload,
} from "@fin/contracts";
import type { Ledger } from "@fin/ledger";

import {
  annualizedTax,
  ordinaryIncome,
  paymentsCumulative,
  quarterSpec,
  realizedGains,
  requiredCumulative,
  safeHarborCap,
  type DatedLot,
  type DatedTransaction,
} from "../tax/math";

/** The recapture rate cap: unrecaptured 1250 gain tops out at 25%. */
const RECAPTURE_CAP = "0.25";

export interface ScenarioContext {
  ledger: Ledger;
  taxProfile: TaxProfile | null;
  estateFile: EstateFile | null;
  now: Date;
}

export function runScenario(ctx: ScenarioContext, req: ScenarioRequest): ScenarioResult {
  const asOf = ctx.now.toISOString();
  const { ledger } = ctx;
  const evidence: string[] = [];
  const caveats: string[] = [];

  // The asset's current value: its total balance (a property's appraised
  // value; a brokerage account's stated total).
  const balanceFact = ledger.asOf({ kind: "balance", subject: req.subject, key: "total" })[0] ?? null;
  if (balanceFact !== null) evidence.push(balanceFact.id);
  const currentValue = balanceFact === null ? null : (balanceFact.payload as BalancePayload).amount;
  const salePrice = req.sale_price ?? currentValue;
  if (salePrice == null) {
    throw new Error(`scenario: no sale_price supplied and no ledger balance for ${req.subject}`);
  }

  // Basis: supplied, or the sum of the subject's lot facts when they exist.
  let basis = req.cost_basis ?? null;
  if (basis == null) {
    const lots = ledger.asOf({ kind: "lot", subject: req.subject });
    if (lots.length > 0 && lots.every((l) => (l.payload as LotPayload).cost_basis !== null)) {
      basis = decimal.sum(lots.map((l) => (l.payload as LotPayload).cost_basis as string));
      evidence.push(...lots.map((l) => l.id));
    }
  }

  // --- tax impact -------------------------------------------------------
  let tax: ScenarioTaxImpact | null = null;
  if (ctx.taxProfile === null) {
    caveats.push("no tax profile configured; tax impact not computed");
  } else if (basis == null) {
    caveats.push(`no cost basis supplied or on record for ${req.subject}; tax impact not computed, never guessed`);
  } else {
    const profile = ctx.taxProfile;
    const taxYear = Number(req.sale_date.slice(0, 4));
    if (taxYear !== profile.tax_year) {
      caveats.push(`sale falls in ${String(taxYear)}; the ${String(profile.tax_year)} profile's rates and prior-year figures are applied as an approximation`);
    }
    const totalGain = decimal.sub(salePrice, basis);
    if (decimal.cmp(totalGain, "0") < 0) caveats.push("sale at a loss; loss offsets are not modelled (conservative-high)");
    const depreciation = req.depreciation_taken ?? "0";
    const recapture = decimal.cmp(totalGain, "0") <= 0 ? "0" : decimal.cmp(depreciation, totalGain) < 0 ? depreciation : totalGain;
    const ltcgGain = decimal.cmp(totalGain, "0") <= 0 ? "0" : decimal.sub(totalGain, recapture);
    const recaptureRate = decimal.cmp(profile.ordinary_rate, RECAPTURE_CAP) < 0 ? profile.ordinary_rate : RECAPTURE_CAP;
    const recaptureTax = decimal.round(decimal.mul(recapture, recaptureRate), 2);
    const ltcgTax = decimal.round(decimal.mul(ltcgGain, profile.ltcg_rate), 2);

    // Which installment the sale lands in: the first quarter whose period
    // end is on/after the sale date.
    const quarter = ([1, 2, 3, 4] as const).find((q) => quarterSpec(taxYear, q).periodEnd >= req.sale_date) ?? 4;
    const spec = quarterSpec(taxYear, quarter);

    // The quarter's installment, before and after, with the year's actual
    // ledger figures underneath -- the same reading the Tax Engine does.
    const txns: DatedTransaction[] = ledger
      .asOf({ kind: "transaction" })
      .map((f) => ({ factId: f.id, subject: f.subject, payload: f.payload as TransactionPayload }));
    const lots: DatedLot[] = ledger.asOf({ kind: "lot" }).map((f) => ({ factId: f.id, subject: f.subject, payload: f.payload as LotPayload }));
    const income = ordinaryIncome(txns, taxYear, spec.periodEnd);
    const gains = realizedGains(txns, lots, taxYear, spec.periodEnd);
    const payments = paymentsCumulative(profile, txns, spec, taxYear);
    const cap = safeHarborCap(profile);
    evidence.push(...income.factIds, ...gains.factIds, ...payments.factIds);

    const installment = (extraLt: string, extraRecapture: string): string => {
      // The gain rides INSIDE the annualized-vs-safe-harbour min, exactly
      // as the Tax Engine will read reality after the sale: LT gain in the
      // annualized tax, recapture annualized at its capped rate. When the
      // prior-year harbour is the smaller leg, a one-time gain leaves the
      // installment UNCHANGED -- the true answer is then "the harbour
      // covers the quarter; reserve total_tax for the filing true-up",
      // which the trust actions state.
      const annualized = annualizedTax(profile, income.total, gains.stTotal, decimal.add(gains.ltTotal, extraLt), spec.factor);
      const recaptureAnnualized = decimal.mul(decimal.mul(extraRecapture, recaptureRate), spec.factor);
      const required = requiredCumulative(spec, decimal.add(annualized, recaptureAnnualized), cap);
      const due = decimal.cmp(required, payments.total) > 0 ? decimal.sub(required, payments.total) : "0";
      return decimal.round(due, 2);
    };
    const before = installment("0", "0");
    const after = installment(ltcgGain, recapture);

    tax = {
      quarter,
      due: spec.due,
      ltcg_gain: decimal.round(ltcgGain, 2),
      ltcg_tax: ltcgTax,
      recapture: decimal.round(recapture, 2),
      recapture_tax: recaptureTax,
      total_tax: decimal.round(decimal.add(ltcgTax, recaptureTax), 2),
      installment_before: before,
      installment_after: after,
      installment_delta: decimal.round(decimal.sub(after, before), 2),
    };
    if (decimal.cmp(tax.installment_delta, "0") === 0 && decimal.cmp(tax.total_tax, "0") > 0) {
      caveats.push(
        `the prior-year safe harbour caps the Q${String(quarter)} installment, so it does not move; the sale's ${tax.total_tax} of tax lands at filing -- reserve it anyway`,
      );
    }
  }

  // --- trust schedule ---------------------------------------------------
  const titlingFact = ledger.asOf({ kind: "titling", subject: req.subject })[0] ?? null;
  const titling = titlingFact === null ? null : (titlingFact.payload as TitlingPayload);
  if (titlingFact !== null) evidence.push(titlingFact.id);
  const inTrust = titling?.in_trust != null;
  const trust = titling?.in_trust ?? null;
  const actions: string[] = [];
  if (titling === null) {
    caveats.push(`no observed titling on record for ${req.subject}; the trust impact reflects the estate plan only`);
  }
  const planTitling = ctx.estateFile?.plan.titling.find((t) => t.account_id === req.subject) ?? null;
  if (inTrust && trust !== null) {
    // Slide 18: what the registry and plan must do when the asset goes.
    actions.push(`remove ${req.subject} from the ${trust} trust schedule`);
    actions.push("review the will/trust clauses that reference the asset");
    actions.push("retire the entity and archive the title chain and closing file in the vault");
  } else if (planTitling?.in_trust != null) {
    actions.push(`the plan expects ${req.subject} in ${planTitling.in_trust} but observed titling disagrees -- resolve before selling`);
  }
  if (tax !== null && decimal.cmp(tax.total_tax, "0") > 0) {
    actions.push(`reserve ${tax.total_tax} for the Q${String(tax.quarter)} estimate before the proceeds are deployed`);
  }

  return {
    kind: "sell_asset",
    as_of: asOf,
    subject: req.subject,
    sale_date: req.sale_date,
    sale_price: decimal.round(salePrice, 2),
    cost_basis: basis === null ? null : decimal.round(basis, 2),
    tax,
    trust: { in_trust: inTrust, trust, actions },
    evidence: [...new Set(evidence)],
    caveats,
  };
}
