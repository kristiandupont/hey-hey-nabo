/**
 * HeyNabo API client.
 *
 * Auth is unusual: the value sent as `Authorization: Bearer <x>` is the PHP
 * session id, identical to the PHPSESSID cookie. There is no JWT and no
 * expiry we can inspect, so the only signal that a token has died is a 401 —
 * see HeyNaboAuthError, which the Worker turns into a visible placeholder
 * calendar rather than a silent failure.
 */

export interface HeyNaboEvent {
  id: number;
  type: string;
  name: string;
  description: string | null;
  /** ISO 8601 with a real UTC offset (verified against known local times). */
  start: string;
  end: string | null;
  registrationEnds: string | null;
  paymentDetails: string | null;
  created: string | null;
  status: string;
  groupId: number | null;
  locationText: string | null;
  locationId: number | null;
  visibleToEveryone: boolean;
  public: boolean;
  maxParticipants: number | null;
  minParticipants: number | null;
}

export interface HeyNaboGroup {
  id: number;
  name: string;
}

interface ListEnvelope<T> {
  list: T[];
}

/** The session token was rejected — it has expired or been invalidated. */
export class HeyNaboAuthError extends Error {
  constructor(status: number) {
    super(`HeyNabo rejected the session token (HTTP ${status})`);
    this.name = "HeyNaboAuthError";
  }
}

export class HeyNaboApiError extends Error {
  constructor(status: number, path: string) {
    super(`HeyNabo request failed: ${path} returned HTTP ${status}`);
    this.name = "HeyNaboApiError";
  }
}

export interface HeyNaboClientConfig {
  baseUrl: string;
  token: string;
}

async function apiGet<T>(config: HeyNaboClientConfig, path: string): Promise<T> {
  const response = await fetch(new URL(path, config.baseUrl), {
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/json",
      "User-Agent": "heynabo-ics (calendar feed)",
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new HeyNaboAuthError(response.status);
  }
  if (!response.ok) {
    throw new HeyNaboApiError(response.status, path);
  }

  return (await response.json()) as T;
}

/**
 * Returns every event the account can see — the endpoint takes no paging or
 * date parameters and hands back the full history in one response.
 */
export async function fetchEvents(config: HeyNaboClientConfig): Promise<HeyNaboEvent[]> {
  const body = await apiGet<ListEnvelope<HeyNaboEvent>>(config, "/api/members/events");
  return body.list ?? [];
}

/**
 * Group id → name, used for CATEGORIES. Non-fatal: a feed without categories
 * is still a perfectly good feed, so a failure here degrades rather than
 * breaks. An auth failure is still propagated, since that means the whole
 * token is dead and the caller needs to know.
 */
export async function fetchGroupNames(config: HeyNaboClientConfig): Promise<Map<number, string>> {
  try {
    const body = await apiGet<ListEnvelope<HeyNaboGroup>>(
      config,
      "/api/members/groups?data[showLimited]=1",
    );
    return new Map((body.list ?? []).map((group) => [group.id, group.name]));
  } catch (error) {
    if (error instanceof HeyNaboAuthError) throw error;
    return new Map();
  }
}
