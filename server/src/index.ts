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
  socket.on('disconnect', () => connections.remove(data.ip));

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
    if (!createLimit.allow(data.ip)) return cb?.({ ok: false, error: 'tooFast' });
    if (config.authMode === 'guest' && typeof payload?.name === 'string') {
      data.identity.name = sanitizeName(payload.name);
    }
    const room = rooms.create();
    if (!room) return cb?.({ ok: false, error: 'serverBusy' });
    const joined = rooms.join(room.state.code, data.identity);
    if (!joined.ok) return cb?.({ ok: false, error: joined.error });

    data.code = room.state.code;
    data.playerId = joined.playerId;
    void socket.join(room.state.code);
    cb?.({ ok: true, code: room.state.code, playerId: joined.playerId });
    pushSelf();
  }));

  socket.on(
    'room:join',
    safely('room:join', (payload: { code?: string; name?: string }, cb?: (r: unknown) => void) => {
      // Rate limited so the code space cannot be walked, however long it is.
      if (!joinLimit.allow(data.ip)) return cb?.({ ok: false, error: 'tooFast' });
      const code = parseRoomCode(payload?.code, config.roomCodeLength);
      if (!code) return cb?.({ ok: false, error: 'badCode' });
      if (config.authMode === 'guest' && typeof payload?.name === 'string') {
        data.identity.name = sanitizeName(payload.name);
      }

      const joined = rooms.join(code, data.identity);
      if (!joined.ok) return cb?.({ ok: false, error: joined.error });

      data.code = code;
      data.playerId = joined.playerId;
      void socket.join(code);
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
    if (!actionLimit.allow(data.ip)) return cb?.({ ok: false, error: 'tooFast' });
    // Anything that is not a recognised action is refused here, not passed on.
    const action = parseAction(raw);
    if (!action) return cb?.({ ok: false, error: 'badAction' });
    const result = rooms.act(code, playerId, action);
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

// Ticks fast enough that a five-second turn clock is not visibly coarse.
setInterval(() => rooms.sweep(), 500).unref();

/* ------------------------------------------------------------------ *
 * Surviving a restart
 * ------------------------------------------------------------------ */

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
  http.close(() => process.exit(0));
  // Sockets keep the server open; do not hang a deploy waiting for them.
  setTimeout(() => process.exit(0), 3000).unref();
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => shutdown(signal));
}

http.listen(config.port, () => {
  console.log(
    `uno server listening on :${config.port} (auth: ${config.authMode}` +
      `${persistenceOn ? `, snapshots: ${config.snapshotPath}` : ', snapshots: off'})`,
  );
});
