// The Corbits design uses Phosphor-style icons; the packaged app must work
// offline, so the set is drawn inline. Stroke icons on a 24-grid, sized by
// font-size (1em) so they inherit color and scale like the glyphs they replace.

const STROKE: Record<string, React.ReactNode> = {
  // navigation
  "squares-four": (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" />
    </>
  ),
  "list-checks": (
    <>
      <path d="M11 6h9M11 12h9M11 18h9" />
      <path d="M4 5.5l1.5 1.5L8 4.5" />
      <path d="M4 11.5l1.5 1.5L8 10.5" />
      <path d="M4 17.5l1.5 1.5L8 16.5" />
    </>
  ),
  stack: (
    <>
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 12.5l9 5 9-5" />
      <path d="M3 16.5l9 5 9-5" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="8" r="4.5" />
      <path d="M11.2 11.2L20 20M16 16l2.5-2.5M18.5 18.5l2-2" />
    </>
  ),
  "users-three": (
    <>
      <circle cx="12" cy="7" r="3" />
      <circle cx="4.5" cy="10" r="2.2" />
      <circle cx="19.5" cy="10" r="2.2" />
      <path d="M6.5 19c.5-3 2.7-5 5.5-5s5 2 5.5 5" />
      <path d="M1.5 16.5c.4-1.8 1.6-3 3-3.3M22.5 16.5c-.4-1.8-1.6-3-3-3.3" />
    </>
  ),
  "calendar-blank": (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 9.5h16M8 3v4M16 3v4" />
    </>
  ),
  "chart-line-up": (
    <>
      <path d="M4 4v16h16" />
      <path d="M7 15l4-4 3 3 6-6" />
      <path d="M20 12V8h-4" />
    </>
  ),
  "house-line": (
    <>
      <path d="M5 12l7-7 7 7" />
      <path d="M6.5 10.5V19h11v-8.5" />
      <path d="M3 21h18" />
    </>
  ),
  "scroll-text": (
    <>
      <path d="M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4z" />
      <path d="M6 4a2 2 0 0 0-2 2v2h4" />
      <path d="M10 9h6M10 13h6" />
    </>
  ),
  "file-text": (
    <>
      <path d="M6 3h8l4 4v14H6V3z" />
      <path d="M14 3v4h4" />
      <path d="M9 12h6M9 16h6" />
    </>
  ),
  // topbar & general
  bell: (
    <>
      <path d="M6 10a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 14 6 10z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </>
  ),
  "trend-up": <path d="M3 17l6-6 4 4 8-8M21 12V7h-5" />,
  "arrow-up-right": <path d="M7 17L17 7M9 7h8v8" />,
  "arrow-down-left": <path d="M17 7L7 17M15 17H7V9" />,
  "sign-out": (
    <>
      <path d="M15 4H6v16h9" />
      <path d="M11 12h10M18 8.5l3 3.5-3 3.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20c1-4 4-6 7.5-6s6.5 2 7.5 6" />
    </>
  ),
  // KPI cards
  wallet: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h13v3" />
      <rect x="3" y="7" width="18" height="12" rx="2" />
      <path d="M16 13h2" />
    </>
  ),
  receipt: (
    <>
      <path d="M5 3h14v18l-2.3-1.5L14.4 21l-2.4-1.5L9.6 21l-2.3-1.5L5 21V3z" />
      <path d="M9 8h6M9 12h6" />
    </>
  ),
  coins: (
    <>
      <ellipse cx="9" cy="8" rx="6" ry="3" />
      <path d="M3 8v4c0 1.7 2.7 3 6 3s6-1.3 6-3V8" />
      <path d="M15 11.2c3 .2 6 1.5 6 3.3v.5c0 1.7-2.7 3-6 3-2 0-3.8-.5-4.9-1.2" />
    </>
  ),
  "currency-btc": (
    <>
      <path d="M8 4h6a3 3 0 0 1 0 6H8h7a3 3 0 0 1 0 6H8V4z" />
      <path d="M10 2v2M14 2v2M10 20v2M14 20v2M8 4v16" />
    </>
  ),
  buildings: (
    <>
      <path d="M3 21h18" />
      <path d="M4 21V7l6-3v17" />
      <path d="M10 21V9h9v12" />
      <path d="M13 12h1.5M16.5 12H18M13 15h1.5M16.5 15H18" />
    </>
  ),
  // actions & badges
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M4.5 12.5l5 5L19.5 7" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6" />
      <path d="M12 7.2v.4" />
    </>
  ),
  "warning-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V13" />
      <path d="M12 16.4v.4" />
    </>
  ),
  bank: (
    <>
      <path d="M3 9l9-5 9 5H3z" />
      <path d="M5 9v8M9.5 9v8M14.5 9v8M19 9v8" />
      <path d="M3 17h18M3 20h18" />
    </>
  ),
  vault: (
    <>
      <rect x="3" y="4" width="18" height="15" rx="2" />
      <circle cx="12" cy="11.5" r="4" />
      <circle cx="12" cy="11.5" r="1.2" />
      <path d="M12 7.5v1.5M12 14v1.5M8 11.5h1.5M14.5 11.5H16M6 19v2M18 19v2" />
    </>
  ),
  "upload-simple": <path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M4 19h16" />,
  note: (
    <>
      <path d="M4 4h16v11l-5 5H4V4z" />
      <path d="M15 20v-5h5" />
    </>
  ),
  pencil: (
    <>
      <path d="M14.5 5.5l4 4L8 20H4v-4L14.5 5.5z" />
      <path d="M12.5 7.5l4 4" />
    </>
  ),
  refresh: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 1 2.2 5.3" />
      <path d="M4.5 13.5V17H8" />
    </>
  ),
  "dots-three": (
    <>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  "link-simple": (
    <>
      <path d="M9 15l6-6" />
      <path d="M11 7l2-2a4 4 0 0 1 5.7 5.7l-2 2" />
      <path d="M13 17l-2 2a4 4 0 0 1-5.7-5.7l2-2" />
    </>
  ),
  tag: (
    <>
      <path d="M3 11V3h8l10 10-8 8L3 11z" />
      <circle cx="8" cy="8" r="1.4" />
    </>
  ),
  trash: (
    <>
      <path d="M4 6h16M9 6V4h6v2M6.5 6l1 14h9l1-14" />
      <path d="M10 10v6M14 10v6" />
    </>
  ),
  prohibit: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.7 5.7l12.6 12.6" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.4 4 5.5 4 9s-1.5 6.6-4 9c-2.5-2.4-4-5.5-4-9s1.5-6.6 4-9z" />
    </>
  ),
  "shield-check": (
    <>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" />
      <path d="M8.5 12l2.5 2.5 4.5-4.5" />
    </>
  ),
  keyboard: (
    <>
      <rect x="3" y="7" width="18" height="11" rx="2" />
      <path d="M6.5 10.5h1M10 10.5h1M13.5 10.5h1M17 10.5h1M6.5 14.5h11" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  "eye-slash": (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
      <path d="M4.5 3.5l15 17" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8l1 2.6a6.8 6.8 0 0 1 2.4 1l2.7-.8 1.9 3.3-1.8 2a6.8 6.8 0 0 1 0 2.6l1.8 2-1.9 3.3-2.7-.8a6.8 6.8 0 0 1-2.4 1l-1 2.6-1-2.6a6.8 6.8 0 0 1-2.4-1l-2.7.8-1.9-3.3 1.8-2a6.8 6.8 0 0 1 0-2.6l-1.8-2 1.9-3.3 2.7.8a6.8 6.8 0 0 1 2.4-1l1-2.6z" transform="translate(0 -.3) scale(1 1.03)" />
    </>
  ),
  "caret-left": <path d="M14.5 5.5L8 12l6.5 6.5" />,
  "caret-right": <path d="M9.5 5.5L16 12l-6.5 6.5" />,
};

