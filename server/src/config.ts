export const config = {
  // UNO_SERVER_PORT wins so a dev tool exporting PORT (for Vite) can't hijack the API.
  port: Number(process.env.UNO_SERVER_PORT ?? process.env.PORT ?? 3001),
  /** 'guest' = no auth (v1). 'keycloak' = verify OIDC access tokens on the socket handshake. */
  authMode: (process.env.AUTH_MODE ?? 'guest') as 'guest' | 'keycloak',
  keycloak: {
    /** e.g. https://keycloak.example.com/realms/uno */
    issuer: process.env.KEYCLOAK_ISSUER ?? '',
    /** Audience to require in the access token, usually the client id. */
    audience: process.env.KEYCLOAK_AUDIENCE ?? '',
  },
  /** Comma-separated list; '*' in dev. */
  corsOrigin: process.env.CORS_ORIGIN ?? '*',

  /*
   * Abuse controls. These matter whether or not sign-in is switched on: they
   * bound what one client can consume, and they are what stops a stranger
   * guessing their way into a room.
   */

  /**
   * Read the client address from X-Forwarded-For. Turn this on only behind a
   * reverse proxy you control — the header is forgeable, so trusting it on a
   * directly-exposed server lets one attacker appear as unlimited clients.
   */
  trustProxy: process.env.TRUST_PROXY === '1',
  /** Characters in a room code. 6 makes guessing an active room impractical. */
  roomCodeLength: Number(process.env.ROOM_CODE_LENGTH ?? 6),
  /** Live sockets allowed from one address. */
  maxConnectionsPerIp: Number(process.env.MAX_CONNECTIONS_PER_IP ?? 12),
  /** Rooms on the server at once, across everyone. */
  maxRooms: Number(process.env.MAX_ROOMS ?? 100),
  /** Game actions per client per minute. Generous for play, useless for flooding. */
  actionsPerMinute: Number(process.env.ACTIONS_PER_MINUTE ?? 240),
  /** Room creations per client per minute. */
  createsPerMinute: Number(process.env.CREATES_PER_MINUTE ?? 5),
  /** Join attempts per client per minute — this is the anti-guessing limit. */
  joinsPerMinute: Number(process.env.JOINS_PER_MINUTE ?? 20),
  /** Seconds a disconnected player keeps their seat mid-game. */
  reconnectGraceSec: Number(process.env.RECONNECT_GRACE_SEC ?? 120),

  /*
   * Turn clocks. The server forces the game forward when one runs out, so a
   * player who steps away cannot stall the table. Each is in seconds; 0 turns
   * that clock off.
   *
   * They differ because the situations differ: being made to draw a +4 is a
   * formality, while choosing which card to play is a real decision that
   * deserves thinking time.
   */

  /** The player has no legal play — the only move is to draw. */
  forcedActionSec: Number(process.env.FORCED_ACTION_SEC ?? 5),
  /** The player has a genuine choice to make. */
  turnTimeoutSec: Number(process.env.TURN_TIMEOUT_SEC ?? 45),
  /** The player is disconnected, so nobody is waiting on a human. */
  afkTurnSec: Number(process.env.AFK_TURN_SEC ?? 20),
  /** Minutes an empty room lingers before being reclaimed. */
  emptyRoomTtlMin: Number(process.env.EMPTY_ROOM_TTL_MIN ?? 15),

  /* --- logging and analytics ---------------------------------------- */

  /** Directory for the JSONL logs. Empty disables writing them to disk. */
  logDir: process.env.LOG_DIR ?? './data/logs',
  logLevel: (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  /** Days of logs to keep. 0 keeps everything. */
  logRetentionDays: Number(process.env.LOG_RETENTION_DAYS ?? 30),

  /**
   * PostHog project API key. This is a publishable key by design — it is
   * embedded in the browser bundle — so it is configuration, not a secret.
   * Leave empty to switch analytics off entirely.
   */
  posthogKey: process.env.POSTHOG_KEY ?? '',
  posthogHost: process.env.POSTHOG_HOST ?? 'https://eu.i.posthog.com',
  /**
   * Salts the hash that turns a session token into an analytics id. Set it to
   * anything stable and private; the default still hashes, it just isn't secret.
   */
  posthogSalt: process.env.POSTHOG_SALT ?? 'uno',

  /*
   * Games live in memory, so a restart would normally end them. Snapshotting
   * lets a redeploy pass without anyone losing their hand.
   */

  /** Where to write the snapshot. Empty string turns persistence off. */
  snapshotPath: process.env.SNAPSHOT_PATH ?? './data/rooms.json',
  /** How often to snapshot in the background, bounding loss on a hard crash. */
  snapshotIntervalSec: Number(process.env.SNAPSHOT_INTERVAL_SEC ?? 10),
  /**
   * After restoring, hold every turn clock for this long. Sockets do not
   * survive a restart, so without it the first player back would be forfeited
   * for being "away" while their phone was still reconnecting.
   */
  resumeGraceSec: Number(process.env.RESUME_GRACE_SEC ?? 30),
};
