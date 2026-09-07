import { redirect } from 'next/navigation';
import { serverFetch } from '@/lib/server/session';
import { Providers } from '@/components/providers';
import { Shell } from '@/components/shell';
import type { AdminProfile } from '@/lib/api';

/**
 * Coquille authentifiée.
 *
 * Le profil est chargé côté serveur : la navigation ne s'affiche jamais avant
 * que l'identité et le rôle soient connus. Sans cela, un administrateur en
 * lecture seule verrait apparaître puis disparaître des actions qui lui sont
 * refusées — au mieux déroutant, au pire trompeur.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await serverFetch<AdminProfile>('/v1/auth/me');

  if (!admin) {
    redirect('/login');
  }

  return (
    <Providers>
      <Shell admin={admin}>{children}</Shell>
    </Providers>
  );
}
