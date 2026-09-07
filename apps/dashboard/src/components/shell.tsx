'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useRealtime } from '@/lib/realtime';
import { roleLabel } from '@/lib/format';
import type { AdminProfile } from '@/lib/api';
import { Badge, severityTone } from './ui';

interface NavItem {
  href: string;
  label: string;
  roles?: AdminProfile['role'][];
}

const NAV: Array<{ section: string; items: NavItem[] }> = [
  {
    section: 'Exploitation',
    items: [
      { href: '/dashboard', label: 'Vue d’ensemble' },
      { href: '/locations', label: 'Carte' },
      { href: '/alerts', label: 'Alertes' },
      { href: '/sessions', label: 'Sessions' },
    ],
  },
  {
    section: 'Flotte',
    items: [
      { href: '/devices', label: 'Téléphones' },
      {
        href: '/devices/provisioning',
        label: 'Mise en service',
        roles: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'DEPOT_ADMIN'],
      },
      {
        href: '/devices/apps',
        label: 'Applications',
        roles: ['SUPER_ADMIN', 'COMPANY_ADMIN'],
      },
      { href: '/depots', label: 'Dépôts' },
    ],
  },
  {
    section: 'Personnel',
    items: [
      { href: '/users', label: 'Chauffeurs' },
      { href: '/badges', label: 'Badges' },
    ],
  },
  {
    section: 'Traçabilité',
    items: [
      { href: '/security', label: 'Sécurité' },
      { href: '/audit-logs', label: 'Journal d’audit' },
      {
        href: '/settings',
        label: 'Paramètres',
        roles: ['SUPER_ADMIN', 'COMPANY_ADMIN'],
      },
    ],
  },
];

export function Shell({
  admin,
  children,
}: {
  admin: AdminProfile;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { connected, liveAlerts, dismiss } = useRealtime();
  const [menuOpen, setMenuOpen] = useState(false);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }

  return (
    <div className="flex min-h-screen">
      <aside
        className={`${menuOpen ? 'block' : 'hidden'} w-60 shrink-0 md:block`}
        style={{
          background: 'var(--color-surface)',
          borderRight: '1px solid var(--color-border)',
        }}
      >
        <div
          className="flex items-center gap-2 px-5 py-4"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <div
            className="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-semibold"
            style={{ background: 'var(--color-accent)', color: '#fff' }}
            aria-hidden
          >
            PC
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Phone Control</div>
            <div
              className="flex items-center gap-1.5 text-xs"
              style={{ color: 'var(--color-ink-faint)' }}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{
                  background: connected
                    ? 'var(--color-ok)'
                    : 'var(--color-ink-faint)',
                }}
                aria-hidden
              />
              {/* L'état du flux est affiché en clair : un dashboard qui ne
                  reçoit plus rien doit le dire, pas laisser croire au calme. */}
              {connected ? 'Temps réel actif' : 'Temps réel interrompu'}
            </div>
          </div>
        </div>

        <nav className="p-3">
          {NAV.map((group) => {
            const items = group.items.filter(
              (item) => !item.roles || item.roles.includes(admin.role),
            );
            if (items.length === 0) return null;

            return (
              <div key={group.section} className="mb-4">
                <div className="label px-2 pb-1">{group.section}</div>
                {items.map((item) => {
                  const active = pathname.startsWith(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setMenuOpen(false)}
                      className="block rounded-lg px-2 py-1.5 text-sm"
                      style={{
                        background: active ? 'var(--color-accent-soft)' : undefined,
                        color: active ? 'var(--color-accent)' : 'var(--color-ink)',
                        fontWeight: active ? 600 : 400,
                      }}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex items-center justify-between gap-3 px-5 py-3"
          style={{
            background: 'var(--color-surface)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <button
            className="btn btn-secondary md:hidden"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Menu"
          >
            ☰
          </button>

          <div className="min-w-0 flex-1" />

          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="truncate text-sm font-medium">{admin.email}</div>
              <div className="text-xs" style={{ color: 'var(--color-ink-faint)' }}>
                {roleLabel(admin.role)}
              </div>
            </div>
            <button className="btn btn-secondary" onClick={logout}>
              Déconnexion
            </button>
          </div>
        </header>

        {liveAlerts.length > 0 && (
          <div className="space-y-2 px-5 pt-4">
            {liveAlerts.slice(0, 3).map((alert) => (
              <div
                key={alert.id}
                className="flex items-start justify-between gap-3 rounded-lg px-4 py-3"
                style={{
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-border-strong)',
                }}
                role="status"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge tone={severityTone(alert.severity)}>{alert.severity}</Badge>
                    <span className="text-sm font-semibold">{alert.title}</span>
                  </div>
                  <p
                    className="mt-1 text-sm"
                    style={{ color: 'var(--color-ink-muted)' }}
                  >
                    {alert.message}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Link href="/alerts" className="btn btn-secondary">
                    Ouvrir
                  </Link>
                  <button
                    className="btn btn-secondary"
                    onClick={() => dismiss(alert.id)}
                    aria-label="Masquer"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <main className="flex-1 p-5">{children}</main>
      </div>
    </div>
  );
}
