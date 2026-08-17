import { useState } from 'react';
import type { Action, GameView, HouseRules } from '@uno/shared';
import { LanguagePicker, useI18n } from '../i18n';
import { track } from '../analytics';

interface Props {
  view: GameView;
  send: (action: Action) => Promise<unknown>;
  onLeave: () => void;
}

export function Lobby({ view, send, onLeave }: Props) {
  const { s } = useI18n();
  const [copied, setCopied] = useState(false);
  const isHost = view.you.isHost;
  const enough = view.players.length >= 2;
  const shareUrl = `${location.origin}/?r=${view.code}`;

  const share = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ text: `${s.ui.gameCode}: ${view.code}`, url: shareUrl });
        track('invite shared', { method: 'share_sheet' });
        return;
      }
      await navigator.clipboard.writeText(shareUrl);
      track('invite shared', { method: 'clipboard' });
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* user dismissed the share sheet */
    }
  };

  const setRule = <K extends keyof HouseRules>(key: K, value: HouseRules[K]) => {
    // Which optional rules anyone actually turns on.
    track('rule changed', { rule: String(key), value: String(value) });
    void send({ type: 'updateRules', rules: { [key]: value } as Partial<HouseRules> });
  };

  return (
    <div className="lobby">
      <header className="lobby-head">
        <button className="btn ghost" onClick={onLeave}>
          {s.ui.leave}
        </button>
        <div className="code-block">
          <span className="code-label">{s.ui.gameCode}</span>
          <strong className="code-value">{view.code}</strong>
        </div>
        <button className="btn ghost" onClick={() => void share()}>
          {copied ? s.ui.copied : s.ui.share}
        </button>
      </header>

      <section className="panel">
        <h2>
          {s.ui.players} ({view.players.length}/10)
        </h2>
        <ul className="player-list">
          {view.players.map((p) => (
            <li key={p.id} className={p.id === view.you.id ? 'me' : ''}>
              <span className="dot" data-on={p.connected} />
              <span className="pname">{p.name}</span>
              {p.isHost && <span className="tag">{s.ui.host}</span>}
              {p.id === view.you.id && <span className="tag you">{s.ui.you}</span>}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>{s.ui.houseRules}</h2>
        <div className="rules">
          <Toggle
            label={s.ui.ruleStacking}
            hint={s.ui.ruleStackingHint}
            checked={view.rules.stacking}
            disabled={!isHost}
            onChange={(v) => setRule('stacking', v)}
          />
          <Toggle
            label={s.ui.ruleChallenges}
            hint={s.ui.ruleChallengesHint}
            checked={view.rules.challenges}
            disabled={!isHost}
            onChange={(v) => setRule('challenges', v)}
          />
          <Toggle
            label={s.ui.ruleDrawToMatch}
            hint={s.ui.ruleDrawToMatchHint}
            checked={view.rules.drawToMatch}
            disabled={!isHost}
            onChange={(v) => setRule('drawToMatch', v)}
          />
          <Toggle
            label={s.ui.ruleSevenZero}
            hint={s.ui.ruleSevenZeroHint}
            checked={view.rules.sevenZero}
            disabled={!isHost}
            onChange={(v) => setRule('sevenZero', v)}
          />
          <Toggle
            label={s.ui.ruleScoring}
            hint={s.ui.ruleScoringHint(view.rules.targetScore)}
            checked={view.rules.scoring}
            disabled={!isHost}
            onChange={(v) => setRule('scoring', v)}
          />
          <label className="stepper">
            <span>{s.ui.cardsDealt}</span>
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
        {!isHost && <p className="muted">{s.ui.hostOnly}</p>}
      </section>

      <section className="panel lang-panel">
        <h2>{s.ui.language}</h2>
        <LanguagePicker />
      </section>

      <footer className="lobby-foot">
        {isHost ? (
          <button
            className="btn primary big"
            disabled={!enough}
            onClick={() => void send({ type: 'start' })}
          >
            {enough ? s.ui.dealTheCards : s.ui.waitingForPlayers}
          </button>
        ) : (
          <p className="muted center">{s.ui.waitingForHost}</p>
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
