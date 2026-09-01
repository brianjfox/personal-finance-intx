// The Phase 1 GUI: net worth, positions, exception queue; every number
// clickable back to fact -> source document -> observed date (deck slide
// 19). The exception queue is the home screen in Phase 1; in Phase 4 the
// approval queue joins it.

import DOMPurify from "dompurify";
import { marked } from "marked";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, fxState, isMasked, maskDigits, money, moneyNative, setApiToken, setFxRates, setMasked, when, type ChatAgentName, type ChatTurn, type EstateStatus, type Fact, type Finding, type InstitutionOverview, type InstitutionsOverview, type JournalEntry, type NetWorth, type Position, type RunSummary, type Doc, type TaxStatus, type TaxQuarterStatus, type TaxStageStatus, type UserInfo } from "./api";
import { DonutChart, HorizonChart, PairedBars, type DonutSlice, type FlowBar } from "./charts";
import { Icon, LogoMark } from "./icons";
import { applyUiSettings, loadUiSettings, resolvedTheme, saveUiSettings, UI_DEFAULTS, type ThemeColors, type UiSettings } from "./theme";
import tauriConf from "../src-tauri/tauri.conf.json";

/** The product version: tauri.conf.json is the single source of truth (it stamps the bundle too). */
const APP_VERSION: string = tauriConf.version;

/**
 * Which OS the host runs on ("darwin", "win32", ...), from the pre-auth
 * /api/health. Fixed before anything renders (useUserGate waits for it),
 * so the security copy below states what is true on THIS machine — never
 * a Mac promise on a Windows disk.
 */
let hostPlatform: string | null = null;
const isWindows = (): boolean => hostPlatform === "win32";
const isMac = (): boolean => hostPlatform === "darwin";
// Unknown platform (health unreachable) claims neither Mac nor Windows.
const thisMachine = (): string => (isWindows() ? "this PC" : isMac() ? "this Mac" : "this computer");
/** Where pasted keys live, with the article the sentence needs. */
const theKeychain = (): string => (isWindows() ? "Windows Credential Manager" : isMac() ? "the Keychain" : "the system credential store");
const yourKeychain = (): string => (isWindows() ? "Windows Credential Manager" : isMac() ? "your Mac's Keychain" : "the system credential store");

type Page = "queue" | "dashboard" | "institutions" | "credentials" | "profile" | "tax" | "strategy" | "estate" | "audit" | "documents" | "settings";

/**
 * Who is using the app. Multi-user hosts put a real login in front:
 * username + password -> a session token; every request carries the
 * token, and the host serves only that user's data.
 */
function useUserGate(): { ready: boolean; multi: boolean; users: UserInfo[]; current: { id: string; name: string } | null; enter: (token: string, user: { id: string; name: string }) => void; renameLocal?: (name: string) => void; signOut: () => void; refresh: () => void } {
  const [state, setState] = useState<{ multi: boolean; users: UserInfo[] } | null>(null);
  const [session, setSession] = useState<{ token: string; id: string; name: string } | null>(() => {
    try {
      const token = localStorage.getItem("fin.token");
      const id = localStorage.getItem("fin.user");
      const name = localStorage.getItem("fin.user_name");
      return token !== null && id !== null ? { token, id, name: name ?? id } : null;
    } catch {
      return null;
    }
  });
  const refresh = useCallback(() => {
    api.users().then((r) => setState({ multi: r.multi_user, users: r.users })).catch(() => setState({ multi: false, users: [] }));
  }, []);
  useEffect(refresh, [refresh]);
  // The platform settles before ready flips: every screen's copy can
  // then read it synchronously. Unreachable health stays unknown, and
  // the copy helpers above claim neither platform.
  const [platformReady, setPlatformReady] = useState(hostPlatform !== null);
  useEffect(() => {
    if (hostPlatform !== null) return;
    api.health()
      .then((h) => { hostPlatform = h.platform; })
      .catch(() => { hostPlatform = null; })
      .finally(() => setPlatformReady(true));
  }, []);
  // A 401 anywhere (host restart, session expiry) drops the session.
  useEffect(() => {
    const onUnauthorized = () => setSession(null);
    window.addEventListener("fin:unauthorized", onUnauthorized);
    return () => window.removeEventListener("fin:unauthorized", onUnauthorized);
  }, []);
  if (session !== null) setApiToken(session.token);
  const store = (token: string | null, user: { id: string; name: string } | null) => {
    try {
      if (token === null || user === null) {
        localStorage.removeItem("fin.token");
        localStorage.removeItem("fin.user");
        localStorage.removeItem("fin.user_name");
      } else {
        localStorage.setItem("fin.token", token);
        localStorage.setItem("fin.user", user.id);
        localStorage.setItem("fin.user_name", user.name);
      }
    } catch {
      /* private mode */
    }
  };
  if (state === null || !platformReady) return { ready: false, multi: false, users: [], current: null, enter: () => {}, signOut: () => {}, refresh };
  if (!state.multi) {
    return { ready: true, multi: false, users: [], current: null, enter: () => {}, signOut: () => {}, refresh };
  }
  return {
    ready: true,
    multi: true,
    users: state.users,
    current: session === null ? null : { id: session.id, name: session.name },
    enter: (token, user) => {
      setApiToken(token);
      store(token, user);
      setSession({ token, ...user });
    },
    renameLocal: (name: string) => {
      setSession((x) => {
        if (x === null) return x;
        store(x.token, { id: x.id, name });
        return { ...x, name };
      });
    },
    signOut: () => {
      void api.logout().catch(() => {});
      setApiToken(null);
      store(null, null);
      // Dropping the session unmounts the whole app body (it's keyed by
      // user), so no component carries the signed-out user's state.
      setSession(null);
    },
    refresh,
  };
}

/**
 * The at-rest sentence must match what the machine provides: the AES-256
 * per-user store on macOS; on Windows, BitLocker's reported status
 * verbatim — including a plain warning when the disk is unencrypted.
 */
function atRestCopy(users: UserInfo[]): string {
  const volume = ", in a store encrypted with that password (AES-256). Signing out locks it. There is no recovery: a forgotten password means the data stays locked.";
  if (!isWindows()) return volume;
  const cap = users[0]?.encrypted;
  if (cap === "volume") return volume;
  if (cap === "os-disk") return ". At rest the files are protected by Windows disk encryption (BitLocker), which this PC reports as on.";
  if (cap === "none") return ". This PC's disk reports no encryption, so the files are not encrypted at rest — turn on Device Encryption or BitLocker in Windows settings to protect them.";
  // No users yet: the disk's status is per-user data we don't have — claim nothing.
  return ". At-rest protection comes from Windows disk encryption (Device Encryption / BitLocker) when it is on.";
}

