import { randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { config } from './config.js';

/**
 * A player's stable identity. In guest mode this is a random token the browser
 * keeps in localStorage; under Keycloak it is the token `sub` claim.
 *
 * Everything downstream (rooms, reconnects, seats) keys off `subject` only, so
 * flipping AUTH_MODE to 'keycloak' is the whole migration.
 */
export interface Identity {
  subject: string;
  name: string;
  /** True when the identity was cryptographically verified. */
  verified: boolean;
}

export interface HandshakeAuth {
  /** Guest-mode identity token previously issued to this browser. */
  token?: string;
  /** Keycloak access token (JWT). */
  accessToken?: string;
  name?: string;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!jwks) {
    if (!config.keycloak.issuer) {
      throw new Error('KEYCLOAK_ISSUER must be set when AUTH_MODE=keycloak');
    }
    jwks = createRemoteJWKSet(
      new URL(`${config.keycloak.issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`),
    );
  }
  return jwks;
}

export function sanitizeName(raw: string | undefined): string {
  const cleaned = (raw ?? '')
    // Strip control characters; leave everything else (emoji, accents) intact.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()
    .slice(0, 16);
  return cleaned.length > 0 ? cleaned : 'Player';
}

export async function resolveIdentity(auth: HandshakeAuth): Promise<Identity> {
  if (config.authMode === 'keycloak') {
    if (!auth.accessToken) throw new Error('Sign-in required.');
    const { payload } = await jwtVerify(auth.accessToken, getJwks(), {
      issuer: config.keycloak.issuer,
      audience: config.keycloak.audience || undefined,
    });
    return {
      subject: String(payload.sub),
      name: sanitizeName(displayNameFrom(payload)),
      verified: true,
    };
  }

  // Guest mode: trust (and mint) an opaque browser-held token.
  const subject = isGuestToken(auth.token) ? auth.token! : `guest_${randomUUID()}`;
  return { subject, name: sanitizeName(auth.name), verified: false };
}

function displayNameFrom(payload: JWTPayload): string {
  const p = payload as Record<string, unknown>;
  for (const key of ['preferred_username', 'name', 'given_name', 'email']) {
    const v = p[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return 'Player';
}

function isGuestToken(token: string | undefined): boolean {
  return typeof token === 'string' && /^guest_[0-9a-f-]{36}$/.test(token);
}
