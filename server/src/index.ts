import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server, type Socket } from 'socket.io';
import type { Action, ActionResult } from '@uno/shared';
import { config } from './config.js';
import { resolveIdentity, sanitizeName, type Identity } from './auth.js';
import { RoomStore } from './rooms.js';
import { loadSnapshot, saveSnapshot, saveSnapshotSync } from './persistence.js';
import { ConnectionCounter, RateLimiter, clientIp } from './guard.js';
import { parseAction, parseRoomCode } from './validate.js';
import { log } from './logger.js';
import { initAnalytics, shutdownAnalytics, track } from './analytics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '../../client/dist');

const app = express();
const http = createServer(app);
const rooms = new RoomStore();

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, authMode: config.authMode, ...rooms.stats() });
});

/** Public config the client needs before it can sign in. */
app.get('/api/config', (_req, res) => {
  res.json({
    authMode: config.authMode,
    keycloak:
      config.authMode === 'keycloak'
        ? { issuer: config.keycloak.issuer, clientId: config.keycloak.audience }
        : null,
  });
});

// In production the built client is served from the same origin as the socket.
app.use(express.static(clientDist));
app.get(/^(?!\/(api|socket\.io|healthz)).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) res.status(404).send('Client build not found. Run `npm run build`.');
  });
});

const io = new Server(http, {
  cors: {
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','),
    credentials: true,
  },
});

interface SocketData {
  identity: Identity;
  code?: string;
  playerId?: string;
  ip: string;
}

const connections = new ConnectionCounter();
const actionLimit = new RateLimiter(config.actionsPerMinute, 60_000);
const createLimit = new RateLimiter(config.createsPerMinute, 60_000);
const joinLimit = new RateLimiter(config.joinsPerMinute, 60_000);

setInterval(() => {
  const now = Date.now();
  for (const limiter of [actionLimit, createLimit, joinLimit]) limiter.sweep(now);
}, 60_000).unref();

/**
 * Socket.IO does not catch throws inside handlers, so one unexpected error
 * would take the whole process — and every other game on it — down. Anything
 * reaching the network gets wrapped.
 */
function safely<A extends unknown[]>(
  label: string,
  handler: (...args: A) => void,
): (...args: A) => void {
  return (...args: A) => {
    try {
      handler(...args);
    } catch (err) {
      console.error(`error handling ${label}:`, err);
      const cb = args[args.length - 1];
      if (typeof cb === 'function') (cb as (r: unknown) => void)({ ok: false, error: 'couldNotJoin' });
    }
  };
}

io.use(async (socket, next) => {
  const ip = clientIp(socket);
  if (connections.get(ip) >= config.maxConnectionsPerIp) {
    log.warn('conn.refused', { ip, count: connections.get(ip), detail: 'per-ip limit' });
    next(new Error('Too many connections.'));
    return;
  }
  try {
    const identity = await resolveIdentity(socket.handshake.auth ?? {});
    const data = socket.data as SocketData;
    data.identity = identity;
    data.ip = ip;
    next();
  } catch (err) {
    log.warn('auth.rejected', { ip, detail: err instanceof Error ? err.message : 'unknown' });
    next(err instanceof Error ? err : new Error('Authentication failed.'));
  }
});

/** Push a personalised view to every socket in a room. */
function broadcast(code: string): void {
  for (const socket of io.sockets.sockets.values()) {
    const data = socket.data as SocketData;
    if (data.code !== code || !data.playerId) continue;
    const view = rooms.view(code, data.playerId);
    if (view) socket.emit('state', view);
  }
}

rooms.onChange = broadcast;

