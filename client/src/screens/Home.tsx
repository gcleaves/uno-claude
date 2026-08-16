import { useState } from 'react';
import { CardFace } from '../components/CardFace';
import { storedName } from '../net';

interface Props {
  presetCode: string;
  onCreate: (name: string) => Promise<void>;
  onJoin: (code: string, name: string) => Promise<void>;
  busy: boolean;
}

export function Home({ presetCode, onCreate, onJoin, busy }: Props) {
  const [name, setName] = useState(storedName());
  const [code, setCode] = useState(presetCode);

  const trimmed = name.trim();
  const canJoin = trimmed.length > 0 && /^[A-Za-z0-9]{4}$/.test(code.trim());

  return (
    <div className="home">
      <div className="home-art" aria-hidden="true">
        <CardFace card={{ id: 'a', kind: 'number', color: 'red', value: 7 }} width={92} />
        <CardFace card={{ id: 'b', kind: 'skip', color: 'blue' }} width={92} />
        <CardFace card={{ id: 'c', kind: 'wild' }} width={92} />
        <CardFace card={{ id: 'd', kind: 'draw2', color: 'green' }} width={92} />
      </div>

      <h1 className="home-title">UNO</h1>
      <p className="home-sub">Play with friends on any device.</p>

      <label className="field">
        <span>Your name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Alex"
          maxLength={16}
          autoComplete="nickname"
        />
      </label>

      <button
        className="btn primary big"
        disabled={busy || trimmed.length === 0}
        onClick={() => void onCreate(trimmed)}
      >
        Start a new game
      </button>

      <div className="divider"><span>or join one</span></div>

      <form
        className="join-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (canJoin) void onJoin(code.trim().toUpperCase(), trimmed);
        }}
      >
        <input
          className="code-input"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 4))}
          placeholder="CODE"
          inputMode="text"
          autoCapitalize="characters"
          spellCheck={false}
          aria-label="Game code"
        />
        <button className="btn big" disabled={busy || !canJoin} type="submit">
          Join
        </button>
      </form>
    </div>
  );
}
