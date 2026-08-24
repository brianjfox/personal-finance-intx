// The Phase 1 GUI: net worth, positions, exception queue; every number
// clickable back to fact -> source document -> observed date (deck slide
// 19). The exception queue is the home screen in Phase 1; in Phase 4 the
// approval queue joins it.

import { useCallback, useEffect, useState } from "react";

import { api, money, when, type Fact, type Finding, type NetWorth, type Position, type RunSummary, type Doc } from "./api";

type Page = "queue" | "dashboard" | "positions" | "runs" | "documents";

export function App() {
  const [page, setPage] = useState<Page>("queue");
  const [queue, setQueue] = useState<Finding[]>([]);
  const [factId, setFactId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    api.queue().then(setQueue).catch(() => setQueue([]));
  }, [tick]);

  return (
    <div className="app">
      <nav>
        <h1>Interchange · Household</h1>
        {(
          [
            ["queue", "Exceptions", queue.length],
            ["dashboard", "Dashboard", null],
            ["positions", "Positions", null],
            ["runs", "Nightly runs", null],
            ["documents", "Documents", null],
          ] as const
        ).map(([id, label, count]) => (
          <a key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)}>
            <span>{label}</span>
            {count !== null && count > 0 ? <span className="badge">{count}</span> : null}
          </a>
        ))}
      </nav>
      <main>
        {page === "queue" && <QueuePage tick={tick} onChanged={refresh} openFact={setFactId} />}
        {page === "dashboard" && <Dashboard tick={tick} openFact={setFactId} />}
        {page === "positions" && <Positions tick={tick} openFact={setFactId} />}
        {page === "runs" && <Runs tick={tick} onChanged={refresh} />}
        {page === "documents" && <Documents tick={tick} />}
      </main>
      {factId !== null && <FactDrawer id={factId} onClose={() => setFactId(null)} openFact={setFactId} />}
    </div>
  );
}

function FactLink({ id, children, openFact }: { id: string; children: React.ReactNode; openFact: (id: string) => void }) {
  return (
    <span className="fact" title={`fact ${id}`} onClick={() => openFact(id)}>
      {children}
    </span>
  );
}

