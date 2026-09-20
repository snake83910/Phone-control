'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

/**
 * Ce qui a amené le manager sur cet écran.
 *
 * Le cas `sso` mérite son propre message : un compte venu de Trajelys n'a pas
 * de mot de passe utilisable ici. Lui dire « reconnectez-vous » au-dessus d'un
 * formulaire de mot de passe l'enverrait essayer indéfiniment quelque chose
 * qui ne peut pas marcher. Le chemin de retour est Trajelys, et c'est ce
 * qu'il faut écrire.
 */
function motifArrivee(params: URLSearchParams): string | null {
  if (params.get('expired')) return 'Votre session a expiré. Reconnectez-vous.';
  if (params.get('sso')) {
    return (
      'Le lien d’ouverture depuis Trajelys n’est plus valable — il ne sert ' +
      'qu’une fois et moins d’une minute. Repartez de Trajelys, onglet ' +
      '« Téléphones ».'
    );
  }
  return null;
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(motifArrivee(params));
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.message ?? 'Identifiants invalides.');
        return;
      }

      router.replace('/dashboard');
      router.refresh();
    } catch {
      setError('Serveur injoignable. Vérifiez que l’API est démarrée.');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div
            className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl text-lg font-semibold"
            style={{ background: 'var(--color-accent)', color: '#fff' }}
            aria-hidden
          >
            PC
          </div>
          <h1 className="text-lg font-semibold">Phone Control</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--color-ink-muted)' }}>
            Console d’administration de la flotte
          </p>
        </div>

        <form onSubmit={submit} className="card card-pad space-y-4">
          <div>
            <label className="label" htmlFor="email">
              Adresse e-mail
            </label>
            <input
              id="email"
              type="email"
              className="field mt-1"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div>
            <label className="label" htmlFor="password">
              Mot de passe
            </label>
            <input
              id="password"
              type="password"
              className="field mt-1"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <p
              className="rounded-lg px-3 py-2 text-sm"
              style={{
                background: 'var(--color-danger-soft)',
                color: 'var(--color-danger)',
              }}
              role="alert"
            >
              {error}
            </p>
          )}

          <button type="submit" className="btn btn-primary w-full" disabled={pending}>
            {pending ? 'Connexion…' : 'Se connecter'}
          </button>
        </form>

        <p
          className="mt-6 text-center text-xs"
          style={{ color: 'var(--color-ink-faint)' }}
        >
          Après cinq tentatives infructueuses, le compte est temporairement
          verrouillé.
        </p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
