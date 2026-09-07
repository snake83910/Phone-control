'use client';

import type { ReactNode } from 'react';

/**
 * Briques d'interface communes.
 *
 * Volontairement peu nombreuses et sans dépendance : une console
 * d'administration a besoin de badges d'état, de tableaux denses et de cartes.
 * Tout le reste serait de la décoration.
 */

type Tone = 'ok' | 'warn' | 'danger' | 'critical' | 'idle' | 'accent';

const TONE_STYLES: Record<Tone, { bg: string; fg: string }> = {
  ok: { bg: 'var(--color-ok-soft)', fg: 'var(--color-ok)' },
  warn: { bg: 'var(--color-warn-soft)', fg: 'var(--color-warn)' },
  danger: { bg: 'var(--color-danger-soft)', fg: 'var(--color-danger)' },
  critical: { bg: 'var(--color-critical-soft)', fg: 'var(--color-critical)' },
  idle: { bg: 'var(--color-idle-soft)', fg: 'var(--color-idle)' },
  accent: { bg: 'var(--color-accent-soft)', fg: 'var(--color-accent)' },
};

export function Badge({
  tone = 'idle',
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  const style = TONE_STYLES[tone];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap"
      style={{ background: style.bg, color: style.fg }}
    >
      {children}
    </span>
  );
}

export function severityTone(severity: string): Tone {
  switch (severity) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'danger';
    case 'MEDIUM':
      return 'warn';
    default:
      return 'idle';
  }
}

export function deviceStateTone(state: string): Tone {
  switch (state) {
    case 'ACTIVE':
      return 'ok';
    case 'RETURNED':
      return 'accent';
    case 'LOCKED':
      return 'idle';
    case 'LOCKING':
      return 'warn';
    default:
      return 'idle';
  }
}

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header
          className="flex items-center justify-between gap-3 px-5 py-3"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <h2 className="text-sm font-semibold">{title}</h2>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="card card-pad">
      <div className="label">{label}</div>
      <div
        className="mono mt-1 text-2xl font-semibold"
        style={tone ? { color: TONE_STYLES[tone].fg } : undefined}
      >
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-xs" style={{ color: 'var(--color-ink-muted)' }}>
          {hint}
        </div>
      )}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      className="px-5 py-10 text-center text-sm"
      style={{ color: 'var(--color-ink-faint)' }}
    >
      {children}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div
      className="m-4 rounded-lg px-4 py-3 text-sm"
      style={{
        background: 'var(--color-danger-soft)',
        color: 'var(--color-danger)',
        border: '1px solid var(--color-danger)',
      }}
      role="alert"
    >
      {message}
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-8 animate-pulse rounded"
          style={{ background: 'var(--color-surface-sunken)' }}
        />
      ))}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && (
          <p className="mt-1 text-sm" style={{ color: 'var(--color-ink-muted)' }}>
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

/** Barre de pagination : indispensable dès qu'une flotte dépasse un écran. */
export function Pagination({
  total,
  take,
  skip,
  onChange,
}: {
  total: number;
  take: number;
  skip: number;
  onChange: (skip: number) => void;
}) {
  if (total <= take) return null;
  const page = Math.floor(skip / take) + 1;
  const pages = Math.ceil(total / take);

  return (
    <div
      className="flex items-center justify-between px-5 py-3 text-sm"
      style={{ borderTop: '1px solid var(--color-border)' }}
    >
      <span style={{ color: 'var(--color-ink-muted)' }}>
        {skip + 1}–{Math.min(skip + take, total)} sur {total}
      </span>
      <div className="flex gap-2">
        <button
          className="btn btn-secondary"
          disabled={skip === 0}
          onClick={() => onChange(Math.max(0, skip - take))}
        >
          Précédent
        </button>
        <span className="self-center text-xs" style={{ color: 'var(--color-ink-faint)' }}>
          {page} / {pages}
        </span>
        <button
          className="btn btn-secondary"
          disabled={skip + take >= total}
          onClick={() => onChange(skip + take)}
        >
          Suivant
        </button>
      </div>
    </div>
  );
}
