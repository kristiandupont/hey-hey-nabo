import { buildFeed, buildTokenExpiredFeed, TTL_MINUTES } from "./feed.ts";
import { fetchEvents, fetchGroupNames, HeyNaboAuthError } from "./heynabo.ts";

export interface Env {
  /** PHP session id from a logged-in HeyNabo browser session. Secret. */
  HEYNABO_TOKEN: string;
  /** Random path segment that makes the feed URL unguessable. Secret. */
  FEED_SECRET: string;
  HEYNABO_BASE_URL: string;
  CALENDAR_NAME: string;
  PAST_EVENT_WINDOW_DAYS: string;
}

interface CacheEntry {
  body: string;
  etag: string;
  storedAt: number;
}

/**
 * Per-isolate memory cache. Deliberately not KV or the Cache API: KV would be
 * a stateful resource to provision, and the Cache API does not operate on
 * *.workers.dev subdomains. A cold isolate just refetches, which for a handful
 * of subscribers costs nothing.
 */
let cache: CacheEntry | null = null;

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

async function handleFeed(request: Request, env: Env): Promise<Response> {
  const now = new Date();

  if (cache && now.getTime() - cache.storedAt < CACHE_TTL_MS) {
    return calendarResponse(cache.body, cache.etag, request, TTL_MINUTES * 60);
  }

  const config = { baseUrl: env.HEYNABO_BASE_URL, token: env.HEYNABO_TOKEN };

  let events;
  let groupNames;
  try {
    [events, groupNames] = await Promise.all([fetchEvents(config), fetchGroupNames(config)]);
  } catch (error) {
    if (error instanceof HeyNaboAuthError) {
      // Serve the warning uncached, so it disappears as soon as the token is
      // rotated rather than lingering for the cache lifetime.
      const body = buildTokenExpiredFeed({ calendarName: env.CALENDAR_NAME, now });
      return calendarResponse(body, await etagFor(body), request, 60);
    }
    throw error;
  }

  const body = buildFeed(events, {
    calendarName: env.CALENDAR_NAME,
    baseUrl: env.HEYNABO_BASE_URL,
    groupNames,
    pastWindowDays: Number(env.PAST_EVENT_WINDOW_DAYS) || 30,
    now,
  });

  const etag = await etagFor(body);
  cache = { body, etag, storedAt: now.getTime() };

  return calendarResponse(body, etag, request, TTL_MINUTES * 60);
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

    try {
      return await handleFeed(request, env);
    } catch (error) {
      console.error("Failed to build feed", error);
      return new Response("Upstream error", { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;