function Dashboard({ tick, openFact }: { tick: number; openFact: (id: string) => void }) {
  const [nw, setNw] = useState<NetWorth | null>(null);
  useEffect(() => {
    api.netWorth().then(setNw).catch(() => setNw(null));
  }, [tick]);
  if (nw === null) return <p className="muted">No ledger yet. Run a nightly.</p>;
  return (
    <>
      <h2>Net worth</h2>
      {nw.provisional && <div className="banner">Some figures rest on provisional facts. Downstream agents are held until the exception queue is cleared.</div>}
      <div className="cards">
        <div className={`card ${nw.provisional ? "prov" : ""}`}><div className="label">Net worth</div><div className="value">{money(nw.net_worth, nw.currency)}</div></div>
        <div className="card"><div className="label">Assets</div><div className="value">{money(nw.assets, nw.currency)}</div></div>
        <div className="card"><div className="label">Liabilities</div><div className="value">{money(nw.liabilities, nw.currency)}</div></div>
      </div>
      <h3>Accounts</h3>
      <table>
        <thead><tr><th>Account</th><th>Type</th><th className="num">Value</th><th>Basis</th><th>Observed</th><th></th></tr></thead>
        <tbody>
          {nw.lines.map((l) => (
            <tr key={l.account_id} className={l.provisional ? "prov" : ""}>
              <td>{l.name}<div className="small muted">{l.account_id}</div></td>
              <td>{l.type}</td>
              <td className="num">
                {l.fact_ids.length > 0 ? <FactLink id={l.fact_ids[0] as string} openFact={openFact}>{money(l.value, l.currency)}</FactLink> : money(l.value, l.currency)}
                {l.fact_ids.length > 1 && <span className="small muted"> (+{l.fact_ids.length - 1} facts)</span>}
              </td>
              <td className="small muted">{l.basis}</td>
              <td className="small">{when(l.observed_at)}</td>
              <td>{l.provisional && <span className="pill prov">provisional</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Positions({ tick, openFact }: { tick: number; openFact: (id: string) => void }) {
  const [rows, setRows] = useState<Position[]>([]);
  useEffect(() => {
    api.positions().then(setRows).catch(() => setRows([]));
  }, [tick]);
  return (
    <>
      <h2>Positions</h2>
      <table>
        <thead><tr><th>Account</th><th>Symbol</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Market value</th><th className="num">Cost basis</th><th>Observed</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.fact_id} className={p.provisional ? "prov" : ""}>
              <td className="small">{p.account_id}</td>
              <td>{p.symbol}<div className="small muted">{p.name ?? p.asset_class}</div></td>
              <td className="num">{p.quantity}</td>
              <td className="num">{money(p.price, p.currency)}</td>
              <td className="num"><FactLink id={p.fact_id} openFact={openFact}>{money(p.market_value, p.currency)}</FactLink></td>
              <td className="num">{p.basis_known ? money(p.cost_basis, p.currency) : <span className="pill medium">unknown</span>}</td>
              <td className="small">{when(p.observed_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function QueuePage({ tick, onChanged, openFact }: { tick: number; onChanged: () => void; openFact: (id: string) => void }) {
  const [items, setItems] = useState<Finding[]>([]);
  useEffect(() => {
    api.queue().then(setItems).catch(() => setItems([]));
  }, [tick]);
  return (
    <>
      <h2>Exception queue</h2>
      {items.length === 0 && <p className="muted">Nothing needs you. Every account reconciled clean.</p>}
      {items.map((f) => (
        <QueueItem key={f.id} f={f} onChanged={onChanged} openFact={openFact} />
      ))}
    </>
  );
}

function QueueItem({ f, onChanged, openFact }: { f: Finding; onChanged: () => void; openFact: (id: string) => void }) {
  const [detail, setDetail] = useState<{ before: Fact[]; after: Fact[] } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.finding(f.id).then((d) => setDetail({ before: d.before, after: d.after })).catch(() => setDetail(null));
  }, [f.id]);
  const resolve = async (decision: string) => {
    setBusy(true);
    try {
      await api.resolve(f.id, decision, note);
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const hasVersions = (detail?.before.length ?? 0) > 0 || (detail?.after.length ?? 0) > 0;
  return (
    <div className="queue-item">
      <div className="head">
        <span className={`pill ${f.severity}`}>{f.severity}</span>
        <span className="code">{f.code.replace(/_/g, " ")}</span>
        <span className="muted small">{f.subject} · {when(f.as_of)} · by {f.emitted_by}</span>
      </div>
      <div className="summary">{f.summary}</div>
      {hasVersions && (
        <div className="versions">
          <div>
            <div className="title">Ledger believed (before)</div>
            {detail!.before.length === 0 && <span className="muted small">— nothing prior —</span>}
            {detail!.before.map((x) => <FactCard key={x.id} f={x} openFact={openFact} />)}
          </div>
          <div>
            <div className="title">Feed now says (after)</div>
            {detail!.after.length === 0 && <span className="muted small">—</span>}
            {detail!.after.map((x) => <FactCard key={x.id} f={x} openFact={openFact} />)}
          </div>
        </div>
      )}
      <div className="actions">
        <input placeholder="note (why)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button disabled={busy} onClick={() => resolve("accept_incoming")}>Accept incoming</button>
        <button disabled={busy} className="secondary" onClick={() => resolve("keep_prior")}>Keep prior</button>
        <button disabled={busy} className="secondary" onClick={() => resolve("both")}>Both are real</button>
        <button disabled={busy} className="secondary" onClick={() => resolve("dismiss")}>Dismiss</button>
      </div>
    </div>
  );
}

function FactCard({ f, openFact }: { f: Fact; openFact: (id: string) => void }) {
  const p = f.payload;
  const headline =
    f.kind === "transaction" ? `${String(p["amount"])} ${String(p["description"] ?? "")}`
    : f.kind === "balance" ? `${String(p["balance_type"])} ${String(p["amount"])}`
    : f.kind === "position" ? `${String(p["quantity"])} ${String((p["instrument"] as { symbol?: string } | undefined)?.symbol ?? "")} @ ${String(p["market_value"] ?? "?")}`
    : f.kind === "lot" ? `lot ${String(p["lot_id"])} basis ${String(p["cost_basis"] ?? "unknown")}`
    : f.kind === "tax_document" ? `${String(p["form"])} ${String(p["tax_year"])} v${String(p["version"])} ${JSON.stringify(p["totals"])}`
    : f.kind;
  return (
    <div className="small" style={{ marginBottom: 6 }}>
      <FactLink id={f.id} openFact={openFact}>{headline}</FactLink>
      <div className="muted">observed {when(f.observed_at)} · effective {when(f.effective_at)}{f.provisional ? " · provisional" : ""}</div>
    </div>
  );
}

function FactDrawer({ id, onClose, openFact }: { id: string; onClose: () => void; openFact: (id: string) => void }) {
  const [data, setData] = useState<{ fact: Fact; history: Fact[]; document: Doc | null } | null>(null);
  useEffect(() => {
    api.fact(id).then(setData).catch(() => setData(null));
  }, [id]);
  if (data === null) return <div className="drawer"><button className="close secondary" onClick={onClose}>close</button><p>loading…</p></div>;
  const { fact, history, document } = data;
  return (
    <div className="drawer">
      <button className="close secondary" onClick={onClose}>close</button>
      <h2>Fact</h2>
      <dl className="kv">
        <dt>id</dt><dd>{fact.id}</dd>
        <dt>kind / key</dt><dd>{fact.kind} / {fact.key}</dd>
        <dt>subject</dt><dd>{fact.subject}</dd>
        <dt>observed at</dt><dd>{when(fact.observed_at)}</dd>
        <dt>effective at</dt><dd>{when(fact.effective_at)}</dd>
        <dt>source</dt><dd>{fact.source_id}</dd>
        <dt>writer</dt><dd>{fact.writer}</dd>
        <dt>provisional</dt><dd>{fact.provisional ? "yes" : "no"}</dd>
        <dt>batch</dt><dd>{fact.batch_id}</dd>
      </dl>
      <h3>Payload</h3>
      <pre>{JSON.stringify(fact.payload, null, 2)}</pre>
      <h3>Source document</h3>
      {document === null ? (
        <p className="muted small">none recorded{fact.source_doc_id ? ` (${fact.source_doc_id})` : ""}</p>
      ) : (
        <dl className="kv">
          <dt>file</dt><dd><a href={`/api/document/${document.id}/bytes`} target="_blank" rel="noreferrer">{document.filename}</a></dd>
          <dt>sha256</dt><dd className="small">{document.sha256}</dd>
          <dt>kind / mime</dt><dd>{document.kind} / {document.mime}{document.pages !== null ? ` · ${document.pages} pages` : ""}{fact.page ? ` · page ${fact.page}` : ""}</dd>
          <dt>ingested</dt><dd>{when(document.ingested_at)} by {document.ingested_by}</dd>
        </dl>
      )}
      <h3>History (supersession chain)</h3>
      <div className="chain">
        {history.map((h) => (
          <div key={h.id} className={`node ${h.id === fact.id ? "current" : ""}`}>
            <FactLink id={h.id} openFact={openFact}>{h.id}</FactLink> · observed {when(h.observed_at)} · effective {when(h.effective_at)} · {h.source_id}{h.provisional ? " · provisional" : ""}
            <pre>{JSON.stringify(h.payload)}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

function Runs({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.runs().then(setRuns).catch(() => setRuns([]));
  }, [tick]);
  const start = async () => {
    setBusy(true);
    try {
      await api.nightly();
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h2>Nightly runs</h2>
      <p><button disabled={busy} onClick={start}>{busy ? "running…" : "Run nightly now"}</button></p>
      <table className="runs">
        <thead><tr><th>Run</th><th>Status</th><th>Started</th><th>Gate</th><th>Steps</th></tr></thead>
        <tbody>
          {runs.map((r) => {
            const gate = r.steps["notify"]?.status === "completed" ? "clean → notify" : r.steps["hold"]?.status === "completed" ? "held" : "—";
            return (
              <tr key={r.runId}>
                <td className="small">{r.runId}</td>
                <td className={`status-${r.status}`}>{r.status}</td>
                <td className="small">{when(r.startedAt)}</td>
                <td>{gate}</td>
                <td className="small muted">{Object.entries(r.steps).map(([k, v]) => `${k}:${v.status}`).join(" ")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function Documents({ tick }: { tick: number }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  useEffect(() => {
    api.documents().then(setDocs).catch(() => setDocs([]));
  }, [tick]);
  return (
    <>
      <h2>Document vault</h2>
      <table>
        <thead><tr><th>File</th><th>Kind</th><th>Source</th><th className="num">Bytes</th><th>Ingested</th><th>sha256</th></tr></thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id}>
              <td><a href={`/api/document/${d.id}/bytes`} target="_blank" rel="noreferrer">{d.filename}</a></td>
              <td>{d.kind}</td>
              <td className="small">{d.source_id}</td>
              <td className="num">{d.bytes}</td>
              <td className="small">{when(d.ingested_at)}</td>
              <td className="small muted">{d.sha256.slice(0, 16)}…</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
