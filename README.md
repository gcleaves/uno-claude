# Uno

A multiplayer Uno game. Everyone plays from their own phone, tablet, or laptop —
one person creates a room, shares the 4-letter code, and the rest join.

- **Server-authoritative.** Clients never see another player's hand; each socket
  gets its own redacted view of the game.
- **No assets to download.** Every card is drawn as inline SVG, so it stays sharp
  on any screen and the whole deck costs zero network requests.
- **Reconnect-friendly.** Refresh, lock your phone, or lose signal — you get your
  seat back automatically. A player who is offline for too long stops holding up
  the table.

## Getting started

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:5173. The Vite dev server also binds to your LAN
address (printed on startup), so you can open that URL on your phone and play
against your laptop over Wi-Fi.

You will see `waiting for the API server on :3001 …` for a second or two first.
Both processes start together, but Vite is ready in about a tenth of a second
while the API server takes a couple, and a browser tab reconnecting into that
gap makes Vite print a proxy stack trace that looks like a fault and is not.
Starting the UI once the API is actually listening avoids the race rather than
hiding it.

Run the rules engine's test suite — including a soak test that plays thousands of
randomized rounds across every rule combination:

```bash
npm test
```

```bash
npm run typecheck
```

## Layout

| Path      | What lives there                                                        |
| --------- | ----------------------------------------------------------------------- |
| `shared/` | The rules engine and the types both sides share. No I/O, fully testable. |
| `server/` | Express + Socket.IO gateway, room store, auth adapter.                   |
| `client/` | React + Vite UI, including the SVG card renderer.                        |
| `scripts/`| `bot.ts` fills a table with auto-playing opponents; `smoke.ts` plays a full round against a deployment; `restart-check.ts` proves a game survives a restart. |

The engine in `shared/src/engine.ts` is a pure state machine: `applyAction(state,
playerId, action, rng)` validates and applies one move. The server owns the only
real `GameState`; `viewFor()` produces the per-player view that goes over the wire.

### Testing with bots

Create a room in the browser, then seat opponents that play themselves:

```bash
npx tsx scripts/bot.ts ABCD Robo
```

## House rules

Configurable by the host in the lobby:

| Rule                  | Default | Effect                                                                  |
| --------------------- | ------- | ----------------------------------------------------------------------- |
| Stacking              | on      | Answer a +2 with a +2 (or escalate to a +4) to pass the penalty along.   |
| Challenge the +4      | on      | The next player may call a bluffed Wild Draw Four. See below.            |
| Draw until playable   | off     | Keep drawing until something matches, instead of drawing exactly one.    |
| Sevens and zeros      | off     | A 7 swaps hands with a chosen player; a 0 rotates all hands.             |
| Keep score            | on      | Play rounds to a target score (default 500) instead of a single round.   |
| Cards dealt           | 7       | Starting hand size.                                                      |

Implemented beyond the basics: reverse acts as a skip head-to-head, the flipped
starting card takes effect on the first player, the draw pile is reshuffled from
the discards when it runs out, and official scoring (face value / 20 / 50).

**Calling UNO.** Say it when you play your next-to-last card. Forget, and anyone
may catch you for a 2-card penalty — but only **before the next player begins
their turn**, which is the official rule. Any play or draw closes the window, so
it is genuinely brief. Head-to-head a skip or reverse gives the same player
another turn, and it is *that* player acting again which closes it.

**Nothing tells you when to pounce.** Spotting that someone went quiet on their
last card is the whole skill, so the game will not flag it — no banner, no marker
that lights up on the guilty player. Tap any opponent at any time to call UNO on
them; if they were safe, nothing happens. The server does not even send the
client who is catchable, so it cannot be read out of devtools either. What you
get is exactly what you would have at a table: everyone's card count, and a badge
on whoever was heard to declare.

One deliberate simplification: a wild flipped as the starting card is buried and
another card is turned instead, since nobody has played yet and there is no one
to choose the colour.

### Challenging a Wild Draw Four

