import type { Card, CardColor } from '@uno/shared';

/**
 * Cards are drawn as SVG rather than shipped as image assets: the geometry is
 * simple, it stays sharp at any size, and it costs no network requests.
 */

export const PALETTE: Record<CardColor, { face: string; deep: string }> = {
  red: { face: '#e0202a', deep: '#8f0d16' },
  yellow: { face: '#f2b705', deep: '#a97a00' },
  green: { face: '#2fa84f', deep: '#166b2c' },
  blue: { face: '#1f6fd6', deep: '#0e3f85' },
};

const WILD_BODY = '#17171c';
const WILD_DEEP = '#000000';

const W = 240;
const H = 360;

interface Props {
  card?: Card;
  faceDown?: boolean;
  /** Card width in px; height follows the 2:3 ratio. */
  width?: number;
  /** Renders the wild in a chosen colour, e.g. the discard pile top. */
  chosenColor?: CardColor | null;
  className?: string;
  /** Accessible name. Supplied by the caller so it can be localised. */
  label?: string;
}

export function CardFace({ card, faceDown, width = 96, chosenColor, className, label }: Props) {
  const height = Math.round((width * H) / W);
  const common = {
    viewBox: `0 0 ${W} ${H}`,
    width,
    height,
    className,
    role: 'img' as const,
  };

  if (faceDown || !card) {
    return (
      <svg {...common} aria-label={label ?? 'Face-down card'}>
        <CardBody body={WILD_BODY} deep={WILD_DEEP} />
        <g transform={`translate(${W / 2} ${H / 2}) rotate(-20)`}>
          <ellipse rx="88" ry="52" fill="#fff" />
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fontFamily="Verdana, Geneva, sans-serif"
            fontWeight="900"
            fontSize="52"
            fontStyle="italic"
            fill={PALETTE.yellow.face}
            stroke={PALETTE.red.deep}
            strokeWidth="3"
            paintOrder="stroke"
          >
            UNO
          </text>
        </g>
      </svg>
    );
  }

  const wild = card.kind === 'wild' || card.kind === 'wild4';
  const body = wild ? WILD_BODY : PALETTE[card.color!].face;
  const deep = wild ? WILD_DEEP : PALETTE[card.color!].deep;
  const accent = wild && chosenColor ? PALETTE[chosenColor].face : null;

  return (
    <svg {...common} aria-label={label ?? labelFor(card, chosenColor)}>
      <CardBody body={body} deep={deep} />

      {/* Tilted oval that every Uno face sits inside. */}
      <g transform={`translate(${W / 2} ${H / 2}) rotate(-20)`}>
        <ellipse rx="86" ry="128" fill="#ffffff" />
        <g transform="rotate(20)">
          <CenterGlyph card={card} deep={deep} />
        </g>
      </g>

      {/* Corner pips, the second one rotated like a real card. */}
      <g transform="translate(34 42)">
        <CornerGlyph card={card} />
      </g>
      <g transform={`translate(${W - 34} ${H - 42}) rotate(180)`}>
        <CornerGlyph card={card} />
      </g>

      {/* When a wild has been resolved to a colour, band the card so it reads at a glance. */}
      {accent && (
        <rect
          x="14"
          y={H - 40}
          width={W - 28}
          height="26"
          rx="13"
          fill={accent}
          stroke="#fff"
          strokeWidth="3"
        />
      )}
    </svg>
  );
}

function CardBody({ body, deep }: { body: string; deep: string }) {
  return (
    <>
      <rect x="0" y="0" width={W} height={H} rx="24" fill="#ffffff" />
      <rect x="10" y="10" width={W - 20} height={H - 20} rx="16" fill={body} />
      <rect
        x="10"
        y="10"
        width={W - 20}
        height={H - 20}
        rx="16"
        fill="none"
        stroke={deep}
        strokeOpacity="0.35"
        strokeWidth="2"
      />
    </>
  );
}

/** Large centred symbol, drawn in a roughly -60..60 box. */
function CenterGlyph({ card, deep }: { card: Card; deep: string }) {
  const fill = card.color ? PALETTE[card.color].face : '#fff';

  switch (card.kind) {
    case 'number':
      return (
        <g>
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fontFamily="Verdana, Geneva, sans-serif"
            fontWeight="900"
            fontSize="170"
            fill={fill}
            stroke={deep}
            strokeWidth="5"
            paintOrder="stroke"
            dy="6"
          >
            {card.value}
          </text>
          {/* 6 and 9 are underlined, exactly as on a real deck, because the
              bottom corner pip is printed upside-down. */}
          {ambiguous(card.value) && (
            <rect x="-46" y="76" width="92" height="12" rx="6" fill={fill} stroke={deep} strokeWidth="4" />
          )}
        </g>
      );
    case 'skip':
      return <SkipIcon size={62} stroke={fill} outline={deep} strokeWidth={14} />;
    case 'reverse':
      return <ReverseIcon scale={1.55} fill={fill} outline={deep} />;
    case 'draw2':
      return <DrawTwoIcon scale={1.5} color={card.color!} />;
    case 'wild':
      return <WildIcon radius={72} />;
    case 'wild4':
      return <WildFourIcon scale={1.6} />;
  }
}