const FILL: Record<string, React.ReactNode> = {
  sparkle: (
    <path d="M12 2.5l1.9 6.1a1 1 0 0 0 .7.7l6.1 1.9-6.1 1.9a1 1 0 0 0-.7.7L12 20l-1.9-6.1a1 1 0 0 0-.7-.7l-6.1-1.9 6.1-1.9a1 1 0 0 0 .7-.7L12 2.5zM19.5 16l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z" />
  ),
};

/** One design-system icon. `name` picks the glyph; color and size come from CSS (currentColor / 1em). */
export function Icon({ name, size, className }: { name: string; size?: number; className?: string }) {
  const filled = FILL[name];
  const body = filled ?? STROKE[name];
  if (body === undefined) return null;
  return (
    <svg
      className={`icon${className !== undefined ? ` ${className}` : ""}`}
      width={size ?? "1em"}
      height={size ?? "1em"}
      viewBox="0 0 24 24"
      fill={filled !== undefined ? "currentColor" : "none"}
      stroke={filled !== undefined ? "none" : "currentColor"}
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {body}
    </svg>
  );
}

import { CORBITS_LOGO } from "./logo";

/** The product mark: the Corbits mountain. */
export function LogoMark({ size = 26 }: { size?: number }) {
  return <img src={CORBITS_LOGO} width={size} height={size} style={{ objectFit: "contain", display: "block" }} alt="" aria-hidden="true" />;
}
