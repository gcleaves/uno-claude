import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  COLORS,
  describeCard,
  type Action,
  type Card,
  type CardColor,
  type GameView,
} from '@uno/shared';
import { CardFace, PALETTE } from '../components/CardFace';

interface Props {
  view: GameView;
  send: (action: Action) => Promise<unknown>;
  onLeave: () => void;
}

export function Game({ view, send, onLeave }: Props) {
  const [pendingWild, setPendingWild] = useState<Card | null>(null);
  const [pendingSwap, setPendingSwap] = useState<{ card: Card; color?: CardColor } | null>(null);
  const [showLog, setShowLog] = useState(false);

  const clock = useTurnClock(view.turnRemainingMs, view.turnTotalMs);
  const viewportWidth = useViewportWidth();
  const layout = useMemo(
    () => handLayout(view.you.hand.length, viewportWidth),
    [view.you.hand.length, viewportWidth],
  );

  const me = view.players.find((p) => p.id === view.you.id);
  const others = useMemo(() => rotateToSelf(view), [view]);
  const current = view.players[view.turn];
  const yourTurn = view.you.isYourTurn;
  const playable = new Set(view.you.playable);
  const overlayOpen = view.phase === 'roundOver' || view.phase === 'matchOver';

  const attempt = (card: Card) => {
    if (!playable.has(card.id)) return;
    const needsColor = card.kind === 'wild' || card.kind === 'wild4';
    const needsTarget =
      view.rules.sevenZero && card.kind === 'number' && card.value === 7 && view.players.length > 2;

    if (needsColor) return setPendingWild(card);
    if (needsTarget) return setPendingSwap({ card });
    void send({ type: 'play', cardId: card.id });
  };

  const chooseColor = (color: CardColor) => {
    const card = pendingWild;
    setPendingWild(null);
    if (!card) return;
    void send({ type: 'play', cardId: card.id, chosenColor: color });
  };

  const chooseSwapTarget = (targetPlayerId: string) => {
    const pending = pendingSwap;
    setPendingSwap(null);
    if (!pending) return;
    void send({ type: 'play', cardId: pending.card.id, targetPlayerId });
  };

  const canCatch = view.unoVulnerable && view.unoVulnerable !== view.you.id;
  const canCallUno =
    view.phase === 'playing' &&
    !!me &&
    (me.handCount === 2 || (me.handCount === 1 && !me.saidUno));

  return (
    <div className="game" data-color={view.activeColor ?? 'none'}>
      <header className="game-head">
        <button className="btn ghost tiny" onClick={onLeave}>
          Leave
        </button>
        <div className="head-mid">
          <span className="room-code">{view.code}</span>
          <span className="dir" title={view.direction === 1 ? 'Clockwise' : 'Counter-clockwise'}>
            {view.direction === 1 ? '↻' : '↺'}
          </span>
        </div>
        <button className="btn ghost tiny" onClick={() => setShowLog((s) => !s)}>
          Log
        </button>
      </header>

      <section className="opponents">
        {others.map((p) => {
          const isTurn = view.players[view.turn]?.id === p.id;
          return (
            <div key={p.id} className="opp" data-turn={isTurn} data-off={!p.connected}>
              <div className="opp-cards" aria-hidden="true">
                {Array.from({ length: Math.min(p.handCount, 6) }).map((_, i) => (
                  <span key={i} className="mini-back" style={{ left: `${i * 9}px` }} />
                ))}
              </div>
              <span className="opp-name">{p.name}</span>
              <span className="opp-count">{p.handCount}</span>
              {view.rules.scoring && <span className="opp-score">{p.score}</span>}
              {view.unoVulnerable === p.id && (
                <button className="catch" onClick={() => void send({ type: 'callOut', playerId: p.id })}>
                  Catch!
                </button>
              )}
              {p.saidUno && p.handCount === 1 && <span className="uno-flag">UNO</span>}
              {isTurn && clock && clock.seconds <= 10 && (
                <span className="opp-clock" data-urgent={clock.urgent}>
                  {clock.seconds}
                </span>
              )}
            </div>
          );
        })}
      </section>

      <section className="table">
        <button
          className="pile draw"
          disabled={!yourTurn || view.hasDrawn}
          onClick={() => void send({ type: 'draw' })}
          aria-label={`Draw pile, ${view.drawPileCount} cards`}
        >
          <CardFace faceDown width={104} />
          <span className="pile-count">{view.drawPileCount}</span>
          {view.pendingDraw > 0 && yourTurn && <span className="pending">+{view.pendingDraw}</span>}
        </button>

        <div className="pile discard">
          {view.topCard ? (
            <CardFace
              // Keying on the card id remounts the node, so the deal animation
              // replays for each newly played card instead of only the first.
              key={view.topCard.id}
              card={view.topCard}
              width={116}
              chosenColor={view.activeColor}
              className="top-card"
            />
          ) : (
            <div className="empty-pile" />
          )}
          {view.activeColor && (
            <span className="color-chip" style={{ background: PALETTE[view.activeColor].face }}>
              {view.activeColor}
            </span>
          )}
        </div>
      </section>

      <section className="status">
        {view.phase === 'playing' ? (
          yourTurn ? (
            <strong className="your-turn">
              {view.pendingDraw > 0
                ? `Draw ${view.pendingDraw}${view.you.playable.length ? ' or stack a penalty' : ''}`
                : view.hasDrawn
                  ? 'Play the card you drew, or pass'
                  : 'Your turn'}
            </strong>
          ) : (
            <span className="muted">Waiting for {current?.name ?? '…'}</span>
          )
        ) : (
          <span className="muted">Round over</span>
        )}

        {clock && (
          <div className="turn-clock" data-urgent={clock.urgent}>
            <div className="turn-clock-track" aria-hidden="true">
              <div className="turn-clock-fill" style={{ transform: `scaleX(${clock.fraction})` }} />
            </div>
            {clock.seconds <= 10 && (
              <span className="turn-clock-count">
                {clock.seconds}s
                <span className="sr-only">
                  {yourTurn ? ' left to play before you forfeit the turn' : ' left in their turn'}
                </span>
              </span>
            )}
          </div>
        )}
      </section>

      <section className="hand-wrap">
        <div className="hand" style={{ '--overlap': `${layout.overlap}px` } as never}>
          {view.you.hand.map((card) => (
            <button
              key={card.id}
              className="hand-card"
              data-playable={playable.has(card.id)}
              disabled={!playable.has(card.id)}
              onClick={() => attempt(card)}
              aria-label={describeCard(card)}
            >
              <CardFace card={card} width={layout.cardWidth} />
            </button>
          ))}
          {view.you.hand.length === 0 && <p className="muted">No cards.</p>}
        </div>
      </section>

      <footer className="actions">
        <button
          className="btn"
          disabled={!yourTurn || view.hasDrawn}
          onClick={() => void send({ type: 'draw' })}
        >
          {view.pendingDraw > 0 ? `Draw ${view.pendingDraw}` : 'Draw'}
        </button>
        <button
          className="btn uno-btn"
          data-armed={canCallUno}
          disabled={!canCallUno}
          onClick={() => void send({ type: 'sayUno' })}
        >
          UNO!
        </button>
        <button
          className="btn"
          disabled={!yourTurn || !view.hasDrawn}
          onClick={() => void send({ type: 'pass' })}
        >
          Pass
        </button>
      </footer>

      {canCatch && <div className="catch-banner">Someone forgot to call UNO — tap “Catch!”</div>}

      {pendingWild && (
        <Modal title="Pick a colour" onClose={() => setPendingWild(null)}>
          <div className="color-grid">
            {COLORS.map((c) => (
              <button
                key={c}
                className="color-btn"
                style={{ background: PALETTE[c].face }}
                onClick={() => chooseColor(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </Modal>
      )}

      {pendingSwap && (
        <Modal title="Swap hands with…" onClose={() => setPendingSwap(null)}>
          <div className="target-grid">
            {others.map((p) => (
              <button key={p.id} className="btn" onClick={() => chooseSwapTarget(p.id)}>
                {p.name} <small>({p.handCount})</small>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {overlayOpen && <RoundOver view={view} send={send} onLeave={onLeave} />}

      {showLog && (
        <Modal title="Game log" onClose={() => setShowLog(false)}>
          <Log view={view} />
        </Modal>
      )}
    </div>
  );
}

function RoundOver({ view, send, onLeave }: Props) {
  const matchOver = view.phase === 'matchOver';
  const winnerId = matchOver ? view.matchWinner : view.roundWinner;
  const winner = view.players.find((p) => p.id === winnerId);
  const standings = [...view.players].sort((a, b) => b.score - a.score);

  return (
    <div className="overlay">
      <div className="sheet">
        <h2>{matchOver ? 'Match over' : 'Round over'}</h2>
        <p className="winner">
          {winner ? (winner.id === view.you.id ? 'You win!' : `${winner.name} wins!`) : '—'}
        </p>

        {view.rules.scoring && (
          <ol className="standings">
            {standings.map((p) => (
              <li key={p.id} data-me={p.id === view.you.id}>
                <span>{p.name}</span>
                <strong>{p.score}</strong>
              </li>
            ))}
          </ol>
        )}

        <div className="sheet-actions">
          {view.you.isHost && !matchOver && (
            <button className="btn primary big" onClick={() => void send({ type: 'nextRound' })}>
              Next round
            </button>
          )}
          {view.you.isHost && matchOver && (
            <button className="btn primary big" onClick={() => void send({ type: 'start' })}>
              Play again
            </button>
          )}
          {!view.you.isHost && <p className="muted">Waiting for the host…</p>}
          <button className="btn ghost" onClick={onLeave}>
            Leave game
          </button>
        </div>
      </div>
    </div>
  );
}

function Log({ view }: { view: GameView }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [view.log.length]);
  return (
    <ol className="log" ref={ref}>
      {view.log.map((entry) => (
        <li key={entry.id}>{entry.text}</li>
      ))}
    </ol>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Seat order starting after you, so the table reads left-to-right in turn order. */
function rotateToSelf(view: GameView) {
  const idx = view.players.findIndex((p) => p.id === view.you.id);
  if (idx === -1) return view.players;
  const n = view.players.length;
  return Array.from({ length: n - 1 }, (_, i) => view.players[(idx + 1 + i) % n]!);
}

/**
 * Counts the turn clock down locally between server updates.
 *
 * The server sends how long is *left* rather than when the deadline falls, so a
 * phone with a wrong clock still shows the right number. Each update re-syncs.
 */
function useTurnClock(
  remainingMs: number | null,
  totalMs: number | null,
): { seconds: number; fraction: number; urgent: boolean } | null {
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    setEndsAt(remainingMs === null ? null : Date.now() + remainingMs);
  }, [remainingMs]);

  useEffect(() => {
    if (endsAt === null) return;
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [endsAt]);

  if (endsAt === null || !totalMs) return null;
  const left = Math.max(0, endsAt - Date.now());
  return {
    seconds: Math.ceil(left / 1000),
    fraction: left / totalMs,
    urgent: left <= 5000,
  };
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);
  return width;
}

/**
 * Fan the hand to fill the screen: shrink the cards a little, then overlap them,
 * and only fall back to horizontal scrolling once they'd become unreadable.
 */
function handLayout(count: number, viewportWidth: number): { cardWidth: number; overlap: number } {
  const available = Math.min(viewportWidth, 720) - 24;
  if (count <= 1) return { cardWidth: 96, overlap: 0 };

  const cardWidth = count > 5 ? 82 : 96;
  // Always leave a sliver wide enough to show the colour, the corner pip, and a thumb.
  const maxOverlap = -(cardWidth - 44);
  const needed = (available - count * cardWidth) / (count - 1);
  const overlap = Math.round(Math.max(maxOverlap, Math.min(0, needed)));
  return { cardWidth, overlap };
}
