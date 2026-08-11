/**
 * Minimal RFC 5545 serializer — enough for a read-only PUBLISH feed.
 *
 * Hand-rolled rather than pulled from npm because the parts that actually
 * matter here (octet-based line folding, text escaping, stable UIDs) are
 * short, and most libraries assume a Node runtime that Workers doesn't have.
 */

const CRLF = "\r\n";
const MAX_OCTETS = 75;

const encoder = new TextEncoder();

/**
 * RFC 5545 §3.1: lines SHOULD NOT exceed 75 *octets*, excluding the CRLF.
 * Danish text is full of æ/ø/å, which are two octets each in UTF-8, so folding
 * on character count would produce lines that are legal-looking but too long.
 * Continuation lines begin with a single space, which counts toward the limit.
 */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= MAX_OCTETS) return line;

  const parts: string[] = [];
  let current = "";
  let octets = 0;

  // Iterating the string yields code points, so surrogate pairs stay intact.
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (octets + size > MAX_OCTETS) {
      parts.push(current);
      current = " ";
      octets = 1;
    }
    current += char;
    octets += size;
  }
  parts.push(current);

  return parts.join(CRLF);
}

/** RFC 5545 §3.3.11. Backslash must be escaped first. Colons are not escaped. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** Format as a UTC date-time value: 20260808T073000Z */
export function formatUtc(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
}

export type EventStatus = "CONFIRMED" | "CANCELLED" | "TENTATIVE";

export interface IcsEvent {
  /** Stable across regenerations, so edits update rather than duplicate. */
  uid: string;
  start: Date;
  end?: Date | null;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  categories?: string[];
  status?: EventStatus;
  /**
   * DTSTAMP. Prefer something stable (the event's creation time) over "now" —
   * a timestamp that churns on every fetch makes some clients treat every
   * event as modified on every poll.
   */
  timestamp: Date;
}

export interface CalendarOptions {
  name: string;
  description?: string;
  /** Advertised polling interval; clients treat it as a hint, not a rule. */
  ttlMinutes?: number;
}

function addProperty(lines: string[], name: string, value: string | undefined | null): void {
  if (value === undefined || value === null || value === "") return;
  lines.push(`${name}:${escapeText(value)}`);
}

function toDuration(minutes: number): string {
  if (minutes % (60 * 24) === 0) return `P${minutes / (60 * 24)}D`;
  if (minutes % 60 === 0) return `PT${minutes / 60}H`;
  return `PT${minutes}M`;
}

export function buildCalendar(events: IcsEvent[], options: CalendarOptions): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//heynabo-ics//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  addProperty(lines, "X-WR-CALNAME", options.name);
  addProperty(lines, "NAME", options.name);
  addProperty(lines, "X-WR-CALDESC", options.description);
  addProperty(lines, "DESCRIPTION", options.description);

  if (options.ttlMinutes) {
    const duration = toDuration(options.ttlMinutes);
    lines.push(`REFRESH-INTERVAL;VALUE=DURATION:${duration}`);
    lines.push(`X-PUBLISHED-TTL:${duration}`);
  }

  for (const event of events) {
    lines.push("BEGIN:VEVENT");
    addProperty(lines, "UID", event.uid);
    lines.push(`DTSTAMP:${formatUtc(event.timestamp)}`);
    lines.push(`DTSTART:${formatUtc(event.start)}`);
    // An event with no end is a point in time; omitting DTEND makes clients
    // default it to the start, which is what we want.
    if (event.end) lines.push(`DTEND:${formatUtc(event.end)}`);

    addProperty(lines, "SUMMARY", event.summary);
    addProperty(lines, "DESCRIPTION", event.description);
    addProperty(lines, "LOCATION", event.location);
    if (event.categories?.length) {
      lines.push(`CATEGORIES:${event.categories.map(escapeText).join(",")}`);
    }
    if (event.status) lines.push(`STATUS:${event.status}`);
    // URL is a URI value, not TEXT — it must not be escaped.
    if (event.url) lines.push(`URL:${event.url}`);

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  return lines.map(foldLine).join(CRLF) + CRLF;
}
