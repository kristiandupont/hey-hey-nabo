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

## Chores (tjanselisten)

The community chore rota is a Google Sheet with one tab per week ("Uge 43", …),
shared as "anyone with the link". Adding `?name=` to the feed URL adds that person's
chores to their calendar:

```
webcal://heynabo-ics.<your-subdomain>.workers.dev/<FEED_SECRET>.ics?name=Kristian
```

The name must be spelled as in the sheet; case and a trailing period are ignored, so
`michael l` matches "Michael L.". An unknown name produces a single notice event in
today's calendar that lists the names the sheet does contain.

To enable it, store the sheet id (the segment after `/d/` in its URL) as a secret:

```bash
npm run chore-sheet
```

It is a secret because the id alone grants read access to the sheet. When the
community starts a new sheet (e.g. for a new year), run it again with the new id.

### Times

| Row label starts with / contains | Event |
| --- | --- |
| `Chefkok`, `Madlavning` | 15:00–17:45 on that day |
| `Opvask` | 18:00–20:00 on that day |
| `hele ugen` | all day, Monday to Sunday of that week |
| anything else (e.g. `Søndagsoprydning`) | all day on that day |

The rules are the `CHORE_TIMES` table in [src/chores.ts](src/chores.ts). A new row
label that matches none of them is still published, as an all-day event. Text in the
"Info, tid mm." row is added to the description of that day's chores, along with the
rest of that day's rota.

### How the sheet is read

The sheet is edited by hand, so the parser does not rely on row or column positions.
In each tab, the header row is the first row containing day headings such as
`Tirsdag 20/10`. The row label is the first non-empty cell to the left of the day
columns. The headings have no year, so the parser uses the year, within six months
of today, in which the date falls on the named weekday. This also gives
`Søndag 3/1` the right year in week 53.

Google offers no keyless API that lists tabs, so the Worker reads the name → gid
mapping from the sheet's `htmlview` page (undocumented, lists only visible tabs) and
downloads each week tab with `export?format=csv&gid=…`. Tabs are chosen by the week
number in their name, from last week onward, at most 30 per refresh. The `gviz`
endpoint is not used: it drops cells that don't match a column's majority type, and
it returns the first tab when asked for one that doesn't exist.

If the sheet cannot be read, the Worker keeps serving the last schedule it loaded. If
it has none, the feed contains a notice event saying so.

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