io.on('connection', (socket: Socket) => {
  const data = socket.data as SocketData;
  connections.add(data.ip);
  log.debug('conn.open', { ip: data.ip, actor: data.identity.subject });
  socket.on('disconnect', () => {
    connections.remove(data.ip);
    log.debug('conn.close', { ip: data.ip, actor: data.identity.subject });
  });

  const pushSelf = () => {
    if (!data.code || !data.playerId) return;
    const view = rooms.view(data.code, data.playerId);
    if (view) socket.emit('state', view);
  };

  socket.emit('hello', {
    // Guest mode: the browser stores this and replays it to reclaim its seat.
    token: config.authMode === 'guest' ? data.identity.subject : undefined,
    name: data.identity.name,
    authMode: config.authMode,
  });

  socket.on('room:create', safely('room:create', (payload: { name?: string }, cb?: (r: unknown) => void) => {
    if (!createLimit.allow(data.ip)) {
      log.warn('limit.tripped', { ip: data.ip, detail: 'room:create' });
      return cb?.({ ok: false, error: 'tooFast' });
    }
    if (config.authMode === 'guest' && typeof payload?.name === 'string') {
      data.identity.name = sanitizeName(payload.name);
    }
    const room = rooms.create();
    if (!room) {
      log.warn('room.refused', { ip: data.ip, detail: 'server at capacity' });
      return cb?.({ ok: false, error: 'serverBusy' });
    }
    const joined = rooms.join(room.state.code, data.identity);
    if (!joined.ok) return cb?.({ ok: false, error: joined.error });

    data.code = room.state.code;
    data.playerId = joined.playerId;
    void socket.join(room.state.code);
    log.info('room.create', {
      room: room.state.code,
      actor: joined.playerId,
      name: data.identity.name,
      ip: data.ip,
    });
    track(data.identity.subject, 'room created', { auth_mode: config.authMode });
    cb?.({ ok: true, code: room.state.code, playerId: joined.playerId });
    pushSelf();
  }));

  socket.on(
    'room:join',
    safely('room:join', (payload: { code?: string; name?: string }, cb?: (r: unknown) => void) => {
      // Rate limited so the code space cannot be walked, however long it is.
      if (!joinLimit.allow(data.ip)) {
        log.warn('limit.tripped', { ip: data.ip, detail: 'room:join' });
        return cb?.({ ok: false, error: 'tooFast' });
      }
      const code = parseRoomCode(payload?.code, config.roomCodeLength);
      if (!code) return cb?.({ ok: false, error: 'badCode' });
      if (config.authMode === 'guest' && typeof payload?.name === 'string') {
        data.identity.name = sanitizeName(payload.name);
      }

      const joined = rooms.join(code, data.identity);
      if (!joined.ok) {
        // A stream of these from one address is someone guessing codes.
        log.warn('room.join_failed', { room: code, ip: data.ip, detail: joined.error });
        return cb?.({ ok: false, error: joined.error });
      }

      data.code = code;
      data.playerId = joined.playerId;
      void socket.join(code);
      log.info('room.join', {
        room: code,
        actor: joined.playerId,
        name: data.identity.name,
        ip: data.ip,
        players: joined.room.state.players.length,
      });
      track(data.identity.subject, 'room joined', {
        players: joined.room.state.players.length,
      });
      cb?.({ ok: true, code, playerId: joined.playerId });
      broadcast(code);
    }),
  );

  socket.on('room:leave', safely('room:leave', (_p: unknown, cb?: (r: unknown) => void) => {
    const { code, playerId } = data;
    if (code && playerId) {
      rooms.markDisconnected(code, playerId);
      void socket.leave(code);
      broadcast(code);
    }
    data.code = undefined;
    data.playerId = undefined;
    cb?.({ ok: true });
  }));

  socket.on('game:action', safely('game:action', (raw: unknown, cb?: (r: ActionResult) => void) => {
    const { code, playerId } = data;
    if (!code || !playerId) return cb?.({ ok: false, error: 'notInGame' });
    if (!actionLimit.allow(data.ip)) {
      log.warn('limit.tripped', { ip: data.ip, room: code, detail: 'game:action' });
      return cb?.({ ok: false, error: 'tooFast' });
    }
    // Anything that is not a recognised action is refused here, not passed on.
    const action = parseAction(raw);
    if (!action) {
      const kind = (raw as { type?: unknown })?.type;
      log.warn('action.malformed', {
        ip: data.ip,
        room: code,
        actor: playerId,
        detail: typeof kind === 'string' ? kind.slice(0, 32) : typeof kind,
      });
      return cb?.({ ok: false, error: 'badAction' });
    }

    const before = rooms.get(code)?.state.phase;
    const started = Date.now();
    const result = rooms.act(code, playerId, action);
    log.debug('action', {
      room: code,
      actor: playerId,
      detail: action.type,
      ok: result.ok,
      ms: Date.now() - started,
    });
    if (!result.ok) log.debug('action.rejected', { room: code, actor: playerId, detail: result.error });
    if (result.ok) reportPhaseChange(code, before);
    cb?.(result);
    if (!result.ok) pushSelf();
  }));

  socket.on('disconnect', () => {
    const { code, playerId } = data;
    if (!code || !playerId) return;
    // Another tab may still hold this seat; only drop when no socket remains.
    const stillHere = [...io.sockets.sockets.values()].some((s) => {
      const d = s.data as SocketData;
      return s.id !== socket.id && d.code === code && d.playerId === playerId;
    });
    if (stillHere) return;
    rooms.markDisconnected(code, playerId);
    broadcast(code);
  });
});

