// Minimal RFC 4180 CSV parser: quoted fields, doubled quotes, CRLF/LF.
// Returns rows as objects keyed by the header row.

export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i] as string;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.length > 1 || (row[0] ?? "") !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || (row[0] ?? "") !== "") rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows.map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => {
      o[h.trim()] = (r[i] ?? "").trim();
    });
    return o;
  });
}

/** "$1,234.56" | "(1,234.56)" | "-1234.56" -> "-1234.56" ; "" -> null */
export function parseMoney(s: string | undefined): string | null {
  if (s === undefined) return null;
  let t = s.trim();
  if (t === "" || t === "--" || t.toUpperCase() === "N/A") return null;
  let neg = false;
  if (t.startsWith("(") && t.endsWith(")")) {
    neg = true;
    t = t.slice(1, -1);
  }
  t = t.replace(/[$,\s]/g, "");
  if (t.startsWith("-")) {
    neg = !neg;
    t = t.slice(1);
  } else if (t.startsWith("+")) {
    t = t.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return `${neg ? "-" : ""}${t}`;
}

/** "08/21/2026" | "2026-08-21" | "2026-08-21T..." -> ISO date-time (UTC midnight for dates). */
export function parseDate(s: string | undefined): string | null {
  if (s === undefined) return null;
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(T.*)?$/.exec(t);
  if (m !== null) {
    return m[4] !== undefined ? new Date(t).toISOString() : `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m !== null) {
    return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}T00:00:00.000Z`;
  }
  return null;
}
