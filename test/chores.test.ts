import assert from "node:assert/strict";
import { test } from "node:test";

import {
  choreEvents,
  copenhagenTime,
  isoWeek,
  knownNames,
  normalizeName,
  parseDayHeading,
  parseWeekTab,
  selectWeekTabs,
  splitNames,
  type ChoreEventOptions,
} from "../src/chores.ts";
import { parseCsv } from "../src/sheet.ts";

const TODAY = new Date("2026-10-19T00:00:00Z");

// Verbatim CSV exports of two tabs from the real sheet.
const UGE_43 = `,,,,
,,,,
,Tirsdag 20/10,Onsdag 21/10,Torsdag 22/10,Søndag 25/10
Chefkok,Jana,Michael L.,Søren,
"Info, tid mm.",,,,
Madlavning 1,Annette,Merete M,Benjamin,
Madlavning 2,Michael J,Jacob,Miran,
Madlavning 3,Annesofie,Marianne,Anna Louise,
Opvask 1,Anders,Anders,Andreas,
Opvask 2,Michael J,Kåre,Olle,
Opvask 3,Kristian,Jacob,Miran,
Søndagsoprydning/vask af klude,,,,Sara
`;

const UGE_53 = `,,,,
,,,,
,Tirsdag 29/12,Onsdag 30/12,Torsdag 31/12,Søndag 3/1
Chefkok,,,,
"Info, tid mm.",JULEFERIE,JULEFERIE,JULEFERIE,
Madlavning 1,,,,
Opvask 1,,,,
Ferietjans hele ugen,,,,Maria
`;

function options(name: string, overrides: Partial<ChoreEventOptions> = {}): ChoreEventOptions {
  return {
    name,
    now: new Date("2026-10-19T08:00:00Z"),
    pastWindowDays: 30,
    sheetUrl: "https://docs.google.com/spreadsheets/d/x/htmlview",
    ...overrides,
  };
}

test("day headings get the year whose weekday matches", () => {
  assert.equal(parseDayHeading("Tirsdag 20/10", TODAY)?.toISOString(), "2026-10-20T00:00:00.000Z");
  // 3/1 is a Sunday in 2027, not in 2026.
  assert.equal(parseDayHeading("Søndag 3/1", TODAY)?.toISOString(), "2027-01-03T00:00:00.000Z");
  assert.equal(parseDayHeading("tirs. 20/10", TODAY)?.toISOString(), "2026-10-20T00:00:00.000Z");
  assert.equal(parseDayHeading("20/10/2026", TODAY)?.toISOString(), "2026-10-20T00:00:00.000Z");
});

test("text that is not a day heading is rejected", () => {
  assert.equal(parseDayHeading("Chefkok", TODAY), null);
  assert.equal(parseDayHeading("Madlavning 1-3", TODAY), null);
  assert.equal(parseDayHeading("Fredag 31/9", TODAY), null);
  // No year in range has 20/10 on a Monday.
  assert.equal(parseDayHeading("Mandag 20/10", TODAY), null);
});

test("a tab is parsed by content, not by fixed positions", () => {
  const schedule = parseWeekTab(parseCsv(UGE_43), TODAY);
  assert.equal(schedule.assignments.length, 22);

  const sunday = schedule.assignments.find((a) => a.label.startsWith("Søndag"));
  assert.equal(sunday?.date.toISOString(), "2026-10-25T00:00:00.000Z");
  assert.deepEqual(sunday?.names, ["Sara"]);

  // An extra leading column and a moved header row change nothing.
  const shifted = UGE_43.split("\n")
    .slice(2)
    .map((line) => (line ? `,${line}` : line))
    .join("\n");
  assert.deepEqual(parseWeekTab(parseCsv(shifted), TODAY), schedule);
});

test("info rows become day notes, not assignments", () => {
  const schedule = parseWeekTab(parseCsv(UGE_53), TODAY);
  assert.equal(schedule.notes.get("2026-12-29"), "JULEFERIE");
  assert.ok(!knownNames(schedule).includes("JULEFERIE"));
});

test("tabs without a day grid yield nothing", () => {
  const fordeling = parseCsv(",,Husnummer,,Total\nAgnete,,51,1,16\n");
  assert.deepEqual(parseWeekTab(fordeling, TODAY).assignments, []);
});

test("cooking and dishes are timed in Copenhagen local time across the DST switch", () => {
  const schedule = parseWeekTab(parseCsv(UGE_43), TODAY);

  const [dishes] = choreEvents(schedule, options("Kristian"));
  // 18:00–20:00 CEST.
  assert.equal(dishes?.start.toISOString(), "2026-10-20T16:00:00.000Z");
  assert.equal(dishes?.end?.toISOString(), "2026-10-20T18:00:00.000Z");
  assert.equal(dishes?.allDay, undefined);

  const [cook] = choreEvents(schedule, options("Jana"));
  // 15:00–17:45 CEST.
  assert.equal(cook?.start.toISOString(), "2026-10-20T13:00:00.000Z");
  assert.equal(cook?.end?.toISOString(), "2026-10-20T15:45:00.000Z");

  // After DST ends on 25 October, Copenhagen is UTC+1.
  assert.equal(copenhagenTime(new Date("2026-10-28T00:00:00Z"), 18, 0).toISOString(), "2026-10-28T17:00:00.000Z");
});

