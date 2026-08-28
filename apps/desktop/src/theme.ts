// GUI appearance settings: theme (light / dark / auto), font size, and
// custom background/foreground colors. Stored in localStorage (a display
// preference of this browser profile, not household data) and applied as
// CSS custom properties on <html>, so every themed token follows along.

/** Per-theme color overrides: Dark's custom background applies only while
 * the dark theme is active (chosen, or resolved by Auto); Light keeps its own. */
export interface ThemeColors {
  background: string | null; // hex, or null = theme default
  foreground: string | null;
}

export interface UiSettings {
  theme: "light" | "dark" | "auto";
  fontSize: number; // px; 14 is the design default
  light: ThemeColors;
  dark: ThemeColors;
}

export const UI_DEFAULTS: UiSettings = {
  theme: "dark",
  fontSize: 14,
  light: { background: null, foreground: null },
  dark: { background: null, foreground: null },
};
const KEY = "fin.ui";

const hexOrNull = (v: unknown): string | null => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : null);
const colorsOf = (v: unknown): ThemeColors => {
  const p = (v ?? {}) as Partial<ThemeColors>;
  return { background: hexOrNull(p.background), foreground: hexOrNull(p.foreground) };
};

export function loadUiSettings(): UiSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return { ...UI_DEFAULTS };
    const p = JSON.parse(raw) as Partial<UiSettings> & { background?: unknown; foreground?: unknown };
    const s: UiSettings = {
      theme: p.theme === "light" || p.theme === "auto" ? p.theme : "dark",
      fontSize: typeof p.fontSize === "number" && p.fontSize >= 11 && p.fontSize <= 20 ? p.fontSize : 14,
      light: colorsOf(p.light),
      dark: colorsOf(p.dark),
    };
    // A short-lived earlier shape stored one flat color pair; it belonged
    // to whichever theme was active when it was saved.
    if (p.light === undefined && p.dark === undefined && (p.background !== undefined || p.foreground !== undefined)) {
      s[resolvedTheme(s)] = { background: hexOrNull(p.background), foreground: hexOrNull(p.foreground) };
    }
    return s;
  } catch {
    return { ...UI_DEFAULTS };
  }
}

export function saveUiSettings(s: UiSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
}

// --- small color math on hex triplets ---

function rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function hex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
/** Mix `a` toward `b` by t (0..1). */
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return hex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}
function luminance(c: string): number {
  const [r, g, b] = rgb(c);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** The surface ramp derived from one background color: panels step away
 * from the page background toward the opposite pole, like the stock themes. */
function backgroundVars(bg: string): Record<string, string> {
  const dark = luminance(bg) < 0.5;
  const pole = dark ? "#ffffff" : "#000000";
  return {
    "--n950": bg,
    "--n900": mix(bg, pole, 0.03),
    "--n850": mix(bg, pole, 0.06),
    "--n800": mix(bg, pole, 0.09),
    "--n700": mix(bg, pole, 0.17),
    "--hairline": mix(bg, pole, 0.24),
    "--row-line": mix(bg, pole, 0.15),
    "--chrome": dark ? mix(bg, "#000000", 0.3) : mix(bg, "#ffffff", 0.5),
    "--inset": mix(bg, dark ? "#000000" : "#ffffff", 0.25),
    "--inset2": mix(bg, pole, 0.04),
    "--hover": mix(bg, pole, 0.08),
  };
}

function foregroundVars(fg: string, towardBg: string): Record<string, string> {
  return {
    "--strong": fg,
    "--t1": mix(fg, towardBg, 0.1),
    "--t2": mix(fg, towardBg, 0.32),
    "--t3": mix(fg, towardBg, 0.5),
  };
}

const OVERRIDABLE = ["--n950", "--n900", "--n850", "--n800", "--n700", "--hairline", "--row-line", "--chrome", "--inset", "--inset2", "--hover", "--strong", "--t1", "--t2", "--t3"];

const media = typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia("(prefers-color-scheme: light)") : null;
let autoActive = false;

export function resolvedTheme(s: UiSettings): "light" | "dark" {
  if (s.theme !== "auto") return s.theme;
  return media !== null && media.matches ? "light" : "dark";
}

/** Apply settings to the document: theme attribute, scale, color overrides. */
export function applyUiSettings(s: UiSettings): void {
  const root = document.documentElement;
  const theme = resolvedTheme(s);
  root.dataset["theme"] = theme;
  autoActive = s.theme === "auto";
  // Font size scales the whole console proportionally (the stylesheet is
  // pixel-based); WebKit and Chromium both honor zoom on the root.
  (root.style as CSSStyleDeclaration & { zoom?: string }).zoom = s.fontSize === 14 ? "" : String(s.fontSize / 14);
  for (const p of OVERRIDABLE) root.style.removeProperty(p);
  const colors = s[theme];
  if (colors.background !== null) {
    for (const [p, v] of Object.entries(backgroundVars(colors.background))) root.style.setProperty(p, v);
  }
  if (colors.foreground !== null) {
    const towardBg = colors.background ?? (theme === "light" ? "#f2f5f9" : "#121a2b");
    for (const [p, v] of Object.entries(foregroundVars(colors.foreground, towardBg))) root.style.setProperty(p, v);
  }
}

/** Startup: apply what's stored, and track the OS appearance while on Auto. */
export function applyStoredUiSettings(): void {
  applyUiSettings(loadUiSettings());
  media?.addEventListener("change", () => {
    if (autoActive) applyUiSettings(loadUiSettings());
  });
}
