/**
 * The community chore rota ("tjanseliste"), kept in a Google Sheet with one tab
 * per week. A tab looks like this (row and column positions are not relied on):
 *
 *   ,Tirsdag 20/10,Onsdag 21/10,Torsdag 22/10,Søndag 25/10
 *   Chefkok,Jana,Michael L.,Søren,
 *   "Info, tid mm.",,,,
 *   Madlavning 1,Annette,Merete M,Benjamin,
 *   Opvask 1,Anders,Anders,Andreas,
 *   Søndagsoprydning/vask af klude,,,,Sara
 *
 * The sheet is edited by hand and its layout changes, so parsing keys on
 * content: the header row is whichever row holds day headings, the row label
 * is the first non-empty cell left of the day columns, and a label not listed
 * in CHORE_TIMES still produces an all-day event rather than being dropped.
 */

import type { IcsEvent } from "./ics.ts";
import { fetchTabCsv, fetchTabs, type SheetTab } from "./sheet.ts";

const TIME_ZONE = "Europe/Copenhagen";

type ChoreTiming =
  | { kind: "timed"; start: [hour: number, minute: number]; end: [hour: number, minute: number] }
  | { kind: "week" };

/** First matching label pattern wins; anything unmatched is all-day. */
const CHORE_TIMES: { pattern: RegExp; timing: ChoreTiming }[] = [
  { pattern: /^(chefkok|madlavning)/i, timing: { kind: "timed", start: [15, 0], end: [17, 45] } },
  { pattern: /^opvask/i, timing: { kind: "timed", start: [18, 0], end: [20, 0] } },
  { pattern: /hele ugen/i, timing: { kind: "week" } },
];

/** Rows with this label hold free-text notes for the day, not names. */
const INFO_ROW = /^info\b/i;

/** Keyed by the first three letters, so "Tirs" and "Tirsdag" both work. */
const WEEKDAYS: Record<string, number> = {
  søn: 0,
  man: 1,
  tir: 2,
  ons: 3,
  tor: 4,
  fre: 5,
  lør: 6,
};

/** Upper bound on tabs fetched per refresh; Workers allow 50 subrequests. */
const MAX_WEEK_TABS = 30;

const DAY_MS = 86_400_000;

const MAX_INFERRED_DISTANCE_MS = 183 * DAY_MS;

export interface ChoreAssignment {
  /** UTC midnight of the day the chore is listed under. */
  date: Date;
  label: string;
  /** Display names, as written in the cell (a cell may hold several). */
  names: string[];
}

export interface ChoreSchedule {
  assignments: ChoreAssignment[];
  /** Day notes from the info row, keyed by dayKey(). */
  notes: Map<string, string>;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Calendar date (as UTC midnight) of an instant, in Copenhagen. */
function localDate(at: Date): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return new Date(`${parts}T00:00:00Z`);
}

/** Minutes Copenhagen is ahead of UTC at the given instant. */
function offsetMinutes(at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)]),
  );
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** The instant at which Copenhagen wall-clock time reads hour:minute on `date`. */
export function copenhagenTime(date: Date, hour: number, minute: number): Date {
  const wallClock = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    hour,
    minute,
  );
  // The offset at the guess is right except within an hour of a DST switch;
  // checking it again at the corrected instant settles those cases.
  let instant = wallClock - offsetMinutes(new Date(wallClock)) * 60_000;
  instant = wallClock - offsetMinutes(new Date(instant)) * 60_000;
  return new Date(instant);
}