/** Small corner marker, always white, drawn in a -18..18 box. */
function CornerGlyph({ card }: { card: Card }) {
  switch (card.kind) {
    case 'number':
      return (
        <g>
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fontFamily="Verdana, Geneva, sans-serif"
            fontWeight="900"
            fontSize="42"
            fill="#fff"
          >
            {card.value}
          </text>
          {ambiguous(card.value) && <rect x="-12" y="20" width="24" height="4" rx="2" fill="#fff" />}
        </g>
      );
    case 'skip':
      return <SkipIcon size={16} stroke="#fff" outline="none" strokeWidth={5} />;
    case 'reverse':
      return <ReverseIcon scale={0.42} fill="#fff" outline="none" />;
    case 'draw2':
      return <CornerText text="+2" />;
    case 'wild':
      return <WildIcon radius={18} />;
    case 'wild4':
      return <CornerText text="+4" />;
  }
}

function CornerText({ text }: { text: string }) {
  return (
    <text
      textAnchor="middle"
      dominantBaseline="central"
      fontFamily="Verdana, Geneva, sans-serif"
      fontWeight="900"
      fontSize="34"
      fill="#fff"
    >
      {text}
    </text>
  );
}

function SkipIcon({
  size,
  stroke,
  outline,
  strokeWidth,
}: {
  size: number;
  stroke: string;
  outline: string;
  strokeWidth: number;
}) {
  const d = size * 0.72;
  return (
    <g>
      {outline !== 'none' && (
        <g stroke={outline} strokeWidth={strokeWidth + 8} fill="none" strokeLinecap="round">
          <circle r={size} />
          <line x1={-d} y1={-d} x2={d} y2={d} />
        </g>
      )}
      <g stroke={stroke} strokeWidth={strokeWidth} fill="none" strokeLinecap="round">
        <circle r={size} />
        <line x1={-d} y1={-d} x2={d} y2={d} />
      </g>
    </g>
  );
}

/** Two block arrows pointing opposite ways. */
function ReverseIcon({
  scale,
  fill,
  outline,
}: {
  scale: number;
  fill: string;
  outline: string;
}) {
  const up = 'M 8 30 L 8 -12 L 22 -12 L 0 -40 L -22 -12 L -8 -12 L -8 30 Z';
  const down = 'M 8 -30 L 8 12 L 22 12 L 0 40 L -22 12 L -8 12 L -8 -30 Z';
  return (
    <g transform={`scale(${scale})`}>
      <g transform="translate(-22 0)">
        <path d={up} fill={fill} stroke={outline === 'none' ? undefined : outline} strokeWidth="4" />
      </g>
      <g transform="translate(22 0)">
        <path
          d={down}
          fill={fill}
          stroke={outline === 'none' ? undefined : outline}
          strokeWidth="4"
        />
      </g>
    </g>
  );
}

/** Two overlapping mini-cards, the Uno "draw two" mark. */
function DrawTwoIcon({ scale, color }: { scale: number; color: CardColor }) {
  const { face, deep } = PALETTE[color];
  const mini = (x: number, y: number, rot: number) => (
    <g transform={`translate(${x} ${y}) rotate(${rot})`}>
      <rect x="-16" y="-24" width="32" height="48" rx="6" fill={face} stroke={deep} strokeWidth="4" />
      <rect x="-11" y="-19" width="22" height="38" rx="4" fill="#fff" opacity="0.25" />
    </g>
  );
  return (
    <g transform={`scale(${scale})`}>
      {mini(-12, 6, -12)}
      {mini(12, -6, 10)}
    </g>
  );
}

/** Four-colour wheel. */
function WildIcon({ radius }: { radius: number }) {
  const quarter = (from: number, color: CardColor) => {
    const a0 = (from * Math.PI) / 180;
    const a1 = ((from + 90) * Math.PI) / 180;
    const p = (a: number) => `${(radius * Math.cos(a)).toFixed(2)} ${(radius * Math.sin(a)).toFixed(2)}`;
    return (
      <path
        key={color}
        d={`M 0 0 L ${p(a0)} A ${radius} ${radius} 0 0 1 ${p(a1)} Z`}
        fill={PALETTE[color].face}
      />
    );
  };
  return (
    <g transform="rotate(-45)">
      {quarter(0, 'red')}
      {quarter(90, 'yellow')}
      {quarter(180, 'green')}
      {quarter(270, 'blue')}
      <circle r={radius} fill="none" stroke="#17171c" strokeWidth={radius > 30 ? 5 : 3} />
    </g>
  );
}

/** Four mini-cards, one per colour. */
function WildFourIcon({ scale }: { scale: number }) {
  const mini = (x: number, y: number, rot: number, color: CardColor) => (
    <g key={color} transform={`translate(${x} ${y}) rotate(${rot})`}>
      <rect
        x="-13"
        y="-19"
        width="26"
        height="38"
        rx="5"
        fill={PALETTE[color].face}
        stroke="#fff"
        strokeWidth="3"
      />
    </g>
  );
  return (
    <g transform={`scale(${scale})`}>
      {mini(-16, -14, -12, 'red')}
      {mini(16, -14, 12, 'yellow')}
      {mini(-16, 16, -8, 'blue')}
      {mini(16, 16, 8, 'green')}
    </g>
  );
}

/** 6 and 9 look alike once the pip is rotated. */
function ambiguous(value: number | undefined): boolean {
  return value === 6 || value === 9;
}

function labelFor(card: Card, chosenColor?: CardColor | null): string {
  const c = card.color ?? chosenColor;
  const colorName = c ? `${c} ` : '';
  switch (card.kind) {
    case 'number':
      return `${colorName}${card.value}`;
    case 'skip':
      return `${colorName}skip`;
    case 'reverse':
      return `${colorName}reverse`;
    case 'draw2':
      return `${colorName}draw two`;
    case 'wild':
      return c ? `wild, ${c} chosen` : 'wild';
    case 'wild4':
      return c ? `wild draw four, ${c} chosen` : 'wild draw four';
  }
}
