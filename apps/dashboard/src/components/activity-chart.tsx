'use client';

import { useId, useState } from 'react';
import type { ActivityPoint } from '@/lib/api';

/**
 * Activité des sept derniers jours.
 *
 * **Petits multiples, et non un graphique à deux axes.** Les sessions se
 * comptent en dizaines, les alertes en unités : superposer les deux sur une
 * seule échelle écraserait les alertes, et leur donner un second axe laisserait
 * croire à des croisements qui n'existent pas. Deux mini-graphiques, chacun avec
 * son échelle, disent la vérité sans effort d'interprétation.
 *
 * Chaque graphique ne porte qu'une série : son titre l'identifie, aucune légende
 * n'est nécessaire. Une vue tableau reste accessible pour les lecteurs d'écran
 * et pour l'impression.
 */

const SERIES = {
  sessions: {
    label: 'Sessions ouvertes',
    light: '#2a78d6',
    dark: '#3987e5',
  },
  alerts: {
    label: 'Alertes émises',
    light: '#eb6834',
    dark: '#d95926',
  },
} as const;

type SeriesKey = keyof typeof SERIES;

const WIDTH = 320;
const HEIGHT = 72;
const BASELINE = HEIGHT - 18;
const TOP = 10;
/** Écart de 2 px entre les barres, exprimé dans le repère du viewBox. */
const GAP = 2;

function dayLabel(iso: string): string {
  const date = new Date(`${iso}T12:00:00Z`);
  return new Intl.DateTimeFormat('fr-FR', {
    weekday: 'short',
    day: '2-digit',
  }).format(date);
}

/** Barre à extrémité arrondie, ancrée sur la ligne de base. */
function barPath(x: number, y: number, width: number, radius = 4): string {
  const r = Math.min(radius, width / 2, BASELINE - y);
  return [
    `M ${x} ${BASELINE}`,
    `L ${x} ${y + r}`,
    `Q ${x} ${y} ${x + r} ${y}`,
    `L ${x + width - r} ${y}`,
    `Q ${x + width} ${y} ${x + width} ${y + r}`,
    `L ${x + width} ${BASELINE}`,
    'Z',
  ].join(' ');
}

function MiniChart({
  points,
  seriesKey,
}: {
  points: ActivityPoint[];
  seriesKey: SeriesKey;
}) {
  const series = SERIES[seriesKey];
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const values = points.map((p) => p[seriesKey]);
  const max = Math.max(1, ...values);
  const slot = WIDTH / points.length;
  const barWidth = Math.max(6, slot - GAP);

  const peakIndex = values.indexOf(max);

  return (
    <figure className="m-0">
      <figcaption className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-medium">{series.label}</span>
        <span className="mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>
          {values.reduce((a, b) => a + b, 0)} sur 7 jours
        </span>
      </figcaption>

      <div className="relative">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full"
          style={{ height: 'auto' }}
          role="img"
          aria-label={`${series.label} par jour sur les sept derniers jours`}
        >
          <defs>
            {/* La couleur est portée par une variable CSS pour que le mode
                sombre applique son propre pas, et non un éclaircissement
                automatique de la teinte claire. */}
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={`var(--chart-${seriesKey})`} />
              <stop offset="100%" stopColor={`var(--chart-${seriesKey})`} />
            </linearGradient>
          </defs>

          {/* Ligne de base discrète : elle situe les barres sans concurrencer
              les données. */}
          <line
            x1="0"
            y1={BASELINE}
            x2={WIDTH}
            y2={BASELINE}
            stroke="var(--color-border)"
            strokeWidth="1"
          />

          {points.map((point, index) => {
            const value = point[seriesKey];
            const height =
              value === 0 ? 0 : ((BASELINE - TOP) * value) / max;
            const x = index * slot + GAP / 2;
            const y = BASELINE - height;
            const isHovered = hover === index;

            return (
              <g key={point.day}>
                {value > 0 && (
                  <path
                    d={barPath(x, y, barWidth)}
                    fill={`url(#${gradientId})`}
                    opacity={hover === null || isHovered ? 1 : 0.45}
                  />
                )}

                {/* Cible de survol plus large que la barre : pointer une barre
                    de 6 px de large serait un exercice d'adresse. */}
                <rect
                  x={index * slot}
                  y={0}
                  width={slot}
                  height={HEIGHT}
                  fill="transparent"
                  onMouseEnter={() => setHover(index)}
                  onMouseLeave={() => setHover(null)}
                />

                <text
                  x={x + barWidth / 2}
                  y={HEIGHT - 4}
                  textAnchor="middle"
                  fontSize="8"
                  fill="var(--color-ink-faint)"
                >
                  {dayLabel(point.day).replace('.', '')}
                </text>

                {/* Étiquette directe sur le pic uniquement : une valeur sur
                    chaque barre ferait un tableau déguisé. */}
                {index === peakIndex && value > 0 && (
                  <text
                    x={x + barWidth / 2}
                    y={y - 3}
                    textAnchor="middle"
                    fontSize="9"
                    fontWeight="600"
                    fill="var(--color-ink-muted)"
                  >
                    {value}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {hover !== null && (
          <div
            className="pointer-events-none absolute -top-1 rounded-md px-2 py-1 text-xs shadow-sm"
            style={{
              left: `${((hover + 0.5) / points.length) * 100}%`,
              transform: 'translateX(-50%)',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border-strong)',
              color: 'var(--color-ink)',
              whiteSpace: 'nowrap',
            }}
            role="status"
          >
            <span style={{ color: 'var(--color-ink-muted)' }}>
              {dayLabel(points[hover].day)}
            </span>{' '}
            <span className="mono font-semibold">{points[hover][seriesKey]}</span>
          </div>
        )}
      </div>
    </figure>
  );
}

export function ActivityChart({ points }: { points: ActivityPoint[] }) {
  const [showTable, setShowTable] = useState(false);

  if (points.length === 0) {
    return (
      <p className="px-5 py-8 text-center text-sm" style={{ color: 'var(--color-ink-faint)' }}>
        Aucune activité sur la période.
      </p>
    );
  }

  return (
    <div
      className="p-5"
      style={
        {
          '--chart-sessions': SERIES.sessions.light,
          '--chart-alerts': SERIES.alerts.light,
        } as React.CSSProperties
      }
    >
      <style>{`
        @media (prefers-color-scheme: dark) {
          .activity-chart {
            --chart-sessions: ${SERIES.sessions.dark};
            --chart-alerts: ${SERIES.alerts.dark};
          }
        }
      `}</style>

      <div className="activity-chart grid gap-6 sm:grid-cols-2">
        <MiniChart points={points} seriesKey="sessions" />
        <MiniChart points={points} seriesKey="alerts" />
      </div>

      <button
        className="mt-4 text-xs underline"
        style={{ color: 'var(--color-ink-faint)' }}
        onClick={() => setShowTable((v) => !v)}
        aria-expanded={showTable}
      >
        {showTable ? 'Masquer les valeurs' : 'Afficher les valeurs'}
      </button>

      {showTable && (
        <table className="table mt-3">
          <caption className="sr-only">
            Sessions et alertes par jour sur les sept derniers jours
          </caption>
          <thead>
            <tr>
              <th scope="col">Jour</th>
              <th scope="col">Sessions</th>
              <th scope="col">Alertes</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.day}>
                <th scope="row" className="font-normal">
                  {dayLabel(point.day)}
                </th>
                <td className="mono">{point.sessions}</td>
                <td className="mono">{point.alerts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