/** ISO 8601 week number. */
export function isoWeek(date: Date): number {
  // The ISO week belongs to the year of its Thursday, and week 1 is the one
  // containing 4 January.
  const thursday = addDays(date, 3 - ((date.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week1Thursday = addDays(jan4, 3 - ((jan4.getUTCDay() + 6) % 7));
  return 1 + Math.round((thursday.getTime() - week1Thursday.getTime()) / (7 * DAY_MS));
}

/**
 * Parse a day heading such as "Tirsdag 20/10". The sheet omits the year, so
 * it is taken from whichever of last, this or next year puts the date nearest
 * to today while agreeing with the weekday name — which also gets
 * "Søndag 3/1" right in a week that crosses New Year. A weekday that matches
 * no date within half a year is treated as a typo and the heading rejected,
 * rather than moving the column a whole year away.
 */
export function parseDayHeading(text: string, today: Date): Date | null {
  const match = /^\s*(?:([a-zæøå]+)\.?\s+)?(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?\s*$/i.exec(text);
  if (!match) return null;

  const weekday = match[1] ? WEEKDAYS[match[1].slice(0, 3).toLowerCase()] : undefined;
  if (match[1] && weekday === undefined) return null;

  const day = Number(match[2]);
  const month = Number(match[3]) - 1;

  let years: number[];
  if (match[4]) {
    const year = Number(match[4]);
    years = [year < 100 ? 2000 + year : year];
  } else {
    const thisYear = today.getUTCFullYear();
    years = [thisYear - 1, thisYear, thisYear + 1];
  }

  let best: Date | null = null;
  for (const year of years) {
    const candidate = new Date(Date.UTC(year, month, day));
    // Rejects overflow such as 31/9 becoming 1/10.
    if (candidate.getUTCDate() !== day || candidate.getUTCMonth() !== month) continue;
    if (weekday !== undefined && candidate.getUTCDay() !== weekday) continue;
    const distance = Math.abs(candidate.getTime() - today.getTime());
    if (!match[4] && distance > MAX_INFERRED_DISTANCE_MS) continue;
    if (!best || distance < Math.abs(best.getTime() - today.getTime())) best = candidate;
  }
  return best;
}

/** A cell may name several people: "Anders/Jacob", "Anders & Jacob", "Anders og Jacob". */
export function splitNames(cell: string): string[] {
  return cell
    .split(/\s*[/&+,]\s*|\s+og\s+/i)
    .map((name) => name.trim())
    .filter(Boolean);
}

/** Case, whitespace and trailing-period differences ("Michael L." / "michael l") are ignored. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFC")
    .toLocaleLowerCase("da")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse one tab. Returns an empty schedule for tabs that hold no day grid. */
export function parseWeekTab(rows: string[][], today: Date): ChoreSchedule {
  const schedule: ChoreSchedule = { assignments: [], notes: new Map() };

  let headerIndex = -1;
  let dayColumns = new Map<number, Date>();
  for (const [index, row] of rows.entries()) {
    const columns = new Map<number, Date>();
    row.forEach((cell, column) => {
      const date = parseDayHeading(cell, today);
      if (date) columns.set(column, date);
    });
    if (columns.size > 0) {
      headerIndex = index;
      dayColumns = columns;
      break;
    }
  }
  if (headerIndex < 0) return schedule;

  const firstDayColumn = Math.min(...dayColumns.keys());

  for (const row of rows.slice(headerIndex + 1)) {
    const label = row
      .slice(0, firstDayColumn)
      .map((cell) => cell.trim())
      .find(Boolean);
    if (!label) continue;

    for (const [column, date] of dayColumns) {
      const cell = row[column]?.trim();
      if (!cell) continue;

      if (INFO_ROW.test(label)) {
        schedule.notes.set(dayKey(date), cell);
      } else {
        schedule.assignments.push({ date, label, names: splitNames(cell) });
      }
    }
  }

  return schedule;
}

/**
 * Pick the tabs to fetch: those whose name contains a week number, starting
 * from last week and wrapping past New Year. Tabs without a number
 * ("Fordeling", "Opgavebeskrivelse") are never week grids.
 */
export function selectWeekTabs(tabs: SheetTab[], today: Date): SheetTab[] {
  const lastWeek = isoWeek(today) - 1;

  return tabs
    .flatMap((tab) => {
      const match = /\d{1,2}/.exec(tab.name);
      if (!match) return [];
      const week = Number(match[0]);
      if (week < 1 || week > 53) return [];
      return [{ tab, offset: (((week - lastWeek) % 53) + 53) % 53 }];
    })
    .sort((a, b) => a.offset - b.offset)
    .slice(0, MAX_WEEK_TABS)
    .map(({ tab }) => tab);
}

export async function fetchChoreSchedule(sheetId: string, now: Date): Promise<ChoreSchedule> {
  const today = localDate(now);
  const tabs = selectWeekTabs(await fetchTabs(sheetId), today);

  const results = await Promise.allSettled(tabs.map((tab) => fetchTabCsv(sheetId, tab.gid)));

  const schedule: ChoreSchedule = { assignments: [], notes: new Map() };
  let failures = 0;
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      failures++;
      console.error(`Failed to fetch chore tab "${tabs[index]!.name}"`, result.reason);
      continue;
    }
    const week = parseWeekTab(result.value, today);
    schedule.assignments.push(...week.assignments);
    for (const [key, note] of week.notes) schedule.notes.set(key, note);
  }

  if (tabs.length > 0 && failures === tabs.length) {
    throw new Error("Every chore tab failed to load");
  }
  return schedule;
}

/** All distinct names in the schedule, for telling a user what to type. */
export function knownNames(schedule: ChoreSchedule): string[] {
  const names = new Map<string, string>();
  for (const assignment of schedule.assignments) {
    for (const name of assignment.names) names.set(normalizeName(name), name);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b, "da"));
}

function timingFor(label: string): ChoreTiming | null {
  return CHORE_TIMES.find(({ pattern }) => pattern.test(label))?.timing ?? null;
}

function slug(value: string): string {
  return normalizeName(value).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
}

function describeDay(schedule: ChoreSchedule, date: Date): string {
  const sections: string[] = [];

  const note = schedule.notes.get(dayKey(date));
  if (note) sections.push(note);

  const sameDay = schedule.assignments.filter((other) => other.date.getTime() === date.getTime());
  if (sameDay.length > 1) {
    sections.push(sameDay.map((other) => `${other.label}: ${other.names.join(", ")}`).join("\n"));
  }

  return sections.join("\n\n");
}

export interface ChoreEventOptions {
  name: string;
  now: Date;
  pastWindowDays: number;
  /** Shown as the events' URL, so people can check the rota itself. */
  sheetUrl: string;
}

export function choreEvents(schedule: ChoreSchedule, options: ChoreEventOptions): IcsEvent[] {
  const wanted = normalizeName(options.name);
  const cutoff = new Date(options.now.getTime() - options.pastWindowDays * DAY_MS);
  const events = new Map<string, IcsEvent>();

  for (const assignment of schedule.assignments) {
    if (!assignment.names.some((name) => normalizeName(name) === wanted)) continue;

    const { date, label } = assignment;
    const timing = timingFor(label);

    let event: Pick<IcsEvent, "start" | "end" | "allDay">;
    if (timing?.kind === "timed") {
      event = {
        start: copenhagenTime(date, ...timing.start),
        end: copenhagenTime(date, ...timing.end),
      };
    } else if (timing?.kind === "week") {
      // Listed under one day, but covers the whole Monday–Sunday week.
      const monday = addDays(date, -((date.getUTCDay() + 6) % 7));
      event = { start: monday, end: addDays(monday, 7), allDay: true };
    } else {
      event = { start: date, end: addDays(date, 1), allDay: true };
    }

    if (event.end! < cutoff) continue;

    // Keyed on day, chore and person: if the rota is reshuffled, an entry that
    // still applies keeps its UID, and one that no longer does disappears.
    const uid = `chore-${dayKey(date)}-${slug(label)}-${slug(options.name)}@heynabo-ics`;
    events.set(uid, {
      uid,
      ...event,
      summary: label,
      description: describeDay(schedule, date) || undefined,
      url: options.sheetUrl,
      categories: ["Tjans"],
      status: "CONFIRMED",
      timestamp: date,
    });
  }

  return [...events.values()];
}

/** Today, all day, in the feed — for messages the subscriber needs to see. */
export function noticeEvent(uid: string, summary: string, description: string, now: Date): IcsEvent {
  const today = localDate(now);
  return {
    uid,
    start: today,
    end: addDays(today, 1),
    allDay: true,
    summary,
    description,
    status: "CONFIRMED",
    timestamp: today,
  };
}