test("the Sunday chore is all day on the Sunday", () => {
  const schedule = parseWeekTab(parseCsv(UGE_43), TODAY);
  const [sunday] = choreEvents(schedule, options("Sara"));
  assert.equal(sunday?.allDay, true);
  assert.equal(sunday?.start.toISOString(), "2026-10-25T00:00:00.000Z");
  assert.equal(sunday?.end?.toISOString(), "2026-10-26T00:00:00.000Z");
});

test("the holiday chore spans Monday to Sunday, across New Year", () => {
  const schedule = parseWeekTab(parseCsv(UGE_53), TODAY);
  const [holiday] = choreEvents(schedule, options("Maria"));
  assert.equal(holiday?.allDay, true);
  assert.equal(holiday?.start.toISOString(), "2026-12-28T00:00:00.000Z");
  // DTEND is exclusive: the Monday after.
  assert.equal(holiday?.end?.toISOString(), "2027-01-04T00:00:00.000Z");
});

test("an unknown chore label is still published, as an all-day event", () => {
  const csv = ",Tirsdag 20/10\nVinduespudsning,Kristian\n";
  const [event] = choreEvents(parseWeekTab(parseCsv(csv), TODAY), options("Kristian"));
  assert.equal(event?.summary, "Vinduespudsning");
  assert.equal(event?.allDay, true);
});

test("names match regardless of case and trailing period", () => {
  const schedule = parseWeekTab(parseCsv(UGE_43), TODAY);
  assert.equal(choreEvents(schedule, options("michael l")).length, 1);
  assert.equal(normalizeName("Michael L."), normalizeName("MICHAEL  L"));
  // Similar names are different people.
  assert.equal(choreEvents(schedule, options("Anette")).length, 0);
  assert.equal(choreEvents(schedule, options("Annette")).length, 1);
});

test("a cell can hold several people", () => {
  assert.deepEqual(splitNames("Anders/Jacob"), ["Anders", "Jacob"]);
  assert.deepEqual(splitNames("Anders & Jacob"), ["Anders", "Jacob"]);
  assert.deepEqual(splitNames("Anders og Jacob"), ["Anders", "Jacob"]);
  // "og" inside a name is not a separator.
  assert.deepEqual(splitNames("Jørgen Bogh"), ["Jørgen Bogh"]);
});

test("same person twice in one row on different days gives two events", () => {
  const schedule = parseWeekTab(parseCsv(UGE_43), TODAY);
  const events = choreEvents(schedule, options("Anders"));
  assert.equal(events.length, 2);
  assert.notEqual(events[0]?.uid, events[1]?.uid);
});

test("uids are stable across refetches", () => {
  const first = choreEvents(parseWeekTab(parseCsv(UGE_43), TODAY), options("Kristian"));
  const second = choreEvents(parseWeekTab(parseCsv(UGE_43), TODAY), options("Kristian"));
  assert.equal(first[0]?.uid, "chore-2026-10-20-opvask-3-kristian@heynabo-ics");
  assert.deepEqual(first, second);
});

test("chores older than the past window are dropped", () => {
  const schedule = parseWeekTab(parseCsv(UGE_43), TODAY);
  const later = options("Kristian", { now: new Date("2027-01-01T00:00:00Z") });
  assert.equal(choreEvents(schedule, later).length, 0);
});

test("the description lists the day's team", () => {
  const [event] = choreEvents(parseWeekTab(parseCsv(UGE_43), TODAY), options("Kristian"));
  assert.match(event?.description ?? "", /^Chefkok: Jana$/m);
  assert.match(event?.description ?? "", /^Opvask 1: Anders$/m);
});

test("iso week numbers", () => {
  assert.equal(isoWeek(new Date("2026-10-19T00:00:00Z")), 43);
  assert.equal(isoWeek(new Date("2026-12-31T00:00:00Z")), 53);
  assert.equal(isoWeek(new Date("2027-01-03T00:00:00Z")), 53);
  assert.equal(isoWeek(new Date("2027-01-04T00:00:00Z")), 1);
});

test("week tabs are chosen from last week onward, wrapping past New Year", () => {
  const tabs = ["Fordeling", "Uge 1", "Uge 41", "Uge 42", "Uge 43", "Uge 53", "Opgavebeskrivelse"].map(
    (name, i) => ({ name, gid: String(i) }),
  );
  assert.deepEqual(
    selectWeekTabs(tabs, TODAY).map((tab) => tab.name),
    ["Uge 42", "Uge 43", "Uge 53", "Uge 1", "Uge 41"],
  );
});
