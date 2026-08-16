import { useState } from 'react';
import type { Action, GameView, HouseRules } from '@uno/shared';

interface Props {
  view: GameView;
  send: (action: Action) => Promise<unknown>;
  onLeave: () => void;
}

export function Lobby({ view, send, onLeave }: Props) {
  const [copied, setCopied] = useState(false);
  const isHost = view.you.isHost;
  const enough = view.players.length >= 2;
  const shareUrl = `${location.origin}/?r=${view.code}`;

  const share = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Join my Uno game', text: `Code: ${view.code}`, url: shareUrl });
        return;
      }
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* user dismissed the share sheet */
    }
  };

  const setRule = <K extends keyof HouseRules>(key: K, value: HouseRules[K]) =>
    void send({ type: 'updateRules', rules: { [key]: value } as Partial<HouseRules> });

  return (
    <div className="lobby">
      <header className="lobby-head">
        <button className="btn ghost" onClick={onLeave}>
          Leave
        </button>
        <div className="code-block">
          <span className="code-label">Game code</span>
          <strong className="code-value">{view.code}</strong>
        </div>
        <button className="btn ghost" onClick={() => void share()}>
          {copied ? 'Copied' : 'Share'}
        </button>
      </header>

      <section className="panel">
        <h2>Players ({view.players.length}/10)</h2>
        <ul className="player-list">
          {view.players.map((p) => (
            <li key={p.id} className={p.id === view.you.id ? 'me' : ''}>
              <span className="dot" data-on={p.connected} />
              <span className="pname">{p.name}</span>
              {p.isHost && <span className="tag">host</span>}
              {p.id === view.you.id && <span className="tag you">you</span>}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>House rules</h2>
        <div className="rules">
          <Toggle
            label="Stacking"
            hint="Answer a +2 with another +2 to pass it on."
            checked={view.rules.stacking}
            disabled={!isHost}
            onChange={(v) => setRule('stacking', v)}
          />
          <Toggle
            label="Draw until playable"
            hint="Keep drawing instead of taking exactly one card."
            checked={view.rules.drawToMatch}
            disabled={!isHost}
            onChange={(v) => setRule('drawToMatch', v)}
          />
          <Toggle
            label="Sevens and zeros"
            hint="A 7 swaps hands with someone; a 0 passes all hands around."
            checked={view.rules.sevenZero}
            disabled={!isHost}
            onChange={(v) => setRule('sevenZero', v)}
          />
          <Toggle
            label="Keep score"
            hint={`Play rounds until someone reaches ${view.rules.targetScore}.`}
            checked={view.rules.scoring}
            disabled={!isHost}
            onChange={(v) => setRule('scoring', v)}
          />
          <label className="stepper">
            <span>Cards dealt</span>
            <div>
              <button
                className="btn tiny"
                disabled={!isHost || view.rules.handSize <= 1}
                onClick={() => setRule('handSize', view.rules.handSize - 1)}
              >
                −
              </button>
              <strong>{view.rules.handSize}</strong>
              <button
                className="btn tiny"
                disabled={!isHost || view.rules.handSize >= 15}
                onClick={() => setRule('handSize', view.rules.handSize + 1)}
              >
                +
              </button>
            </div>
          </label>
        </div>
        {!isHost && <p className="muted">Only the host can change these.</p>}
      </section>

      <footer className="lobby-foot">
        {isHost ? (
          <button
            className="btn primary big"
            disabled={!enough}
            onClick={() => void send({ type: 'start' })}
          >
            {enough ? 'Deal the cards' : 'Waiting for one more player…'}
          </button>
        ) : (
          <p className="muted center">Waiting for the host to start…</p>
        )}
      </footer>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="toggle" data-disabled={disabled}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track" aria-hidden="true" />
      <span className="toggle-text">
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
    </label>
  );
}
