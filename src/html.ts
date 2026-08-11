/**
 * HeyNabo event descriptions are rich-text HTML. Calendar clients want plain
 * text, so we flatten the small tag vocabulary the editor actually produces
 * (p, span, br, strong, a, ul/ol/li, table/tr/td, h2, div).
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  // Deliberately a plain space rather than U+00A0: a non-breaking space buys
  // nothing in a calendar description and renders oddly in some clients.
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, ref: string) => {
    if (ref[0] !== "#") {
      return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
    }

    const hex = ref[1] === "x" || ref[1] === "X";
    const codePoint = Number.parseInt(hex ? ref.slice(2) : ref.slice(1), hex ? 16 : 10);
    if (!Number.isInteger(codePoint)) return match;

    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return match; // outside the Unicode range
    }
  });
}

/** Convert an HTML fragment to plain text suitable for an ICS DESCRIPTION. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";

  let text = html;

  // Never render these, even though the editor shouldn't emit them.
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Keep link targets: "label (https://…)", or the bare URL when there is no
  // distinct label worth showing.
  text = text.replace(
    /<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      if (!label) return href;
      return href.includes(label) ? label : `${label} (${href})`;
    },
  );

  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<li\b[^>]*>/gi, "\n• ");
  text = text.replace(/<\/td\s*>/gi, "\t");
  // Note: </li> is absent on purpose — the opening <li> already emits the
  // newline, and closing one too would double-space every list.
  text = text.replace(/<\/(p|div|h[1-6]|tr|ul|ol|table|tbody|blockquote)\s*>/gi, "\n");
  text = text.replace(/<(p|div|h[1-6]|tr|table|tbody|blockquote)\b[^>]*>/gi, "\n");

  // Drop everything else (span, strong, em, …) but keep the contents.
  text = text.replace(/<[^>]+>/g, "");

  text = decodeEntities(text);

  // Normalise whitespace: collapse runs, cap consecutive blank lines at one.
  // U+00A0 is included because it can arrive as a literal byte, not only as
  // the &nbsp; entity handled above.
  text = text.replace(/\r\n?/g, "\n");
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]{2,}/g, " ").trimEnd())
    .join("\n");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}
