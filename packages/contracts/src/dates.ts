// Reading dates the way people write them: "Jul 30 1959",
// "July 30, 1959", "30 Jul 1959", "7/30/1959", "1959-07-30". The
// canonical form is always ISO (YYYY-MM-DD); ambiguity resolves the US
// way (month first) unless the day makes that impossible. Impossible
// dates (Feb 30) are refused, not silently shifted.

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

function iso(y: number, m: number, d: number): string | null {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return null;
  return `${String(y)}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Parse a human-typed date to ISO YYYY-MM-DD, or null when it can't be
 * read (or isn't a real date). Never guesses a year: two-part dates
 * ("Jul 30") are rejected.
 */
export function parseDateInput(raw: string): string | null {
  const s = raw.trim().replace(/\s+/g, " ");
  if (s === "") return null;

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m !== null) return iso(Number(m[1]), Number(m[2]), Number(m[3]));

  // "Jul 30 1959", "July 30, 1959", "Jul. 30th 1959"
  m = /^([A-Za-z]+)\.?,? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(s);
  if (m !== null) {
    const month = MONTHS[(m[1] as string).toLowerCase()];
    return month === undefined ? null : iso(Number(m[3]), month, Number(m[2]));
  }

  // "30 Jul 1959", "30th of July, 1959"
  m = /^(\d{1,2})(?:st|nd|rd|th)?(?: of)? ([A-Za-z]+)\.?,? (\d{4})$/.exec(s);
  if (m !== null) {
    const month = MONTHS[(m[2] as string).toLowerCase()];
    return month === undefined ? null : iso(Number(m[3]), month, Number(m[1]));
  }

  // "7/30/1959" (US month-first) -- day-first only when month-first is impossible.
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s);
  if (m !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    return a > 12 ? iso(y, b, a) : iso(y, a, b);
  }

  return null;
}
