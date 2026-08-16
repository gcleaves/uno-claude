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
| `scripts/`| `bot.ts`, an auto-playing client for filling a table while testing.      |

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
| Draw until playable   | off     | Keep drawing until something matches, instead of drawing exactly one.    |
| Sevens and zeros      | off     | A 7 swaps hands with a chosen player; a 0 rotates all hands.             |
| Keep score            | on      | Play rounds to a target score (default 500) instead of a single round.   |
| Cards dealt           | 7       | Starting hand size.                                                      |

Implemented beyond the basics: reverse acts as a skip head-to-head, the flipped
starting card takes effect on the first player, the draw pile is reshuffled from
the discards when it runs out, UNO must be declared and can be caught for a
2-card penalty, and official scoring (face value / 20 / 50).

Two deliberate simplifications: a wild flipped as the starting card is buried and
another card is turned instead (nobody has played yet, so there is no one to
choose the colour), and Wild Draw Four cannot be challenged.

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
| `AFK_TURN_SEC`        | `20`    | How long before an offline player's turn is auto-played.|
| `EMPTY_ROOM_TTL_MIN`  | `15`    | How long an empty room lingers before being reclaimed. |

## Deploying

```bash
npm run build
```

```bash
npm start
```

The server serves the built client from the same origin, so one process on one
port is all you need. Game state is in memory: restarting the server ends any
games in progress, and you cannot run more than one instance without adding a
shared store.

## About the artwork

The cards are generated from scratch in `client/src/components/CardFace.tsx` —
rounded rect, tilted white oval, and a symbol drawn with SVG primitives. No Mattel
artwork is used or reproduced. UNO is a trademark of Mattel; this is a personal
project for playing with friends, not affiliated with or endorsed by them.
