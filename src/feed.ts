import type { HeyNaboEvent } from "./heynabo.ts";
import { htmlToText } from "./html.ts";
import { buildCalendar, type EventStatus, type IcsEvent } from "./ics.ts";

/** How long clients are asked to wait between polls. */
export const TTL_MINUTES = 15;

export interface FeedOptions {
  calendarName: string;
  /** e.g. https://staldhusene.spaces.heynabo.com */
  baseUrl: string;
  groupNames: Map<number, string>;
  pastWindowDays: number;
  now: Date;
}

const DANISH_DATE_TIME = new Intl.DateTimeFormat("da-DK", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "Europe/Copenhagen",
});

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mapStatus(status: string): EventStatus {
  return status.toUpperCase() === "CANCELED" ? "CANCELLED" : "CONFIRMED";
}

function buildDescription(event: HeyNaboEvent, eventUrl: string): string {
  const sections: string[] = [];

  const body = htmlToText(event.description);
  if (body) sections.push(body);

  // HeyNabo populates registrationEnds on every event, defaulting it to the
  // event's own end time. Only a deadline that actually falls before the event
  // starts carries information worth showing.
  const registrationEnds = parseDate(event.registrationEnds);
  const start = parseDate(event.start);
  if (registrationEnds && start && registrationEnds < start) {
    sections.push(`Tilmeldingsfrist: ${DANISH_DATE_TIME.format(registrationEnds)}`);
  }

  const payment = htmlToText(event.paymentDetails);
  if (payment) sections.push(`Betaling: ${payment}`);

  sections.push(eventUrl);

  return sections.join("\n\n");
}

/**
 * Convert HeyNabo events into calendar entries.
 *
 * Two filters apply. `visibleToEveryone` is a safety guard: every event in the
 * space currently carries it, but if a group-private event ever appears it
 * must not leak into a feed URL shared with the whole neighbourhood. The date
 * window keeps the feed small and stops a two-year backfill landing in
 * someone's calendar the moment they subscribe.
 */
export function toIcsEvents(events: HeyNaboEvent[], options: FeedOptions): IcsEvent[] {
  const host = new URL(options.baseUrl).host;
  const calendarUrl = new URL("/desktop/calendar/events", options.baseUrl).toString();
  const cutoff = new Date(options.now.getTime() - options.pastWindowDays * 86_400_000);

  const mapped: IcsEvent[] = [];

  for (const event of events) {
    if (!event.visibleToEveryone) continue;

    const start = parseDate(event.start);
    if (!start) continue;

    const end = parseDate(event.end);
    // An event is "past" only once it has finished, so a long event stays
    // visible for its whole duration.
    if ((end ?? start) < cutoff) continue;

    const groupName = event.groupId === null ? undefined : options.groupNames.get(event.groupId);

    mapped.push({
      uid: `event-${event.id}@${host}`,
      start,
      // Guard against bad data putting the end before the start.
      end: end && end > start ? end : null,
      summary: event.name?.trim() || "(uden titel)",
      description: buildDescription(event, calendarUrl),
      location: event.locationText?.trim() || undefined,
      url: calendarUrl,
      categories: groupName ? [groupName] : undefined,
      status: mapStatus(event.status),
      // Stable across regenerations so clients don't see phantom edits.
      timestamp: parseDate(event.created) ?? start,
    });
  }

  mapped.sort((a, b) => a.start.getTime() - b.start.getTime());
  return mapped;
}

export function buildFeed(events: HeyNaboEvent[], options: FeedOptions): string {
  return buildCalendar(toIcsEvents(events, options), {
    name: options.calendarName,
    description: `Begivenheder fra ${new URL(options.baseUrl).host}`,
    ttlMinutes: TTL_MINUTES,
  });
}

/**
 * Served when HeyNabo rejects the session token. A feed that silently goes
 * stale is invisible; an event sitting in today's calendar is not.
 */
export function buildTokenExpiredFeed(options: { calendarName: string; now: Date }): string {
  const start = options.now;
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  return buildCalendar(
    [
      {
        uid: "token-expired@heynabo-ics",
        start,
        end,
        summary: `⚠️ ${options.calendarName}: kalenderen mangler et nyt token`,
        description:
          "HeyNabo afviste sessionen, så kalenderen kan ikke opdateres.\n\n" +
          "Log ind i HeyNabo, kopiér den nye PHPSESSID og kør:\n" +
          "npm run token",
        status: "CONFIRMED",
        timestamp: start,
      },
    ],
    { name: options.calendarName, ttlMinutes: TTL_MINUTES },
  );
}