/** The login screen: pick who you are, prove it; or add a new person. */
function UserGate({ users, onEnter, onChanged }: { users: UserInfo[]; onEnter: (token: string, user: { id: string; name: string }) => void; onChanged: () => void }) {
  const [who, setWho] = useState<UserInfo | null>(users.length === 1 ? users[0]! : null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [adding, setAdding] = useState(users.length === 0);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };
  const signIn = (u: UserInfo) =>
    act(async () => {
      const r = await api.login(u.id, password);
      onEnter(r.token, { id: r.user.id, name: r.user.name });
    });
  const create = (u: UserInfo) =>
    act(async () => {
      if (password.length < 4) throw new Error("The password needs at least 4 characters.");
      if (password !== confirm) throw new Error("The two passwords don't match.");
      const r = await api.setPassword(u.id, password);
      if (r.token === null) throw new Error("Password set — sign in now.");
      onEnter(r.token, { id: r.user.id, name: r.user.name });
    });
  const addUser = () =>
    act(async () => {
      if (name.trim() === "") throw new Error("Enter a name.");
      if (password.length < 4) throw new Error("The password needs at least 4 characters.");
      if (password !== confirm) throw new Error("The two passwords don't match.");
      const r = await api.addUser(name.trim(), password);
      onChanged();
      if (r.token === null) throw new Error("User added — sign in now.");
      onEnter(r.token, { id: r.user.id, name: r.user.name });
    });
  const submit = () => {
    if (adding) return void addUser();
    if (who === null) return;
    return who.password_set ? void signIn(who) : void create(who);
  };
  return (
    <div style={{ maxWidth: 460, margin: "80px auto" }}>
      <h2>Who's using Corbits Personal Finance?</h2>
      <p className="small muted">
        Each person signs in with their own password and sees only their own ledger, documents, agents, and keys — all
        on {thisMachine()}{atRestCopy(users)}
      </p>
      {!adding && users.map((u) => (
        <p key={u.id}>
          <button
            className={who?.id === u.id ? "" : "secondary"}
            style={{ width: "100%", textAlign: "left" }}
            onClick={() => {
              setWho(u);
              setError(null);
            }}
          >
            {u.encrypted !== "none" ? "🔒" : "👤"} {u.name}{!u.password_set && <span className="small muted"> — first sign-in: choose a password</span>}
          </button>
        </p>
      ))}
      {adding && (
        <div className="actions" style={{ marginTop: 8 }}>
          <input style={{ flex: 1 }} placeholder="Name — e.g. Brian" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
        </div>
      )}
      {(adding || who !== null) && (
        <>
          <div className="actions" style={{ marginTop: 8 }}>
            <input
              style={{ flex: 1 }}
              type="password"
              placeholder={adding || !(who?.password_set ?? false) ? "Choose a password" : `Password for ${who!.name}`}
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
            {(adding || !(who?.password_set ?? false)) && (
              <input
                style={{ flex: 1 }}
                type="password"
                placeholder="Repeat it"
                value={confirm}
                disabled={busy}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
            )}
          </div>
          <div className="actions" style={{ marginTop: 8 }}>
            <button disabled={busy} onClick={submit}>
              {busy ? "…" : adding ? "Create user" : who?.password_set ?? false ? "Sign in" : "Set password & sign in"}
            </button>
          </div>
        </>
      )}
      <p style={{ marginTop: 16 }}>
        {users.length > 0 && (
          <button className="secondary" disabled={busy} onClick={() => { setAdding((a) => !a); setError(null); setPassword(""); setConfirm(""); }}>
            {adding ? "Back to sign-in" : "Add a person…"}
          </button>
        )}
      </p>
      {error !== null && <div className="banner" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

export function App() {
  const gate = useUserGate();
  if (!gate.ready) {
    return <div className="app"><main><div className="page"><p className="muted">Starting…</p></div></main></div>;
  }
  if (gate.multi && gate.current === null) {
    return (
      <div className="app">
        <main>
          <div className="page page-narrow">
            <UserGate users={gate.users} onEnter={gate.enter} onChanged={gate.refresh} />
          </div>
        </main>
      </div>
    );
  }
  // Keyed by user: signing out or switching remounts everything fresh.
  return <AppBody key={gate.current?.id ?? "single"} user={gate.multi ? gate.current : null} signOut={gate.signOut} onRenamed={gate.renameLocal ?? (() => {})} />;
}

/** The About popup: the mark, the name, and the version. */
function AboutModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <LogoMark size={72} />
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--strong)", textTransform: "none", letterSpacing: 0 }}>Corbits Personal Finance</h3>
        <span className="pill info">Version {APP_VERSION}</span>
        <p className="small muted" style={{ margin: 0, lineHeight: 1.6 }}>
          A local-first household finance console. Your ledger, documents, and keys live on {thisMachine()} — and every figure
          links back to dated evidence.
        </p>
        <button className="secondary" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

/** The sidebar's entries: page id, label, icon. */
const NAV_ITEMS: ReadonlyArray<readonly [Page, string, string]> = [
  ["dashboard", "Dashboard", "squares-four"],
  ["queue", "Queue", "list-checks"],
  ["institutions", "Assets", "stack"],
  ["credentials", "Credentials", "key"],
  ["profile", "People", "users-three"],
  ["tax", "Tax Calendar", "calendar-blank"],
  ["strategy", "Strategy", "chart-line-up"],
  ["estate", "Estate", "house-line"],
  ["audit", "Audit Logs", "scroll-text"],
  ["documents", "Documents", "file-text"],
  ["settings", "Settings", "gear"],
];

function AppBody({ user, signOut, onRenamed }: { user: { id: string; name: string } | null; signOut: () => void; onRenamed: (name: string) => void }) {
  const [page, setPage] = useState<Page>("dashboard");
  const [queue, setQueue] = useState<Finding[]>([]);
  const [approvalsCount, setApprovalsCount] = useState(0);
  const [strategyTab, setStrategyTab] = useState<StrategyTab>("chat");
  const [overview, setOverview] = useState<InstitutionsOverview | null>(null);
  const [nw, setNw] = useState<NetWorth | null>(null);
  const [factId, setFactId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const [, setFxTick] = useState(0);
  useEffect(() => {
    api.queue().then(setQueue).catch(() => setQueue([]));
    api.approvals().then((a) => setApprovalsCount(a.length)).catch(() => setApprovalsCount(0));
    api.institutionsOverview().then(setOverview).catch(() => setOverview(null));
    api.netWorth().then(setNw).catch(() => setNw(null));
    api.fx().then((fx) => {
      setFxRates(fx);
      setFxTick((t) => t + 1); // re-render with rates in hand
    }).catch(() => {});
  }, [tick]);

  // Nothing at all yet: the welcome screen takes over (except when the
  // user is already on the Institutions page connecting something).
  const nothingYet = overview !== null && overview.institutions.length === 0 && !overview.hasFacts;
  // The welcome screen owns the DATA pages while there's nothing to show,
  // but never the setup pages: a fresh user must be able to reach
  // Credentials (Plaid/EB keys, the wizard) and People before any data exists.
  // Pages that render even before any data exists: the setup flow, plus
  // Settings, which is pure display preferences with no ledger behind it.
  const SETUP_PAGES: ReadonlySet<Page> = new Set(["institutions", "credentials", "profile", "settings"]);
  const takeover = nothingYet && !SETUP_PAGES.has(page);

  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return localStorage.getItem("fin.nav.collapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggleNav = () => {
    setNavCollapsed((c) => {
      try {
        localStorage.setItem("fin.nav.collapsed", c ? "0" : "1");
      } catch {
        /* private mode */
      }
      return !c;
    });
  };
  const initials =
    user !== null
      ? user.name.trim().split(/\s+/).map((w) => w[0] ?? "").slice(0, 2).join("").toUpperCase()
      : "ME";
  const [showAbout, setShowAbout] = useState(false);
  // Phone layout: the sidebar slides in from the left behind a hamburger.
  const [menuOpen, setMenuOpen] = useState(false);
  // The privacy veil: masks every rendered financial figure with *s.
  const [masked, setMaskedState] = useState(isMasked());
  const toggleMask = () => {
    setMasked(!masked);
    setMaskedState(!masked);
  };
  const chatMode = page === "strategy" && strategyTab === "chat" && !takeover;
  // Pages that still use the classic single-column layout get the standard container.
  const contained = (node: React.ReactNode) => <div className="page page-mid">{node}</div>;
  return (
    <div className={`app${navCollapsed ? " nav-collapsed" : ""}`}>
      <header className="topbar">
        <div className="tb-left">
          <button className="iconbtn only-mobile" title="Menu" onClick={() => setMenuOpen((o) => !o)}><Icon name="menu" /></button>
          <span className="tb-brand click" role="button" title="About Corbits Personal Finance" onClick={() => setShowAbout(true)}><LogoMark /> <span className="bt">Corbits Personal Finance</span></span>
          <span className="tb-divider" />
          <span className="tb-networth">
            <span className="lbl">Net Worth</span>
            <span className="val num">{nw !== null ? money(nw.net_worth, nw.currency) : "—"}</span>
            <button className="iconbtn eye" title={masked ? "Show the figures" : "Hide the figures (show *s)"} onClick={toggleMask}>
              <Icon name={masked ? "eye-slash" : "eye"} />
            </button>
            {nw !== null && nw.provisional && <span className="pill prov">provisional</span>}
          </span>
          {nw?.as_of.observed_at != null && <span className="tb-updated">Last updated {when(nw.as_of.observed_at)}</span>}
        </div>
        <div className="tb-right">
          {user !== null && (
            <button className="iconbtn" title={`Signed in as ${user.name} — sign out`} onClick={signOut}>
              <Icon name="sign-out" />
            </button>
          )}
          <span className="tb-avatar" title={user?.name ?? "You"}>{initials}</span>
          <button
            className="iconbtn"
            title={(() => {
              const parts: string[] = [];
              if (queue.length > 0) parts.push(`${queue.length} exception${queue.length === 1 ? "" : "s"}`);
              if (approvalsCount > 0) parts.push(`${approvalsCount} proposal${approvalsCount === 1 ? "" : "s"} awaiting your signature`);
              return parts.length > 0 ? parts.join(" · ") : "Nothing requires your attention";
            })()}
            onClick={() => {
              // Exceptions first; with none, a pending proposal is what the bell is about.
              if (queue.length === 0 && approvalsCount > 0) {
                setStrategyTab("plan");
                setPage("strategy");
              } else {
                setPage("queue");
              }
            }}
          >
            <Icon name="bell" />
            {(queue.length > 0 || approvalsCount > 0) && <span className="dot" />}
          </button>
        </div>
      </header>
      <div className="body">
        {menuOpen && <div className="side-scrim" onClick={() => setMenuOpen(false)} />}
        <nav className={`side${menuOpen ? " open" : ""}`}>
          {NAV_ITEMS.map(([id, label, icon]) => (
            <a key={id} className={page === id ? "active" : ""} title={label} onClick={() => { setPage(id); setMenuOpen(false); }}>
              <span className="icon"><Icon name={icon} /></span>
              <span className="label">{label}</span>
              {id === "queue" && queue.length > 0 ? <span className="nav-badge">{queue.length}</span> : null}
              {id === "strategy" && approvalsCount > 0 ? <span className="nav-badge">{approvalsCount}</span> : null}
            </a>
          ))}
          <div className="health-card">
            <div className="head"><Icon name="shield-check" /> Portfolio Health</div>
            <div className="note">
              {queue.length === 0
                ? "Every account reconciled clean. No exceptions detected."
                : `${queue.length} exception${queue.length === 1 ? "" : "s"} in the queue need${queue.length === 1 ? "s" : ""} review.`}
            </div>
            <div className="progressbar"><div style={{ width: queue.length === 0 ? "100%" : "55%" }} /></div>
          </div>
          <button className="collapse-toggle" title={navCollapsed ? "Expand the menu" : "Collapse to icons"} onClick={toggleNav}>
            {navCollapsed ? <Icon name="caret-right" /> : <Icon name="caret-left" />}
          </button>
        </nav>
        <main className={chatMode ? "chatmode" : ""}>
          {takeover ? (
            contained(<Welcome onConnect={() => setPage("institutions")} onChanged={refresh} />)
          ) : (
            <>
              {!nothingYet && <NoNumbersYet overview={overview} onChanged={refresh} goInstitutions={() => setPage("institutions")} />}
              {page === "queue" && <QueuePage tick={tick} onChanged={refresh} openFact={setFactId} />}
              {page === "dashboard" && <Dashboard tick={tick} openFact={setFactId} />}
              {page === "institutions" && <InstitutionsPage tick={tick} onChanged={refresh} />}
              {page === "credentials" && contained(<CredentialsPage tick={tick} onChanged={refresh} user={user} onRenamed={onRenamed} />)}
              {page === "profile" && <ProfilePage tick={tick} onChanged={refresh} />}
              {page === "tax" && <TaxPage tick={tick} onChanged={refresh} openFact={setFactId} />}
              {page === "strategy" && <StrategyPage tab={strategyTab} setTab={setStrategyTab} tick={tick} onChanged={refresh} openFact={setFactId} />}
              {page === "estate" && contained(<EstatePage tick={tick} onChanged={refresh} openFact={setFactId} />)}
              {page === "audit" && contained(<AuditPage tick={tick} onChanged={refresh} openFact={setFactId} />)}
              {page === "documents" && contained(<Documents tick={tick} />)}
              {page === "settings" && contained(<SettingsPage />)}
            </>
          )}
        </main>
      </div>
      {factId !== null && <FactDrawer id={factId} onClose={() => setFactId(null)} openFact={setFactId} />}
      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
    </div>
  );
}

// The very first screen: absolutely no data yet, two ways to begin.
function Welcome({ onConnect, onChanged }: { onConnect: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const demo = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.seedDemo();
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="welcome">
      <h2>Welcome</h2>
      <p>Currently, there are no institutions connected, and there's no other data for us to work with.</p>
      {busy ? (
        <p className="muted">Setting up a made-up household and fetching its numbers… this takes a few seconds.</p>
      ) : (
        <div className="welcome-actions">
          <button onClick={onConnect}>Click here to start connecting your institutions</button>
          <button className="secondary" onClick={() => void demo()}>Click here to start with a bunch of made up data</button>
        </div>
      )}
      <p className="small muted">
        Everything here is read-only: connections can look at your accounts, never touch them. The made-up data is clearly
        fictional and can be thrown away by deleting its institutions.
      </p>
      {error !== null && <div className="banner">{error}</div>}
    </div>
  );
}

// Institutions exist but the first numbers haven't been fetched yet.
function NoNumbersYet({ overview, onChanged, goInstitutions }: { overview: InstitutionsOverview | null; onChanged: () => void; goInstitutions: () => void }) {
  const [busy, setBusy] = useState(false);
  // Renders NOTHING in the normal case -- the wrapper lives here so no
  // empty spacer ever sits above a page (it used to push every non-chat
  // page down ~24px, making headers jump between pages).
  if (overview === null || overview.hasFacts || overview.institutions.length === 0) return null;
  const fetchNow = async () => {
    setBusy(true);
    try {
      await api.nightly();
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page page-mid" style={{ paddingBottom: 0, flex: "none", width: "100%" }}>
      <div className="banner">
        <b>Almost there.</b> Your institutions are set up, but no numbers have come in yet.{" "}
        {busy ? (
          <span className="muted">Fetching your numbers…</span>
        ) : (
          <>
            <button onClick={() => void fetchNow()}>Fetch the numbers now</button>{" "}
            <button className="secondary" onClick={goInstitutions}>Manage institutions</button>
          </>
        )}
      </div>
    </div>
  );
}

// --- Profile: who you are, and the people your estate and tax plans must know about ---

type Rel = { legal_name: string; relationship: string; date_of_birth: string; note: string };
const emptyRel = (): Rel => ({ legal_name: "", relationship: "", date_of_birth: "", note: "" });
const toRel = (r: import("./api").ProfileRelation | null | undefined): Rel => ({
  legal_name: r?.legal_name ?? "",
  relationship: r?.relationship ?? "",
  date_of_birth: r?.date_of_birth ?? "",
  note: r?.note ?? "",
});
const fromRel = (r: Rel): import("./api").ProfileRelation => ({
  legal_name: r.legal_name.trim(),
  ...(r.relationship.trim() !== "" ? { relationship: r.relationship.trim() } : {}),
  ...(r.date_of_birth.trim() !== "" ? { date_of_birth: r.date_of_birth.trim() } : {}),
  ...(r.note.trim() !== "" ? { note: r.note.trim() } : {}),
});

interface ProfileDraft {
  legal_name: string; preferred_name: string; date_of_birth: string; ssn: string; ssn_last4: string | null; clear_ssn: boolean;
  citizenship: string; country_of_residence: string; state_or_province: string; marital_status: string; preferred_currency: string;
  has_spouse: boolean; spouse: Rel; children: Rel[]; others: Rel[];
}

function draftFrom(p: import("./api").ProfileRedacted): ProfileDraft {
  return {
    legal_name: p.person?.legal_name ?? "",
    preferred_name: p.person?.preferred_name ?? "",
    date_of_birth: p.person?.date_of_birth ?? "",
    ssn: "",
    ssn_last4: p.person?.ssn_last4 ?? null,
    clear_ssn: false,
    citizenship: p.person?.citizenship ?? "",
    country_of_residence: p.person?.country_of_residence ?? "",
    state_or_province: p.person?.state_or_province ?? "",
    marital_status: p.person?.marital_status ?? "",
    preferred_currency: p.preferred_currency ?? "USD",
    has_spouse: p.spouse != null,
    spouse: toRel(p.spouse),
    children: (p.children ?? []).map(toRel),
    others: (p.others ?? []).map(toRel),
  };
}

function saveInputFrom(d: ProfileDraft): import("./api").ProfileSave {
  return {
    person: {
      legal_name: d.legal_name.trim(),
      ...(d.preferred_name.trim() !== "" ? { preferred_name: d.preferred_name.trim() } : {}),
      ...(d.date_of_birth.trim() !== "" ? { date_of_birth: d.date_of_birth.trim() } : {}),
      ...(d.ssn.trim() !== "" ? { ssn: d.ssn.trim() } : {}),
      ...(d.citizenship.trim() !== "" ? { citizenship: d.citizenship.trim() } : {}),
      ...(d.country_of_residence.trim() !== "" ? { country_of_residence: d.country_of_residence.trim() } : {}),
      ...(d.state_or_province.trim() !== "" ? { state_or_province: d.state_or_province.trim() } : {}),
      ...(d.marital_status !== "" ? { marital_status: d.marital_status } : {}),
    },
    preferred_currency: d.preferred_currency,
    ...(d.has_spouse && d.spouse.legal_name.trim() !== "" ? { spouse: fromRel(d.spouse) } : { spouse: null }),
    children: d.children.filter((c) => c.legal_name.trim() !== "").map(fromRel),
    others: d.others.filter((o) => o.legal_name.trim() !== "").map(fromRel),
    ...(d.clear_ssn ? { clear_ssn: true } : {}),
  };
}

function RelRow({ r, onChange, onRemove, relPlaceholder, disabled }: { r: Rel; onChange: (r: Rel) => void; onRemove: () => void; relPlaceholder: string; disabled: boolean }) {
  return (
    <div className="actions" style={{ marginTop: 6 }}>
      <input style={{ flex: 1 }} placeholder="Full legal name" value={r.legal_name} disabled={disabled} onChange={(e) => onChange({ ...r, legal_name: e.target.value })} />
      <input style={{ width: 140 }} placeholder={relPlaceholder} value={r.relationship} disabled={disabled} onChange={(e) => onChange({ ...r, relationship: e.target.value })} />
      <input style={{ width: 130 }} placeholder="Born — e.g. Jul 30 1959" value={r.date_of_birth} disabled={disabled} onChange={(e) => onChange({ ...r, date_of_birth: e.target.value })} />
      <button className="secondary" disabled={disabled} onClick={onRemove}>Remove</button>
    </div>
  );
}

/** The people an estate plan must account for. Reused by the Profile page and the Estate page's wizard. */
function PeopleEditor({ d, setD, disabled }: { d: ProfileDraft; setD: (fn: (d: ProfileDraft) => ProfileDraft) => void; disabled: boolean }) {
  return (
    <>
      <h3>2 · Spouse or partner</h3>
      <label className="small">
        <input type="checkbox" checked={d.has_spouse} disabled={disabled} onChange={(e) => setD((x) => ({ ...x, has_spouse: e.target.checked }))} /> I have a spouse or partner
      </label>
      {d.has_spouse && (
        <div className="actions" style={{ marginTop: 6 }}>
          <input style={{ flex: 1 }} placeholder="Spouse/partner's full legal name" value={d.spouse.legal_name} disabled={disabled} onChange={(e) => setD((x) => ({ ...x, spouse: { ...x.spouse, legal_name: e.target.value } }))} />
          <input style={{ width: 130 }} placeholder="Born — e.g. Jul 30 1959" value={d.spouse.date_of_birth} disabled={disabled} onChange={(e) => setD((x) => ({ ...x, spouse: { ...x.spouse, date_of_birth: e.target.value } }))} />
        </div>
      )}
      <h3>3 · Children</h3>
      {d.children.map((c, i) => (
        <RelRow key={i} r={c} disabled={disabled} relPlaceholder="son / daughter / stepchild" onChange={(r) => setD((x) => ({ ...x, children: x.children.map((y, j) => (j === i ? r : y)) }))} onRemove={() => setD((x) => ({ ...x, children: x.children.filter((_, j) => j !== i) }))} />
      ))}
      <p><button className="secondary" disabled={disabled} onClick={() => setD((x) => ({ ...x, children: [...x.children, emptyRel()] }))}>Add a child</button></p>
      <h3>4 · Anyone else who should appear in your will</h3>
      <p className="small muted">Parents, siblings, godchildren, close friends, charities — anyone you may want named.</p>
      {d.others.map((o, i) => (
        <RelRow key={i} r={o} disabled={disabled} relPlaceholder="relationship" onChange={(r) => setD((x) => ({ ...x, others: x.others.map((y, j) => (j === i ? r : y)) }))} onRemove={() => setD((x) => ({ ...x, others: x.others.filter((_, j) => j !== i) }))} />
      ))}
      <p><button className="secondary" disabled={disabled} onClick={() => setD((x) => ({ ...x, others: [...x.others, emptyRel()] }))}>Add a person</button></p>
    </>
  );
}

function useProfileDraft(tick: number): { d: ProfileDraft | null; setD: (fn: (d: ProfileDraft) => ProfileDraft) => void; save: () => Promise<boolean>; busy: boolean; error: string | null; saved: boolean; reset: () => void } {
  const [d, setDraft] = useState<ProfileDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const reset = useCallback(() => {
    api.profile().then((p) => setDraft(draftFrom(p))).catch(() => setDraft(null));
  }, []);
  useEffect(reset, [reset, tick]);
  const setD = (fn: (x: ProfileDraft) => ProfileDraft) => {
    setSaved(false);
    setDraft((x) => (x === null ? x : fn(x)));
  };
  // Returns whether the save landed. A refused field (an unreadable
  // date, say) must leave the draft exactly as typed -- the caller may
  // only refresh other panels on success, since a tick bump reloads the
  // stored profile over the draft.
  const save = async (): Promise<boolean> => {
    if (d === null) return false;
    if (d.legal_name.trim() === "") {
      setError("Your full legal name is the one required field.");
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.profileSave(saveInputFrom(d));
      setDraft(draftFrom(r));
      setSaved(true);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { d, setD, save, busy, error, saved, reset };
}

/** One editable person row on the People page: initial, name, DOB, relationship, remove. */
function PersonRow({ r, onChange, onRemove, relPlaceholder, disabled }: { r: Rel; onChange: (r: Rel) => void; onRemove: () => void; relPlaceholder: string; disabled: boolean }) {
  const initial = (r.legal_name.trim()[0] ?? "?").toUpperCase();
  return (
    <div className="person-row">
      <span className="avatar-initial round">{initial}</span>
      <div className="cols">
        <div>
          <span className="mini-label">Name</span>
          <input placeholder="Full legal name" value={r.legal_name} disabled={disabled} onChange={(e) => onChange({ ...r, legal_name: e.target.value })} />
        </div>
        <div>
          <span className="mini-label">Born</span>
          <input placeholder="e.g. Mar 12 2004" value={r.date_of_birth} disabled={disabled} onChange={(e) => onChange({ ...r, date_of_birth: e.target.value })} />
        </div>
        <div>
          <span className="mini-label">Role</span>
          <input placeholder={relPlaceholder} value={r.relationship} disabled={disabled} onChange={(e) => onChange({ ...r, relationship: e.target.value })} />
        </div>
      </div>
      <button className="ghost danger" title="Remove" disabled={disabled} onClick={onRemove}><Icon name="trash" /></button>
    </div>
  );
}

function ProfilePage({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { d, setD, save, busy, error, saved, reset } = useProfileDraft(tick);
  if (d === null) return <div className="page"><p className="muted">Host unreachable.</p></div>;
  const spouseNamed = d.has_spouse && d.spouse.legal_name.trim() !== "";
  const beneficiaries = (spouseNamed ? 1 : 0) + d.children.filter((c) => c.legal_name.trim() !== "").length + d.others.filter((o) => o.legal_name.trim() !== "").length;
  const initials = (name: string) => name.trim().split(/\s+/).map((w) => w[0] ?? "").slice(0, 2).join("").toUpperCase() || "?";
  return (
    <div className="page">
      <div style={{ marginBottom: 28 }}>
        <h2>Household &amp; Estate</h2>
        <p className="page-sub" style={{ maxWidth: 640 }}>
          Manage the people your estate and tax planning must know about. Information is stored locally on {thisMachine()}. AI
          models can read everything here <span style={{ color: "var(--red-ink)", fontWeight: 600, textDecoration: "underline" }}>except</span> your tax ID.
        </p>
      </div>
      <div className="people-grid">
        <div>
          <ProfileIntake setD={setD} disabled={busy} />
          <div className="household">
            <div className="uc" style={{ fontSize: 11, fontWeight: 700, color: "var(--t3)", marginBottom: 16 }}>Household Composition</div>
            <div className="h-row">
              <span className="avatar-initial">{initials(d.legal_name === "" ? (d.preferred_name || "You") : d.legal_name)}</span>
              <div>
                <div className="h-name">{d.legal_name !== "" ? d.legal_name : "Not named yet"}</div>
                <div className="h-role">Primary (You)</div>
              </div>
            </div>
            {spouseNamed && (
              <div className="h-row">
                <span className="avatar-initial">{initials(d.spouse.legal_name)}</span>
                <div>
                  <div className="h-name">{d.spouse.legal_name}</div>
                  <div className="h-role">Spouse</div>
                </div>
              </div>
            )}
            <hr className="hairline-h" />
            <div className="stat-row" style={{ marginBottom: 12 }}>
              <span className="lbl">People named</span>
              <span className="val small">{beneficiaries}</span>
            </div>
            <div className="stat-row" style={{ marginBottom: 0 }}>
              <span className="lbl">Estate clarity</span>
              <span className="val small" style={{ color: beneficiaries > 0 && d.legal_name.trim() !== "" ? "var(--green)" : "var(--amber)" }}>
                {beneficiaries > 0 && d.legal_name.trim() !== "" ? "High" : "Needs input"}
              </span>
            </div>
          </div>
        </div>
        <div>
          <section className="form-section">
            <div className="sec-head">
              <div className="l"><span className="sec-num">1</span><span className="sec-title">Primary Individual</span></div>
              {d.legal_name.trim() !== "" && <span className="sec-status">Completed</span>}
            </div>
            <div className="sec-body">
              <div className="fgrid">
                <div>
                  <label className="field-label">Full Legal Name</label>
                  <input placeholder="Full legal name" value={d.legal_name} disabled={busy} onChange={(e) => setD((x) => ({ ...x, legal_name: e.target.value }))} />
                </div>
                <div>
                  <label className="field-label">Preferred Name</label>
                  <input placeholder="Preferred name" value={d.preferred_name} disabled={busy} onChange={(e) => setD((x) => ({ ...x, preferred_name: e.target.value }))} />
                </div>
                <div>
                  <label className="field-label">Date of Birth</label>
                  <input placeholder="e.g. Jul 30 1959" value={d.date_of_birth} disabled={busy} onChange={(e) => setD((x) => ({ ...x, date_of_birth: e.target.value }))} />
                </div>
                <div>
                  <label className="field-label">Tax ID / SSN<span className="req">*Private — never shown to models</span></label>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <input
                      style={{ flex: 1 }}
                      type="password"
                      placeholder={d.ssn_last4 !== null ? `On file (…${d.ssn_last4}) — type to replace` : "Optional"}
                      value={d.ssn}
                      disabled={busy}
                      onChange={(e) => setD((x) => ({ ...x, ssn: e.target.value }))}
                    />
                    {d.ssn_last4 !== null && (
                      <label className="small" style={{ whiteSpace: "nowrap" }}><input type="checkbox" checked={d.clear_ssn} disabled={busy} onChange={(e) => setD((x) => ({ ...x, clear_ssn: e.target.checked }))} /> remove</label>
                    )}
                  </div>
                </div>
                <div className="fgrid-3">
                  <div>
                    <label className="field-label">Citizenship</label>
                    <input placeholder="Country" value={d.citizenship} disabled={busy} onChange={(e) => setD((x) => ({ ...x, citizenship: e.target.value }))} />
                  </div>
                  <div>
                    <label className="field-label">Country of Residence</label>
                    <input placeholder="Country" value={d.country_of_residence} disabled={busy} onChange={(e) => setD((x) => ({ ...x, country_of_residence: e.target.value }))} />
                  </div>
                  <div>
                    <label className="field-label">State / Province</label>
                    <input placeholder="State" value={d.state_or_province} disabled={busy} onChange={(e) => setD((x) => ({ ...x, state_or_province: e.target.value }))} />
                  </div>
                </div>
                <div className="fgrid-3">
                  <div>
                    <label className="field-label">Marital Status</label>
                    <select value={d.marital_status} disabled={busy} onChange={(e) => setD((x) => ({ ...x, marital_status: e.target.value }))}>
                      <option value="">Choose…</option>
                      <option value="single">Single</option>
                      <option value="married">Married</option>
                      <option value="partnered">Partnered</option>
                      <option value="divorced">Divorced</option>
                      <option value="widowed">Widowed</option>
                    </select>
                  </div>
                  <div>
                    <label className="field-label">Display Currency</label>
                    <select value={d.preferred_currency} disabled={busy} onChange={(e) => setD((x) => ({ ...x, preferred_currency: e.target.value }))} title="Everything displays converted into this currency">
                      {["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "TRY", "ILS", "INR", "KRW", "CNY", "HKD", "SGD", "MXN", "BRL", "ZAR"].map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="form-section">
            <div className="sec-head">
              <div className="l"><span className="sec-num">2</span><span className="sec-title">Spouse or Partner</span></div>
              <label className="small" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={d.has_spouse} disabled={busy} onChange={(e) => setD((x) => ({ ...x, has_spouse: e.target.checked }))} />
                <span className="uc" style={{ fontSize: 10, fontWeight: 700, color: "var(--t2)" }}>Enable</span>
              </label>
            </div>
            {d.has_spouse && (
              <div className="sec-body">
                <div className="fgrid">
                  <div>
                    <label className="field-label">Full Legal Name</label>
                    <input placeholder="Spouse/partner's full legal name" value={d.spouse.legal_name} disabled={busy} onChange={(e) => setD((x) => ({ ...x, spouse: { ...x.spouse, legal_name: e.target.value } }))} />
                  </div>
                  <div>
                    <label className="field-label">Date of Birth</label>
                    <input placeholder="e.g. Jul 30 1959" value={d.spouse.date_of_birth} disabled={busy} onChange={(e) => setD((x) => ({ ...x, spouse: { ...x.spouse, date_of_birth: e.target.value } }))} />
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="form-section">
            <div className="sec-head">
              <div className="l"><span className="sec-num">3</span><span className="sec-title">Children &amp; Dependents</span></div>
              <button className="ghost" style={{ color: "var(--link)", fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase" }} disabled={busy} onClick={() => setD((x) => ({ ...x, children: [...x.children, emptyRel()] }))}>
                + Add Child
              </button>
            </div>
            <div className="sec-body">
              {d.children.length === 0 && <p className="small muted" style={{ margin: 0 }}>No children recorded.</p>}
              {d.children.map((c, i) => (
                <PersonRow key={i} r={c} disabled={busy} relPlaceholder="son / daughter / stepchild" onChange={(r) => setD((x) => ({ ...x, children: x.children.map((y, j) => (j === i ? r : y)) }))} onRemove={() => setD((x) => ({ ...x, children: x.children.filter((_, j) => j !== i) }))} />
              ))}
            </div>
          </section>

          <section className="form-section">
            <div className="sec-head">
              <div className="l"><span className="sec-num">4</span><span className="sec-title">Anyone Else In Your Will</span></div>
              <button className="ghost" style={{ color: "var(--link)", fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase" }} disabled={busy} onClick={() => setD((x) => ({ ...x, others: [...x.others, emptyRel()] }))}>
                + Add Person
              </button>
            </div>
            <div className="sec-body">
              <p className="small muted" style={{ marginTop: 0 }}>Parents, siblings, godchildren, close friends, charities — anyone you may want named.</p>
              {d.others.map((o, i) => (
                <PersonRow key={i} r={o} disabled={busy} relPlaceholder="relationship" onChange={(r) => setD((x) => ({ ...x, others: x.others.map((y, j) => (j === i ? r : y)) }))} onRemove={() => setD((x) => ({ ...x, others: x.others.filter((_, j) => j !== i) }))} />
              ))}
            </div>
          </section>

          {error !== null && <div className="banner">{error}</div>}
          <div className="form-foot">
            <p className="note">No information is shared until you press Save Profile.</p>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {saved && <span className="pill low">saved</span>}
              <button className="secondary" disabled={busy} onClick={reset}>Reset Form</button>
              <button disabled={busy} onClick={() => { void save().then((ok) => { if (ok) onChanged(); }); }}>{busy ? "saving…" : "Save Profile"}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Free-text intake: the model proposes fields into the UNSAVED form; the operator reviews and saves. */
function ProfileIntake({ setD, disabled }: { setD: (fn: (d: ProfileDraft) => ProfileDraft) => void; disabled: boolean }) {
  const [text, setTextState] = useState(() => DRAFTS.get("profile-intake") ?? "");
  const setText = (v: string) => {
    DRAFTS.set("profile-intake", v);
    setTextState(v);
  };
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const intakeRef = useRef<HTMLDivElement | null>(null);
  const run = async () => {
    const t = text.trim();
    if (t === "") return;
    setText("");
    setPending(t);
    requestAnimationFrame(() => intakeRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }));
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const patch = await api.profileExtract(t);
      const filled: string[] = [];
      setD((x) => {
        const next = { ...x };
        const pp = patch.person ?? {};
        const setField = (key: keyof ProfileDraft, v: string | undefined, label: string) => {
          if (v !== undefined && v !== "") {
            (next as Record<string, unknown>)[key] = v;
            filled.push(label);
          }
        };
        setField("legal_name", pp.legal_name, "your name");
        setField("preferred_name", pp.preferred_name, "your preferred name");
        setField("date_of_birth", pp.date_of_birth, "your date of birth");
        setField("ssn", pp.ssn, "your tax id");
        setField("citizenship", pp.citizenship, "your citizenship");
        setField("country_of_residence", pp.country_of_residence, "your country of residence");
        setField("state_or_province", pp.state_or_province, "your state");
        setField("marital_status", pp.marital_status, "your marital status");
        if (patch.spouse != null) {
          next.has_spouse = true;
          next.spouse = toRel(patch.spouse);
          filled.push("spouse");
        }
        const have = (list: Rel[], name: string) => list.some((r) => r.legal_name.trim().toLowerCase() === name.trim().toLowerCase());
        for (const c of patch.children ?? []) {
          if (!have(next.children, c.legal_name)) {
            next.children = [...next.children, toRel(c)];
            filled.push(`child ${c.legal_name}${c.date_of_birth != null && c.date_of_birth !== "" ? " (with birth date)" : " (no birth date)"}`);
          }
        }
        for (const o of patch.others ?? []) {
          if (!have(next.others, o.legal_name)) {
            next.others = [...next.others, toRel(o)];
            filled.push(`${o.legal_name}${o.date_of_birth != null && o.date_of_birth !== "" ? " (with birth date)" : ""}`);
          }
        }
        return next;
      });
      setResult(
        (filled.length > 0 ? `Filled in: ${filled.join(", ")}. Review above and press Save profile.` : "Nothing new found in that.") +
          (patch.note !== undefined ? ` (${patch.note})` : ""),
      );
    } catch (e) {
      setError(String(e));
      setText(t); // the draft comes back rather than being lost
    } finally {
      setPending(null);
      setBusy(false);
    }
  };
  return (
    <div className="magic-card">
      <div className="blob" />
      <div className="m-head">
        <span className="icon-tile"><Icon name="sparkle" /></span>
        <span className="m-title">AI Narrative Import</span>
      </div>
      <p style={{ fontSize: 12, color: "var(--t2)", lineHeight: 1.6, margin: "0 0 14px" }}>
        Instead of filling every box, just describe your household in plain English. The details are extracted into the
        form for your review.
      </p>
      <div className="magic-ta">
        <textarea
          placeholder={busy ? "reading…" : 'e.g. "I\'m Brian, born in California, married to Alex since 2001. We have two kids: Sam (2004-03-02) and Riley, who\'s 15. My brother Ted should be in the will."'}
          value={text}
          disabled={busy || disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void run();
            }
          }}
        />
        <button className="go" disabled={busy || disabled} onClick={() => void run()}>{busy ? "…" : "Fill Profile"}</button>
      </div>
      {pending !== null && (
        <div ref={intakeRef} style={{ marginTop: 12 }}>
          <div className="pending-msg small">{pending}</div>
          <Thinking label="Reading what you wrote and filling in the form" />
        </div>
      )}
      {result !== null && <div className="banner" style={{ marginTop: 12 }}>{result}</div>}
      {error !== null && <div className="banner" style={{ marginTop: 12 }}>{error}</div>}
      <div className="guard">
        <div className="g-head"><Icon name="shield-check" /> Privacy Guard</div>
        <p>
          Your words go to the AI model to be understood; the fields it suggests land in the form unsaved, for you to
          check. Your stored tax ID is never sent. Nothing is saved until you press Save Profile.
        </p>
      </div>
    </div>
  );
}

// --- Credentials: paste keys once; the app keeps them in the Keychain ---

type CredentialsData = Awaited<ReturnType<typeof api.credentials>>;


/** The factory reset: everything on disk and every Keychain secret, after typed confirmation. */
function DeleteAllDataCard() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wiped, setWiped] = useState(false);
  const wipe = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteAllData();
      try {
        localStorage.clear();
      } catch {
        /* private mode */
      }
      setWiped(true);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };
  if (wiped) {
    return (
      <div className="queue-item" style={{ marginTop: 18 }}>
        <div className="head"><b>Everything has been deleted</b></div>
        <p>
          The ledger, documents, profile, settings, and every stored key are gone. Quit the app{isMac() ? " (⌘Q)" : ""} and relaunch
          to start fresh.
        </p>
        <p className="small muted">
          One thing this cannot do: revoke access on the other side. If you had connected banks or exchanges, also
          remove this app's access in their own settings (Plaid-connected banks, Enable Banking consents, Coinbase and
          Kraken API keys).{isWindows() &&
            " The WebView2 runtime also keeps this window's browsing data under %LOCALAPPDATA%\\com.corbitsdev.macos.personal-finance — delete that folder after quitting."}
        </p>
      </div>
    );
  }
  return (
    <div className="queue-item" style={{ marginTop: 18 }}>
      <div className="head">
        <b>Delete all data</b>
        {!open && <button className="secondary" onClick={() => setOpen(true)}>Delete all data…</button>}
      </div>
      <div className="small muted">
        The factory reset: removes the entire ledger and its history, all documents, your profile, every setting, and
        every key from {theKeychain()}. This cannot be undone.
      </div>
      {open && (
        <>
          <p className="small" style={{ marginTop: 8 }}>Type <b>DELETE</b> to confirm.</p>
          <div className="actions">
            <input style={{ width: 160 }} placeholder="DELETE" value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
            <button disabled={busy || text.trim() !== "DELETE"} onClick={() => void wipe()}>
              {busy ? "deleting…" : "Delete everything"}
            </button>
            <button className="secondary" disabled={busy} onClick={() => { setOpen(false); setText(""); }}>Cancel</button>
          </div>
        </>
      )}
      {error !== null && <div className="banner" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

/** Multi-user: change your login name or password. The name is also the username at sign-in. */
function AccountCard({ user, onRenamed }: { user: { id: string; name: string }; onRenamed: (name: string) => void }) {
  const [name, setName] = useState(user.name);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      setNote(await fn());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };
  const rename = () =>
    act("rename", async () => {
      const r = await api.renameMe(name.trim());
      onRenamed(r.name);
      return `You now sign in as "${r.name}".`;
    });
  const changePw = () =>
    act("password", async () => {
      if (newPw !== confirmPw) throw new Error("The two new passwords don't match.");
      await api.changeMyPassword(oldPw, newPw);
      setOldPw("");
      setNewPw("");
      setConfirmPw("");
      return isMac() ? "Password changed — your encrypted store now opens with the new one." : "Password changed.";
    });
  return (
    <div className="queue-item">
      <div className="head"><b>Your account</b><span className="muted small">{user.id}</span></div>
      <div className="small muted">Your name is also your username at sign-in.{isMac() && " Changing the password re-keys your encrypted store."}</div>
      <div className="actions" style={{ marginTop: 8 }}>
        <input style={{ flex: 1, maxWidth: 280 }} placeholder="Your name" value={name} disabled={busy !== null} onChange={(e) => setName(e.target.value)} />
        <button disabled={busy !== null || name.trim() === "" || name.trim() === user.name} onClick={() => void rename()}>
          {busy === "rename" ? "renaming…" : "Rename"}
        </button>
      </div>
      <div className="actions" style={{ marginTop: 6 }}>
        <input style={{ width: 170 }} type="password" placeholder="Current password" value={oldPw} disabled={busy !== null} onChange={(e) => setOldPw(e.target.value)} />
        <input style={{ width: 160 }} type="password" placeholder="New password" value={newPw} disabled={busy !== null} onChange={(e) => setNewPw(e.target.value)} />
        <input style={{ width: 160 }} type="password" placeholder="Repeat it" value={confirmPw} disabled={busy !== null} onChange={(e) => setConfirmPw(e.target.value)} />
        <button disabled={busy !== null || oldPw === "" || newPw.length < 4} onClick={() => void changePw()}>
          {busy === "password" ? "changing…" : "Change password"}
        </button>
      </div>
      {note !== null && <p className="small" style={{ marginTop: 6 }}>{note}</p>}
      {error !== null && <div className="banner" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function CredentialsPage({ tick, onChanged, user, onRenamed }: { tick: number; onChanged: () => void; user: { id: string; name: string } | null; onRenamed: (name: string) => void }) {
  const [data, setData] = useState<CredentialsData | null>(null);
  useEffect(() => {
    api.credentials().then(setData).catch(() => setData(null));
  }, [tick]);
  if (data === null) return <p className="muted">Host unreachable.</p>;
  return (
    <>
      <h2>Credentials</h2>
      <p className="small muted">
        Every key is pasted once, stored in {yourKeychain()} by the app, and shown here only as set / not set — the
        values never leave this machine. None of these keys can move money.
      </p>
      {user !== null && <AccountCard user={user} onRenamed={onRenamed} />}
      {data.slots.map((s) => (
        <CredentialCard key={s.id} slot={s} onChanged={onChanged} />
      ))}
      <InferenceCard tick={tick} />
      {data.tokens.length > 0 && (
        <>
          <h3>Connection tokens</h3>
          <p className="small muted">
            Stored automatically when you connect an institution; removed automatically when you delete one. Removing a
            token here disconnects that institution until you reconnect it.
          </p>
          <table>
            <thead><tr><th>Institution</th><th>Kind</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {data.tokens.map((t) => (
                <TokenRow key={t.institution_id} t={t} onChanged={onChanged} />
              ))}
            </tbody>
          </table>
        </>
      )}
      <DeleteAllDataCard />
    </>
  );
}

/** Which AI engine answers: Anthropic's cloud, or a local server (Apple MLX, LM Studio) so nothing leaves this Mac. */
const INFERENCE_TASKS: ReadonlyArray<readonly [string, string, string]> = [
  ["profile", "People", "the free-text intake on the People page — works well on small local models"],
  ["estate", "Estate", "the Estate Planner chat and its drafts"],
  ["tax", "Tax", "reserved: tax math is deterministic today; applies when model-backed tax planning arrives"],
  ["strategy", "Strategy", "the Strategist chat"],
];

/** Configure any number of AI providers; assign a default and one per task. Keys go to the Keychain. */
function InferenceCard({ tick }: { tick: number }) {
  type S = import("./api").InferenceState;
  const [state, setState] = useState<S | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [addSel, setAddSel] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.inference().then(setState).catch(() => setState(null));
  }, [tick]);
  if (state === null) return null;
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const setProvider = (i: number, patch: Partial<S["providers"][number]>) =>
    setState((x) => (x === null ? x : { ...x, providers: x.providers.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  const addProvider = () => {
    if (addSel === "") return;
    const preset = addSel === "__other__" ? undefined : state.presets.find((pr) => pr.id === addSel);
    const base = preset ?? { id: "other", label: "Other provider", kind: "openai-compatible" as const, base_url: "https://", model: "" };
    let id = base.id;
    let n = 2;
    while (state.providers.some((p) => p.id === id)) id = `${base.id}-${n++}`;
    setState((x) => (x === null ? x : { ...x, providers: [...x.providers, { id, kind: base.kind, label: base.label, base_url: base.base_url, model: base.model }] }));
    setAddSel("");
  };
  const removeProvider = (id: string) =>
    setState((x) => {
      if (x === null || x.providers.length <= 1) return x;
      const providers = x.providers.filter((p) => p.id !== id);
      const fallback = providers[0]!.id;
      const tasks = Object.fromEntries(Object.entries(x.tasks ?? {}).filter(([, v]) => v !== id));
      return { ...x, providers, default: x.default === id ? fallback : x.default, tasks };
    });
  const save = () =>
    act(async () => {
      const r = await api.inferenceSave(
        { version: "2", providers: state.providers, default: state.default, ...(state.tasks !== undefined && Object.keys(state.tasks).length > 0 ? { tasks: state.tasks } : {}) },
        keys,
      );
      setState(r);
      setKeys({});
      setStatus("Saved. New turns use these providers immediately — no restart.");
    });
  const test = (provider?: string) =>
    act(async () => {
      const r = await api.inferenceTest(provider !== undefined ? { provider } : undefined);
      setStatus(`${provider ?? "default"}: ${r.ok ? `working — ${r.detail}` : `not working — ${r.detail}`}`);
    });
  const providerName = (id: string): string => state.providers.find((p) => p.id === id)?.label ?? id;
  return (
    <div className="queue-item">
      <div className="head">
        <b>AI providers</b>
        <span className="pill info">{providerName(state.default)} by default</span>
      </div>
      <div className="small muted">
        Configure as many providers as you like; each of Profile, Estate, Tax, and Strategy can use its own. Keys are
        pasted once and stored in {yourKeychain()} — never shown again. A local server means nothing you discuss
        leaves {thisMachine()}.
      </div>
      {state.providers.map((p, i) => (
        <div key={p.id} style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
          <div className="actions">
            <b style={{ minWidth: 170 }}>{p.label}</b>
            <span className={`pill ${state.key_set[p.id] === true ? "low" : "medium"}`}>{state.key_set[p.id] === true ? "ready" : "needs a key"}</span>
            <button className="secondary" disabled={busy} onClick={() => void test(p.id)}>Test</button>
            {state.providers.length > 1 && (
              <button className="secondary" disabled={busy} onClick={() => removeProvider(p.id)}>Remove</button>
            )}
          </div>
          <div className="actions" style={{ marginTop: 4 }}>
            <input style={{ flex: 1 }} placeholder="Server address" value={p.base_url} disabled={busy} onChange={(e) => setProvider(i, { base_url: e.target.value })} />
            <input style={{ width: 240 }} placeholder="Model name" value={p.model} disabled={busy} onChange={(e) => setProvider(i, { model: e.target.value })} />
            <input
              style={{ width: 220 }}
              type="password"
              placeholder={state.key_set[p.id] === true ? "key stored — type to replace" : "API key"}
              value={keys[p.id] ?? ""}
              disabled={busy}
              onChange={(e) => setKeys((k) => ({ ...k, [p.id]: e.target.value }))}
            />
          </div>
        </div>
      ))}
      <div className="actions" style={{ marginTop: 10 }}>
        <select value={addSel} disabled={busy} onChange={(e) => setAddSel(e.target.value)}>
          <option value="">Add a provider…</option>
          {state.presets.map((pr) => (
            <option key={pr.id} value={pr.id}>{pr.label}</option>
          ))}
          <option value="__other__">Other OpenAI compatible Provider</option>
        </select>
        <button className="secondary" disabled={busy || addSel === ""} onClick={addProvider}>Add</button>
      </div>
      <div style={{ marginTop: 10 }}>
        <div className="small muted" style={{ marginBottom: 4 }}><b>Assignments</b></div>
        <div className="actions" style={{ marginTop: 4 }}>
          <span style={{ width: 70, display: "inline-block" }}>Default</span>
          <select value={state.default} disabled={busy} onChange={(e) => setState((x) => (x === null ? x : { ...x, default: e.target.value }))}>
            {state.providers.map((p) => (
              <option key={p.id} value={p.id}>{p.label} — {p.model}</option>
            ))}
          </select>
        </div>
        {INFERENCE_TASKS.map(([id, label, hint]) => (
          <div key={id} className="actions" style={{ marginTop: 4 }}>
            <span style={{ width: 70, display: "inline-block" }}>{label}</span>
            <select
              value={state.tasks?.[id] ?? ""}
              disabled={busy}
              onChange={(e) =>
                setState((x) => {
                  if (x === null) return x;
                  const tasks = { ...(x.tasks ?? {}) };
                  if (e.target.value === "") delete tasks[id];
                  else tasks[id] = e.target.value;
                  return { ...x, tasks };
                })
              }
            >
              <option value="">Use default</option>
              {state.providers.map((p) => (
                <option key={p.id} value={p.id}>{p.label} — {p.model}</option>
              ))}
            </select>
            <span className="small muted">{hint}</span>
          </div>
        ))}
      </div>
      <div className="actions" style={{ marginTop: 8 }}>
        <button disabled={busy} onClick={() => void save()}>{busy ? "…" : "Save"}</button>
      </div>
      {status !== null && <div className="banner" style={{ marginTop: 8 }}>{status}</div>}
      {error !== null && <div className="banner" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

/** Credential notes name websites (dashboard.plaid.com, enablebanking.com...); make them clickable. */
function NoteText({ text }: { text: string }) {
  const parts = text.split(/((?:[a-z0-9-]+\.)+(?:com|io|org)(?:\/[\w./-]*)?)/gi);
  return (
    <>
      {parts.map((part, i) =>
        /^(?:[a-z0-9-]+\.)+(?:com|io|org)/i.test(part) ? (
          <a key={i} style={{ cursor: "pointer", textDecoration: "underline" }} onClick={() => void api.openExternal(`https://${part}`).catch(() => {})}>
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

function CredentialCard({ slot, onChanged }: { slot: CredentialsData["slots"][number]; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEditing(false);
      setConfirmDelete(false);
      setValues({});
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="queue-item">
      <div className="head">
        <b>{slot.label}</b>
        <span className={`pill ${slot.configured ? "low" : "medium"}`}>{slot.configured ? "set up" : "not set up"}</span>
      </div>
      <div className="small muted"><NoteText text={slot.note} /></div>
      {editing ? (
        <>
          {slot.fields.map((f) => (
            <div key={f.account} className="actions" style={{ marginTop: 6 }}>
              {f.multiline ? (
                <textarea
                  style={{ flex: 1, minHeight: 80, fontFamily: "monospace", fontSize: 11 }}
                  placeholder={f.label}
                  value={values[f.account] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.account]: e.target.value }))}
                />
              ) : (
                <input
                  style={{ flex: 1 }}
                  type="password"
                  placeholder={f.label}
                  value={values[f.account] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.account]: e.target.value }))}
                />
              )}
            </div>
          ))}
          <div className="actions" style={{ marginTop: 6 }}>
            <button disabled={busy} onClick={() => void act(() => api.credentialSet(slot.id, values))}>
              {busy ? "saving…" : isWindows() ? "Save to Credential Manager" : isMac() ? "Save to Keychain" : "Save key"}
            </button>
            <button className="secondary" disabled={busy} onClick={() => { setEditing(false); setValues({}); setError(null); }}>Cancel</button>
          </div>
        </>
      ) : (
        <div className="actions" style={{ marginTop: 8 }}>
          <button className="secondary" disabled={busy} onClick={() => setEditing(true)}>
            {slot.configured ? "Replace" : "Set up"}
          </button>
          {slot.configured &&
            (confirmDelete ? (
              <>
                <span className="small">Remove this key from {theKeychain()}?</span>
                <button disabled={busy} onClick={() => void act(() => api.credentialDelete(slot.id))}>Yes, remove</button>
                <button className="secondary" onClick={() => setConfirmDelete(false)}>Cancel</button>
              </>
            ) : (
              <button className="secondary" disabled={busy} onClick={() => setConfirmDelete(true)}>Remove</button>
            ))}
        </div>
      )}
      {error !== null && <div className="banner" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function TokenRow({ t, onChanged }: { t: CredentialsData["tokens"][number]; onChanged: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const kind = t.adapter === "plaid" ? "Plaid access token" : t.adapter === "enablebanking" ? "bank consent session" : t.adapter === "kraken" ? "Kraken API key" : "Coinbase API key";
  const remove = async () => {
    setBusy(true);
    try {
      await api.connectionTokensDelete(t.institution_id);
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const done = () => {
    setReconnecting(false);
    onChanged();
  };
  return (
    <>
      <tr>
        <td>{t.name}<div className="small muted">{t.institution_id}</div></td>
        <td className="small">{kind}</td>
        <td>
          {t.set ? (
            <span className="pill low">stored</span>
          ) : (
            // The words ARE the fix: clicking opens the reconnect flow for
            // this institution right here.
            <button className="linklike" title={`Reconnect ${t.name} now`} onClick={() => setReconnecting((r) => !r)}>
              <span className="pill medium">missing — reconnect</span>
            </button>
          )}
        </td>
        <td>
          {t.set &&
            (confirm ? (
              <>
                <span className="small">Disconnects until you reconnect. </span>
                <button disabled={busy} onClick={() => void remove()}>Yes, remove</button>{" "}
                <button className="secondary" onClick={() => setConfirm(false)}>Cancel</button>
              </>
            ) : (
              <button className="secondary" disabled={busy} onClick={() => setConfirm(true)}>Remove</button>
            ))}
        </td>
      </tr>
      {reconnecting && (
        <tr>
          <td colSpan={4}>
            {t.adapter === "plaid" && <PlaidConnect name={t.name} institutionId={t.institution_id} onDone={done} />}
            {t.adapter === "enablebanking" && <EbConnect name={t.name} institutionId={t.institution_id} preset={null} onDone={done} />}
            {t.adapter === "coinbase" && <CoinbaseConnect name={t.name} institutionId={t.institution_id} onDone={done} />}
            {t.adapter === "kraken" && <KrakenConnect name={t.name} institutionId={t.institution_id} onDone={done} />}
          </td>
        </tr>
      )}
    </>
  );
}

// --- Institutions: connect, pause, delete, and keep values current ---
// No JSON, no files in the home directory: forms and uploads only.

const ACCOUNT_TYPE_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["checking", "Checking"],
  ["savings", "Savings"],
  ["brokerage", "Investment (brokerage)"],
  ["ira", "Retirement — IRA"],
  ["401k", "Retirement — 401(k)"],
  ["hsa", "Health savings (HSA)"],
  ["crypto", "Crypto"],
  ["real_estate", "Real estate"],
  ["credit_card", "Credit card"],
  ["mortgage", "Mortgage"],
  ["loan", "Loan"],
  ["other", "Property or other"],
];
const typeLabel = (t: string): string => ACCOUNT_TYPE_OPTIONS.find(([v]) => v === t)?.[1] ?? t;

/**
 * THE page header, one structure everywhere: a title row (page-level
 * actions on its right), a short description of what the area is for,
 * and the tab navigation on its own row below. Each container renders
 * at the same place on the page regardless of which tab is active.
 */
function PageHeader({ title, sub, tabs, actions }: { title: React.ReactNode; sub: string; tabs?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="page-header">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h2>{title}</h2>
          <p className="page-sub">{sub}</p>
        </div>
        {actions !== undefined && <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>{actions}</div>}
      </div>
      {tabs !== undefined && <div style={{ marginTop: 16 }}>{tabs}</div>}
    </div>
  );
}

/**
 * THE page-tab control: a segmented button group, one row below the
 * page title and description (see PageHeader). Counts render as chips
 * inside the buttons.
 */
function SegTabs<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (t: T) => void;
  options: ReadonlyArray<{ id: T; label: string; count?: number; tone?: "green" | "red" }>;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.id} className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)}>
          {o.label}
          {o.count !== undefined && o.count > 0 && <span className={`tab-count${o.tone !== undefined ? ` ${o.tone}` : ""}`}>{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
const OWED_TYPES = new Set(["credit_card", "mortgage", "loan", "heloc"]);

type HoldingsTab = "institutions" | "real_estate" | "crypto";
const CRYPTO_ADAPTERS = new Set(["coinbase", "kraken", "wallet"]);

/** Which tab a connection belongs on: explicit category first, then the adapter, then what it holds. */
function holdingsTabOf(i: InstitutionOverview): HoldingsTab {
  if (i.category === "real_estate") return "real_estate";
  if (i.category === "crypto" || CRYPTO_ADAPTERS.has(i.adapter)) return "crypto";
  const open = i.accounts.filter((a) => !a.closed);
  if (open.length > 0 && open.every((a) => a.type === "real_estate")) return "real_estate";
  if (open.length > 0 && open.every((a) => a.type === "crypto")) return "crypto";
  return "institutions";
}

/** The Setup Progress rail: where a new household is on the road to a live ledger. */
function SetupProgress({ ob, profileOk }: { ob: InstitutionsOverview; profileOk: boolean }) {
  const steps: Array<{ title: string; desc: string; done: boolean }> = [
    { title: "Create Account", desc: `Local store ready on ${thisMachine()}.`, done: true },
    {
      title: "Connect Institutions",
      desc: ob.institutions.length > 0 ? `${ob.institutions.length} connected.` : "Connect a bank, broker, or wallet.",
      done: ob.institutions.length > 0,
    },
    { title: "Household Profile", desc: "Define beneficiaries and dependents.", done: profileOk },
    { title: "First Numbers", desc: ob.hasFacts ? "Balances observed and recorded." : "Fetch the numbers for the first time.", done: ob.hasFacts },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const current = steps.findIndex((s) => !s.done);
  // Setup is a checklist, not a trophy: once everything is done, the card
  // has nothing left to say and gets out of the way.
  if (doneCount === steps.length) return null;
  return (
    <div className="panel">
      <div className="panel-title" style={{ marginBottom: 16 }}>Setup Progress</div>
      <div className="steps">
        {steps.map((s, i) => (
          <div key={s.title} className={`step${s.done ? " done" : i === current ? " now" : ""}`}>
            <span className="step-num">{s.done ? <Icon name="check" /> : i + 1}</span>
            <div>
              <div className="t">{s.title}</div>
              <div className="d">{s.desc}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid var(--hairline)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span className="uc" style={{ fontSize: 10, fontWeight: 700, color: "var(--t3)" }}>Completion</span>
          <span className="uc green" style={{ fontSize: 10, fontWeight: 700 }}>{Math.round((doneCount / steps.length) * 100)}%</span>
        </div>
        <div className="progressbar" style={{ marginTop: 0 }}><div style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
      </div>
    </div>
  );
}

function InstitutionsPage({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const [ob, setOb] = useState<InstitutionsOverview | null>(null);
  const [tab, setTab] = useState<HoldingsTab>("institutions");
  const [adding, setAdding] = useState(false);
  const [profileOk, setProfileOk] = useState(false);
  useEffect(() => {
    api.institutionsOverview().then(setOb).catch(() => setOb(null));
    api.profile().then((p) => setProfileOk((p.person?.legal_name ?? "") !== "")).catch(() => setProfileOk(false));
  }, [tick]);
  if (ob === null) return <div className="page"><p className="muted">Host unreachable.</p></div>;
  const inTab = ob.institutions.filter((i) => holdingsTabOf(i) === tab);
  // Drag-to-reorder within the tab: compute the tab's new id order, apply
  // it optimistically (the listed cards swap among their own slots), and
  // persist it as the registry order.
  const dropOn = (from: string, to: string) => {
    if (from === to) return;
    const ids = inTab.map((i) => i.institution_id);
    const fromIdx = ids.indexOf(from);
    const toIdx = ids.indexOf(to);
    if (fromIdx < 0 || toIdx < 0) return;
    ids.splice(fromIdx, 1);
    ids.splice(ids.indexOf(to) + (fromIdx < toIdx ? 1 : 0), 0, from);
    setOb((prev) => {
      if (prev === null) return prev;
      const listed = new Set(ids);
      const slots = prev.institutions.map((x, idx) => (listed.has(x.institution_id) ? idx : -1)).filter((idx) => idx >= 0);
      const byId = new Map(prev.institutions.map((x) => [x.institution_id, x]));
      const next = [...prev.institutions];
      ids.forEach((id, k) => { next[slots[k]!] = byId.get(id)!; });
      return { ...prev, institutions: next };
    });
    api.reorderInstitutions(ids).catch(() => onChanged());
  };
  const none = inTab.length === 0;
  const counts = new Map<HoldingsTab, number>();
  for (const i of ob.institutions) counts.set(holdingsTabOf(i), (counts.get(holdingsTabOf(i)) ?? 0) + 1);
  const addForm =
    tab === "real_estate" ? (
      <AddPropertyForm
        onDone={() => {
          setAdding(false);
          onChanged();
        }}
        onCancel={none ? null : () => setAdding(false)}
      />
    ) : (
      <AddInstitutionForm
        onDone={() => {
          setAdding(false);
          onChanged();
        }}
        onCancel={none ? null : () => setAdding(false)}
        modes={tab === "crypto" ? ["coinbase", "kraken", "wallet"] : ["managed", "files", "plaid", "eb"]}
        existing={ob.institutions.map((i) => i.name)}
      />
    );
  return (
    <div className="page">
      <PageHeader
        title={<>Assets, Cash &amp; Holdings</>}
        sub="Connections are read-only. We can observe your holdings, but we never move money."
        actions={<button onClick={() => setAdding(true)} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Icon name="plus" /> Add Asset</button>}
        tabs={
          <SegTabs
            value={tab}
            onChange={(id) => {
              setTab(id);
              setAdding(false);
            }}
            options={[
              { id: "institutions", label: "Institutions", count: counts.get("institutions") ?? 0 },
              { id: "real_estate", label: "Real Estate", count: counts.get("real_estate") ?? 0 },
              { id: "crypto", label: "Crypto", count: counts.get("crypto") ?? 0 },
            ]}
          />
        }
      />
      <div className="split">
        <div>
          {none && (
            <p className="muted" style={{ marginTop: 0 }}>
              {tab === "institutions" && "No institutions are connected yet. Let's add your first one."}
              {tab === "real_estate" && "No properties yet. Add your first one — its value flows straight into net worth."}
              {tab === "crypto" && "No crypto connections yet. Connect an exchange, or watch a self-custody wallet."}
            </p>
          )}
          {(none || adding) && addForm}
          {inTab.map((i) => (
            <DraggableCard key={i.institution_id} id={i.institution_id} onDropOn={dropOn}>
              <InstitutionCard inst={i} onChanged={onChanged} />
            </DraggableCard>
          ))}
        </div>
        <div className="rail">
          <SetupProgress ob={ob} profileOk={profileOk} />
          <TipsCard />
        </div>
      </div>
    </div>
  );
}

// The Tricks & Tips pool: real behaviors of this app, one sentence each,
// no marketing. Two show at a time and rotate on a timer.
const TIPS: readonly string[] = [
  "Click any figure to see its provenance — a number is never asserted without the evidence behind it.",
  `Your data never leaves ${thisMachine()}. Even AI analysis can run entirely locally — pick providers on the Credentials page.`,
  "Every connection is read-only: the app can observe your holdings, but it can never move money.",
  "Hide a single account with the eye-slash button on its row; hidden accounts are listed under Manage with a Restore button.",
  "Drag an institution card by the strip on its left edge to arrange cards in the order you like — the order is saved.",
  "If a connection token goes missing, click “missing — reconnect” on the Credentials page to fix it on the spot.",
  "Balances refresh nightly on their own; Update now on any card fetches that institution immediately.",
  "Type money naturally: 1250000, $1,250,000 and €1.250.000 all work, and foreign currencies convert at ECB rates.",
  "Dates are freeform too — “Jul 30 1959” works anywhere a date is asked for.",
  "The Queue holds only what genuinely needs your judgment; everything else reconciles silently overnight.",
  "Transfers between your own accounts are detected and paired, so they never count as income or spending.",
  "Documents keeps every raw statement ever ingested — the original evidence behind each number.",
  "The break-glass export writes plain CSVs, your original documents, and a printed guide that needs no software to read.",
  "Pause updates on a card to stop fetching without losing anything; resume whenever you like.",
  "Watch-only wallets need just a public address — pasting a Ledger Live account export works too.",
  "The Positions tab's Consolidated view bundles the same holding across accounts into a single line.",
  "Estate and Strategy chats file every draft they present under Documents → Drafts.",
  "Deleting an institution removes its money from your totals but keeps the history of what was observed.",
  "Assign a different AI provider per task — profile intake runs well on small local models.",
  "Reconnecting an institution keeps account history continuous: new provider ids are matched to the accounts you already have.",
  "Bank consents expire; the card warns two weeks ahead so you can reconnect before updates stop.",
  "Add a property from the Real Estate tab — its value flows straight into net worth and can be edited in place.",
];

/** Two rotating tips from the pool; advances one slot on a timer, starting from a random spot so the card varies between visits. */
function TipsCard() {
  const [at, setAt] = useState(() => Math.floor(Math.random() * TIPS.length));
  useEffect(() => {
    const t = setInterval(() => setAt((x) => (x + 1) % TIPS.length), 12_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="panel">
      <div className="uc" style={{ fontSize: 11, fontWeight: 700, color: "var(--t2)", marginBottom: 12 }}>Tricks &amp; Tips</div>
      <div className="tipbox">{TIPS[at]}</div>
      <div className="tipbox">{TIPS[(at + 1) % TIPS.length]}</div>
    </div>
  );
}

/**
 * Drag-to-reorder wrapper for one institution card. Dragging is armed
 * only from the grip on the card's left edge, so text selection and the
 * inputs inside the card are never hijacked by HTML5 drag.
 */
function DraggableCard({ id, onDropOn, children }: { id: string; onDropOn: (from: string, to: string) => void; children: React.ReactNode }) {
  const [armed, setArmed] = useState(false);
  const [over, setOver] = useState(false);
  return (
    <div
      className="drag-wrap"
      draggable={armed}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/fin-institution", id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => setArmed(false)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("text/fin-institution")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const from = e.dataTransfer.getData("text/fin-institution");
        if (from !== "") {
          e.preventDefault();
          onDropOn(from, id);
        }
      }}
      style={over ? { outline: "2px solid var(--link)", outlineOffset: 2, borderRadius: 12 } : undefined}
    >
      <button
        className="drag-grip"
        title="Drag to reorder"
        onMouseDown={() => setArmed(true)}
        onMouseUp={() => setArmed(false)}
      >
        <Icon name="dots-three" />
        <Icon name="dots-three" />
      </button>
      {children}
    </div>
  );
}

/** The Real Estate tab's add flow: one property, one value -- a managed institution under the hood. */
function AddPropertyForm({ onDone, onCancel }: { onDone: () => void; onCancel: (() => void) | null }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    if (name.trim() === "") {
      setError("Name the property — \"Our house\" or \"12 Main St\" works.");
      return;
    }
    if (value.trim() === "") {
      setError("Enter the current value — 1250000, $1,250,000, and €1.250.000 all work.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const inst = await api.addInstitution(name.trim(), "managed", "real_estate");
      await api.saveManagedAccount(inst.institution_id, { name: name.trim(), type: "real_estate", value: value.trim() });
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="queue-item">
      <div className="head"><b>Add a property</b></div>
      <div className="small muted">
        Its value becomes a dated observation — update it any time (new appraisal, market shift) and the history stays.
        A mortgage is its own account: add it here with type Mortgage, or it arrives with a connected lender.
      </div>
      <div className="actions" style={{ marginTop: 8 }}>
        <input style={{ flex: 1 }} placeholder="Property — e.g. Our house, 12 Main St" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
        <input style={{ width: 160 }} placeholder="Current value" value={value} disabled={busy} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
      </div>
      {error !== null && <div className="banner" style={{ marginTop: 8 }}>{error}</div>}
      <div className="actions" style={{ marginTop: 8 }}>
        <button disabled={busy} onClick={() => void add()}>{busy ? "adding and valuing…" : "Add property"}</button>
        {onCancel !== null && <button className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}

type ConnectMode = "managed" | "files" | "plaid" | "eb" | "coinbase" | "kraken" | "wallet";

/** "Coinbase" -> "Coinbase 2" -> "Coinbase 3": one past the highest counter already in use. */
function uniqueName(base: string, existing: readonly string[]): string {
  const taken = existing.map((n) => n.trim().toLowerCase());
  const b = base.toLowerCase();
  if (!taken.includes(b)) return base;
  const esc = b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let n = 2;
  for (const t of taken) {
    const m = new RegExp(`^${esc} (\\d+)$`).exec(t);
    if (m !== null) n = Math.max(n, Number(m[1]) + 1);
  }
  return `${base} ${n}`;
}

/** The obvious default name for a connect mode; null when only the user can know it. */
const MODE_DEFAULT_NAME: Record<ConnectMode, string | null> = {
  managed: null, files: null, plaid: null, eb: null,
  coinbase: "Coinbase", kraken: "Kraken", wallet: "Wallet",
};

function AddInstitutionForm({ onDone, onCancel, modes, existing }: { onDone: () => void; onCancel: (() => void) | null; modes: readonly ConnectMode[]; existing: readonly string[] }) {
  const firstMode = modes[0] ?? "managed";
  const [name, setName] = useState(() => {
    const d = MODE_DEFAULT_NAME[firstMode];
    return d === null ? "" : uniqueName(d, existing);
  });
  const [mode, setMode] = useState<ConnectMode>(firstMode);
  // A name the user typed themselves is never overwritten by a default.
  const edited = useRef(false);
  const suggestName = (base: string | null) => {
    if (edited.current) return;
    setName(base === null ? "" : uniqueName(base, existing));
  };
  const pickMode = (m: ConnectMode) => {
    setMode(m);
    suggestName(MODE_DEFAULT_NAME[m]);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    if (name.trim() === "") {
      setError("Give the institution a name — e.g. \"Chase\".");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.addInstitution(name.trim(), mode as "managed" | "files");
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const radio = (m: ConnectMode, label: string, hint: string) =>
    modes.includes(m) ? (
      <label style={{ display: "block", marginBottom: 6 }}>
        <input type="radio" checked={mode === m} onChange={() => pickMode(m)} /> {label}
        <div className="small muted" style={{ marginLeft: 20 }}>{hint}</div>
      </label>
    ) : null;
  return (
    <div className="queue-item">
      <div className="head"><b>Add an asset, or connect an institution</b></div>
      <div className="actions" style={{ marginTop: 8 }}>
        <input
          style={{ flex: 1, maxWidth: 320 }}
          placeholder="Name — e.g. Chase, Fidelity"
          value={name}
          onChange={(e) => {
            edited.current = e.target.value.trim() !== "";
            setName(e.target.value);
          }}
        />
      </div>
      <div style={{ marginTop: 8 }}>
        {radio("managed", "I'll type the numbers in myself", "For cash, valuables like art or jewelry, and institutions that can't be connected automatically below. You can update the values any time. (Real estate has its own tab.)")}
        {radio("files", "I'll upload files downloaded from the institution's website", "Each upload is kept unchanged as evidence, and the numbers in it flow into your dashboard.")}
        {radio("plaid", "Connect automatically — US & Canadian banks (via Plaid)", "You log in on your bank's own page; this app only ever receives read-only data. Needs your Plaid keys — set them up once on the Credentials page.")}
        {radio("eb", "Connect automatically — European banks (via Enable Banking)", "The bank's own consent page; read-only by regulation, renewed every few months. Needs your Enable Banking key — set it up once on the Credentials page.")}
        {radio("coinbase", "Connect Coinbase (crypto holdings)", `Uses a view-only Coinbase API key you create — it can look at balances, never trade or withdraw. Stored in ${yourKeychain()}.`)}
        {radio("kraken", "Connect Kraken (crypto holdings)", `Uses a Kraken API key with only the Query Funds permission — it can look at balances, never trade or withdraw. Stored in ${yourKeychain()}.`)}
        {radio("wallet", "Watch a self-custody wallet (Ledger, Trezor, any address)", "Paste public addresses; balances are read from the blockchain. An address can never move funds. The addresses are disclosed to public chain-data services.")}
      </div>
      {mode === "plaid" && <PlaidConnect name={name} institutionId={null} onDone={onDone} />}
      {mode === "eb" && <EbConnect name={name} institutionId={null} preset={null} onDone={onDone} onBankPicked={suggestName} />}
      {mode === "coinbase" && <CoinbaseConnect name={name} institutionId={null} onDone={onDone} />}
      {mode === "kraken" && <KrakenConnect name={name} institutionId={null} onDone={onDone} />}
      {mode === "wallet" && <WalletConnect name={name} onDone={onDone} />}
      {error !== null && <div className="banner" style={{ marginTop: 8 }}>{error}</div>}
      <div className="actions" style={{ marginTop: 8 }}>
        {(mode === "managed" || mode === "files") && (
          <button disabled={busy} onClick={() => void add()}>{busy ? "adding…" : "Add institution"}</button>
        )}
        {onCancel !== null && <button className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}

/**
 * A link the webview can't open itself: the host opens the default
 * browser, and the address stays visible as a copyable fallback.
 */
function ExternalLinkNote({ url }: { url: string }) {
  return (
    <div className="small muted" style={{ marginTop: 6, wordBreak: "break-all" }}>
      Your browser should have opened. If not, copy this address into it:{" "}
      <code style={{ userSelect: "all" }}>{url}</code>
    </div>
  );
}

/** Plaid Hosted Link: open the bank login in the browser; with the registered loopback redirect it finishes by itself. */
function PlaidConnect({ name, institutionId, onDone }: { name: string; institutionId: string | null; onDone: () => void }) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoFinish, setAutoFinish] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => {
    if (pollRef.current !== null) clearInterval(pollRef.current);
  }, []);
  const startPolling = () => {
    if (pollRef.current !== null) clearInterval(pollRef.current);
    const startedAt = Date.now();
    pollRef.current = setInterval(() => {
      void api.plaidPending().then((p) => {
        if (p.state === "done") {
          if (pollRef.current !== null) clearInterval(pollRef.current);
          pollRef.current = null;
          onDone();
        } else if (p.state === "failed") {
          if (pollRef.current !== null) clearInterval(pollRef.current);
          pollRef.current = null;
          setError(p.detail ?? "The connection didn't finish -- try the Finish button.");
        } else if (Date.now() - startedAt > 15 * 60_000 && pollRef.current !== null) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }).catch(() => {});
    }, 2500);
  };
  const start = async () => {
    if (institutionId === null && name.trim() === "") {
      setError("Give the connection a name first — e.g. \"Chase\".");
      return;
    }
    setBusy("start");
    setError(null);
    try {
      const r = await api.plaidStart(institutionId !== null ? { institution_id: institutionId } : { name: name.trim() });
      setLinkToken(r.link_token);
      if (r.hosted_link_url === null) {
        throw new Error("Plaid didn't return a Hosted Link address -- check that Hosted Link is enabled for your Plaid account.");
      }
      setLinkUrl(r.hosted_link_url);
      setAutoFinish(r.auto_finish);
      if (r.auto_finish) startPolling();
      await api.openExternal(r.hosted_link_url);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };
  const finish = async () => {
    if (institutionId === null && name.trim() === "") {
      setError("Give the connection a name first — e.g. \"Chase\".");
      return;
    }
    setBusy("finish");
    setError(null);
    try {
      await api.plaidComplete({
        ...(institutionId !== null ? { institution_id: institutionId } : { name: name.trim() }),
        ...(linkToken !== null ? { link_token: linkToken } : {}),
      });
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div style={{ marginTop: 8 }}>
      <div className="actions">
        <button disabled={busy !== null} onClick={() => void start()}>
          {busy === "start" ? "opening…" : "1 · Open your bank's secure login"}
        </button>
        <button disabled={busy !== null || linkToken === null} onClick={() => void finish()}>
          {busy === "finish" ? "fetching your accounts…" : "2 · I've finished — fetch my accounts"}
        </button>
      </div>
      {linkUrl !== null && <ExternalLinkNote url={linkUrl} />}
      {autoFinish && linkUrl !== null && (
        <p className="small muted" style={{ marginTop: 6 }}>
          <span className="spinner" style={{ marginRight: 6 }} />
          After you approve at the bank, this finishes by itself — the Finish button is only a fallback.
        </p>
      )}
      {error !== null && <div className="banner" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

/** Coinbase: paste the view-only CDP API key; it goes straight to the Keychain via the host. */
function CoinbaseConnect({ name, institutionId, onDone }: { name: string; institutionId: string | null; onDone: () => void }) {
  const [keyName, setKeyName] = useState("");
  const [pem, setPem] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    if (institutionId === null && name.trim() === "") {
      setError("Give the connection a name first — \"Coinbase\" works.");
      return;
    }
    if (pem.trim() === "" || (keyName.trim() === "" && !pem.trim().startsWith("{"))) {
      setError("Paste the private key — or just paste the whole downloaded key file (JSON), which fills in everything.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.connectCoinbase({
        ...(institutionId !== null ? { institution_id: institutionId } : { name: name.trim() }),
        api_key_name: keyName.trim(),
        private_key: pem,
      });
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ marginTop: 8 }}>
      <div className="small muted" style={{ marginBottom: 4 }}>
        In Coinbase: Settings → API → create a key with the <b>View</b> permission only, and download the key file.
        Easiest: paste the <b>whole downloaded file</b> (it's JSON) into the key box below — the name fills in by itself.
        Everything goes into {yourKeychain()}; this app stores nothing else.
      </div>
      <div className="actions">
        <input style={{ flex: 1 }} placeholder="API key name — organizations/…/apiKeys/… (fills in automatically from a pasted key file)" value={keyName} onChange={(e) => setKeyName(e.target.value)} />
      </div>
      <div className="actions" style={{ marginTop: 6 }}>
        <textarea
          style={{ flex: 1, minHeight: 80, fontFamily: "monospace", fontSize: 11 }}
          placeholder={'Paste the downloaded key file here — {"name":"organizations/…","privateKey":"…"} — or just the private key itself'}
          value={pem}
          onChange={(e) => {
            const v = e.target.value;
            setPem(v);
            // Pasted the whole downloaded JSON key file? Fill the name in.
            if (v.trim().startsWith("{")) {
              try {
                const j = JSON.parse(v) as { name?: string };
                if (typeof j.name === "string" && j.name !== "") setKeyName(j.name);
              } catch {
                /* keep typing */
              }
            }
          }}
        />
      </div>
      <div className="actions" style={{ marginTop: 6 }}>
        <button disabled={busy} onClick={() => void connect()}>{busy ? "connecting and fetching…" : "Connect Coinbase"}</button>
      </div>
      {error !== null && <div className="banner" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

/** The account list Ledger Live keeps on this Mac: tick the ones to watch. Local read only. */
function LedgerLiveImport({ name, onDone }: { name: string; onDone: () => void }) {
  type LL = Awaited<ReturnType<typeof api.ledgerLiveAccounts>>;
  const [data, setData] = useState<LL | null | "loading">(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setData("loading");
    setError(null);
    try {
      const r = await api.ledgerLiveAccounts();
      setData(r);
      // Pre-tick every supported account.
      setChecked(Object.fromEntries(r.accounts.filter((a) => a.supported).map((a) => [a.id, true])));
    } catch (e) {
      setData(null);
      setError(String(e));
    }
  };
  const connect = async () => {
    if (data === null || data === "loading") return;
    const holdings = data.accounts.filter((a) => a.supported && checked[a.id] === true && a.holding !== undefined).map((a) => a.holding!);
    if (holdings.length === 0) {
      setError("Tick at least one account.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.connectWallet({ name: name.trim() === "" ? "Ledger" : name.trim(), holdings });
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ marginTop: 10 }}>
      {data === null && (
        <button className="secondary" onClick={() => void load()}>
          Import from Ledger Wallet (Ledger Live) on {thisMachine()}
        </button>
      )}
      {data === "loading" && <span className="muted small">reading the Ledger app's account list…</span>}
      {data !== null && data !== "loading" && (
        <>
          {data.permission_denied === true ? (
            <div className="banner">
              <b>macOS is protecting other apps' data</b> — it refused to let this app read your Ledger accounts, and it
              doesn't always show an Allow dialog for helper processes. One-time fix:
              <ol className="small" style={{ margin: "6px 0 6px 18px" }}>
                <li>Open the privacy settings (button below — lands on Full Disk Access).</li>
                <li>Click <b>+</b>, add <b>Corbits Personal Finance</b> from Applications, and switch it on.</li>
                <li>Come back and hit Try again (if it still refuses, quit and reopen this app once).</li>
              </ol>
              <div className="actions">
                <button onClick={() => void api.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")}>
                  Open macOS privacy settings
                </button>
                <button className="secondary" onClick={() => void load()}>Try again</button>
              </div>
              <div className="small muted" style={{ marginTop: 4 }}>Or skip all of this and paste the addresses above.</div>
            </div>
          ) : (
            data.error !== undefined && <div className="banner">{data.error}</div>
          )}
          {data.accounts.length > 0 && (
            <>
              <div className="small muted" style={{ marginBottom: 4 }}>
                Found in your Ledger app (read locally — nothing is sent anywhere). Balances shown are its last sync;
                once watched, balances come live from the blockchain.
              </div>
              {data.accounts.map((a) => (
                <label key={a.id} style={{ display: "block", marginBottom: 4, opacity: a.supported ? 1 : 0.6 }}>
                  <input
                    type="checkbox"
                    disabled={!a.supported || busy}
                    checked={checked[a.id] === true}
                    onChange={(e) => setChecked((c) => ({ ...c, [a.id]: e.target.checked }))}
                  />{" "}
                  <b>{a.name}</b> <span className="pill info">{a.chain}</span>{" "}
                  {a.balance !== null && <span className="small muted">{a.balance}</span>}
                  {!a.supported && a.reason !== undefined && <div className="small muted" style={{ marginLeft: 20 }}>{a.reason}</div>}
                </label>
              ))}
              <div className="actions" style={{ marginTop: 6 }}>
                <button disabled={busy} onClick={() => void connect()}>
                  {busy ? "reading the blockchain…" : "Watch the ticked accounts"}
                </button>
              </div>
            </>
          )}
        </>
      )}
      {error !== null && <div className="banner" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

/** Watch-only wallet: paste addresses; the chain is recognized from the address itself. */
function WalletConnect({ name, onDone }: { name: string; onDone: () => void }) {
  const [rows, setRows] = useState<Array<{ value: string; label: string; chain: string | null; note: string | null; problem: string | null }>>([
    { value: "", label: "", chain: null, note: null, problem: null },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setRow = (i: number, patch: Partial<{ value: string; label: string; chain: string | null; note: string | null; problem: string | null }>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const detect = async (i: number, value: string) => {
    if (value.trim() === "") {
      setRow(i, { chain: null, note: null, problem: null });
      return;
    }
    try {
      const d = await api.walletDetect(value);
      if (d.ok) {
        setRow(i, {
          chain: d.chain,
          note: d.note ?? null,
          problem: null,
          // A pasted Ledger Live account object collapses to its address,
          // and brings its account name along as the label.
          ...(d.value !== value.trim() ? { value: d.value } : {}),
          ...(d.label !== undefined && rows[i]?.label.trim() === "" ? { label: d.label } : {}),
        });
      } else {
        setRow(i, { chain: null, note: null, problem: d.reason });
      }
    } catch {
      setRow(i, { chain: null, note: null, problem: null });
    }
  };
  const connect = async () => {
    if (name.trim() === "") {
      setError("Give the wallet a name first — \"Ledger\" works.");
      return;
    }
    const holdings = rows
      .filter((r) => r.value.trim() !== "")
      .map((r) => ({ value: r.value.trim(), ...(r.label.trim() !== "" ? { label: r.label.trim() } : {}) }));
    if (holdings.length === 0) {
      setError("Paste at least one address. In Ledger Live: each account's receive address (Accounts → Receive).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.connectWallet({ name: name.trim(), holdings });
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ marginTop: 8 }}>
      <div className="small muted" style={{ marginBottom: 4 }}>
        Public addresses only — they can show balances, never move funds. Just paste; the chain is recognized from the
        address itself (Bitcoin, Litecoin, Ethereum, Solana, and legacy Bitcoin xpubs today). In Ledger Live, copy each
        account's receive address. Note: the addresses are looked up via public chain services, which learn that someone
        asked about them.
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ marginTop: 6 }}>
          <div className="actions">
            <input
              style={{ flex: 1 }}
              placeholder="Paste an address — bc1…, 0x…, L…, xpub…, a Solana address…"
              value={r.value}
              onChange={(e) => setRow(i, { value: e.target.value })}
              onBlur={(e) => void detect(i, e.target.value)}
            />
            <input style={{ width: 130 }} placeholder="label (optional)" value={r.label} onChange={(e) => setRow(i, { label: e.target.value })} />
            {r.chain !== null && <span className="pill low">{r.chain}</span>}
          </div>
          {r.note !== null && <div className="small muted" style={{ marginTop: 2 }}>{r.note}</div>}
          {r.problem !== null && <div className="small" style={{ marginTop: 2 }}><span className="pill high">{r.problem}</span></div>}
        </div>
      ))}
      <div className="actions" style={{ marginTop: 6 }}>
        <button className="secondary" disabled={busy} onClick={() => setRows((r) => [...r, { value: "", label: "", chain: null, note: null, problem: null }])}>
          Add another address
        </button>
        <button disabled={busy} onClick={() => void connect()}>{busy ? "reading the blockchain…" : "Watch this wallet"}</button>
      </div>
      {error !== null && <div className="banner" style={{ marginTop: 8 }}>{error}</div>}
      <LedgerLiveImport name={name} onDone={onDone} />
    </div>
  );
}

/** Kraken: paste the read-only API key pair; straight to the Keychain via the host. */
function KrakenConnect({ name, institutionId, onDone }: { name: string; institutionId: string | null; onDone: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    if (institutionId === null && name.trim() === "") {
      setError("Give the connection a name first — \"Kraken\" works.");
      return;
    }
    if (apiKey.trim() === "" || secret.trim() === "") {
      setError("Paste both the API key and the private key from Kraken.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.connectKraken({
        ...(institutionId !== null ? { institution_id: institutionId } : { name: name.trim() }),
        api_key: apiKey.trim(),
        private_key: secret.trim(),
      });
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ marginTop: 8 }}>
      <div className="small muted" style={{ marginBottom: 4 }}>
        In Kraken: Settings → API → create a key with only the <b>Query Funds</b> permission. Both values go into{" "}
        {yourKeychain()}; this app stores nothing else.
      </div>
      <div className="actions">
        <input style={{ flex: 1 }} type="password" placeholder="API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </div>
      <div className="actions" style={{ marginTop: 6 }}>
        <input style={{ flex: 1 }} type="password" placeholder="Private key" value={secret} onChange={(e) => setSecret(e.target.value)} />
      </div>
      <div className="actions" style={{ marginTop: 6 }}>
        <button disabled={busy} onClick={() => void connect()}>{busy ? "connecting and fetching…" : "Connect Kraken"}</button>
      </div>
      {error !== null && <div className="banner" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

/** The countries Enable Banking covers (EU/EEA + UK), by name. */
const EB_COUNTRIES: ReadonlyArray<readonly [string, string]> = [
  ["AT", "Austria"], ["BE", "Belgium"], ["BG", "Bulgaria"], ["HR", "Croatia"], ["CY", "Cyprus"],
  ["CZ", "Czechia"], ["DK", "Denmark"], ["EE", "Estonia"], ["FI", "Finland"], ["FR", "France"],
  ["DE", "Germany"], ["GR", "Greece"], ["HU", "Hungary"], ["IS", "Iceland"], ["IE", "Ireland"],
  ["IT", "Italy"], ["LV", "Latvia"], ["LT", "Lithuania"], ["LU", "Luxembourg"], ["MT", "Malta"],
  ["NL", "Netherlands"], ["NO", "Norway"], ["PL", "Poland"], ["PT", "Portugal"], ["RO", "Romania"],
  ["SK", "Slovakia"], ["SI", "Slovenia"], ["ES", "Spain"], ["SE", "Sweden"], ["GB", "United Kingdom"],
];

/** Enable Banking: pick the bank, consent on its page, paste the code from the redirect. */
function EbConnect({ name, institutionId, preset, onDone, onBankPicked }: { name: string; institutionId: string | null; preset: { name: string; country: string } | null; onDone: () => void; onBankPicked?: (bank: string) => void }) {
  const [country, setCountry] = useState(preset?.country ?? "");
  const [banks, setBanks] = useState<Array<{ name: string; country: string }>>([]);
  const [bank, setBank] = useState(preset?.name ?? "");
  const [state, setState] = useState<string | null>(null);
  const [consentUrl, setConsentUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  // Registered with the Enable Banking application (enablebanking.com -> API
  // applications -> Redirect URLs); the same one every time, so remember it.
  const [redirect, setRedirect] = useState(() => {
    try {
      return localStorage.getItem("fin.eb.redirect") ?? "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };
  const findBanks = () =>
    act("banks", async () => {
      const list = await api.ebBanks(country.trim().toUpperCase());
      setBanks(list);
      if (list.length > 0 && !list.some((b) => b.name === bank)) {
        setBank(list[0]!.name);
        onBankPicked?.(list[0]!.name);
      }
    });
  const start = () =>
    act("start", async () => {
      if (institutionId === null && name.trim() === "") throw new Error("Give the connection a name first.");
      if (redirect.trim() === "") {
        throw new Error("Enter the redirect URL registered with your Enable Banking application (enablebanking.com \u2192 API applications → Redirect URLs), in the box below the bank picker.");
      }
      try {
        localStorage.setItem("fin.eb.redirect", redirect.trim());
      } catch {
        /* private mode */
      }
      const r = await api.ebStart({
        ...(institutionId !== null ? { institution_id: institutionId } : { name: name.trim() }),
        country: country.trim().toUpperCase(),
        bank,
        redirect_url: redirect.trim(),
      });
      setState(r.state);
      setConsentUrl(r.url);
      await api.openExternal(r.url);
    });
  const finish = () =>
    act("finish", async () => {
      if (state === null) throw new Error("Open the bank's consent page first.");
      const c = /[?&]code=([^&#\s]+)/.exec(code.trim())?.[1] ?? code.trim();
      if (c === "") throw new Error("Paste the code (or the whole address) from the page the bank sent you to.");
      await api.ebComplete({ state, code: decodeURIComponent(c) });
      onDone();
    });
  return (
    <div style={{ marginTop: 8 }}>
      <div className="actions">
        <select value={country} onChange={(e) => setCountry(e.target.value)}>
          <option value="">Choose a country…</option>
          {EB_COUNTRIES.map(([code, label]) => (
            <option key={code} value={code}>{label}</option>
          ))}
        </select>
        <button disabled={busy !== null || country === ""} onClick={() => void findBanks()}>
          {busy === "banks" ? "looking…" : "Find banks"}
        </button>
        {banks.length > 0 && (
          <select value={bank} onChange={(e) => { setBank(e.target.value); onBankPicked?.(e.target.value); }}>
            {banks.map((b) => (
              <option key={b.name} value={b.name}>{b.name}</option>
            ))}
          </select>
        )}
        <button disabled={busy !== null || bank === ""} onClick={() => void start()}>
          {busy === "start" ? "opening…" : "Open the bank's consent page"}
        </button>
      </div>
      <div className="actions" style={{ marginTop: 6 }}>
        <input
          style={{ flex: 1 }}
          placeholder="Redirect URL registered with your Enable Banking application"
          value={redirect}
          onChange={(e) => setRedirect(e.target.value)}
        />
      </div>
      <p className="small muted" style={{ marginTop: 2 }}>
        Step 1: the exact redirect URL from your application on enablebanking.com (API applications → Redirect URLs). The bank sends you there
        after you approve; then paste what it gave you below.
      </p>
      {consentUrl !== null && <ExternalLinkNote url={consentUrl} />}
      <div className="actions" style={{ marginTop: 6 }}>
        <input
          style={{ flex: 1 }}
          placeholder="Step 2 — after approving: paste the code (or the whole address) the bank redirected you to"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button disabled={busy !== null || state === null} onClick={() => void finish()}>
          {busy === "finish" ? "fetching your accounts…" : "Finish"}
        </button>
      </div>
      {error !== null && <div className="banner" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

/** How a connection describes itself under the card title. */
function adapterLabel(inst: InstitutionOverview): string {
  switch (inst.adapter) {
    case "plaid": return "Automatic via Plaid";
    case "enablebanking": return "Automatic via Enable Banking";
    case "coinbase": return "Automatic via Coinbase";
    case "kraken": return "Automatic via Kraken";
    case "wallet": return "Watch-only wallet";
    default: return inst.managed ? "You enter the values" : "File uploads";
  }
}

function adapterIcon(inst: InstitutionOverview): string {
  if (inst.adapter === "coinbase" || inst.adapter === "kraken" || inst.adapter === "wallet") return "currency-btc";
  if (CONNECTOR_ADAPTERS.has(inst.adapter)) return "bank";
  if (inst.category === "real_estate") return "buildings";
  return inst.managed ? "vault" : "file-text";
}

function InstitutionCard({ inst, onChanged }: { inst: InstitutionOverview; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingProperty, setEditingProperty] = useState(false);
  const [manage, setManage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };
  const open = inst.accounts.filter((a) => !a.closed);
  const ignored = inst.accounts.filter((a) => a.ignored);
  const closedCount = inst.accounts.length - open.length - ignored.length;
  const isProperty = inst.managed && inst.category === "real_estate" && open.length === 1;
  const isConnector = CONNECTOR_ADAPTERS.has(inst.adapter);
  const lastObserved = open.map((a) => a.observed_at).filter((x): x is string => x !== null).sort().pop() ?? null;
  const valued = open.filter((a) => a.value !== null);
  const currencies = new Set(valued.map((a) => a.currency));
  // Owed accounts arrive with either sign convention (connectors report the
  // visa as negative; typed-in mortgages are positive amounts owed) — both
  // must reduce the card's total.
  const total =
    valued.length > 0 && currencies.size === 1
      ? valued.reduce((s, a) => s + (OWED_TYPES.has(a.type) ? -Math.abs(Number(a.value)) : Number(a.value)), 0)
      : null;
  return (
    <div className="inst-card">
      <div className="inst-head">
        <div className="inst-id">
          <span className="icon-tile plain big"><Icon name={adapterIcon(inst)} /></span>
          <div style={{ minWidth: 0 }}>
            <h3 className="name">{inst.name}</h3>
            <div className="meta">
              {inst.enabled ? (
                <span className={`badge-chip ${inst.managed ? "gray" : "green"}`}>{inst.managed ? "Manually managed" : "Connected"}</span>
              ) : (
                <span className="badge-chip amber">Paused</span>
              )}
              <span>
                {adapterLabel(inst)}
                {lastObserved !== null && <> • Last updated {when(lastObserved)}</>}
              </span>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {isConnector && (
            <button
              className="iconbtn"
              title="Update now"
              disabled={busy !== null}
              onClick={() => void act("update", () => api.refreshInstitution(inst.institution_id))}
            >
              <Icon name="refresh" />
            </button>
          )}
          {inst.managed && !isProperty && (
            <button className="iconbtn" title="Add or update an account" onClick={() => setManage((m) => !m)}><Icon name="plus" /></button>
          )}
          <button className={`iconbtn${manage ? " on" : ""}`} title="Manage this connection" onClick={() => setManage((m) => !m)}><Icon name="dots-three" /></button>
        </div>
      </div>
      {inst.problems.map((prob, i) => (
        <div key={i} className="banner" style={{ margin: "12px 20px 0" }}>{prob}</div>
      ))}
      {busy === "update" ? (
        <p className="muted" style={{ padding: "16px 20px" }}>Saving and updating your numbers…</p>
      ) : (
        open.length > 0 && (
          <table>
            <thead><tr><th>Account Name</th><th>Type</th><th className="num">Balance</th><th>Last updated</th>{(inst.managed || isProperty || isConnector) && <th></th>}</tr></thead>
            <tbody>
              {open.map((a) => (
                <tr key={a.account_id}>
                  <td style={{ fontWeight: 500, color: "var(--strong)" }}>{a.name}</td>
                  <td className="muted">{typeLabel(a.type)}</td>
                  <td className="num" style={{ fontWeight: 600, color: "var(--strong)" }}>
                    {a.value === null ? <span className="muted" style={{ fontWeight: 400 }}>not fetched yet</span> : money(a.value, a.currency)}
                    {OWED_TYPES.has(a.type) && a.value !== null ? <span className="small muted" style={{ fontWeight: 400 }}> owed</span> : null}
                  </td>
                  <td className="small muted">{when(a.observed_at)}</td>
                  {(inst.managed || isProperty || isConnector) && (
                    <td style={{ textAlign: "right" }}>
                      {isProperty && (
                        <button className="ghost" disabled={busy !== null} onClick={() => setEditingProperty((e) => !e)} title="Edit this property">
                          <Icon name="pencil" />
                        </button>
                      )}
                      {inst.managed && (
                        <button
                          className="ghost danger"
                          title="Remove this account"
                          disabled={busy !== null}
                          onClick={() => void act("update", () => api.removeManagedAccount(inst.institution_id, a.account_id))}
                        >
                          <Icon name="trash" />
                        </button>
                      )}
                      {isConnector && (
                        <button
                          className="ghost"
                          title="Hide this account — it leaves your totals and updates stop recording it until you restore it"
                          disabled={busy !== null}
                          onClick={() => void act("update", () => api.setAccountIgnored(a.account_id, true))}
                        >
                          <Icon name="eye-slash" />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
      {editingProperty && isProperty && (
        <div className="card-body">
          <PropertyEditor
            inst={inst}
            disabled={busy !== null}
            onSave={(input) =>
              void act("update", async () => {
                // The address is both the card's name and the account's.
                await api.renameInstitution(inst.institution_id, input.address);
                await api.saveManagedAccount(inst.institution_id, { account_id: input.account_id, name: input.address, type: "real_estate", value: input.value });
                setEditingProperty(false);
              })
            }
          />
        </div>
      )}
      {manage && (
        <div className="card-body">
          {inst.managed && !isProperty && (
            <ManagedAccountEditor
              inst={inst}
              disabled={busy !== null}
              onSave={(input) => void act("update", () => api.saveManagedAccount(inst.institution_id, input))}
            />
          )}
          {!inst.managed && !isConnector && <UploadBox inst={inst} disabled={busy !== null} onDone={onChanged} />}
          {isConnector && (
            <ConnectorStatus
              inst={inst}
              disabled={busy !== null}
              onUpdate={() => void act("update", () => api.refreshInstitution(inst.institution_id))}
              onChanged={onChanged}
            />
          )}
          {ignored.length > 0 && (
            <div className="small muted" style={{ marginTop: 8 }}>
              {ignored.length} hidden account{ignored.length > 1 ? "s" : ""}:{" "}
              {ignored.map((a) => (
                <span key={a.account_id} style={{ marginRight: 10, whiteSpace: "nowrap" }}>
                  {a.name}{" "}
                  <button
                    className="ghost"
                    title="Restore this account — the next update fills it in again"
                    disabled={busy !== null}
                    onClick={() => void act("update", () => api.setAccountIgnored(a.account_id, false))}
                  >
                    <Icon name="eye" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {closedCount > 0 && <p className="small muted">{closedCount} removed account{closedCount > 1 ? "s" : ""} kept in history.</p>}
          {error !== null && <div className="banner" style={{ marginTop: 8 }}>{error}</div>}
          <div className="actions" style={{ marginTop: 12 }}>
            <button
              className="secondary"
              disabled={busy !== null}
              onClick={() => void act("pause", () => api.setInstitutionEnabled(inst.institution_id, !inst.enabled))}
            >
              {inst.enabled ? "Pause updates" : "Resume updates"}
            </button>
            {confirmDelete ? (
              <>
                <span className="small">Delete this connection? Its cash and holdings leave your totals; the history of what was observed is kept.</span>
                <button disabled={busy !== null} onClick={() => void act("delete", () => api.deleteInstitution(inst.institution_id))}>
                  Yes, delete
                </button>
                <button className="secondary" onClick={() => setConfirmDelete(false)}>Cancel</button>
              </>
            ) : (
              <button className="secondary" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>Delete</button>
            )}
            <span className="small muted" style={{ marginLeft: "auto" }}>{inst.institution_id}</span>
          </div>
        </div>
      )}
      {!manage && error !== null && <div className="banner" style={{ margin: "12px 20px" }}>{error}</div>}
      <div className="card-foot">
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {!inst.managed && !isConnector && (
            <button className="linklike" onClick={() => setManage((m) => !m)}><Icon name="upload-simple" /> Upload statement</button>
          )}
          <button className="linklike" onClick={() => setManage((m) => !m)}><Icon name="note" /> {manage ? "Hide management" : "Manage"}</button>
        </div>
        {total !== null && (
          <span className="small num" style={{ fontWeight: 600, color: "var(--strong)" }}>
            Total: {money(String(Math.round(total * 100) / 100), valued[0]!.currency)}
          </span>
        )}
      </div>
    </div>
  );
}

const CONNECTOR_ADAPTERS = new Set(["plaid", "enablebanking", "coinbase", "kraken", "wallet"]);

/** JSON bodies pretty-print; anything else shows as-is. */
function prettyBody(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

const fmtHeaders = (h: Record<string, string>): string =>
  Object.keys(h).length === 0 ? "(none)" : Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\n");

/**
 * The raw wire record of recent fetches for one institution: every
 * request/response with headers, credentials masked host-side. Held in
 * memory only — nothing here is written to disk.
 */
function FetchLogDrawer({ inst, onClose }: { inst: InstitutionOverview; onClose: () => void }) {
  const [logs, setLogs] = useState<import("./api").FetchLogRecord[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    api.institutionFetchLog(inst.institution_id).then(setLogs).catch(() => setLogs([]));
  }, [inst.institution_id]);
  return (
    <div className="drawer">
      <button className="close secondary" onClick={onClose}>close</button>
      <h2 style={{ fontSize: 18 }}>Fetch Logs</h2>
      <p className="small muted">
        {inst.name} — the raw request/response of each recent fetch, credentials masked. Held in memory only;
        restarting the app clears it.
      </p>
      {logs === null && <p className="muted">loading…</p>}
      {logs !== null && logs.length === 0 && (
        <p className="muted">No fetches recorded since the app started. Hit Update now, then reopen this panel.</p>
      )}
      {(logs ?? []).map((run, ri) => (
        <div key={ri} className="panel" style={{ padding: 14, marginBottom: 14 }}>
          <div className="small" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className={`pill ${run.ok ? "low" : "critical"}`}>{run.ok ? "ok" : "failed"}</span>
            <b style={{ color: "var(--strong)" }}>{when(run.at)}</b>
            <span className="muted">{run.via} · {run.entries.length} call{run.entries.length === 1 ? "" : "s"}</span>
          </div>
          {run.error !== undefined && <div className="banner" style={{ margin: "10px 0 0" }}>{run.error}</div>}
          {run.entries.map((e, ei) => {
            const k = `${ri}:${ei}`;
            const cls = e.status >= 200 && e.status < 300 ? "low" : e.status === 0 ? "critical" : "medium";
            return (
              <div key={k} className="httpcall">
                <button className="linklike" style={{ width: "100%" }} onClick={() => setOpen(open === k ? null : k)}>
                  <span className={`pill ${cls}`}>{e.status === 0 ? "ERR" : e.status}</span>
                  <code className="small" style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", textAlign: "left" }}>{e.method} {e.url}</code>
                  <span className="small muted" style={{ whiteSpace: "nowrap" }}>{e.ms}ms {open === k ? "▾" : "▸"}</span>
                </button>
                {open === k && (
                  <div className="httpdetail">
                    <div className="field-label">Request headers</div>
                    <pre>{fmtHeaders(e.request_headers)}</pre>
                    {e.request_body !== null && (
                      <>
                        <div className="field-label">Request body</div>
                        <pre>{prettyBody(e.request_body)}</pre>
                      </>
                    )}
                    <div className="field-label">Response headers</div>
                    <pre>{fmtHeaders(e.response_headers)}</pre>
                    <div className="field-label">Response body</div>
                    <pre>{prettyBody(e.response_body)}</pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Connector institutions: automatic read-only updates, consent status, and the reconnect flow. */
function ConnectorStatus({ inst, disabled, onUpdate, onChanged }: { inst: InstitutionOverview; disabled: boolean; onUpdate: () => void; onChanged: () => void }) {
  const [reconnecting, setReconnecting] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const days =
    inst.consent_until === null ? null : Math.floor((new Date(inst.consent_until).getTime() - Date.now()) / 86_400_000);
  const reconnectable = inst.adapter !== "wallet";
  return (
    <div style={{ marginTop: 10 }}>
      <div className="small muted">
        {inst.adapter === "wallet"
          ? "Watch-only: balances read from the blockchain via public addresses — they can never move funds."
          : "Connected automatically — this app only ever has read-only access; it cannot move money."}
        {inst.consent_until !== null && (
          <>
            {" "}Bank permission valid until {when(inst.consent_until)}
            {days !== null && days < 0 && <span className="pill critical"> expired — reconnect below</span>}
            {days !== null && days >= 0 && days <= 14 && <span className="pill high"> {days} day{days === 1 ? "" : "s"} left</span>}
          </>
        )}
      </div>
      <div className="actions" style={{ marginTop: 6 }}>
        <button className="secondary" disabled={disabled} onClick={onUpdate}>Update now</button>
        {reconnectable && (
          <button className="secondary" disabled={disabled} onClick={() => setReconnecting((r) => !r)}>
            {reconnecting ? "Hide reconnect" : inst.adapter === "coinbase" || inst.adapter === "kraken" ? "Replace the API key" : "Reconnect"}
          </button>
        )}
        <button className="secondary" onClick={() => setShowLog(true)}>View Fetch Logs</button>
      </div>
      {showLog && <FetchLogDrawer inst={inst} onClose={() => setShowLog(false)} />}
      {reconnecting && inst.adapter === "plaid" && (
        <PlaidConnect name={inst.name} institutionId={inst.institution_id} onDone={() => { setReconnecting(false); onChanged(); }} />
      )}
      {reconnecting && inst.adapter === "enablebanking" && (
        <EbConnect name={inst.name} institutionId={inst.institution_id} preset={inst.aspsp} onDone={() => { setReconnecting(false); onChanged(); }} />
      )}
      {reconnecting && inst.adapter === "coinbase" && (
        <CoinbaseConnect name={inst.name} institutionId={inst.institution_id} onDone={() => { setReconnecting(false); onChanged(); }} />
      )}
      {reconnecting && inst.adapter === "kraken" && (
        <KrakenConnect name={inst.name} institutionId={inst.institution_id} onDone={() => { setReconnecting(false); onChanged(); }} />
      )}
    </div>
  );
}

/** A property is one address and one value; edit both in place. The rename covers the card and the account. */
function PropertyEditor({ inst, disabled, onSave }: { inst: InstitutionOverview; disabled: boolean; onSave: (input: { address: string; value: string; account_id: string }) => void }) {
  const account = inst.accounts.filter((a) => !a.closed)[0];
  const [address, setAddress] = useState(inst.name);
  const [value, setValue] = useState(account?.value ?? "");
  const [error, setError] = useState<string | null>(null);
  if (account === undefined) return null;
  const save = () => {
    if (address.trim() === "") {
      setError("Enter the property's address or name.");
      return;
    }
    if (value.trim() === "") {
      setError("Enter the value — 1234.56, $1,234.56, and €1.234,56 all work; the currency is kept with it.");
      return;
    }
    setError(null);
    onSave({ address: address.trim(), value: value.trim(), account_id: account.account_id });
  };
  return (
    <div style={{ marginTop: 10 }}>
      <div className="small muted" style={{ marginBottom: 4 }}>Edit the address or the value; each save is a dated observation, not an overwrite.</div>
      <div className="actions">
        <input style={{ flex: 1 }} placeholder="Address — e.g. 12 Main St, Springfield" value={address} disabled={disabled} onChange={(e) => setAddress(e.target.value)} />
        <input
          style={{ width: 150 }}
          placeholder="Current value"
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
        <button disabled={disabled} onClick={save}>Save property</button>
      </div>
      {error !== null && <div className="banner" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

/** One row of inputs: pick an existing account to update, or add a new one. */
function ManagedAccountEditor({ inst, disabled, onSave }: { inst: InstitutionOverview; disabled: boolean; onSave: (input: { account_id?: string; name: string; type: string; value: string }) => void }) {
  const open = inst.accounts.filter((a) => !a.closed);
  const defaultType = inst.category === "real_estate" ? "real_estate" : "checking";
  const [accountId, setAccountId] = useState<string>("new");
  const [name, setName] = useState("");
  const [type, setType] = useState(defaultType);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const existing = open.find((a) => a.account_id === accountId);
  const pick = (id: string) => {
    setAccountId(id);
    const a = open.find((x) => x.account_id === id);
    setName(a?.name ?? "");
    setType(a?.type ?? defaultType);
    setValue(a?.value ?? "");
    setError(null);
  };
  const save = () => {
    if (name.trim() === "") {
      setError("Name the account — e.g. \"Everyday checking\" or \"The house\".");
      return;
    }
    if (value.trim() === "") {
      setError("Enter the value — 1234.56, $1,234.56, and €1.234,56 all work; the currency is kept with it.");
      return;
    }
    setError(null);
    onSave({ ...(existing !== undefined ? { account_id: existing.account_id } : {}), name: name.trim(), type, value: value.trim() });
    if (existing === undefined) {
      setName("");
      setValue("");
    }
  };
  return (
    <div style={{ marginTop: 10 }}>
      <div className="small muted" style={{ marginBottom: 4 }}>
        {open.length > 0 ? "Update an account's value, or add another:" : "Add the first account:"}
      </div>
      <div className="actions">
        {open.length > 0 && (
          <select value={accountId} onChange={(e) => pick(e.target.value)} disabled={disabled}>
            <option value="new">＋ New account</option>
            {open.map((a) => (
              <option key={a.account_id} value={a.account_id}>{a.name}</option>
            ))}
          </select>
        )}
        <input placeholder="Account name" value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} />
        <select value={type} disabled={disabled || existing !== undefined} onChange={(e) => setType(e.target.value)}>
          {ACCOUNT_TYPE_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
        <input
          style={{ width: 130 }}
          placeholder={OWED_TYPES.has(type) ? "Amount owed" : "Current value"}
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
        <button disabled={disabled} onClick={save}>{existing !== undefined ? "Save new value" : "Add account"}</button>
      </div>
      {error !== null && <div className="banner" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function UploadBox({ inst, disabled, onDone }: { inst: InstitutionOverview; disabled: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const upload = async (file: File) => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.uploadInstitutionFile(inst.institution_id, file.name, await file.arrayBuffer());
      setResult(
        r.problems.length > 0
          ? `We couldn't read that file: ${r.problems.join("; ")}`
          : "Got it — your numbers are updated.",
      );
      onDone();
    } catch (e) {
      setResult(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ marginTop: 10 }}>
      <div className="small muted" style={{ marginBottom: 4 }}>
        Upload the latest export downloaded from {inst.name}'s website. The file is kept unchanged as evidence.
      </div>
      <div className="actions">
        <input
          type="file"
          disabled={disabled || busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f !== undefined) void upload(f);
            e.target.value = "";
          }}
        />
        {busy && <span className="muted small">Reading the file and updating your numbers…</span>}
      </div>
      {result !== null && <div className="banner" style={{ marginTop: 8 }}>{result}</div>}
    </div>
  );
}

/**
 * A link to a document served by the host. Inside the Tauri webview a
 * target=_blank anchor is a blocked new-window request (GH issue #1), so
 * the host opens the default browser instead; the href stays real for
 * copy-link and for plain-browser use.
 */
function DocumentLink({ path, children }: { path: string; children: React.ReactNode }) {
  return (
    <a
      href={path}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault();
        void api.openExternal(new URL(path, window.location.origin).toString()).catch(() => {
          // Host refused or unreachable: fall back to the anchor's default.
          window.open(path, "_blank");
        });
      }}
    >
      {children}
    </a>
  );
}

/**
 * Shown wherever the app is waiting on an inference provider, so a long
 * think (local models especially) never looks like a hang. The elapsed
 * counter appears after a few seconds.
 */
function Thinking({ label }: { label: string }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="thinking small muted">
      <span className="spinner" />
      <span>
        {label}…{secs >= 3 ? ` ${secs}s` : ""}
      </span>
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

type AccountSortKey = "account" | "type" | "value" | "observed";

/** Long account names lose their middle: >70 chars becomes 32 + "..." + 32 (67), full name on hover. */
function chopMiddle(name: string): string {
  return name.length > 70 ? `${name.slice(0, 32)}...${name.slice(-32)}` : name;
}

/** The yield slider's ceiling, %/yr. */
const YIELD_MAX = 15;

/** Scenario growth rates for the horizon modeler: a client-side projection, not advice. */
const SCENARIOS: ReadonlyArray<readonly [string, string, number]> = [
  ["conservative", "Conservative", 0.03],
  ["balanced", "Balanced", 0.06],
  ["aggressive", "Aggressive", 0.09],
];

function compactMoney(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e6) return maskDigits(`${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`);
  if (a >= 1e3) return maskDigits(`${sign}$${Math.round(a / 1e3)}k`);
  return maskDigits(`${sign}$${a.toFixed(0)}`);
}

function Dashboard({ tick, openFact }: { tick: number; openFact: (id: string) => void }) {
  const [nw, setNw] = useState<NetWorth | null>(null);
  const [cf, setCf] = useState<import("./api").CashFlowView | null>(null);
  const [sort, setSort] = useState<{ key: AccountSortKey; dir: 1 | -1 } | null>(null);
  const [tab, setTab] = useState<"accounts" | "positions">("accounts");
  const [horizonPct, setHorizonPct] = useState(30);
  // %/yr for the projection: the scenario presets set it, the slider frees it.
  const [yieldPct, setYieldPct] = useState(3);
  useEffect(() => {
    api.netWorth().then(setNw).catch(() => setNw(null));
    api.cashFlow(12).then(setCf).catch(() => setCf(null));
  }, [tick]);
  if (nw === null) return <div className="page"><p className="muted">No ledger yet. Run a nightly.</p></div>;
  const clickSort = (key: AccountSortKey) =>
    setSort((s) => {
      // First click: names/types A->Z, value largest-first, observed newest-first.
      if (s === null || s.key !== key) return { key, dir: key === "account" || key === "type" ? 1 : -1 };
      return { key, dir: s.dir === 1 ? -1 : 1 };
    });
  const Th = ({ k, label, num }: { k: AccountSortKey; label: string; num?: boolean }) => (
    <th className={`sortable${num === true ? " num" : ""}`} onClick={() => clickSort(k)}>
      {label}
      {sort?.key === k ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
    </th>
  );
  const lines =
    sort === null
      ? nw.lines
      : [...nw.lines].sort((a, b) => {
          switch (sort.key) {
            case "account": return sort.dir * a.name.localeCompare(b.name);
            case "type": return sort.dir * (a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
            case "value": return sort.dir * (Number(a.value) - Number(b.value));
            case "observed": return sort.dir * (a.observed_at ?? "").localeCompare(b.observed_at ?? "");
          }
        });
  // A class-of-asset subtotal in the display currency. Lines without a
  // conversion rate are excluded, matching how the headline totals work.
  const sumTypes = (types: readonly string[]): string => {
    let total = 0;
    for (const l of nw.lines) {
      if (!types.includes(l.type)) continue;
      const v = l.display_value ?? (l.currency === nw.currency ? l.value : null);
      if (v == null) continue;
      total += Number(v);
    }
    return String(Math.round(total * 100) / 100);
  };
  const rate = yieldPct / 100;
  const year0 = new Date().getFullYear();
  const span = 10;
  const targetYear = Math.round(year0 + (horizonPct / 100) * span);
  const base = Number(nw.net_worth);
  const projectedGain = base > 0 ? base * Math.pow(1 + rate, targetYear - year0) - base : 0;
  const cash = Number(sumTypes(["checking", "savings", "money_market"]));
  const liabilities = Number(nw.liabilities);
  // On sub-iPad screens, one overflowing figure shrinks them ALL: if any
  // lozenge runs past 8 digits, every lozenge drops 10% together, so the
  // row never mixes sizes (CSS gates it to small viewports).
  const kpi = {
    assets: money(nw.assets, nw.currency),
    liabilities: money(nw.liabilities, nw.currency),
    cash: money(sumTypes(["checking", "savings", "money_market"]), nw.currency),
    crypto: money(sumTypes(["crypto"]), nw.currency),
    property: money(sumTypes(["real_estate"]), nw.currency),
  };
  const kpisTight = Object.values(kpi).some((v) => (v.match(/\d/g) ?? []).length > 8);
  const alloc: DonutSlice[] = [
    { label: "Investments", value: Number(sumTypes(["brokerage", "ira", "401k", "hsa"])), color: "#10b981" },
    { label: "Real Estate", value: Number(sumTypes(["real_estate"])), color: "#6366f1" },
    { label: "Cash", value: cash, color: "#fbbf24" },
    { label: "Crypto", value: Number(sumTypes(["crypto"])), color: "#fb923c" },
    { label: "Other", value: Number(sumTypes(["other"])), color: "#4b5563" },
  ].filter((s) => s.value > 0);
  const allocTotal = alloc.reduce((s, x) => s + x.value, 0);
  // Cash flow: monthly in/out from the rolling transaction window the
  // connectors re-observe each nightly. Internal movement is excluded
  // host-side; figures arrive already in the display currency.
  const flowMonths = cf?.months ?? [];
  const withFlow = flowMonths.filter((m) => m.txns > 0);
  const hasFlow = withFlow.length > 0;
  const monthLabel = (m: string) => new Date(`${m}-15T00:00:00Z`).toLocaleString(undefined, { month: "short" });
  const bars: FlowBar[] = flowMonths.map((m) => ({ label: monthLabel(m.month), inflow: Number(m.inflow), outflow: Number(m.outflow) }));
  const latestFlow = flowMonths.length > 0 ? flowMonths[flowMonths.length - 1]! : null;
  const avgOut = hasFlow ? withFlow.reduce((s, m) => s + Number(m.outflow), 0) / withFlow.length : null;
  const avgNet = hasFlow ? withFlow.reduce((s, m) => s + Number(m.net), 0) / withFlow.length : null;
  const runway = avgNet !== null && avgNet < 0 && cash > 0 ? cash / -avgNet : null;
  return (
    <div className="page">
      {nw.provisional && <div className="banner">Some figures rest on provisional facts. Downstream agents are held until the exception queue is cleared.</div>}
      {(nw.fx_missing ?? []).length > 0 && (
        <div className="banner">
          No exchange rate available for {(nw.fx_missing ?? []).join(", ")} — those accounts show their native amounts and are excluded from the totals.
        </div>
      )}
      <section className={`kpis${kpisTight ? " kpis-tight" : ""}`}>
        <div className={`kpi ${nw.provisional ? "prov" : ""}`}>
          <div className="k-label"><span style={{ color: "#10b981", display: "inline-flex" }}><Icon name="wallet" /></span>Assets</div>
          <div className="k-value">{kpi.assets}</div>
        </div>
        <div className="kpi">
          <div className="k-label"><span style={{ color: "#ef4444", display: "inline-flex" }}><Icon name="receipt" /></span>Liabilities</div>
          <div className="k-value">{kpi.liabilities}</div>
        </div>
        <div className="kpi">
          <div className="k-label"><span style={{ color: "#fbbf24", display: "inline-flex" }}><Icon name="coins" /></span>Cash</div>
          <div className="k-value">{kpi.cash}</div>
        </div>
        <div className="kpi">
          <div className="k-label"><span style={{ color: "#fb923c", display: "inline-flex" }}><Icon name="currency-btc" /></span>Crypto</div>
          <div className="k-value">{kpi.crypto}</div>
        </div>
        <div className="kpi">
          <div className="k-label"><span style={{ color: "#3b82f6", display: "inline-flex" }}><Icon name="buildings" /></span>Property</div>
          <div className="k-value">{kpi.property}</div>
        </div>
      </section>
      {nw.lines.some((l) => l.currency !== nw.currency) && fxState() !== null && (
        <p className="small muted" style={{ marginTop: -12, marginBottom: 20 }}>
          Foreign-currency accounts converted to {nw.currency} at ECB reference rates of {fxState()!.date}
          {fxState()!.stale ? " (offline — last known rates)" : ""}. Native amounts shown beneath.
        </p>
      )}

      <section className="panel">
        <div className="panel-head" style={{ marginBottom: 16 }}>
          <div className="panel-title">
            <span className="icon-tile"><Icon name="sparkle" /></span>
            <span>
              Yield Horizon Modeler
              <div className="panel-sub">Drag the handles to shift your target year and expected yield; the projection recalculates. A what-if, not advice.</div>
            </span>
          </div>
          <div className="seg">
            {SCENARIOS.map(([id, label, r]) => (
              <button key={id} className={yieldPct === r * 100 ? "on" : ""} onClick={() => setYieldPct(r * 100)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="slider-row">
          <span className="sl-name">Horizon</span>
          <span className="yr">{year0}</span>
          <div className="hslider">
            <div className="track" />
            <div className="fill" style={{ width: `${horizonPct}%` }} />
            <input type="range" min="0" max="100" value={horizonPct} onChange={(e) => setHorizonPct(Number(e.target.value))} />
            <div className="knob" style={{ left: `${horizonPct}%` }} />
          </div>
          <span className="yr right">{year0 + span}</span>
        </div>
        <div className="slider-row">
          <span className="sl-name">Yield / yr</span>
          <span className="yr">0%</span>
          <div className="hslider">
            <div className="track" />
            <div className="fill" style={{ width: `${(yieldPct / YIELD_MAX) * 100}%` }} />
            <input type="range" min="0" max={YIELD_MAX} step="0.25" value={yieldPct} onChange={(e) => setYieldPct(Number(e.target.value))} />
            <div className="knob" style={{ left: `${(yieldPct / YIELD_MAX) * 100}%` }} />
          </div>
          <span className="yr right">{YIELD_MAX}%</span>
        </div>
        <div className="horizon-meta">
          <span className="small muted">Target horizon</span>
          <span className="num" style={{ fontWeight: 600, color: "var(--strong)" }}>
            {targetYear} · +{compactMoney(projectedGain)} projected at {yieldPct % 1 === 0 ? yieldPct : yieldPct.toFixed(2)}%/yr
          </span>
        </div>
        <div className="chartbox">
          {base > 0 ? (
            <HorizonChart base={base} rate={rate} yearStart={year0} yearEnd={year0 + span} />
          ) : (
            <div className="chart-empty">The projection starts from a positive net worth — nothing to model yet.</div>
          )}
        </div>
      </section>

      <section className="flow-grid">
        <div className="panel" style={{ marginBottom: 24 }}>
          <div className="panel-head">
            <span className="panel-title">Cash Flow — In vs Out</span>
            <span className="legend">
              <span><span className="sw" style={{ background: "#10b981" }} />Inflow</span>
              <span><span className="sw" style={{ background: "#1f2937", border: "1px solid #4b5563" }} />Outflow</span>
            </span>
          </div>
          <p className="small muted" style={{ margin: "4px 0 12px" }}>
            Money in rises above the baseline; money out drops below. Transfers between your own accounts and buys/sells inside an account don't count.
          </p>
          {hasFlow ? (
            <>
              <div className="chartbox"><PairedBars bars={bars} /></div>
              <p className="small muted" style={{ margin: "8px 0 0" }}>
                From {withFlow.reduce((s, m) => s + m.txns, 0)} observed transactions
                {cf !== null && cf.excluded_internal > 0 ? ` (${cf.excluded_internal} internal movements excluded)` : ""}
                {cf !== null && cf.fx_missing.length > 0 ? ` · no rate for ${cf.fx_missing.join(", ")} — those excluded` : ""}
                . History deepens as the nightly re-observes each rolling 30-day window.
              </p>
            </>
          ) : (
            <div className="chartbox chart-empty" style={{ minHeight: 240 }}>
              Cash-flow history builds up as connected accounts report transactions — each nightly fetch observes a rolling 30-day window, so a year of monthly in/out accumulates on its own. Nothing recorded yet.
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div className="panel" style={{ marginBottom: 0 }}>
            <div className="panel-title" style={{ marginBottom: 16 }}>Flow Summary</div>
            <div className="stat-row">
              <span className="lbl">Net Inflow{latestFlow !== null ? ` (${monthLabel(latestFlow.month)})` : ""}</span>
              <span className="val num" style={{ color: latestFlow !== null && Number(latestFlow.net) < 0 ? "var(--red-ink)" : "var(--green)" }}>
                {latestFlow !== null && latestFlow.txns > 0 ? money(latestFlow.net, cf!.currency) : "—"}
              </span>
            </div>
            <div className="stat-row">
              <span className="lbl">Avg Monthly Spend</span>
              <span className="val num">{avgOut !== null ? money(avgOut.toFixed(2), cf!.currency) : "—"}</span>
            </div>
            <div className="stat-row">
              <span className="lbl">Runway (at avg burn)</span>
              <span className="val num">
                {runway !== null ? maskDigits(`${Math.round(runway)} mo`) : avgNet !== null && avgNet >= 0 ? "not burning" : "—"}
              </span>
            </div>
            <div className="stat-row">
              <span className="lbl">Cash ÷ Liabilities</span>
              <span className="val num" style={{ color: "var(--link)" }}>{liabilities > 0 && cash > 0 ? maskDigits(`${(cash / liabilities).toFixed(1)}×`) : "—"}</span>
            </div>
          </div>
          <div className="panel" style={{ marginBottom: 0, flex: 1 }}>
            <div className="panel-title">Asset Allocation</div>
            <p className="small muted" style={{ margin: "2px 0 12px" }}>By market value</p>
            {alloc.length === 0 ? (
              <div className="chart-empty" style={{ minHeight: 120 }}>No holdings yet.</div>
            ) : (
              <div className="donut-wrap">
                <DonutChart slices={alloc} size={150} />
                <div className="alloc-legend" style={{ flex: 1, minWidth: 140 }}>
                  {alloc.map((s) => (
                    <div className="row" key={s.label}>
                      <span><span className="sw" style={{ background: s.color, width: 10, height: 10, borderRadius: 3, display: "inline-block", marginRight: 8, verticalAlign: -1 }} />{s.label}</span>
                      <span className="num" style={{ color: "var(--strong)" }}>{allocTotal > 0 ? `${Math.round((s.value / allocTotal) * 100)}%` : ""}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="panel flush">
        <div className="panel-head">
          <div className="panel-title">
            <span className="icon-tile"><Icon name="vault" /></span>
            Holding Detail
          </div>
          <div className="seg">
            <button className={tab === "accounts" ? "on" : ""} onClick={() => setTab("accounts")}>Accounts</button>
            <button className={tab === "positions" ? "on" : ""} onClick={() => setTab("positions")}>Positions</button>
          </div>
        </div>
        {tab === "positions" && <div style={{ padding: "16px 20px" }}><Positions tick={tick} openFact={openFact} /></div>}
        {tab === "accounts" && (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><Th k="account" label="Account" /><Th k="type" label="Type" /><Th k="value" label="Value" num /><th>Basis</th><Th k="observed" label="Observed" /><th>Status</th></tr></thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.account_id} className={l.provisional ? "prov" : ""}>
                    <td title={l.name}><span style={{ fontWeight: 500, color: "var(--strong)" }}>{chopMiddle(l.name)}</span><div className="small muted" title={l.account_id}>{chopMiddle(l.account_id)}</div></td>
                    <td className="muted">{l.type}</td>
                    <td className="num">
                      {l.fact_ids.length > 0 ? <FactLink id={l.fact_ids[0] as string} openFact={openFact}>{money(l.value, l.currency)}</FactLink> : money(l.value, l.currency)}
                      {l.fact_ids.length > 1 && <span className="small muted"> (+{l.fact_ids.length - 1} facts)</span>}
                      {l.currency !== nw.currency && <div className="small muted">{moneyNative(l.value, l.currency)}</div>}
                    </td>
                    <td className="small muted">{l.basis}</td>
                    <td className="small">{when(l.observed_at)}</td>
                    <td>
                      {l.provisional ? (
                        <span className="pill medium"><span className="status-dot" />Provisional</span>
                      ) : (
                        <span className="pill low"><span className="status-dot" />Verified</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

type PositionSortKey = "symbol" | "qty" | "price" | "value";

/** Sort by a clicked header: numbers descending first, symbols ascending first; missing values last. */
function sortPositions<T extends { symbol: string; quantity: string; price: string | null; market_value: string | null }>(
  rows: T[],
  sort: { key: PositionSortKey; dir: 1 | -1 } | null,
): T[] {
  if (sort === null) return rows;
  const num = (v: string | null): number => (v === null ? Number.NEGATIVE_INFINITY : Number(v));
  const out = [...rows].sort((a, b) => {
    switch (sort.key) {
      case "symbol": return sort.dir * a.symbol.localeCompare(b.symbol);
      case "qty": return sort.dir * (num(a.quantity) - num(b.quantity));
      case "price": return sort.dir * (num(a.price) - num(b.price));
      case "value": return sort.dir * (num(a.market_value) - num(b.market_value));
    }
  });
  return out;
}

function Positions({ tick, openFact }: { tick: number; openFact: (id: string) => void }) {
  const [rows, setRows] = useState<Position[]>([]);
  const [bundled, setBundled] = useState<import("./api").ConsolidatedPosition[]>([]);
  const [consolidated, setConsolidated] = useState(true);
  const [sort, setSort] = useState<{ key: PositionSortKey; dir: 1 | -1 } | null>({ key: "value", dir: -1 });
  useEffect(() => {
    api.positions().then(setRows).catch(() => setRows([]));
    api.positionsConsolidated().then(setBundled).catch(() => setBundled([]));
  }, [tick]);
  const clickSort = (key: PositionSortKey) =>
    setSort((s) => {
      if (s === null || s.key !== key) {
        // First click: symbols A->Z, numbers largest-first.
        return { key, dir: key === "symbol" ? 1 : -1 };
      }
      return { key, dir: s.dir === 1 ? -1 : 1 };
    });
  const Th = ({ k, label, num }: { k: PositionSortKey; label: string; num?: boolean }) => (
    <th className={`sortable${num === true ? " num" : ""}`} onClick={() => clickSort(k)}>
      {label}
      {sort?.key === k ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
    </th>
  );
  return (
    <>
      <p style={{ marginBottom: 4 }}>
        <span className="seg">
          <button className={consolidated ? "on" : ""} onClick={() => setConsolidated(true)}>Consolidated</button>
          <button className={consolidated ? "" : "on"} onClick={() => setConsolidated(false)}>By account</button>
        </span>
      </p>
      <p className="small muted" style={{ marginTop: 0 }}>
        {consolidated
          ? "All holdings of one asset bundled into a single row, across accounts."
          : "Every holding shown where it lives: one row per asset per account."}
      </p>
      {!consolidated && (
        <table>
          <thead><tr><th>Account</th><Th k="symbol" label="Symbol" /><Th k="qty" label="Qty" num /><Th k="price" label="Price" num /><Th k="value" label="Market value" num /><th className="num">Cost basis</th><th>Observed</th></tr></thead>
          <tbody>
            {sortPositions(rows, sort).map((p) => (
              <tr key={p.fact_id} className={p.provisional ? "prov" : ""}>
                <td className="small" title={p.account_id}>{chopMiddle(p.account_id)}</td>
                <td title={p.name ?? undefined}>{p.symbol}<div className="small muted">{chopMiddle(p.name ?? p.asset_class)}</div></td>
                <td className="num">{maskDigits(p.quantity)}</td>
                <td className="num">{money(p.price, p.currency)}</td>
                <td className="num"><FactLink id={p.fact_id} openFact={openFact}>{money(p.market_value, p.currency)}</FactLink></td>
                <td className="num">{p.basis_known ? money(p.cost_basis, p.currency) : <span className="pill medium">unknown</span>}</td>
                <td className="small">{when(p.observed_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {consolidated && (
        <table>
          <thead><tr><Th k="symbol" label="Asset" /><th>Held in</th><Th k="qty" label="Qty" num /><Th k="price" label="Price" num /><Th k="value" label="Market value" num /><th className="num">Cost basis</th><th>Observed</th></tr></thead>
          <tbody>
            {sortPositions(bundled, sort).map((p) => (
              <tr key={`${p.symbol}|${p.currency}`} className={p.provisional ? "prov" : ""}>
                <td title={p.name ?? undefined}>{p.symbol}<div className="small muted">{chopMiddle(p.name ?? p.asset_class)}</div></td>
                <td className="small" title={p.account_ids.join("\n")}>{p.accounts} account{p.accounts === 1 ? "" : "s"}</td>
                <td className="num">{maskDigits(p.quantity)}</td>
                <td className="num">{money(p.price, p.currency)}</td>
                <td className="num">
                  {p.fact_ids.length > 0 ? (
                    <FactLink id={p.fact_ids[0] as string} openFact={openFact}>{money(p.market_value, p.currency)}</FactLink>
                  ) : (
                    money(p.market_value, p.currency)
                  )}
                  {p.fact_ids.length > 1 && <span className="small muted"> (+{p.fact_ids.length - 1} facts)</span>}
                </td>
                <td className="num">
                  {p.cost_basis === null ? (
                    <span className="pill medium">unknown</span>
                  ) : (
                    <>
                      {money(p.cost_basis, p.currency)}
                      {!p.basis_complete && <span className="pill medium" title="some accounts don't state a basis; the sum understates"> partial</span>}
                    </>
                  )}
                </td>
                <td className="small">{when(p.observed_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// The home screen (deck slide 19): the Attention Queue. Approvals,
// data exceptions, and prepared orders under one roof, tabbed.
// Chat is a tool inside the product, not the product.
// Pure reconciliation exceptions: what the feeds did that needs your
// judgment. The Market Manager's proposals and prepared orders live on
// Strategy -> Plan & Rebalancing.
function QueuePage({ tick, onChanged, openFact }: { tick: number; onChanged: () => void; openFact: (id: string) => void }) {
  const [items, setItems] = useState<Finding[]>([]);
  useEffect(() => {
    api.queue().then(setItems).catch(() => setItems([]));
  }, [tick]);
  return (
    <div className="page page-narrow">
      <h2>Attention Queue</h2>
      <p className="page-sub">Data exceptions that need your judgment before the books are trusted.</p>
      {items.length === 0 ? (
        <p className="muted">Nothing requires your attention. Every account reconciled clean.</p>
      ) : (
        <>
          <div className="section-label" style={{ marginTop: 0 }}><Icon name="warning-circle" /> Conflict Resolution Required</div>
          <div className="conflict-grid">
            {items.map((f) => (
              <QueueItem key={f.id} f={f} onChanged={onChanged} openFact={openFact} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Phase 4: the approval queue. Scoped to one proposal id, bounded,
// expiring; auditor-cleared before it ever reaches you.
function ApprovalsSection({ approvals, hasPlan = true, onChanged, openFact }: { approvals: import("./api").QueuedApproval[]; hasPlan?: boolean; onChanged: () => void; openFact: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const propose = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.propose();
      // A run that settles without queueing anything is an ANSWER, not
      // silence: say what happened, on the page.
      if (r.state === "terminal") {
        setError(
          r.reason !== undefined
            ? `The Market Manager run ended without a proposal: ${r.reason}`
            : r.status === "completed"
              ? "The Market Manager finished without a proposal — every asset class is inside the plan's drift band."
              : `The Market Manager run ended (${r.status}) without queueing a proposal.`,
        );
      }
      onChanged();
    } catch (e) {
      // On the page, in plain words -- never a popup.
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="actions" style={{ marginBottom: 24 }}>
        <button
          className="secondary"
          disabled={busy || !hasPlan}
          title={hasPlan ? undefined : "Write the investment plan above first — the Market Manager only proposes against a written plan"}
          onClick={() => void propose()}
        >
          {busy ? "proposing…" : "Ask the Market Manager for a proposal"}
        </button>
        {!hasPlan && <span className="small muted">Needs a written plan first.</span>}
      </div>
      {error !== null && <div className="banner" style={{ marginBottom: 16 }}>{error}</div>}
      {busy && <Thinking label="The Market Manager is drafting and the Auditor is re-running its figures" />}
      {approvals.length === 0 && !busy && <p className="muted">No proposals await your signature.</p>}
      {approvals.map((q) => (
        <ApprovalItem key={q.recommendation.id} q={q} onChanged={onChanged} openFact={openFact} />
      ))}
    </>
  );
}

function ApprovalItem({ q, onChanged, openFact }: { q: import("./api").QueuedApproval; onChanged: () => void; openFact: (id: string) => void }) {
  const rec = q.recommendation;
  const [qty, setQty] = useState(rec.action.quantity ?? "");
  const [limit, setLimit] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    try {
      await api.decide(rec.id, decision, { max_quantity: qty || null, limit_price: limit || null }, note);
      onChanged();
    } catch (e) {
      alert(String(e));
    } finally {
      setBusy(false);
    }
  };
  const verb = rec.action.verb;
  const headline = `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${rec.action.quantity ?? ""} ${rec.action.instrument ?? ""}`.replace(/\s+/g, " ").trim();
  return (
    <div className="approval-card">
      <div className="approval-head">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="icon-tile blue"><Icon name="sparkle" /></span>
          <div>
            <div className="who">AI Trade Recommendation</div>
            <div className="sub">{rec.from} • {(rec.confidence * 100).toFixed(0)}% confidence • auditor cleared (attempt {q.verdict.attempt})</div>
          </div>
        </div>
        <span className="exp">Expires {when(rec.expires)}</span>
      </div>
      <div className="approval-body">
        <div className="approval-grid">
          <div>
            <h2>{maskDigits(headline)}{rec.action.amount != null && <span className="muted" style={{ fontWeight: 400 }}> · ~{money(rec.action.amount.amount, rec.action.amount.currency)}</span>}</h2>
            <p style={{ fontSize: 14, color: "var(--t2)", lineHeight: 1.6, margin: "0 0 16px" }}>{rec.thesis}</p>
            <div className="evrow">
              <Icon name="link-simple" className="icon" />
              <span>Evidence:{" "}
                {rec.evidence.slice(0, 6).map((id) => (
                  <FactLink key={id} id={id} openFact={openFact}><span>{id.slice(0, 12)}… </span></FactLink>
                ))}
                {rec.evidence.length > 6 && <span className="muted">(+{rec.evidence.length - 6})</span>}
              </span>
            </div>
            {rec.action.detail != null && rec.action.detail !== "" && (
              <div className="evrow"><span style={{ color: "var(--t3)", display: "inline-flex" }}><Icon name="tag" /></span><span className="muted">{rec.action.detail}</span></div>
            )}
            {(rec.tax_lots ?? []).length > 0 && (
              <div className="evrow">
                <span style={{ color: "var(--t3)", display: "inline-flex" }}><Icon name="tag" /></span>
                <span>Tax lot{(rec.tax_lots ?? []).length > 1 ? "s" : ""}: <code>{(rec.tax_lots ?? []).map((l) => `${l.lot_id} (${l.treatment})`).join(", ")}</code></span>
              </div>
            )}
            <div className="evrow"><span className="muted">{rec.subject}</span></div>
          </div>
          <div className="form-panel">
            <div>
              <label className="field-label">Max quantity to {verb}</label>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <input value={qty} onChange={(e) => setQty(e.target.value)} />
                <span className="inline-note">proposed {maskDigits(rec.action.quantity ?? "—")}</span>
              </div>
            </div>
            <div>
              <label className="field-label">Limit price</label>
              <input placeholder="optional" value={limit} onChange={(e) => setLimit(e.target.value)} />
            </div>
            <div>
              <label className="field-label">Approval note (optional)</label>
              <textarea placeholder="Reasoning for deviation…" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
        </div>
        <div className="approval-foot">
          <button className="ghost danger" disabled={busy} onClick={() => void decide("reject")}><Icon name="trash" /> Reject Recommendation</button>
          <button disabled={busy} onClick={() => void decide("approve")}>Approve (Scoped &amp; Expiring)</button>
        </div>
      </div>
    </div>
  );
}

// Prepared -- never sent. Place any order yourself; revoke here any time.
function InstructionsSection({ rows, onChanged }: { rows: import("./api").InstructionRow[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const revoke = async (id: string) => {
    setBusy(true);
    try {
      await api.revoke(id, "revoked from the queue");
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  if (rows.length === 0) return <p className="muted">No prepared orders. Execution is disabled: anything prepared here is placed by you, never sent by the system.</p>;
  return (
    <>
      <p className="small muted" style={{ marginTop: 0 }}>Execution is disabled: these are prepared, never sent. Place them yourself; the nightly reconciles the fill.</p>
      <table>
        <thead><tr><th>Instruction</th><th>Order</th><th>Bound</th><th>Status</th><th>Expires</th><th></th></tr></thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.id}>
              <td className="small">{i.id}</td>
              <td>{i.action.verb} {i.action.instrument}</td>
              <td className="small">≤ {i.bound.max_quantity ?? "?"} {i.bound.limit_price != null ? `@ limit ${i.bound.limit_price}` : ""}</td>
              <td><span className={`pill ${i.current_status === "prepared" ? "info" : "medium"}`}>{i.current_status}</span></td>
              <td className="small">{when(i.expires)}</td>
              <td>{i.current_status === "prepared" && <button disabled={busy} className="secondary" onClick={() => void revoke(i.id)}>Revoke</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
  const title = f.code.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <div className="conflict-card">
      <div className="blob" />
      <div className="c-head">
        <span className={`sev ${f.severity}`} />
        <span className="c-title">{title}</span>
        <span className={`pill ${f.severity}`} style={{ marginLeft: "auto" }}>{f.severity}</span>
      </div>
      <p style={{ fontSize: 12, color: "var(--t2)", lineHeight: 1.6, margin: "0 0 6px" }}>{f.summary}</p>
      <div className="small muted" style={{ marginBottom: 14 }}>{f.subject} · {when(f.as_of)} · by {f.emitted_by}</div>
      {hasVersions && (
        <div className="vs-grid">
          <div className="vs-box">
            <span className="vs-lbl">Internal ledger (before)</span>
            {detail!.before.length === 0 && <div className="vs-sub">— nothing prior —</div>}
            {detail!.before.map((x) => <FactCard key={x.id} f={x} openFact={openFact} />)}
          </div>
          <div className="vs-box bad">
            <span className="vs-lbl">Feed now says (after)</span>
            {detail!.after.length === 0 && <div className="vs-sub">—</div>}
            {detail!.after.map((x) => <FactCard key={x.id} f={x} openFact={openFact} />)}
          </div>
        </div>
      )}
      <input placeholder="Note (why)" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: "100%", marginBottom: 12 }} />
      <div className="choice-grid">
        <button className="neutral" disabled={busy} onClick={() => resolve("keep_prior")}>Keep Prior</button>
        <button disabled={busy} onClick={() => resolve("accept_incoming")}>Accept Incoming</button>
        <button className="neutral wide" disabled={busy} onClick={() => resolve("both")}>Both are real (Split)</button>
        <button className="ghost wide" disabled={busy} onClick={() => resolve("dismiss")}>Dismiss</button>
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
    <div style={{ marginTop: 6 }}>
      <div className="vs-val"><FactLink id={f.id} openFact={openFact}>{headline}</FactLink></div>
      <div className="vs-sub">observed {when(f.observed_at)} · effective {when(f.effective_at)}{f.provisional ? " · provisional" : ""}</div>
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
          <dt>file</dt><dd><DocumentLink path={`/api/document/${document.id}/bytes`}>{document.filename}</DocumentLink></dd>
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

// Phase 2: the tax calendar. Deadline gates, the running estimate, and
// reserve coverage -- every figure clickable back to its facts.
function TaxPage({ tick, onChanged, openFact }: { tick: number; onChanged: () => void; openFact: (id: string) => void }) {
  const [tax, setTax] = useState<TaxStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    api.tax().then(setTax).catch(() => setTax(null));
  }, [tick]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      alert(String(e));
    } finally {
      setBusy(false);
    }
  };
  if (tax === null) return <div className="page"><p className="muted">Host unreachable.</p></div>;
  if (tax.profile === null) {
    return (
      <div className="page page-mid">
        <h2>Tax Calendar</h2>
        <p className="page-sub">Let's set up your tax profile — a few numbers you'd confirm with your accountant. The engine is an estimator, not tax advice.</p>
        <TaxProfileForm existing={null} onSaved={onChanged} />
      </div>
    );
  }
  // The first quarter whose deadline gate hasn't run yet is "current"; the
  // one after it is next in line, everything later is future.
  const settled = (s: TaxStageStatus) => s.state === "ran" || s.state === "skipped";
  let currentIdx = tax.quarters.findIndex((q) => !settled(q.due_stage));
  if (currentIdx === -1) currentIdx = tax.quarters.length;
  return (
    <div className="page page-mid">
      <div className="page-head">
        <div>
          <h2>Tax Calendar · {tax.year}</h2>
          <div className="head-chips">
            <span className="chip"><Icon name="wallet" /> Reserve: <code>{tax.profile.reserve_account}</code></span>
            <span className="chip"><Icon name="shield-check" /> Safe Harbour: <code>{money(tax.profile.prior_year_tax)}</code></span>
            <span className="chip">Withholding: <code>{money(tax.profile.withholding_annual)}/yr</code></span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button className="secondary" onClick={() => setEditing((e) => !e)}>{editing ? "Hide Tax Profile" : "Edit Tax Profile"}</button>
          {tax.runId === null ? (
            <button className="btn-blue" disabled={busy} onClick={() => void act(() => api.taxYearStart())}>
              Start {tax.profile.tax_year} Standing Run
            </button>
          ) : (
            <span className="pill info" title={tax.runId}>standing run · {tax.runStatus}</span>
          )}
        </div>
      </div>
      {editing && <TaxProfileForm existing={tax.profile} onSaved={() => { setEditing(false); onChanged(); }} />}
      <div className="tl">
        {tax.quarters.map((q, i) => (
          <QuarterCard
            key={q.quarter}
            q={q}
            busy={busy}
            act={act}
            openFact={openFact}
            status={i < currentIdx ? "past" : i === currentIdx ? "current" : i === currentIdx + 1 ? "next" : "future"}
          />
        ))}
      </div>
      <div className="infonote">
        <h4><Icon name="info" /> Understanding the "Standing Run"</h4>
        <p>
          The {tax.profile.tax_year} standing run is the automated process that watches your tax liabilities through the
          year. Ahead of each deadline it re-estimates the installment and checks that your <b>reserve account</b> holds
          enough cash to cover it — without selling assets at the wrong time. Every figure links back to dated ledger facts.
        </p>
      </div>
    </div>
  );
}

/** The accountant conversation's numbers, collected as a form -- no JSON, no files. */
function TaxProfileForm({ existing, onSaved }: { existing: TaxStatus["profile"]; onSaved: () => void }) {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(String(existing?.tax_year ?? currentYear));
  const [ordinary, setOrdinary] = useState(existing !== null ? String(Number(existing.ordinary_rate) * 100) : "");
  const [ltcg, setLtcg] = useState(existing !== null ? String(Number(existing.ltcg_rate) * 100) : "");
  const [priorTax, setPriorTax] = useState(existing?.prior_year_tax ?? "");
  const [over150k, setOver150k] = useState(false);
  const [withholding, setWithholding] = useState(existing?.withholding_annual ?? "");
  const [reserve, setReserve] = useState(existing?.reserve_account ?? "");
  const [accounts, setAccounts] = useState<Array<{ account_id: string; name: string; type: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.accounts().then(setAccounts).catch(() => setAccounts([]));
  }, []);
  const save = async () => {
    if (reserve === "") {
      setError("Pick the account your estimated-tax money sits in (the reserve). Connect or add one on the Assets page first if none fits.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.taxProfileSave({
        tax_year: Number(year),
        ordinary_rate: ordinary,
        ltcg_rate: ltcg,
        prior_year_tax: priorTax,
        prior_year_agi_over_150k: over150k,
        withholding_annual: withholding,
        reserve_account: reserve,
      });
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="queue-item" style={{ marginTop: 10 }}>
      <h3 style={{ marginTop: 0 }}>1 · Rates</h3>
      <div className="actions">
        <input style={{ width: 110 }} placeholder="Tax year" value={year} disabled={busy} onChange={(e) => setYear(e.target.value)} />
        <input style={{ width: 200 }} placeholder="Ordinary income rate — e.g. 24%" value={ordinary} disabled={busy} onChange={(e) => setOrdinary(e.target.value)} />
        <input style={{ width: 210 }} placeholder="Long-term gains rate — e.g. 15%" value={ltcg} disabled={busy} onChange={(e) => setLtcg(e.target.value)} />
      </div>
      <h3>2 · Last year & withholding</h3>
      <div className="actions">
        <input style={{ width: 230 }} placeholder="Last year's total tax — e.g. $18,500" value={priorTax} disabled={busy} onChange={(e) => setPriorTax(e.target.value)} />
        <input style={{ width: 250 }} placeholder="Withholding this year — e.g. $12,000/yr" value={withholding} disabled={busy} onChange={(e) => setWithholding(e.target.value)} />
        <label className="small"><input type="checkbox" checked={over150k} disabled={busy} onChange={(e) => setOver150k(e.target.checked)} /> last year's income was over $150k (raises the safe-harbour to 110%)</label>
      </div>
      <h3>3 · Where the tax money sits</h3>
      <div className="actions">
        <select value={reserve} disabled={busy} onChange={(e) => setReserve(e.target.value)}>
          <option value="">Pick the reserve account…</option>
          {accounts.map((a) => (
            <option key={a.account_id} value={a.account_id}>{a.name} ({a.type})</option>
          ))}
        </select>
        <span className="small muted">the deadline checks compare each installment against this account's balance</span>
      </div>
      {error !== null && <div className="banner" style={{ marginTop: 8 }}>{error}</div>}
      <div className="actions" style={{ marginTop: 10 }}>
        <button disabled={busy} onClick={() => void save()}>{busy ? "saving…" : "Save tax profile"}</button>
      </div>
    </div>
  );
}

/** A gate's dot color and short text for the timeline card's status boxes. */
function stageView(s: TaxStageStatus): { dot: string; text: string; sub: string | null } {
  switch (s.state) {
    case "armed":
      return { dot: "amber", text: "Armed", sub: s.fire_at !== null ? `fires ${when(s.fire_at)}` : null };
    case "ran":
      return s.covered === false
        ? { dot: "red", text: "Ran — reserve short", sub: "escalated to the queue" }
        : { dot: "green", text: "Ran", sub: s.covered === true ? "covered by reserve" : null };
    case "skipped":
      return { dot: "gray", text: "Skipped", sub: null };
    case "failed":
      return { dot: "red", text: "Failed", sub: null };
    default:
      return { dot: "gray", text: "Inactive", sub: null };
  }
}

const QUARTER_NAMES = ["First", "Second", "Third", "Fourth"];

function QuarterCard({ q, busy, act, openFact, status }: { q: TaxQuarterStatus; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void>; openFact: (id: string) => void; status: "past" | "current" | "next" | "future" }) {
  const [note, setNote] = useState("");
  const f = q.estimate?.figures ?? null;
  const pre = stageView(q.pre);
  const due = stageView(q.due_stage);
  const itemCls = status === "current" ? "now" : status === "past" ? "dim" : status === "next" ? "dim" : "far";
  const showDetail = status === "current" || status === "past";
  return (
    <div className={`tl-item ${itemCls}`}>
      <div className="tl-dot" />
      <div className="tl-card">
        <div className="tl-head">
          <div>
            {status === "current" ? (
              <span className="badge-chip green">Current Period</span>
            ) : (
              <span className="uc" style={{ fontSize: 10, fontWeight: 700, color: "var(--t3)" }}>
                {status === "past" ? "Completed" : status === "next" ? "Upcoming" : "Future"}
              </span>
            )}
            <h4>Q{q.quarter} · {QUARTER_NAMES[q.quarter - 1]} Quarter</h4>
            <p className="when">Period ends {q.period_end} • <b>Deadline {q.due}</b></p>
          </div>
          {status === "current" && (
            <div style={{ display: "flex", gap: 8 }}>
              <button disabled={busy} onClick={() => void act(() => api.taxCheck(q.quarter, "pre"))}>Check Now</button>
              <button className="secondary" disabled={busy} onClick={() => void act(() => api.taxCheck(q.quarter, "due"))}>Deadline Check</button>
            </div>
          )}
        </div>
        {showDetail && (
          <>
            <div className="gates">
              <div className="gate-box">
                <p className="g-lbl">Pre-stage Status</p>
                <div className={`g-val${pre.dot === "gray" ? " off" : ""}`}><span className={`g-dot ${pre.dot}`} />{pre.text}</div>
                {pre.sub !== null && <div className="g-sub">{pre.sub}</div>}
              </div>
              <div className="gate-box">
                <p className="g-lbl">Deadline Status</p>
                <div className={`g-val${due.dot === "gray" ? " off" : ""}`}><span className={`g-dot ${due.dot}`} />{due.text}</div>
                {due.sub !== null && <div className="g-sub">{due.sub}</div>}
              </div>
              <div className="gate-box" style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 8 }}>
                <input placeholder="Skip note (why)" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: "100%" }} />
                <button
                  className="ghost"
                  disabled={busy || status !== "current"}
                  onClick={() => void act(() => api.taxSkip(q.quarter, q.pre.state === "armed" ? "pre" : "due", note))}
                  style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
                >
                  <Icon name="prohibit" /> Skip this gate
                </button>
              </div>
            </div>
            {q.estimate !== null && q.estimate.blocked.length > 0 && (
              <div className="banner" style={{ marginTop: 16, marginBottom: 0 }}>Estimate blocked: {q.estimate.blocked.join(", ")} provisional.</div>
            )}
            {(q.obligation !== null || f !== null) && (
              <div className="figures">
                <div className="fig">
                  <div className="f-lbl">Installment due</div>
                  <div className="f-val">
                    {q.obligation !== null && q.obligation.amount !== null ? (
                      <FactLink id={q.obligation.fact_id} openFact={openFact}>{money(q.obligation.amount)}</FactLink>
                    ) : f !== null ? (
                      money(f.installment_due)
                    ) : (
                      <span className="muted">—</span>
                    )}
                    {q.obligation?.superseded && <span className="small muted"> (corrected)</span>}
                  </div>
                </div>
                {f !== null && (
                  <>
                    <div className="fig"><div className="f-lbl">Income YTD</div><div className="f-val">{money(f.ordinary_income)}</div></div>
                    <div className="fig"><div className="f-lbl">Gains ST / LT</div><div className="f-val">{money(f.st_gains)} / {money(f.lt_gains)}{f.basis_incomplete ? <span className="small muted"> (basis gaps)</span> : null}</div></div>
                    <div className="fig"><div className="f-lbl">Required cum.</div><div className="f-val">{money(f.required_cum)}</div></div>
                    <div className="fig"><div className="f-lbl">Paid cum.</div><div className="f-val">{money(f.payments_cum)}</div></div>
                    {q.estimate!.reserve !== null && (
                      <div className="fig">
                        <div className="f-lbl">Reserve</div>
                        <div className="f-val">
                          {money(q.estimate!.reserve.balance)}{" "}
                          {q.estimate!.reserve_ok ? <span className="pill low">covers</span> : <span className="pill critical">short {money(q.estimate!.reserve.shortfall)}</span>}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {(q.estimate?.wash_sales ?? []).map((w) => (
              <div key={w.sale_txn_id} className="small muted" style={{ marginTop: 10 }}>wash-sale watch: {w.symbol} loss {money(w.loss)}, ~{money(w.disallowed_estimate)} disallowed</div>
            ))}
          </>
        )}
        {status === "next" && <div className="locked-box">Locked until previous gate completion</div>}
      </div>
    </div>
  );
}

// Phase 3: the Strategist chat. The model narrates; every figure comes
// from a tool result recorded as evidence, each number clickable back to
// its facts. Chat is a tool inside the product, not the product.
/** Unsent drafts survive page/tab switches (component unmounts) for the whole session. */
const DRAFTS = new Map<string, string>();

/** Agent replies are markdown; render them as such (sanitized -- model output is not trusted HTML). */
function Markdown({ text }: { text: string }) {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }));
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

const agentTitle = (a: ChatAgentName): string => (a === "estate_planner" ? "The Estate Planner" : "The Strategist");

/** One recorded exchange: your bubble on the right, the agent's evidence-rich reply on the left. */
function ChatTurnCard({ t, openFact }: { t: ChatTurn; openFact: (id: string) => void }) {
  return (
    <>
      <div className="msg user">
        <div style={{ maxWidth: "80%" }}>
          <div className="stamp" style={{ textAlign: "right" }}>you · {when(t.at)}</div>
          <div className="bubble-user">{t.message}</div>
        </div>
      </div>
      <div className="msg">
        <span className="ai-avatar"><Icon name="sparkle" /></span>
        <div className="bubble-ai">
          <div className="stamp">{agentTitle(t.agent)}</div>
          <Markdown text={t.reply} />
          {t.evidence.length > 0 && (
            <div className="evidence-block">
              {t.evidence.map((e, i) => (
                <div key={i} className="evidence-row">
                  <div className="e-info">
                    <Icon name="file-text" className="icon" />
                    <div style={{ minWidth: 0 }}>
                      <div className="e-title">{e.tool.replace(/_/g, " ")}</div>
                      <div className="e-sub">
                        {e.fact_ids.slice(0, 8).map((id) => (
                          <FactLink key={id} id={id} openFact={openFact}>
                            <span>{id.slice(0, 14)}… </span>
                          </FactLink>
                        ))}
                        {e.fact_ids.length > 8 && <span>(+{e.fact_ids.length - 8} facts)</span>}
                        {e.fact_ids.length === 0 && <span>deterministic tool result</span>}
                      </div>
                    </div>
                  </div>
                  {e.fact_ids.length > 0 && (
                    <button className="ghost" style={{ color: "var(--link)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap" }} onClick={() => openFact(e.fact_ids[0]!)}>
                      View Evidence
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {t.journal_ids.length > 0 && <div className="small muted" style={{ marginTop: 10 }}>journaled: {t.journal_ids.join(", ")}</div>}
        </div>
      </div>
    </>
  );
}

/** What the agent is carrying forward, computed from the recorded transcript -- no model call. */
function memorySummary(turns: ChatTurn[]): string | null {
  if (turns.length === 0) return null;
  const first = turns[0]!;
  const last = turns[turns.length - 1]!;
  const journaled = turns.reduce((n, t) => n + t.journal_ids.length, 0);
  const since = first.at.slice(0, 10);
  const lastMsg = last.message.replace(/\s+/g, " ").trim();
  const gist = lastMsg.length > 90 ? `${lastMsg.slice(0, 90)}…` : lastMsg;
  return `Remembering ${turns.length} exchange${turns.length === 1 ? "" : "s"} since ${since}${journaled > 0 ? `, ${journaled} journaled` : ""} — last asked: “${gist}”`;
}

/**
 * One agent's transcript + a proper composer (4-6 lines, wrapping;
 * Enter sends, Shift+Enter = new line). Earlier exchanges collapse
 * behind a disclosure; only the latest stays in view, with a subdued
 * summary of the remembered state above the composer.
 */
function ChatPanel({ agent, openFact, intro, layout = "inline" }: { agent: ChatAgentName; openFact: (id: string) => void; intro?: string; layout?: "inline" | "workspace" }) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [text, setTextState] = useState(() => DRAFTS.get(`chat:${agent}`) ?? "");
  const setText = (v: string) => {
    DRAFTS.set(`chat:${agent}`, v);
    setTextState(v);
  };
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollToComposer = () => {
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }));
  };
  const load = useCallback(() => {
    api.chatTranscript(agent).then(setTurns).catch(() => setTurns([]));
  }, [agent]);
  useEffect(load, [load]);
  // A reply landing (turn count grows) also brings the composer back into view.
  const prevTurnCount = useRef<number | null>(null);
  useEffect(() => {
    if (prevTurnCount.current !== null && turns.length > prevTurnCount.current) scrollToComposer();
    prevTurnCount.current = turns.length;
  }, [turns.length]);
  const send = async () => {
    const t = text.trim();
    if (t === "") return;
    // Optimistic: the question appears highlighted at once, the box empties,
    // and the panel scrolls so the spinner AND the composer are in view.
    setText("");
    setPending(t);
    setBusy(true);
    setError(null);
    scrollToComposer();
    try {
      await api.chatSend(agent, t);
      load();
    } catch (e) {
      setError(String(e));
      setText(t); // the draft comes back rather than being lost
    } finally {
      setPending(null);
      setBusy(false);
    }
  };
  const earlier = turns.slice(0, -1);
  const latest = turns.length > 0 ? turns[turns.length - 1]! : null;
  const summary = memorySummary(turns);
  const messages = (
    <>
      {turns.length === 0 && layout === "workspace" && (
        <div className="chat-hero">
          <div className="h-icon"><Icon name="info" /></div>
          <h3>Private Advisory Mode</h3>
          <p>{agentTitle(agent)} has no write permissions. Every reply's evidence links back to dated ledger facts or journal entries.</p>
          {intro !== undefined && <p style={{ marginTop: 16, fontStyle: "italic" }}>{intro}</p>}
        </div>
      )}
      {turns.length === 0 && layout === "inline" && intro !== undefined && <p className="muted">{intro}</p>}
      {earlier.length > 0 && (
        <p style={{ margin: 0, maxWidth: 820, marginLeft: "auto", marginRight: "auto", width: "100%" }}>
          <button className="secondary" onClick={() => setShowHistory((h) => !h)}>
            {showHistory ? "▾ Hide" : "▸ Show"} earlier conversation ({earlier.length})
          </button>
        </p>
      )}
      {showHistory && earlier.map((t) => <ChatTurnCard key={t.message_id} t={t} openFact={openFact} />)}
      {latest !== null && <ChatTurnCard t={latest} openFact={openFact} />}
      {pending !== null && (
        <>
          <div className="msg user">
            <div style={{ maxWidth: "80%" }}>
              <div className="stamp" style={{ textAlign: "right" }}>you · just now</div>
              <div className="bubble-user">{pending}</div>
            </div>
          </div>
          <div className="msg">
            <span className="ai-avatar"><Icon name="sparkle" /></span>
            <div className="bubble-ai" style={{ flex: "none" }}>
              <Thinking label={`${agentTitle(agent)} is thinking`} />
            </div>
          </div>
        </>
      )}
      {error !== null && <div className="banner" style={{ maxWidth: 820, margin: "0 auto", width: "100%" }}>{error}</div>}
    </>
  );
  if (layout === "workspace") {
    return (
      <>
        <div className="chat-scroll">
          {messages}
          <div ref={bottomRef} />
        </div>
        <div className="chat-inputbar">
          {summary !== null && <div className="chat-context">{summary}</div>}
          <div className="box">
            <textarea
              placeholder={busy ? "thinking…" : `Ask ${agentTitle(agent)} anything…`}
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="sendrow">
              <kbd className="kbd">Shift ⏎ = new line</kbd>
              <button className="btn-blue" disabled={busy} onClick={() => void send()}>{busy ? "…" : "Send"}</button>
            </div>
          </div>
          <div className="foot">Advisory only • every figure links back to dated ledger facts</div>
        </div>
      </>
    );
  }
  return (
    <div className="chat-inline">
      {messages}
      {summary !== null && <p className="small muted" style={{ fontStyle: "italic", margin: 0 }}>{summary}</p>}
      <div ref={bottomRef} className="actions" style={{ alignItems: "flex-end" }}>
        <textarea
          className="chat-input"
          rows={5}
          placeholder={busy ? "thinking…" : "Ask anything… (Enter sends, Shift+Enter for a new line)"}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button disabled={busy} onClick={() => void send()}>
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

type StrategyTab = "chat" | "plan";

/**
 * Strategy is one destination with two distinct agents behind two tabs:
 * the Strategist (conversation -- it advises and journals, never drafts
 * trades) and the Market Manager's Plan & Rebalancing workflow (the
 * written plan, drift, bounded proposals the Auditor re-verifies).
 */
function StrategyPage({ tab, setTab, tick, onChanged, openFact }: { tab: StrategyTab; setTab: (t: StrategyTab) => void; tick: number; onChanged: () => void; openFact: (id: string) => void }) {
  const [approvalsCount, setApprovalsCount] = useState(0);
  useEffect(() => {
    api.approvals().then((a) => setApprovalsCount(a.length)).catch(() => setApprovalsCount(0));
  }, [tick]);
  // The SAME header on both tabs -- title, description, tab row -- so
  // nothing moves when switching.
  const head = (
    <PageHeader
      title="Strategy"
      sub="Advisory only — figures are deterministic, the Auditor re-verifies every proposal, and execution stays disabled."
      tabs={
        <SegTabs
          value={tab}
          onChange={setTab}
          options={[
            { id: "chat", label: "The Strategist" },
            { id: "plan", label: "Plan & Rebalancing", count: approvalsCount, tone: "green" },
          ]}
        />
      }
    />
  );
  // Both tabs wrap the header in the SAME container -- same max-width,
  // same padding -- so the title and tabs render at identical pixels and
  // nothing jumps when switching.
  if (tab === "chat") {
    return (
      <>
        <div className="page page-mid" style={{ paddingBottom: 0, flex: "none", width: "100%" }}>{head}</div>
        <ChatPage openFact={openFact} />
      </>
    );
  }
  return (
    <div className="page page-mid" style={{ width: "100%" }}>
      {head}
      <PlanSection tick={tick} onChanged={onChanged} openFact={openFact} />
    </div>
  );
}

const ASSET_CLASS_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["equity", "Stocks (individual equities)"],
  ["etf", "ETFs"],
  ["mutual_fund", "Mutual funds"],
  ["bond", "Bonds"],
  ["crypto", "Crypto"],
  ["cash", "Cash"],
  ["option", "Options"],
  ["other", "Other"],
];

/**
 * Write the investment plan in the GUI: target weights per asset class,
 * the drift band, optional notes and constraints. Percentages in, the
 * host stores fractions and refuses weights that do not add to 100%.
 */
function PlanEditor({ plan, onSaved }: { plan: import("./api").PlanStatus["plan"]; onSaved: () => void }) {
  const asPct = (frac: string): string => `${Number((Number(frac) * 100).toFixed(2))}`;
  const [rows, setRows] = useState<Array<{ asset_class: string; pct: string }>>(() =>
    plan !== null && plan.targets.length > 0
      ? plan.targets.map((t) => ({ asset_class: t.asset_class, pct: asPct(t.weight) }))
      : [
          { asset_class: "etf", pct: "60" },
          { asset_class: "bond", pct: "40" },
        ],
  );
  const [band, setBand] = useState(() => (plan !== null ? asPct(plan.band) : "5"));
  const [notes, setNotes] = useState(plan?.notes ?? "");
  const [noSell, setNoSell] = useState((plan?.constraints.do_not_sell ?? []).join(", "));
  const [maxPos, setMaxPos] = useState(plan?.constraints.max_position_weight != null ? asPct(plan.constraints.max_position_weight) : "");
  const [maxOrder, setMaxOrder] = useState(plan?.constraints.max_order_value ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = rows.reduce((s, r) => s + (Number(r.pct) || 0), 0);
  const toFrac = (pct: string): string => String(Number((Number(pct) / 100).toFixed(4)));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.savePlan({
        band: toFrac(band),
        targets: rows.filter((r) => r.pct.trim() !== "").map((r) => ({ asset_class: r.asset_class, weight: toFrac(r.pct) })),
        constraints: {
          ...(noSell.trim() !== "" ? { do_not_sell: noSell.split(",").map((s) => s.trim().toUpperCase()).filter((s) => s !== "") } : {}),
          ...(maxPos.trim() !== "" ? { max_position_weight: toFrac(maxPos) } : {}),
          ...(maxOrder.trim() !== "" ? { max_order_value: String(maxOrder).replace(/[$,\s]/g, "") } : {}),
        },
        ...(notes.trim() !== "" ? { notes: notes.trim() } : {}),
      });
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel" style={{ marginBottom: 20 }}>
      <p className="small muted" style={{ marginTop: 0 }}>
        Target weights for the invested portfolio. The Market Manager proposes only when a class drifts outside the band.
      </p>
      {rows.map((r, i) => (
        <div key={i} className="actions" style={{ marginBottom: 8 }}>
          <select value={r.asset_class} onChange={(e) => setRows((x) => x.map((row, j) => (j === i ? { ...row, asset_class: e.target.value } : row)))}>
            {ASSET_CLASS_OPTIONS.map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
          <input style={{ width: 90 }} value={r.pct} placeholder="60" onChange={(e) => setRows((x) => x.map((row, j) => (j === i ? { ...row, pct: e.target.value } : row)))} />
          <span className="small muted">%</span>
          <button className="ghost danger" title="Remove this target" disabled={rows.length === 1} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}><Icon name="trash" /></button>
        </div>
      ))}
      <div className="actions" style={{ marginBottom: 12 }}>
        <button className="linklike" onClick={() => setRows((x) => [...x, { asset_class: "equity", pct: "" }])}><Icon name="plus" /> Add an asset class</button>
        <span className={`small ${Math.abs(total - 100) < 0.5 ? "muted" : ""}`} style={Math.abs(total - 100) < 0.5 ? undefined : { color: "var(--amber)", fontWeight: 600 }}>
          Total: {Number(total.toFixed(2))}% {Math.abs(total - 100) < 0.5 ? "" : "— must reach 100%"}
        </span>
      </div>
      <div className="actions" style={{ marginBottom: 8 }}>
        <span className="small">Drift band ±</span>
        <input style={{ width: 70 }} value={band} onChange={(e) => setBand(e.target.value)} />
        <span className="small muted">% before a class is out of band</span>
      </div>
      <div className="actions" style={{ marginBottom: 8, flexWrap: "wrap" }}>
        <span className="small">Never sell</span>
        <input style={{ width: 180 }} placeholder="AAPL, BTC (optional)" value={noSell} onChange={(e) => setNoSell(e.target.value)} />
        <span className="small">Max single position</span>
        <input style={{ width: 70 }} placeholder="%" value={maxPos} onChange={(e) => setMaxPos(e.target.value)} />
        <span className="small">Max order value</span>
        <input style={{ width: 110 }} placeholder="$ (optional)" value={maxOrder} onChange={(e) => setMaxOrder(e.target.value)} />
      </div>
      <textarea rows={2} style={{ width: "100%" }} placeholder="Notes to your future self about why these targets (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
      {error !== null && <div className="banner" style={{ marginTop: 8 }}>{error}</div>}
      <div className="actions" style={{ marginTop: 12 }}>
        <button disabled={busy} onClick={() => void save()}>{busy ? "saving…" : plan === null ? "Write the plan" : "Save the plan"}</button>
      </div>
    </div>
  );
}

/** The Market Manager's home: plan -> drift -> proposals -> prepared orders. */
function PlanSection({ tick, onChanged, openFact }: { tick: number; onChanged: () => void; openFact: (id: string) => void }) {
  const [status, setStatus] = useState<import("./api").PlanStatus | null>(null);
  const [approvals, setApprovals] = useState<import("./api").QueuedApproval[]>([]);
  const [orders, setOrders] = useState<import("./api").InstructionRow[]>([]);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    api.planStatus().then(setStatus).catch(() => setStatus(null));
    api.approvals().then(setApprovals).catch(() => setApprovals([]));
    api.instructions().then(setOrders).catch(() => setOrders([]));
  }, [tick]);
  const pct = (w: string): string => `${(Number(w) * 100).toFixed(1).replace(/\.0$/, "")}%`;
  const plan = status?.plan ?? null;
  const drift = status?.drift ?? null;
  return (
    <>
      <div className="section-label" style={{ marginTop: 0, display: "flex", alignItems: "center", gap: 12 }}>
        <Icon name="note" /> The written plan
        {plan !== null && (
          <button className="linklike" onClick={() => setEditing((e) => !e)}><Icon name="pencil" /> {editing ? "Close the editor" : "Edit the plan"}</button>
        )}
      </div>
      {(plan === null || editing) && (
        <PlanEditor
          plan={plan}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
      {plan === null ? (
        <p className="muted small" style={{ marginTop: 12 }}>
          The Market Manager only ever proposes against a plan you wrote down — target weights per asset class and a
          drift band. Not sure what to target? Ask the Strategist on the other tab.
        </p>
      ) : (
        <>
          <table>
            <thead><tr><th>Asset class</th><th className="num">Target</th>{drift !== null && <><th className="num">Actual</th><th className="num">Drift</th></>}</tr></thead>
            <tbody>
              {plan.targets.map((t) => {
                const line = drift?.by_class.find((l) => l.asset_class === t.asset_class);
                const out = line !== undefined && Math.abs(Number(line.drift)) > Number(plan.band);
                return (
                  <tr key={t.asset_class}>
                    <td style={{ fontWeight: 500, color: "var(--strong)" }}>{t.asset_class === "etf" ? "ETF" : t.asset_class.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}</td>
                    <td className="num">{pct(t.weight)}</td>
                    {drift !== null && (
                      <>
                        <td className="num">{line !== undefined ? pct(line.weight) : "—"}</td>
                        <td className="num" style={out ? { color: "var(--amber)", fontWeight: 600 } : undefined}>
                          {line !== undefined ? `${Number(line.drift) > 0 ? "+" : ""}${pct(line.drift)}` : "—"}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="small muted" style={{ marginTop: 8 }}>
            Band: ±{pct(plan.band)} per class · plan as of {plan.as_of}
            {drift !== null && <> · portfolio {money(drift.portfolio_value, "USD")} + cash {money(drift.cash_value, "USD")}</>}
            {plan.notes !== undefined && plan.notes !== "" && <> · {plan.notes}</>}
          </p>
          {drift !== null && drift.candidates.length > 0 && (
            <p className="small muted">
              {drift.candidates.length} class{drift.candidates.length === 1 ? " is" : "es are"} outside the band — the
              Market Manager has material for a proposal.
            </p>
          )}
        </>
      )}
      <div className="section-label"><Icon name="sparkle" /> Proposals</div>
      <ApprovalsSection approvals={approvals} hasPlan={plan !== null} onChanged={onChanged} openFact={openFact} />
      {orders.length > 0 && (
        <>
          <div className="section-label"><Icon name="note" /> Prepared orders</div>
          <InstructionsSection rows={orders} onChanged={onChanged} />
        </>
      )}
    </>
  );
}

function ChatPage({ openFact }: { openFact: (id: string) => void }) {
  const [agent, setAgent] = useState<ChatAgentName>("strategist");
  return (
    <div className="chatwrap">
      <div className="chat-head">
        <div className="who">
          <span className="icon-tile blue" style={{ width: 40, height: 40, borderRadius: 12 }}><Icon name="sparkle" /></span>
          <div>
            <div className="w-name">{agentTitle(agent)}</div>
            <div className="w-status"><span className="on" />Active • advisory only • deterministic figures</div>
          </div>
        </div>
        <select value={agent} onChange={(e) => setAgent(e.target.value as ChatAgentName)}>
          <option value="strategist">The Strategist</option>
          <option value="estate_planner">The Estate Planner</option>
        </select>
      </div>
      <ChatPanel
        key={agent}
        agent={agent}
        openFact={openFact}
        layout="workspace"
        intro={'Try: "If I sell the rental next spring, what does that do to the Q2 estimate and the trust schedule?"'}
      />
    </div>
  );
}

// Phase 3: the Entity & Estate Registry -- plan on paper vs plan in reality.
function EstatePage({ tick, onChanged, openFact }: { tick: number; onChanged: () => void; openFact: (id: string) => void }) {
  const [estate, setEstate] = useState<EstateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.estate().then(setEstate).catch(() => setEstate(null));
  }, [tick]);
  if (estate === null) return <p className="muted">Host unreachable.</p>;
  const wizardAndChat = (
    <>
      <EstateWizard tick={tick} onChanged={onChanged} />
      <h3 style={{ marginTop: 18 }}>Ask the Estate Planner</h3>
      <p className="small muted">
        Advisory only. It can read your profile (never your tax id), the registry, and the document vault; concerns it
        raises are cited findings, never silent edits.
      </p>
      <ChatPanel agent="estate_planner" openFact={openFact} intro={'No conversation yet. Try: "Who is missing from my will given my family situation?"'} />
    </>
  );
  if (!estate.configured) {
    return (
      <>
        <h2>Estate registry</h2>
        <p className="muted">
          No estate plan on file yet. Start with the wizard below; the registry itself (intended titling, expected
          documents, executors) is written with your attorney into <code>estate.json</code>.
        </p>
        {wizardAndChat}
      </>
    );
  }
  const audit = async () => {
    setBusy(true);
    try {
      await api.estateAudit();
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const observedBySubject = new Map(estate.titling.map((t) => [t.subject, t]));
  return (
    <>
      <h2>Estate registry</h2>
      <p>
        <button disabled={busy} onClick={() => void audit()}>{busy ? "auditing…" : "Run hygiene audit"}</button>{" "}
        {estate.openFindings > 0 && <span className="pill high">{estate.openFindings} open estate finding(s) in the queue</span>}
      </p>
      <h3>Entities</h3>
      <table>
        <thead><tr><th>Entity</th><th>Kind</th><th>Fact</th></tr></thead>
        <tbody>
          {estate.entities.map((e) => (
            <tr key={e.subject}>
              <td>{e.payload.name ?? e.subject}<div className="small muted">{e.subject}</div></td>
              <td>{e.payload.kind}</td>
              <td className="small"><FactLink id={e.fact_id} openFact={openFact}>{e.fact_id.slice(0, 16)}…</FactLink></td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Titling — plan vs paperwork</h3>
      <table>
        <thead><tr><th>Account</th><th>Plan</th><th>Observed (dated)</th></tr></thead>
        <tbody>
          {(estate.plan?.titling ?? []).map((p) => {
            const o = observedBySubject.get(p.account_id);
            const planStr = `${p.owner}${p.in_trust ? ` · in ${p.in_trust}` : ""}${(p.beneficiaries ?? []).length > 0 ? ` · ben: ${(p.beneficiaries ?? []).map((b) => b.name).join(", ")}` : ""}`;
            const obsStr = o === undefined ? null : `${o.payload.owner ?? "?"}${o.payload.in_trust ? ` · in ${o.payload.in_trust}` : ""}${(o.payload.beneficiaries ?? []).length > 0 ? ` · ben: ${(o.payload.beneficiaries ?? []).map((b) => b.name).join(", ")}` : ""}`;
            const differs = obsStr !== null && planStr !== obsStr;
            return (
              <tr key={p.account_id} className={differs ? "prov" : ""}>
                <td className="small">{p.account_id}</td>
                <td className="small">{planStr}</td>
                <td className="small">
                  {o === undefined ? (
                    <span className="pill medium">no record</span>
                  ) : (
                    <FactLink id={o.fact_id} openFact={openFact}>{obsStr}</FactLink>
                  )}
                  {o?.payload.verified_at !== undefined && <span className="muted"> · verified {o.payload.verified_at}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h3>Break-glass</h3>
      <p className="small">
        Executors: {(estate.plan?.executors ?? []).join(", ") || <span className="pill high">none recorded</span>} · expected
        documents: {(estate.plan?.documents ?? []).map((d) => d.kind).join(", ") || "none"}
      </p>
      {wizardAndChat}
    </>
  );
}

/** The estate wizard: collect the people a will must account for (stored in the household profile). */
function EstateWizard({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { d, setD, save, busy, error, saved } = useProfileDraft(tick);
  const [open, setOpen] = useState(false);
  if (d === null) return null;
  const people = (d.has_spouse && d.spouse.legal_name.trim() !== "" ? 1 : 0) + d.children.filter((c) => c.legal_name.trim() !== "").length + d.others.filter((o) => o.legal_name.trim() !== "").length;
  return (
    <div className="queue-item" style={{ marginTop: 14 }}>
      <div className="head">
        <b>People in your estate</b>
        {people > 0 ? <span className="pill low">{people} recorded</span> : <span className="pill medium">not collected yet</span>}
        <button className="secondary" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : people > 0 ? "Review / edit" : "Start"}</button>
      </div>
      <div className="small muted">
        An estate planner needs to know who exists before what-goes-where: spouse, children, and anyone else your will
        should name. Saved with your household details; residence, citizenship, and tax id live on the
        People page.
      </div>
      {open && (
        <>
          {d.legal_name.trim() === "" && (
            <>
              <h3>1 · Your name</h3>
              <div className="actions"><input style={{ flex: 1 }} placeholder="Your full legal name" value={d.legal_name} disabled={busy} onChange={(e) => setD((x) => ({ ...x, legal_name: e.target.value }))} /></div>
            </>
          )}
          <PeopleEditor d={d} setD={setD} disabled={busy} />
          {error !== null && <div className="banner">{error}</div>}
          <div className="actions" style={{ marginTop: 8 }}>
            <button disabled={busy} onClick={() => { void save().then((ok) => { if (ok) onChanged(); }); }}>{busy ? "saving…" : "Save"}</button>
            {saved && <span className="pill low">saved</span>}
          </div>
        </>
      )}
    </div>
  );
}

// Phase 3: the Decision Journal -- what was decided, when, why.
/** Where the system accounts for itself: what ran, and what was decided. */
function AuditPage({ tick, onChanged, openFact }: { tick: number; onChanged: () => void; openFact: (id: string) => void }) {
  const [tab, setTab] = useState<"runs" | "journal">("runs");
  return (
    <>
      <PageHeader
        title="Audit Logs"
        sub="What ran, what it found, and what was decided — kept because financial feedback loops are years long."
        tabs={
          <SegTabs
            value={tab}
            onChange={setTab}
            options={[
              { id: "runs", label: "Nightly runs" },
              { id: "journal", label: "Decision journal" },
            ]}
          />
        }
      />
      {tab === "runs" && <Runs tick={tick} onChanged={onChanged} />}
      {tab === "journal" && <JournalPage tick={tick} openFact={openFact} />}
    </>
  );
}

function JournalPage({ tick, openFact }: { tick: number; openFact: (id: string) => void }) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  useEffect(() => {
    api.journalFull().then(setEntries).catch(() => setEntries([]));
  }, [tick]);
  return (
    <>
      <p className="small muted">Financial feedback loops are years long; memory is the only way to learn from them.</p>
      <table>
        <thead><tr><th>When</th><th>Kind</th><th>Author</th><th>Entry</th><th>Refs</th></tr></thead>
        <tbody>
          {entries.map((j) => (
            <tr key={j.id}>
              <td className="small">{when(j.at)}</td>
              <td><span className={`pill ${j.kind === "decision" ? "info" : "low"}`}>{j.kind}</span></td>
              <td className="small">{j.author}</td>
              <td>{j.summary}</td>
              <td className="small">
                {j.refs.slice(0, 4).map((r) => (
                  <FactLink key={r} id={r} openFact={openFact}><span className="muted">{r.slice(0, 12)}… </span></FactLink>
                ))}
                {j.refs.length > 4 && <span className="muted">(+{j.refs.length - 4})</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
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

// --- Settings: how the console looks. A display preference of this ---
// --- machine's browser profile; never stored on the host. ---

function SettingsPage() {
  const [ui, setUi] = useState<UiSettings>(() => loadUiSettings());
  // LAN exposure is a HOST setting (it rebinds the listener and persists
  // in the data root), unlike the appearance choices below.
  const [lan, setLanState] = useState<import("./api").LanStatus | null>(null);
  const [lanBusy, setLanBusy] = useState(false);
  const [lanError, setLanError] = useState<string | null>(null);
  useEffect(() => {
    api.lanStatus().then(setLanState).catch(() => setLanState(null));
  }, []);
  const toggleLan = (enabled: boolean) => {
    setLanBusy(true);
    setLanError(null);
    api.lanSet(enabled)
      .then(setLanState)
      .catch((e) => setLanError(String(e)))
      .finally(() => setLanBusy(false));
  };
  const update = (patch: Partial<UiSettings>) => {
    setUi((u) => {
      const next = { ...u, ...patch };
      applyUiSettings(next);
      saveUiSettings(next);
      return next;
    });
  };
  // Colors edit the ACTIVE theme's set: with Dark showing (chosen, or via
  // Auto), a new background changes only how Dark looks.
  const active = resolvedTheme(ui);
  const colors = ui[active];
  const activeName = active === "dark" ? "Dark" : "Light";
  const updateColors = (patch: Partial<ThemeColors>) => update({ [active]: { ...colors, ...patch } } as Partial<UiSettings>);
  const noColors = (c: ThemeColors) => c.background === null && c.foreground === null;
  const isDefault =
    ui.theme === UI_DEFAULTS.theme && ui.fontSize === UI_DEFAULTS.fontSize && noColors(ui.light) && noColors(ui.dark);
  const colorRow = (
    name: string,
    hint: string,
    value: string | null,
    fallback: string,
    set: (v: string | null) => void,
  ) => (
    <div className="set-row">
      <div>
        <div className="set-name">{name}</div>
        <div className="set-hint">{hint}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <input type="color" value={value ?? fallback} onChange={(e) => set(e.target.value)} title={name} />
        {value !== null ? (
          <>
            <code className="small">{value}</code>
            <button className="secondary" onClick={() => set(null)}>Theme default</button>
          </>
        ) : (
          <span className="small muted">theme default</span>
        )}
      </div>
    </div>
  );
  return (
    <>
      <h2>Settings</h2>
      <p className="page-sub">
        How the console looks on {thisMachine()}. These preferences live in the app's local storage — they never touch the
        ledger and never leave the machine.
      </p>
      <div className="panel">
        <div className="panel-title" style={{ marginBottom: 8 }}>
          <span className="icon-tile"><Icon name="gear" /></span>
          Appearance
        </div>
        <div className="set-row">
          <div>
            <div className="set-name">Theme</div>
            <div className="set-hint">Auto follows the {isWindows() ? "Windows" : isMac() ? "macOS" : "system"} appearance.</div>
          </div>
          <div className="seg">
            {(["light", "dark", "auto"] as const).map((t) => (
              <button key={t} className={ui.theme === t ? "on" : ""} onClick={() => update({ theme: t })}>
                {t.charAt(0).toUpperCase()}{t.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="set-row">
          <div>
            <div className="set-name">Font size</div>
            <div className="set-hint">Scales the whole console proportionally.</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <input
              type="range"
              min={11}
              max={20}
              step={1}
              value={ui.fontSize}
              onChange={(e) => update({ fontSize: Number(e.target.value) })}
              style={{ width: 180, padding: 0 }}
            />
            <span className="num" style={{ width: 44, color: "var(--strong)", fontWeight: 600 }}>{ui.fontSize} px</span>
          </div>
        </div>
        {colorRow(
          "Background color",
          `Applies to the ${activeName} theme only; panel, border, and hover shades are derived from it.`,
          colors.background,
          active === "dark" ? "#1a1a1a" : "#eaeef5",
          (v) => updateColors({ background: v }),
        )}
        {colorRow(
          "Foreground color",
          `Applies to the ${activeName} theme only; secondary text shades are derived from it.`,
          colors.foreground,
          active === "dark" ? "#e5e7eb" : "#243044",
          (v) => updateColors({ foreground: v }),
        )}
        <div className="set-row" style={{ borderBottom: 0, paddingBottom: 0 }}>
          <span className="set-hint">Changes apply immediately.</span>
          <button className="secondary" disabled={isDefault} onClick={() => update({ ...UI_DEFAULTS })}>
            Reset to defaults
          </button>
        </div>
      </div>
      {lan !== null && (
        <div className="panel">
          <div className="panel-title" style={{ marginBottom: 8 }}>
            <span className="icon-tile blue"><Icon name="globe" /></span>
            Network
          </div>
          <div className="set-row">
            <div>
              <div className="set-name">Make available on my LAN</div>
              <div className="set-hint" style={{ fontStyle: "italic" }}>
                You can connect a browser to {lan.addresses[0] ?? "this machine"}.
              </div>
            </div>
            <input
              type="checkbox"
              style={{ width: 20, height: 20 }}
              checked={lan.enabled}
              disabled={lanBusy}
              onChange={(e) => toggleLan(e.target.checked)}
              title={lan.enabled ? "Stop serving the local network" : "Serve the local network"}
            />
          </div>
          <div className="set-row" style={{ borderBottom: 0, paddingBottom: 0 }}>
            <span className="set-hint">
              Every request still requires sign-in, and only requests naming this machine are served — but traffic is
              plain HTTP, so use it on networks you trust. Applies immediately and persists across launches.
              {lan.enabled && lan.addresses.length > 1 ? ` Also reachable at ${lan.addresses.slice(1).join(", ")}.` : ""}
            </span>
          </div>
          {lanError !== null && <div className="banner" style={{ marginTop: 8 }}>{lanError}</div>}
        </div>
      )}
    </>
  );
}

type DocTab = "all" | "drafts" | "data" | "records";
type DocSortKey = "name" | "kind" | "creator" | "size" | "date";

const CREATOR_LABELS: Record<string, string> = {
  estate_planner: "Estate Planner",
  strategist: "Strategist",
  assets_manager: "Institutions & feeds",
  operator: "You",
};
const creatorLabel = (id: string): string => CREATOR_LABELS[id] ?? id;

/** mime/extension -> a coarse, filterable file type. */
function fileTypeOf(d: Doc): string {
  const m = d.mime.toLowerCase();
  const ext = (d.filename.split(".").pop() ?? "").toLowerCase();
  if (m.includes("pdf") || ext === "pdf") return "PDF";
  if (m.includes("markdown") || ext === "md") return "Markdown";
  if (m.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "heic", "webp"].includes(ext)) return "Image";
  if (m.includes("json") || ext === "json") return "JSON";
  if (m.includes("csv") || ext === "csv") return "CSV";
  if (m.startsWith("text/") || ext === "txt") return "Text";
  return ext !== "" ? ext.toUpperCase() : "Other";
}

function docTabOf(d: Doc): DocTab {
  if (d.kind === "draft") return "drafts";
  if (d.kind === "snapshot" || d.kind === "export") return "data";
  return "records"; // statements, tax forms, deeds, wills, policies, ...
}

function Documents({ tick }: { tick: number }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [tab, setTab] = useState<DocTab>("all");
  const [creator, setCreator] = useState("");
  const [ftype, setFtype] = useState("");
  const [sort, setSort] = useState<{ key: DocSortKey; dir: 1 | -1 }>({ key: "date", dir: -1 });
  const [exported, setExported] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.documents().then(setDocs).catch(() => setDocs([]));
  }, [tick]);
  const doExport = async () => {
    setBusy(true);
    try {
      const r = await api.exportBreakGlass();
      setExported(`${r.dir} (${r.files} files, ${r.documents} documents) -- open index.html there; print OPERATING-GUIDE.pdf`);
    } catch (e) {
      setExported(String(e));
    } finally {
      setBusy(false);
    }
  };
  const clickSort = (key: DocSortKey) =>
    setSort((s0) => (s0.key === key ? { key, dir: s0.dir === 1 ? -1 : 1 } : { key, dir: key === "date" || key === "size" ? -1 : 1 }));
  const Th = ({ k, label, num }: { k: DocSortKey; label: string; num?: boolean }) => (
    <th className={`sortable${num === true ? " num" : ""}`} onClick={() => clickSort(k)}>
      {label}
      {sort.key === k ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
    </th>
  );
  const creators = [...new Set(docs.map((d) => d.ingested_by))].sort();
  const ftypes = [...new Set(docs.map(fileTypeOf))].sort();
  const counts = new Map<DocTab, number>();
  for (const d of docs) counts.set(docTabOf(d), (counts.get(docTabOf(d)) ?? 0) + 1);
  const rows = docs
    .filter((d) => (tab === "all" ? true : docTabOf(d) === tab))
    .filter((d) => (creator === "" ? true : d.ingested_by === creator))
    .filter((d) => (ftype === "" ? true : fileTypeOf(d) === ftype))
    .sort((a, b) => {
      switch (sort.key) {
        case "name": return sort.dir * a.filename.localeCompare(b.filename);
        case "kind": return sort.dir * (a.kind.localeCompare(b.kind) || a.filename.localeCompare(b.filename));
        case "creator": return sort.dir * (a.ingested_by.localeCompare(b.ingested_by) || a.filename.localeCompare(b.filename));
        case "size": return sort.dir * (a.bytes - b.bytes);
        case "date": return sort.dir * a.ingested_at.localeCompare(b.ingested_at);
      }
    });
  return (
    <>
      <PageHeader
        title="Document vault"
        sub="Every raw statement and draft the app has ingested or written — the evidence behind each number."
        tabs={
          <SegTabs
            value={tab}
            onChange={setTab}
            options={[
              { id: "all", label: "All" },
              { id: "drafts", label: "Drafts", count: counts.get("drafts") ?? 0 },
              { id: "data", label: "Statements & data", count: counts.get("data") ?? 0 },
              { id: "records", label: "Records", count: counts.get("records") ?? 0 },
            ]}
          />
        }
      />
      <p>
        <button disabled={busy} onClick={() => void doExport()}>{busy ? "exporting…" : "Break-glass export"}</button>
        <span className="small muted"> Create a directory with all of your information in clear text</span>
      </p>
      {exported !== null && <div className="banner">{exported}</div>}
      <div className="actions" style={{ marginBottom: 8 }}>
        <select value={creator} onChange={(e) => setCreator(e.target.value)}>
          <option value="">All creators</option>
          {creators.map((c) => (
            <option key={c} value={c}>{creatorLabel(c)}</option>
          ))}
        </select>
        <select value={ftype} onChange={(e) => setFtype(e.target.value)}>
          <option value="">All types</option>
          {ftypes.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        {(creator !== "" || ftype !== "") && (
          <button className="secondary" onClick={() => { setCreator(""); setFtype(""); }}>Clear filters</button>
        )}
        <span className="small muted">{rows.length} of {docs.length} documents</span>
      </div>
      <table>
        <thead><tr><Th k="name" label="File" /><Th k="kind" label="Kind" /><th>Type</th><Th k="creator" label="Creator" /><Th k="size" label="Bytes" num /><Th k="date" label="Ingested" /><th>sha256</th></tr></thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td><DocumentLink path={`/api/document/${d.id}/bytes`}>{d.filename}</DocumentLink></td>
              <td>{d.kind}</td>
              <td className="small">{fileTypeOf(d)}</td>
              <td className="small">{creatorLabel(d.ingested_by)}</td>
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