A Wild Draw Four is only a legal play when you hold **nothing of the colour
currently in play**. Holding a matching number, or another wild, does not stop
you — only the colour does. Bluffing is allowed; the challenge is what enforces
the rule.

When a +4 lands on you, you may take the cards or call the bluff. If you
challenge, the accused shows you their hand:

- **They were bluffing** — they draw the penalty instead of you, and your turn
  carries on as normal.
- **They were clean** — you draw the penalty *plus two more* and lose your turn.

Their hand is shown only to the challenger, as in the official rule; everyone
else just sees the outcome in the log. With stacking on, the challenge always
targets the most recent +4, and a successful one makes that player eat the whole
accumulated stack.

Deciding whether to challenge counts as a real decision, so it gets the full turn
clock rather than the short one used for forced draws.

## Exposed to the internet

Anything reachable from the open internet will be poked at. What is in place:

- **Nothing untrusted reaches the game engine.** Every socket payload is parsed
  and rejected unless it is a recognised action with the right field types. This
  is not theoretical tidiness: an unrecognised action type used to return
  `undefined` from the engine, and reading a property off it threw straight out
  of the socket handler and killed the process. One message, whole server down,
  no account needed. Handlers are also wrapped so an unexpected throw can never
  do that again.
- **Room codes are six characters** from a 31-character alphabet — about 887
  million combinations — and join attempts are rate limited. Finding a live room
  by guessing would take decades. Four characters, as it shipped originally, was
  under a million and walkable in minutes.
- **Per-client limits** on connections, actions, room creations and joins, so one
  source cannot flood the server or exhaust its memory.
- **A ceiling on total rooms**, so room creation cannot grow the process without
  bound.

Set `TRUST_PROXY=1` when running behind a reverse proxy, otherwise every
connection looks like it comes from the proxy and the per-client limits apply to
everyone at once. Do **not** set it on a directly exposed server: the forwarded
header is forgeable, and trusting it would let one attacker appear as unlimited
clients.

None of this decides *who* may play. For that, see below.

## Authentication

The first version runs open — anyone with a room code can play, identified by a
random token their browser stores. That token is the *only* notion of identity in
the system, which is what makes swapping in Keycloak small.

Everything funnels through `resolveIdentity()` in `server/src/auth.ts`, which
returns a `{ subject, name }`. Rooms, seats, and reconnects key off `subject` and
nothing else.

The Keycloak path is already written. To turn it on:

```bash
AUTH_MODE=keycloak \
KEYCLOAK_ISSUER=https://your-keycloak/realms/your-realm \
KEYCLOAK_AUDIENCE=uno-client \
npm start
```

The server then requires a Keycloak access token on the socket handshake and
verifies it against the realm's JWKS (signature, issuer, audience, expiry). The
remaining work is client-side: add an OIDC login (`keycloak-js` or `oidc-client-ts`
with PKCE), and pass the access token as `auth.accessToken` when opening the
socket in `client/src/net.ts`. `GET /api/config` already reports the auth mode and
issuer so the client can configure itself at runtime.

## Configuration