/**
 * Round and match outcomes are the events worth keeping. They can only be
 * reached by someone playing their last card, so watching the phase either side
 * of an action catches all of them.
 */
function reportPhaseChange(code: string, before: string | undefined): void {
  const room = rooms.get(code);
  if (!room || room.state.phase === before) return;
  const state = room.state;
  if (state.phase !== 'roundOver' && state.phase !== 'matchOver') return;

  const winnerId = state.phase === 'matchOver' ? state.matchWinner : state.roundWinner;
  const winner = state.players.find((p) => p.id === winnerId);
  if (!winner) return;

  const durationMs = Date.now() - room.roundStartedAt;
  log.info(state.phase === 'matchOver' ? 'game.match_end' : 'game.round_end', {
    room: code,
    actor: winner.id,
    name: winner.name,
    players: state.players.length,
    count: winner.score,
    ms: durationMs,
  });
  track(winner.token, state.phase === 'matchOver' ? 'match won' : 'round won', {
    players: state.players.length,
    score: winner.score,
    duration_sec: Math.round(durationMs / 1000),
    stacking: state.rules.stacking,
    challenges: state.rules.challenges,
    seven_zero: state.rules.sevenZero,
    hand_size: state.rules.handSize,
  });
}

// Ticks fast enough that a five-second turn clock is not visibly coarse.
setInterval(() => rooms.sweep(), 500).unref();

/* ------------------------------------------------------------------ *
 * Surviving a restart
 * ------------------------------------------------------------------ */

initAnalytics();

const persistenceOn = config.snapshotPath.trim().length > 0;

if (persistenceOn) {
  const snapshot = loadSnapshot(config.snapshotPath);
  if (snapshot) {
    const restored = rooms.restore(snapshot.rooms);
    const age = Math.round((Date.now() - snapshot.savedAt) / 1000);
    console.log(`restored ${restored} room(s) from a snapshot ${age}s old`);
  }

  if (config.snapshotIntervalSec > 0) {
    setInterval(() => {
      if (!rooms.dirty) return;
      void saveSnapshot(config.snapshotPath, rooms.export()).catch((err) =>
        console.warn('snapshot failed:', err),
      );
    }, config.snapshotIntervalSec * 1000).unref();
  }
}

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('server.stop', { detail: signal, ...rooms.stats() });

  if (persistenceOn) {
    try {
      // Synchronous: the process is about to exit, so an awaited write may
      // never land. This is the save that makes a planned restart seamless.
      const saved = rooms.export();
      saveSnapshotSync(config.snapshotPath, saved);
      console.log(`${signal}: saved ${saved.length} room(s)`);
    } catch (err) {
      console.error('could not save rooms on shutdown:', err);
    }
  }

  io.close();
  // Give the analytics queue and the log file a moment to flush, but never let
  // that hold up a deploy.
  void Promise.allSettled([shutdownAnalytics(), log.close()]).then(() => process.exit(0));
  http.close();
  setTimeout(() => process.exit(0), 3000).unref();
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => shutdown(signal));
}

http.listen(config.port, () => {
  log.info('server.start', {
    detail: config.authMode,
    count: config.port,
    ok: persistenceOn,
  });
  console.log(
    `uno server listening on :${config.port} (auth: ${config.authMode}` +
      `${persistenceOn ? `, snapshots: ${config.snapshotPath}` : ', snapshots: off'})`,
  );
});
