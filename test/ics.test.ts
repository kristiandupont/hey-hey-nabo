import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCalendar, escapeText, foldLine, formatUtc } from "../src/ics.ts";

const encoder = new TextEncoder();

/** Reverse RFC 5545 folding, to check we can round-trip. */
function unfold(value: string): string {
  return value.replace(/\r\n /g, "");
}

test("short lines are left alone", () => {
  assert.equal(foldLine("SUMMARY:Krebsegilde"), "SUMMARY:Krebsegilde");
});

test("folding counts octets, not characters", () => {
  // 70 'ø' characters is 70 chars but 140 octets — folding by character count
  // would leave this as a single over-long line.
  const line = `SUMMARY:${"ø".repeat(70)}`;
  const folded = foldLine(line);

  assert.ok(folded.includes("\r\n"), "expected the line to be folded");
  for (const part of folded.split("\r\n")) {
    assert.ok(
      encoder.encode(part).length <= 75,
      `line of ${encoder.encode(part).length} octets exceeds the limit`,
    );
  }
  assert.equal(unfold(folded), line);
});

test("folding does not split surrogate pairs", () => {
  const line = `SUMMARY:${"🎉".repeat(40)}`;
  const folded = foldLine(line);

  assert.ok(!folded.includes("�"));
  assert.equal(unfold(folded), line);
  assert.equal([...unfold(folded)].filter((c) => c === "🎉").length, 40);
});

test("text escaping handles backslash before the characters it introduces", () => {
  assert.equal(escapeText("a\\b"), "a\\\\b");
  assert.equal(escapeText("Fest; mad, drikke"), "Fest\\; mad\\, drikke");
  assert.equal(escapeText("line one\nline two"), "line one\\nline two");
  // Colons are not escaped in TEXT values.
  assert.equal(escapeText("kl. 10:00"), "kl. 10:00");
});

test("dates render as UTC date-time values", () => {
  assert.equal(formatUtc(new Date("2026-08-08T07:30:00+00:00")), "20260808T073000Z");
  // A non-UTC offset must be converted, not truncated.
  assert.equal(formatUtc(new Date("2026-08-08T09:30:00+02:00")), "20260808T073000Z");
});

test("calendar has the required structure and CRLF endings", () => {
  const ics = buildCalendar(
    [
      {
        uid: "event-7@example.com",
        start: new Date("2026-02-11T09:00:00Z"),
        end: new Date("2026-02-11T11:00:00Z"),
        summary: "Fastelavn",
        description: "Tøndeslagning",
        location: "Fælleshuset",
        categories: ["Social udvalget"],
        status: "CONFIRMED",
        timestamp: new Date("2026-02-08T11:56:14Z"),
      },
    ],
    { name: "Staldhusene", ttlMinutes: 15 },
  );

  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!/(?<!\r)\n/.test(ics), "every line ending must be CRLF");

  assert.match(ics, /^UID:event-7@example\.com\r$/m);
  assert.match(ics, /^DTSTART:20260211T090000Z\r$/m);
  assert.match(ics, /^DTEND:20260211T110000Z\r$/m);
  assert.match(ics, /^DTSTAMP:20260208T115614Z\r$/m);
  assert.match(ics, /^X-PUBLISHED-TTL:PT15M\r$/m);
});

test("an event without an end omits DTEND", () => {
  const ics = buildCalendar(
    [
      {
        uid: "u@example.com",
        start: new Date("2026-02-11T09:00:00Z"),
        summary: "Point in time",
        timestamp: new Date("2026-02-11T09:00:00Z"),
      },
    ],
    { name: "Test" },
  );

  assert.ok(!ics.includes("DTEND"));
});

test("URL values are not text-escaped", () => {
  const ics = buildCalendar(
    [
      {
        uid: "u@example.com",
        start: new Date("2026-02-11T09:00:00Z"),
        summary: "Med link",
        url: "https://example.com/desktop/calendar/events",
        timestamp: new Date("2026-02-11T09:00:00Z"),
      },
    ],
    { name: "Test" },
  );

  assert.match(ics, /^URL:https:\/\/example\.com\/desktop\/calendar\/events\r$/m);
});
