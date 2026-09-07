import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * Détention des jetons côté serveur Next.
 *
 * Les jetons ne sont JAMAIS remis au navigateur : ils vivent dans des cookies
 * `httpOnly`, que le JavaScript de la page ne peut pas lire. Une faille XSS sur
 * le dashboard ne permet donc pas d'exfiltrer une session administrateur — elle
 * permettrait au mieux d'agir dans l'onglet ouvert, ce qui est déjà grave, mais
 * sans vol de jeton réutilisable ailleurs.
 *
 * C'est la raison d'être du proxy : le navigateur appelle `/api/proxy/...`,
 * jamais l'API directement.
 */

export const ACCESS_COOKIE = 'pc_at';
export const REFRESH_COOKIE = 'pc_rt';

const isProduction = process.env.NODE_ENV === 'production';

export function apiBaseUrl(): string {
  return process.env.API_INTERNAL_URL ?? 'http://localhost:3001/api';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export function setAuthCookies(response: NextResponse, tokens: TokenPair): void {
  const common = {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax' as const,
    path: '/',
  };

  response.cookies.set(ACCESS_COOKIE, tokens.accessToken, {
    ...common,
    maxAge: tokens.expiresIn,
  });
  response.cookies.set(REFRESH_COOKIE, tokens.refreshToken, {
    ...common,
    maxAge: 7 * 24 * 3600,
  });
}

export function clearAuthCookies(response: NextResponse): void {
  response.cookies.delete(ACCESS_COOKIE);
  response.cookies.delete(REFRESH_COOKIE);
}

export async function readTokens(): Promise<{
  accessToken?: string;
  refreshToken?: string;
}> {
  const jar = await cookies();
  return {
    accessToken: jar.get(ACCESS_COOKIE)?.value,
    refreshToken: jar.get(REFRESH_COOKIE)?.value,
  };
}

/** Rafraîchit la paire de jetons auprès de l'API. */
export async function refreshTokens(
  refreshToken: string,
): Promise<TokenPair | null> {
  const response = await fetch(`${apiBaseUrl()}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    cache: 'no-store',
  });

  if (!response.ok) return null;

  const body = (await response.json()) as TokenPair;
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    expiresIn: body.expiresIn,
  };
}

/**
 * Appel authentifié depuis un composant serveur.
 * Ne rafraîchit pas : un composant serveur ne peut pas poser de cookie pendant
 * son rendu. En cas de 401, la page redirige vers la connexion, et c'est le
 * proxy — qui, lui, peut écrire des cookies — qui gère la rotation.
 */
export async function serverFetch<T>(path: string): Promise<T | null> {
  const { accessToken } = await readTokens();
  if (!accessToken) return null;

  const response = await fetch(`${apiBaseUrl()}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });

  if (!response.ok) return null;
  return (await response.json()) as T;
}
