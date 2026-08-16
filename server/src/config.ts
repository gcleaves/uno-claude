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
  /** Seconds a disconnected player keeps their seat mid-game. */
  reconnectGraceSec: Number(process.env.RECONNECT_GRACE_SEC ?? 120),
  /** Seconds before a disconnected player's turn is auto-played. */
  afkTurnSec: Number(process.env.AFK_TURN_SEC ?? 20),
  /** Minutes an empty room lingers before being reclaimed. */
  emptyRoomTtlMin: Number(process.env.EMPTY_ROOM_TTL_MIN ?? 15),
};
