import {
  choreEvents,
  fetchChoreSchedule,
  knownNames,
  normalizeName,
  noticeEvent,
  type ChoreSchedule,
} from "./chores.ts";
import { buildFeed, toIcsEvents, tokenExpiredEvent, TTL_MINUTES } from "./feed.ts";
import {
  fetchEvents,
  fetchGroupNames,
  HeyNaboAuthError,
  type HeyNaboEvent,
} from "./heynabo.ts";
import type { IcsEvent } from "./ics.ts";

export interface Env {
  /** PHP session id from a logged-in HeyNabo browser session. Secret. */
  HEYNABO_TOKEN: string;
  /** Random path segment that makes the feed URL unguessable. Secret. */
  FEED_SECRET: string;
  /**
   * Id of the Google Sheet holding the chore rota. Secret, because the link
   * alone grants read access to it. Optional: without it, `?name=` is ignored.
   */
  CHORE_SHEET_ID?: string;
  HEYNABO_BASE_URL: string;
  CALENDAR_NAME: string;
  PAST_EVENT_WINDOW_DAYS: string;
}

interface Cached<T> {
  value: T;
  storedAt: number;
}

/**
 * Per-isolate memory cache. Deliberately not KV or the Cache API: KV would be
 * a stateful resource to provision, and the Cache API does not operate on
 * *.workers.dev subdomains. A cold isolate just refetches, which for a handful
 * of subscribers costs nothing.
 *
 * The sources are cached rather than the rendered feed, because each
 * `?name=` gets its own feed but all of them are built from the same data.
 */
let heynaboCache: Cached<{ events: HeyNaboEvent[]; groupNames: Map<number, string> }> | null = null;
let choreCache: Cached<ChoreSchedule> | null = null;

const CACHE_TTL_MS = TTL_MINUTES * 60 * 1000;

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let i = 0; i < left.length; i++) {
    difference |= left[i]! ^ right[i]!;
  }
  return difference === 0;
}

async function etagFor(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `"${hex}"`;
}

function calendarResponse(
  body: string,
  etag: string,
  request: Request,
  maxAgeSeconds: number,
): Response {
  const headers: HeadersInit = {
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": 'inline; filename="heynabo.ics"',
    "Cache-Control": `public, max-age=${maxAgeSeconds}`,
    ETag: etag,
  };

  // Calendar clients poll often and do send If-None-Match; honouring it turns
  // most of those polls into a 304 with no body.
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(body, { status: 200, headers });
}

function isFresh(entry: Cached<unknown> | null, now: Date): boolean {
  return entry !== null && now.getTime() - entry.storedAt < CACHE_TTL_MS;
}

/** HeyNabo events, or the token warning if the session has died. */
async function loadHeynaboEvents(env: Env, now: Date): Promise<{ events: IcsEvent[]; ok: boolean }> {
  if (!isFresh(heynaboCache, now)) {
    const config = { baseUrl: env.HEYNABO_BASE_URL, token: env.HEYNABO_TOKEN };
    try {
      const [events, groupNames] = await Promise.all([fetchEvents(config), fetchGroupNames(config)]);
      heynaboCache = { value: { events, groupNames }, storedAt: now.getTime() };
    } catch (error) {
      if (error instanceof HeyNaboAuthError) {
        // Not cached, so the warning disappears as soon as the token is
        // rotated rather than lingering for the cache lifetime.
        return { events: [tokenExpiredEvent({ calendarName: env.CALENDAR_NAME, now })], ok: false };
      }
      throw error;
    }
  }

  const { events, groupNames } = heynaboCache!.value;
  return {
    events: toIcsEvents(events, {
      calendarName: env.CALENDAR_NAME,
      baseUrl: env.HEYNABO_BASE_URL,
      groupNames,
      pastWindowDays: Number(env.PAST_EVENT_WINDOW_DAYS) || 30,
      now,
    }),
    ok: true,
  };
}

/**
 * Chore events for one person. A failed refresh falls back to the last
 * schedule this isolate saw; only with nothing to fall back on does the
 * subscriber get a notice instead of their chores.
 */
async function loadChoreEvents(
  env: Env,
  sheetId: string,
  name: string,
  now: Date,
): Promise<{ events: IcsEvent[]; ok: boolean }> {
  let ok = true;
  if (!isFresh(choreCache, now)) {
    try {
      choreCache = { value: await fetchChoreSchedule(sheetId, now), storedAt: now.getTime() };
    } catch (error) {
      console.error("Failed to load chore sheet", error);
      ok = false;
    }
  }

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/htmlview`;

  if (!choreCache) {
    return {
      events: [
        noticeEvent(
          "chores-unavailable@heynabo-ics",
          "⚠️ Tjanselisten kunne ikke hentes",
          `Kalenderen kunne ikke læse tjanselisten, så dine tjanser mangler.\n\n${sheetUrl}`,
          now,
        ),
      ],
      ok: false,
    };
  }

  const schedule = choreCache.value;
  const events = choreEvents(schedule, {
    name,
    now,
    pastWindowDays: Number(env.PAST_EVENT_WINDOW_DAYS) || 30,
    sheetUrl,
  });

  // A typo in ?name= would otherwise look exactly like having no chores.
  const names = knownNames(schedule);
  if (events.length === 0 && !names.some((known) => normalizeName(known) === normalizeName(name))) {
    events.push(
      noticeEvent(
        "chores-unknown-name@heynabo-ics",
        `⚠️ Ingen tjanser fundet for "${name}"`,
        "Navnet i kalenderens adresse (?name=…) står ikke på tjanselisten. " +
          "Det skal staves som på listen, fx:\n\n" +
          names.join(", "),
        now,
      ),
    );
  }

  return { events, ok };
}

async function handleFeed(request: Request, env: Env, name: string | null): Promise<Response> {
  const now = new Date();

  const sheetId = env.CHORE_SHEET_ID?.trim();
  const [heynabo, chores] = await Promise.all([
    loadHeynaboEvents(env, now),
    name && sheetId ? loadChoreEvents(env, sheetId, name, now) : { events: [], ok: true },
  ]);

  const body = buildFeed([...heynabo.events, ...chores.events], {
    calendarName: env.CALENDAR_NAME,
    baseUrl: env.HEYNABO_BASE_URL,
  });

  // A degraded feed is given a short max-age so the fix shows up quickly.
  const maxAge = heynabo.ok && chores.ok ? TTL_MINUTES * 60 : 60;
  return calendarResponse(body, await etagFor(body), request, maxAge);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    // The secret is the whole access control, so the path is compared in
    // constant time and nothing else on the origin hints that it exists.
    const requested = url.pathname.replace(/^\/+/, "").replace(/\.ics$/, "");
    if (!env.FEED_SECRET || !timingSafeEqual(requested, env.FEED_SECRET)) {
      return new Response("Not found", { status: 404 });
    }

    const name = url.searchParams.get("name")?.trim().slice(0, 100) || null;

    try {
      return await handleFeed(request, env, name);
    } catch (error) {
      console.error("Failed to build feed", error);
      return new Response("Upstream error", { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;
