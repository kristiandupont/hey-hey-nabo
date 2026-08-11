import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTokenExpiredFeed, toIcsEvents, type FeedOptions } from "../src/feed.ts";
import type { HeyNaboEvent } from "../src/heynabo.ts";

const NOW = new Date("2026-08-11T05:00:00Z");

const OPTIONS: FeedOptions = {
  calendarName: "Staldhusene",
  baseUrl: "https://staldhusene.spaces.heynabo.com",
  groupNames: new Map([[31, "Social udvalget"]]),
  pastWindowDays: 30,
  now: NOW,
};

function event(overrides: Partial<HeyNaboEvent> = {}): HeyNaboEvent {
  return {
    id: 1,
    type: "event",
    name: "Fællesspisning",
    description: "<p>Mad i fælleshuset</p>",
    start: "2026-09-01T16:00:00+00:00",
    end: "2026-09-01T18:00:00+00:00",
    registrationEnds: null,
    paymentDetails: null,
    created: "2026-08-01T10:00:00+00:00",
    status: "PUBLISHED",
    groupId: null,
    locationText: null,
    locationId: null,
    visibleToEveryone: true,
    public: false,
    maxParticipants: null,
    minParticipants: null,
    ...overrides,
  };
}

test("group-private events never reach the feed", () => {
  const result = toIcsEvents([event({ visibleToEveryone: false })], OPTIONS);
  assert.equal(result.length, 0);
});

test("events older than the window are dropped", () => {
  const old = event({ start: "2026-01-01T10:00:00+00:00", end: "2026-01-01T12:00:00+00:00" });
  assert.equal(toIcsEvents([old], OPTIONS).length, 0);
});

test("events inside the past window are kept", () => {
  const recent = event({ start: "2026-08-01T10:00:00+00:00", end: "2026-08-01T12:00:00+00:00" });
  assert.equal(toIcsEvents([recent], OPTIONS).length, 1);
});

test("an in-progress long event is kept even if it started before the window", () => {
  const ongoing = event({ start: "2026-06-01T10:00:00+00:00", end: "2026-09-01T12:00:00+00:00" });
  assert.equal(toIcsEvents([ongoing], OPTIONS).length, 1);
});

test("uids are stable and namespaced by host", () => {
  const [mapped] = toIcsEvents([event({ id: 387 })], OPTIONS);
  assert.equal(mapped?.uid, "event-387@staldhusene.spaces.heynabo.com");
});

test("cancelled events are published with STATUS:CANCELLED", () => {
  // HeyNabo spells it with one L; ICS requires two.
  const [mapped] = toIcsEvents([event({ status: "CANCELED" })], OPTIONS);
  assert.equal(mapped?.status, "CANCELLED");
});

test("group names become categories", () => {
  const [mapped] = toIcsEvents([event({ groupId: 31 })], OPTIONS);
  assert.deepEqual(mapped?.categories, ["Social udvalget"]);

  const [unknown] = toIcsEvents([event({ groupId: 999 })], OPTIONS);
  assert.equal(unknown?.categories, undefined);
});

test("a registration deadline equal to the event end is treated as noise", () => {
  const [mapped] = toIcsEvents(
    [event({ registrationEnds: "2026-09-01T18:00:00+00:00" })],
    OPTIONS,
  );
  assert.ok(!mapped?.description?.includes("Tilmeldingsfrist"));
});

test("a genuine registration deadline is shown in Danish local time", () => {
  const [mapped] = toIcsEvents(
    [event({ registrationEnds: "2026-08-25T20:00:00+00:00" })],
    OPTIONS,
  );
  // 20:00 UTC in August is 22:00 in Copenhagen (CEST).
  assert.match(mapped?.description ?? "", /Tilmeldingsfrist: 25\. august 2026 kl\. 22\.00/);
});

test("an end before the start is discarded rather than emitted", () => {
  const [mapped] = toIcsEvents(
    [event({ start: "2026-09-01T16:00:00+00:00", end: "2026-09-01T15:00:00+00:00" })],
    OPTIONS,
  );
  assert.equal(mapped?.end, null);
});

test("events are sorted chronologically", () => {
  const result = toIcsEvents(
    [
      event({ id: 2, start: "2026-10-01T10:00:00+00:00", end: null }),
      event({ id: 1, start: "2026-09-01T10:00:00+00:00", end: null }),
    ],
    OPTIONS,
  );
  assert.deepEqual(
    result.map((e) => e.uid),
    ["event-1@staldhusene.spaces.heynabo.com", "event-2@staldhusene.spaces.heynabo.com"],
  );
});

test("a nameless event still gets a summary", () => {
  const [mapped] = toIcsEvents([event({ name: "  " })], OPTIONS);
  assert.equal(mapped?.summary, "(uden titel)");
});

test("the token-expired feed is a valid single-event calendar", () => {
  const ics = buildTokenExpiredFeed({ calendarName: "Staldhusene", now: NOW });
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 1);
  assert.match(ics, /SUMMARY:.*token/);
});
