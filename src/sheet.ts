/**
 * Read-only access to a Google Sheet shared as "anyone with the link".
 *
 * No API key is involved, which leaves two unauthenticated endpoints and one
 * trap:
 *
 * - `/export?format=csv&gid=<id>` returns a tab's *formatted* values exactly
 *   as displayed. It only accepts the numeric gid; a `sheet=<name>` parameter
 *   is ignored and the first visible tab is returned instead.
 * - `/htmlview` is the only place the name → gid mapping appears. It is an
 *   undocumented page, so parsing it is the fragile step, and it lists only
 *   *visible* tabs (past weeks are hidden in practice, which is fine here).
 * - `/gviz/tq?sheet=<name>` looks like the obvious choice but is not usable:
 *   it types each column, silently dropping cells that do not match the
 *   majority type, and returns the first tab when the name does not exist.
 */

export interface SheetTab {
  name: string;
  gid: string;
}

export class SheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetError";
  }
}

function sheetUrl(sheetId: string, path: string): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/${path}`;
}

async function getText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "heynabo-ics (calendar feed)" },
    redirect: "follow",
  });
  // A sheet that is no longer shared redirects to a Google login page, which
  // arrives as a 200 — fetchTabCsv checks the body for that case.
  if (!response.ok) {
    throw new SheetError(`Google Sheets returned HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

/** Decode the \xHH and \uHHHH escapes Google uses inside JS string literals. */
function decodeJsString(value: string): string {
  return value.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (_match, escape: string) => {
    if (escape.length > 1) return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    return escape === "n" ? "\n" : escape;
  });
}

/** Extract the visible tabs from the htmlview page source. */
export function parseTabList(html: string): SheetTab[] {
  const tabs: SheetTab[] = [];
  const seen = new Set<string>();

  // Each tab appears as {name: "Uge 43", pageUrl: "…", gid: "1879457789", …}.
  for (const match of html.matchAll(/\bname: "((?:[^"\\]|\\.)*)"[^{}]*?\bgid: "(\d+)"/g)) {
    const gid = match[2]!;
    if (seen.has(gid)) continue;
    seen.add(gid);
    tabs.push({ name: decodeJsString(match[1]!), gid });
  }

  return tabs;
}

export async function fetchTabs(sheetId: string): Promise<SheetTab[]> {
  const tabs = parseTabList(await getText(sheetUrl(sheetId, "htmlview")));
  if (tabs.length === 0) {
    throw new SheetError("Found no tabs in the sheet's htmlview page; is it still shared?");
  }
  return tabs;
}

/** RFC 4180 CSV: quoted fields may contain commas, quotes ("") and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

export async function fetchTabCsv(sheetId: string, gid: string): Promise<string[][]> {
  const text = await getText(sheetUrl(sheetId, `export?format=csv&gid=${encodeURIComponent(gid)}`));
  if (/^\s*<(!doctype|html)/i.test(text)) {
    throw new SheetError(`Tab ${gid} returned HTML instead of CSV; is the sheet still shared?`);
  }
  return parseCsv(text);
}
