import { NextRequest, NextResponse } from 'next/server';
import { apiBaseUrl, setAuthCookies } from '@/lib/server/session';

/**
 * Atterrissage du passage depuis Trajelys.
 *
 * ── Pourquoi cette page existe ──────────────────────────────────────────
 * Trajelys vit sur `www.<domaine>`, ce tableau de bord sur `admin.<domaine>`.
 * Le navigateur interdit à l'un de poser la session de l'autre : des jetons
 * obtenus côté Trajelys y resteraient enfermés. Trajelys obtient donc un code
 * à usage unique, redirige le navigateur ici, et c'est ICI — sur notre propre
 * origine, où nous avons le droit d'écrire des cookies — que le code devient
 * une session.
 *
 * ── Un gestionnaire de route, pas une page ──────────────────────────────
 * Un composant serveur ne peut pas poser de cookie pendant son rendu. Et le
 * code ne doit jamais atteindre le JavaScript de la page : il n'a rien à y
 * faire, et l'y faire passer l'exposerait à une faille XSS pour rien.
 *
 * ── L'en-tête `Location` est RELATIF, et ce n'est pas un détail ─────────
 * `NextResponse.redirect` exige une URL absolue, que Next reconstruit à
 * partir de l'en-tête `Host` en supposant le protocole. Derrière Caddy, cette
 * supposition donne `http://` : le navigateur repartirait en clair, les
 * cookies `secure` qu'on vient de poser ne seraient PAS envoyés sur ce
 * saut, et le manager atterrirait sur l'écran de connexion sans comprendre
 * pourquoi. Un `Location` relatif ne pose aucune de ces questions.
 */
function versRelatif(chemin: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location: chemin } });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get('code');

  if (!code) {
    return versRelatif('/login?sso=absent');
  }

  let payload: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  } | null = null;

  try {
    const upstream = await fetch(`${apiBaseUrl()}/v1/auth/trajelys/echange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
      cache: 'no-store',
    });
    if (upstream.ok) {
      payload = await upstream.json();
    }
  } catch {
    // Volontairement confondu avec un refus : l'écran de connexion dit quoi
    // faire (repartir de Trajelys), ce qui est la bonne conduite dans les
    // deux cas.
    payload = null;
  }

  if (!payload?.accessToken) {
    // Un seul motif pour les trois refus possibles — code inconnu, expiré,
    // déjà consommé. Les distinguer apprendrait à qui essaie si sa valeur a
    // existé.
    return versRelatif('/login?sso=refuse');
  }

  const reponse = versRelatif('/dashboard');
  setAuthCookies(reponse, payload);
  return reponse;
}
