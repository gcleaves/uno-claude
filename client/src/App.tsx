import { useEffect, useRef, useState } from 'react';
import { storedName, useNet } from './net';
import { useI18n } from './i18n';
import { track } from './analytics';
import { MAX_CODE } from './screens/Home';
import { Home } from './screens/Home';
import { Lobby } from './screens/Lobby';
import { Game } from './screens/Game';

export default function App() {
  const { s, error: tError } = useI18n();
  const net = useNet();
  const [busy, setBusy] = useState(false);
  const [presetCode] = useState(() => {
    const fromUrl = new URLSearchParams(location.search).get('r') ?? '';
    return fromUrl.toUpperCase().slice(0, MAX_CODE);
  });

  // A refresh, or a phone waking up, should drop you straight back into your seat:
  // the stored token already identifies you to the server.
  const autoJoined = useRef(false);
  useEffect(() => {
    if (autoJoined.current || net.conn !== 'online' || net.code) return;
    // Read the URL live rather than the mount-time value: leaving a room clears
    // the parameter, and we must not drag someone back into a room they left.
    const code = new URLSearchParams(location.search).get('r');
    const name = storedName();
    if (!code || !name) return;
    autoJoined.current = true;
    void net.joinRoom(code, name);
  }, [net]);

  // Keep the address bar in sync so a refresh (or a shared link) lands in the room.
  useEffect(() => {
    const url = new URL(location.href);
    if (net.code) url.searchParams.set('r', net.code);
    else url.searchParams.delete('r');
    history.replaceState(null, '', url);
  }, [net.code]);

  const create = async (name: string) => {
    setBusy(true);
    const code = await net.createRoom(name);
    track('game start attempted', { how: 'create', ok: !!code });
    setBusy(false);
  };

  const join = async (code: string, name: string) => {
    setBusy(true);
    const ok = await net.joinRoom(code, name);
    // How often a shared link works first time is the one funnel the server
    // cannot see, because a failed join never becomes a session.
    track('game start attempted', { how: 'join', ok });
    setBusy(false);
  };

  const inRoom = net.code && net.view;

  return (
    <div className="app">
      {net.conn !== 'online' && (
        <div className="conn-banner">
          {net.conn === 'connecting' ? s.ui.connecting : s.ui.reconnecting}
        </div>
      )}

      {!inRoom ? (
        <Home presetCode={presetCode} onCreate={create} onJoin={join} busy={busy} />
      ) : net.view!.phase === 'lobby' ? (
        <Lobby view={net.view!} send={net.send} onLeave={net.leaveRoom} />
      ) : (
        <Game view={net.view!} send={net.send} onLeave={net.leaveRoom} />
      )}

      {net.error && (
        <div className="toast" role="status" onClick={net.clearError}>
          {tError(net.error)}
          <AutoDismiss onDone={net.clearError} key={net.error} />
        </div>
      )}
    </div>
  );
}

function AutoDismiss({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3500);
    return () => clearTimeout(t);
  }, [onDone]);
  return null;
}
