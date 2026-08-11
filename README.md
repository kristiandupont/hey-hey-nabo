# heynabo-ics

A webcal/iCalendar feed for [HeyNabo](https://heynabo.com) community events, so they
show up in a normal calendar app. Runs as a single Cloudflare Worker.

HeyNabo has no calendar export. This fetches `/api/members/events` with a logged-in
session, renders RFC 5545 iCalendar, and serves it at one unguessable URL.

## How it works

Every event in the space is flagged `visibleToEveryone`, so there is no per-member
view to reproduce — one feed is correct for the whole neighbourhood. The Worker holds
a single HeyNabo session token and serves everyone from it, which means neighbours can
subscribe by pasting a URL and never have to hand over credentials of their own.

Events that are *not* `visibleToEveryone` are filtered out, so a future group-private
event cannot leak into a URL that has been shared around.

## Setup

```bash
npm install
npx wrangler login          # one-time browser OAuth
```

Then set the two secrets. The feed secret is the random path segment that makes the
URL unguessable — generate a fresh one:

```bash
openssl rand -hex 24        # generate one, and keep the output —
npm run feed-secret         # Cloudflare cannot show you a secret again
npm run token               # paste the PHPSESSID value, see below
npm run deploy
```

Copy the generated value somewhere before pasting it: it is half of your feed
URL, and a secret that has been set can only be replaced, never read back.

Your feed is then at:

```
https://heynabo-ics.<your-subdomain>.workers.dev/<FEED_SECRET>.ics
```

Subscribe with `webcal://` in place of `https://` to get the "add to calendar"
prompt. Both schemes hit the same endpoint.

Non-secret settings (space URL, calendar name, how much history to include) live in
[wrangler.jsonc](wrangler.jsonc) and are applied by `npm run deploy`.

## Getting the token

HeyNabo authenticates with a PHP session id, sent both as the `PHPSESSID` cookie and
as `Authorization: Bearer <same value>`. There is no JWT, no expiry to inspect, and no
refresh flow — but sessions survive for months in practice.

1. Log in to HeyNabo in a browser.
2. DevTools → Application → Cookies → copy the value of `PHPSESSID`.
3. `npm run token` and paste it.

That token grants full access to your HeyNabo account, not a read-only calendar
scope. It belongs in a Worker secret and nowhere else — never in this repo.

### When it expires

The feed does not go quietly stale. If HeyNabo rejects the token, the Worker serves a
calendar containing a single event on the current day — *"kalenderen mangler et nyt
token"* — so it shows up in your calendar and you know to rotate it. Repeat the steps
above; no redeploy needed.

## Development

```bash
npm run dev        # local Worker at 127.0.0.1:8787
npm test           # unit tests, no network or credentials needed
npm run typecheck
```

For `npm run dev`, put the secrets in `.dev.vars` (gitignored) — see
[.dev.vars.example](.dev.vars.example).

## Design notes

- **In-memory caching, not KV.** The rendered feed is cached in the isolate for 15
  minutes. KV would be a stateful resource to provision, and the Cache API does not
  operate on `*.workers.dev` subdomains. A cold isolate simply refetches. `ETag` /
  `If-None-Match` turns most client polls into a 304.
- **Times are genuine UTC.** The API returns `+00:00` offsets that really are UTC —
  confirmed against events whose descriptions state their local start time. So the
  feed emits UTC directly and needs no `VTIMEZONE` block.
- **Stable `UID` and `DTSTAMP`.** `UID` comes from the HeyNabo event id, so edits
  update an existing entry instead of duplicating it. `DTSTAMP` uses the event's
  creation time rather than "now", so clients don't see a phantom edit on every poll.
- **Hand-rolled ICS.** Line folding is done on UTF-8 *octets*, not characters, which
  matters for a calendar full of æ/ø/å.
- **`registrationEnds` is mostly noise.** HeyNabo defaults it to the event's own end
  time; only deadlines that fall before the event starts are shown.
