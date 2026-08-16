import { useState } from 'react';
import { CardFace } from '../components/CardFace';
import { storedName } from '../net';
import { LanguagePicker, useI18n } from '../i18n';

interface Props {
  presetCode: string;
  onCreate: (name: string) => Promise<void>;
  onJoin: (code: string, name: string) => Promise<void>;
  busy: boolean;
}

export function Home({ presetCode, onCreate, onJoin, busy }: Props) {
  const { s } = useI18n();
  const [name, setName] = useState(storedName());
  const [code, setCode] = useState(presetCode);

  const trimmed = name.trim();
  const canJoin = trimmed.length > 0 && /^[A-Za-z0-9]{4}$/.test(code.trim());

  return (
    <div className="home">
      <div className="home-lang">
        <LanguagePicker />
      </div>

      <div className="home-art" aria-hidden="true">
        <CardFace card={{ id: 'a', kind: 'number', color: 'red', value: 7 }} width={92} />
        <CardFace card={{ id: 'b', kind: 'skip', color: 'blue' }} width={92} />
        <CardFace card={{ id: 'c', kind: 'wild' }} width={92} />
        <CardFace card={{ id: 'd', kind: 'draw2', color: 'green' }} width={92} />
      </div>

      <h1 className="home-title">UNO</h1>
      <p className="home-sub">{s.ui.tagline}</p>

      <label className="field">
        <span>{s.ui.yourName}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={s.ui.namePlaceholder}
          maxLength={16}
          autoComplete="nickname"
        />
      </label>

      <button
        className="btn primary big"
        disabled={busy || trimmed.length === 0}
        onClick={() => void onCreate(trimmed)}
      >
        {s.ui.startNewGame}
      </button>

      <div className="divider">
        <span>{s.ui.orJoinOne}</span>
      </div>

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
          placeholder={s.ui.codePlaceholder}
          inputMode="text"
          autoCapitalize="characters"
          spellCheck={false}
          aria-label={s.ui.codeLabel}
        />
        <button className="btn big" disabled={busy || !canJoin} type="submit">
          {s.ui.join}
        </button>
      </form>
    </div>
  );
}
