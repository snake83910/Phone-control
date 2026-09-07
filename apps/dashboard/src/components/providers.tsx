'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RealtimeProvider } from '@/lib/realtime';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Le temps reel invalide deja les vues concernees : reinterroger
            // au moindre changement d'onglet ne ferait qu'ajouter du bruit.
            refetchOnWindowFocus: false,
            staleTime: 15_000,
            retry: (failureCount, error) => {
              const status = (error as { status?: number }).status;
              // Inutile de reessayer une session expiree ou un acces refuse.
              if (status === 401 || status === 403 || status === 404) return false;
              return failureCount < 2;
            },
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <RealtimeProvider>{children}</RealtimeProvider>
    </QueryClientProvider>
  );
}