| Variable              | Default | Meaning                                                |
| --------------------- | ------- | ------------------------------------------------------ |
| `UNO_SERVER_PORT`     | `3001`  | API/socket port. Takes precedence over `PORT`.         |
| `PORT`                | —       | Fallback port, for platforms that inject one.          |
| `AUTH_MODE`           | `guest` | `guest` or `keycloak`.                                 |
| `CORS_ORIGIN`         | `*`     | Comma-separated allowed origins.                       |
| `RECONNECT_GRACE_SEC` | `120`   | How long a disconnected player keeps their seat.       |
| `FORCED_ACTION_SEC`   | `5`     | Turn clock when the player has no legal play.          |
| `TURN_TIMEOUT_SEC`    | `45`    | Turn clock when the player has a real choice.          |
| `AFK_TURN_SEC`        | `20`    | Turn clock when the player is disconnected.            |
| `EMPTY_ROOM_TTL_MIN`  | `15`    | How long an empty room lingers before being reclaimed. |
| `TRUST_PROXY`         | `0`     | Read the client address from `X-Forwarded-For`. Only behind a proxy. |
| `ROOM_CODE_LENGTH`    | `6`     | Characters in a room code.                             |
| `MAX_CONNECTIONS_PER_IP` | `12` | Live sockets from one address.                         |
| `MAX_ROOMS`           | `100`   | Rooms on the server at once.                           |
| `ACTIONS_PER_MINUTE`  | `240`   | Game actions per client.                               |
| `CREATES_PER_MINUTE`  | `5`     | Room creations per client.                             |
| `JOINS_PER_MINUTE`    | `20`    | Join attempts per client — the anti-guessing limit.    |
| `LOG_DIR`             | `/data/logs` | Where JSONL logs go. Empty disables them.         |
| `LOG_LEVEL`           | `info`  | `debug` also records every game action.                |
| `LOG_RETENTION_DAYS`  | `30`    | Days of logs to keep. 0 keeps everything.              |
| `POSTHOG_KEY`         | —       | Project API key, both halves. Empty disables analytics. Build-time for the browser. |
| `POSTHOG_HOST`        | `https://eu.i.posthog.com` | EU Cloud by default.                |
| `POSTHOG_SALT`        | `uno`   | Salts the hash used for analytics ids.                 |
| `SNAPSHOT_PATH`       | `/data/rooms.json` | Where games are saved. Empty disables persistence. |
| `SNAPSHOT_INTERVAL_SEC` | `10`  | Background save interval; bounds loss on a crash.      |
| `RESUME_GRACE_SEC`    | `30`    | Turn clocks are held this long after a restart.        |

## The turn clock

Nobody gets to stall the table. Whenever the game is waiting on someone, a clock
runs; when it expires the server plays the turn for them. There are three clocks
because the situations are genuinely different:

| Situation | Default | Why |
| --- | --- | --- |
| No legal play — the only move is to draw | 5s | A formality. Nobody should wait on it. |
| A real choice of card | 45s | Deciding takes longer than acknowledging. |
| Disconnected | 20s | No human is thinking, but they may be reconnecting. |

Set any of them to `0` to switch that clock off.

Timing out **draws and forfeits the turn — it never plays a card from your hand.**
If you are owed a +4 you take it; if you were choosing, you lose the turn and
keep your cards. Letting the server pick a card would mean it could choose badly
on your behalf, or dump the exact wild you were saving.

Drawing restarts the clock, so choosing to draw always buys a fresh window to
decide what to do with the card you got. Unrelated updates — someone else calling
UNO — do not extend it.

Both the timer bar and the countdown are visible to everyone, so the table can
see the clock the server is actually enforcing.

## Deploying with Docker

```bash
docker compose up -d --build
```

That is the whole deployment. The image builds the client, installs production
dependencies only, and serves the static files and the WebSocket from a single
process on port 3001 — so there is no CORS to configure and no second service to
run.

Copy `.env.example` to `.env` to change anything; compose reads it automatically.
To publish on a different port:

```bash
UNO_PORT=8080 docker compose up -d
```

Confirm a deployment actually works — not just that it answers `/healthz`, but
that the socket path works end to end. This seats three clients and plays a full
round against the running server:

```bash
npm run smoke -- http://localhost:3001
```

The image runs as the unprivileged `node` user with a read-only root filesystem
and `no-new-privileges`. `/tmp` is a tmpfs because the server runs TypeScript
through `tsx`, which caches compiled output there.

### Behind a reverse proxy

Uno needs the WebSocket upgrade to reach the container. With nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

Without the `Upgrade`/`Connection` headers, Socket.IO silently falls back to HTTP
long-polling — the game still works, but every move costs a round trip.

### Surviving restarts

Games are held in memory, but they are snapshotted to `/data/rooms.json` (a
docker volume) and restored on boot, so a redeploy does not end anyone's game.
Players' browsers reconnect and re-take their seats automatically — from their
side a restart looks like a couple of seconds offline.

Two saves cover the two ways a server goes away:

- **On `SIGTERM`**, written synchronously before exit. This is the one that makes
  a planned restart seamless, and why compose sets `stop_grace_period: 15s`.
