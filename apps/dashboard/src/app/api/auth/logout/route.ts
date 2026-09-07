import { NextRequest, NextResponse } from 'next/server';
import {
  REFRESH_COOKIE,
  apiBaseUrl,
  clearAuthCookies,
} from '@/lib/server/session';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;

  if (refreshToken) {
    // Revocation cote serveur : effacer le cookie ne suffirait pas, le jeton
    // resterait valide s'il avait ete copie.
    await fetch(`${apiBaseUrl()}/v1/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    }).catch(() => undefined);
  }

  const response = NextResponse.json({ ok: true });
  clearAuthCookies(response);
  return response;
}
