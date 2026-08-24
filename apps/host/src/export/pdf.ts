// A minimal PDF writer (PDF 1.4, built-in Helvetica) for the break-glass
// operating guide. No dependencies, no compression: the point of the
// artifact is that it opens on any machine with no software from this
// project -- which is also true of the writer itself.
//
// Supports exactly what the guide needs: US-Letter pages, three text
// styles (title, heading, body), automatic word-wrap and pagination.

interface Line {
  text: string;
  size: number;
  bold: boolean;
  gapBefore: number;
}

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 54;
const LEAD = 1.35;

export class PdfDoc {
  private readonly lines: Line[] = [];

  title(text: string): void {
    this.push(text, 18, true, 6);
  }

  heading(text: string): void {
    this.push(text, 12.5, true, 10);
  }

  body(text: string): void {
    this.push(text, 10, false, 2);
  }

  bullet(text: string): void {
    this.push(`-  ${text}`, 10, false, 2);
  }

  gap(): void {
    this.push("", 10, false, 6);
  }

  private push(text: string, size: number, bold: boolean, gapBefore: number): void {
    // Wrap on an approximate Helvetica advance (0.5em average).
    const maxChars = Math.floor((PAGE_W - 2 * MARGIN) / (size * 0.5));
    const paragraphs = text.split("\n");
    let first = true;
    for (const para of paragraphs) {
      for (const line of wrap(para, maxChars)) {
        this.lines.push({ text: line, size, bold, gapBefore: first ? gapBefore : 0 });
        first = false;
      }
    }
  }

  /** Serialize the document. */
  render(): Uint8Array {
    // Paginate.
    const pages: Line[][] = [];
    let page: Line[] = [];
    let y = PAGE_H - MARGIN;
    for (const line of this.lines) {
      const advance = line.gapBefore + line.size * LEAD;
      if (y - advance < MARGIN && page.length > 0) {
        pages.push(page);
        page = [];
        y = PAGE_H - MARGIN;
      }
      y -= advance;
      page.push(line);
    }
    if (page.length > 0) pages.push(page);

    // Objects: 1 catalog, 2 pages, 3 helv, 4 helv-bold, then per page: page obj + content obj.
    const objects: string[] = [];
    const pageObjIds: number[] = [];
    const helv = 3;
    const helvBold = 4;
    let nextId = 5;
    const pageIds: { page: number; content: number }[] = [];
    for (let i = 0; i < pages.length; i += 1) {
      pageIds.push({ page: nextId, content: nextId + 1 });
      pageObjIds.push(nextId);
      nextId += 2;
    }

    objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
    objects[2] = `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${String(id)} 0 R`).join(" ")}] /Count ${String(pages.length)} >>`;
    objects[helv] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
    objects[helvBold] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`;

    pages.forEach((pg, i) => {
      const ids = pageIds[i] as { page: number; content: number };
      let stream = "BT\n";
      let y2 = PAGE_H - MARGIN;
      for (const line of pg) {
        y2 -= line.gapBefore + line.size * LEAD;
        if (line.text !== "") {
          stream += `/${line.bold ? "F2" : "F1"} ${String(line.size)} Tf 1 0 0 1 ${String(MARGIN)} ${y2.toFixed(1)} Tm (${escapePdf(line.text)}) Tj\n`;
        }
      }
      stream += "ET";
      objects[ids.content] = `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`;
      objects[ids.page] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(PAGE_W)} ${String(PAGE_H)}] ` +
        `/Resources << /Font << /F1 ${String(helv)} 0 R /F2 ${String(helvBold)} 0 R >> >> /Contents ${String(ids.content)} 0 R >>`;
    });

    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (let id = 1; id < nextId; id += 1) {
      offsets[id] = out.length;
      out += `${String(id)} 0 obj\n${objects[id] ?? "<< >>"}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${String(nextId)}\n0000000000 65535 f \n`;
    for (let id = 1; id < nextId; id += 1) {
      out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${String(nextId)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
    return new TextEncoder().encode(out);
  }
}

function wrap(text: string, maxChars: number): string[] {
  if (text === "") return [""];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur === "") {
      cur = w;
    } else if (cur.length + 1 + w.length <= maxChars) {
      cur += ` ${w}`;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur !== "") lines.push(cur);
  return lines;
}

function escapePdf(s: string): string {
  // ASCII only: the xref offsets are computed on string length, so every
  // character must serialize as one byte. Anything else becomes '?'.
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e]/g, "?");
}