- **Every 10 seconds** in the background, so a crash or `kill -9` loses at most
  that much play rather than the whole game.

The file is written to a temporary name and renamed into place, so a crash
mid-write leaves the last good snapshot rather than a truncated one. A snapshot
that is corrupt, or written by a different version, is ignored and the server
starts empty — losing games is bad, refusing to boot is worse.

After restoring, all turn clocks are held for `RESUME_GRACE_SEC` (30s). Sockets
do not survive a restart, so without it the first player back would be forfeited
for being "away" while their phone was still reconnecting.

Verify it end to end — this deals a hand, restarts the server underneath the
players, and checks everyone gets their own cards back and can still play:

```bash
npm run restart-check -- "docker compose restart" http://localhost:3001
```

Set `SNAPSHOT_PATH=` (empty) to turn persistence off.

The snapshot contains every player's hand, so it is written `0600`. Keep the
volume as private as you would any other game state.

### What this deployment cannot do

You cannot run more than one replica. Two would each hold different rooms, and
players would land on whichever one the load balancer picked. For a game among
friends this is usually the right trade; if you outgrow it, `server/src/rooms.ts`
is the single place that would need to move to Redis — the snapshot format there
is already a clean serialisation boundary.

### Without Docker

```bash
npm run build && npm start
```

## Logs

Every notable event is written as one line of JSON to `/data/logs/uno-YYYY-MM-DD.jsonl`,
rotated daily and pruned after `LOG_RETENTION_DAYS`. The format exists to be
queried directly:

```bash
duckdb -c "SELECT event, count(*) FROM read_json_auto('data/logs/*.jsonl', union_by_name=true) GROUP BY 1 ORDER BY 2 DESC"
```

Two properties make that work, and both are load-bearing rather than tidiness:
a field means the same thing and has the same type on every line, so DuckDB
infers one column type instead of a union; and nothing is nested, so every
column is directly selectable. There is a test that runs real DuckDB against
real output to keep it that way.

Who won, and how long rounds run:

```sql
SELECT name AS winner, players, count AS score, round(ms/1000.0) AS secs
FROM read_json_auto('data/logs/*.jsonl', union_by_name = true)
WHERE event = 'game.round_end' ORDER BY ts DESC;
```

Whether anyone is poking at the server — this is the visibility that was missing
when the decision was made to leave the game open:

```sql
SELECT ip, event, detail, count(*) AS n
FROM read_json_auto('data/logs/*.jsonl', union_by_name = true)
WHERE level = 'warn' GROUP BY ALL ORDER BY n DESC;
```

`limit.tripped` and `room.join_failed` in volume from one address is someone
guessing room codes. `action.malformed` is someone sending things the UI never
sends.

Busiest hours, for capacity or curiosity:

```sql
SELECT date_trunc('hour', CAST(ts AS TIMESTAMP)) AS hour, count(*) AS actions
FROM read_json_auto('data/logs/*.jsonl', union_by_name = true)
WHERE event = 'action' GROUP BY 1 ORDER BY 1;
```

`LOG_LEVEL=debug` records every individual game action, which is what makes that
last query interesting; `info` is the default and keeps the files small. Set
`LOG_DIR=` to switch file logging off entirely. Warnings and errors always also
go to stdout, so `docker compose logs` shows them.

## Analytics

PostHog, via the **npm SDK** on both sides rather than the HTML snippet. The
snippet fetches the library from a CDN at run time; this app is bundled and
served from its own container, so bundling keeps the version pinned in the
lockfile and removes a third-party request from page load. The client uses
posthog-js's `slim.no-external` build, which also stops the library lazily
fetching extra chunks from that CDN — otherwise choosing the SDK would have
bought nothing.

Game outcomes are sent from the **server**, because that is where the truth is:
a browser event is lost when a tab closes and can be edited by anyone with
devtools. The client sends what the server cannot see — intent, and where people
give up.

Every event, in full:

