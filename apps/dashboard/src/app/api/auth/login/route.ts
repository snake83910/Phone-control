import { NextRequest, NextResponse } from 'next/server';
import { apiBaseUrl, setAuthCookies } from '@/lib/server/session';

/**
 * Connexion.
 *
 * Le formulaire n'appelle jamais l'API directement : il passe par ici, et
 * repart avec des cookies `httpOnly` plutôt qu'avec des jetons. Le navigateur
 * ne détient donc aucun secret réutilisable.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const credentials = (await request.json()) as {
    email?: string;
    password?: string;
  };

  const upstream = await fetch(`${apiBaseUrl()}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
    cache: 'no-store',
  });

  const payload = await upstream.json().catch(() => ({}));

  if (!upstream.ok) {
    // Le message de l'API est déjà volontairement générique : le reprendre tel
    // quel évite d'introduire ici une distinction qu'elle refuse de faire.
    return NextResponse.json(
      { message: payload?.message ?? 'Identifiants invalides.' },
      { status: upstream.status },
    );
  }

  const response = NextResponse.json({ admin: payload.admin });
  setAuthCookies(response, payload);
  return response;
}