| From | Event | Answers |
| --- | --- | --- |
| server | `room created`, `room joined` | Is anyone playing? Joins are real arrivals only. |
| server | `player reconnected` | How often phones drop and come back |
| server | `round won`, `match won` | Round length, player count, which rules were on |
| client | `app opened` | Mobile or desktop layout |
| client | `language ready`, `language changed` | Is anyone using Spanish or Italian, by choice or by browser default |
| client | `game start attempted` | Do shared links work first time |
| client | `game dealt` | Did the lobby actually become a game |
| client | `game abandoned` | Did someone walk out mid-round |
| client | `invite shared` | Share sheet or clipboard |
| client | `rule changed` | Which house rules anyone bothers with |
| client | `challenge used`, `uno called`, `catch attempted` | Are the game's fiddliest features discoverable at all |

`catch attempted` carries whether the catch landed, which is the only way to tell
whether removing the "someone forgot to say UNO" banner made catching too hard.

**One player is one person.** The browser and the server both file events under
the same id: the server derives it from the session token and sends it in the
handshake, because the browser cannot compute it itself — the salt never leaves
the server. Without that the two halves land under different identities and no
journey through PostHog joins up, which is subtle enough to look like the data
is simply wrong.

**Reconnecting is not joining.** A phone waking up re-takes its seat constantly,
and counting that as an arrival inflates joins to the point where the event
stream stops resembling what happened at the table. Only a genuinely new player
produces `room joined`.

**What is deliberately not sent:** player names, room codes, IP addresses, chat,
or the contents of anyone's hand. Note that room codes needed explicit work to
keep out: posthog-js attaches the page URL to every event, and the code lives in
the query string, so `sanitize_properties` strips the query and fragment from
any URL property. Nothing in the app passing a code is not enough. Children play this. Events carry counts and
outcomes; the identifier is the browser's own random token, hashed with
`POSTHOG_SALT` so a PostHog record cannot be matched back to a session token in
the logs. Autocapture, session recording and surveys are all off. A captured
event looks like this in full:

```json
{"event":"round won","distinct_id":"p_8h3sowr5qity",
 "properties":{"players":3,"score":179,"duration_sec":91,"hand_size":7}}
```

`POSTHOG_KEY` is a project API key — publishable by design, since it ships in
the browser bundle — so it is configuration, not a secret. Leaving it empty
disables analytics on both sides.

**One variable name covers both halves.** Vite normally reads `.env` from
`client/` and only exposes `VITE_`-prefixed names, which would have meant a
second variable that could silently disagree with the server's — set one and
not the other and you get server-side analytics with a browser reporting
nothing. Vite is pointed at the repo-root `.env` instead, and the value is
injected explicitly, so a single `POSTHOG_KEY` in one file configures
everything. Nothing else from that file reaches the bundle.

**The browser half is baked in at build time**, so changing the key needs
`docker compose up -d --build`; a restart will keep serving the old bundle.
Locally, `npm run dev` picks it up from the root `.env` on both sides — the
server loads that file itself, since Node does not, and real environment
variables still take precedence over it.

## Languages

The interface is available in **English, Spanish and Italian**, switchable from
the home screen, the lobby, or the game log while a game is running. The choice
is remembered, and a first-time visitor gets their browser's language when it is
one of the three.

Everyone at a table can read in a different language: nothing user-visible is
generated as English prose on the server. Log entries travel as a key plus
values (`{ key: 'played', params: { name: 'Ada' }, card }`) and rejection
reasons travel as codes, so the words — including card names like *Comodín Roba
Cuatro* and *Jolly Pesca Quattro* — are chosen on each player's own device.

Adding a language means adding one file under `client/src/i18n/`. The `Strings`
type makes a missing key a compile error, and `client/test/i18n.test.ts` checks
what types cannot: that no translation dropped a placeholder, and that nothing
was left as untranslated English.

## License

MIT — see [LICENSE](LICENSE).

## About the artwork

The cards are generated from scratch in `client/src/components/CardFace.tsx` —
rounded rect, tilted white oval, and a symbol drawn with SVG primitives. No Mattel
artwork is used or reproduced. UNO is a trademark of Mattel; this is a personal
project for playing with friends, not affiliated with or endorsed by them.
