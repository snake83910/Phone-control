import { NextRequest, NextResponse } from 'next/server';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  apiBaseUrl,
  refreshTokens,
  setAuthCookies,
} from '@/lib/server/session';

/**
 * Passerelle vers l'API.
 *
 * Le navigateur n'atteint jamais l'API directement : il appelle
 * `/api/proxy/v1/...`, et c'est ce gestionnaire qui ajoute le jeton lu dans le
 * cookie `httpOnly`.
 *
 * Il gère aussi la rotation : sur un 401, il tente un rafraîchissement puis
 * rejoue la requête UNE fois. Sans cela, chaque administrateur serait déconnecté
 * toutes les quinze minutes — et la tentation serait grande d'allonger la durée
 * de vie du jeton, ce qui reviendrait à affaiblir la sécurité pour du confort.
 */

/**
 * En-tetes qui appartiennent au saut reseau et non au message : un proxy les
 * traite, il ne les relaie pas.
 *
 * `expect` merite un mot. Un client qui envoie un corps volumineux annonce
 * souvent `Expect: 100-continue` pour demander l'accord du serveur avant de
 * transmettre. Relaye tel quel, il fait echouer la requete sortante avec un
 * « expect header not supported » qui ne dit rien de la cause. Le cas ne se
 * produit pas depuis un navigateur, mais se produit des qu'on depose un APK
 * avec curl -- c'est-a-dire au premier diagnostic.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'expect',
]);

async function handle(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await context.params;
  const search = request.nextUrl.search;
  const target = `${apiBaseUrl()}/${path.join('/')}${search}`;

  const accessToken = request.cookies.get(ACCESS_COOKIE)?.value;
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;

  if (!accessToken && !refreshToken) {
    return NextResponse.json(
      { statusCode: 401, message: 'Session expirée.' },
      { status: 401 },
    );
  }

  // Corps lu en binaire, jamais en texte.
  //
  // Un `request.text()` decode en UTF-8 : tout octet qui ne forme pas une
  // sequence valide est remplace par U+FFFD, silencieusement. Le JSON n'en
  // souffre pas ; un APK, si — il arriverait corrompu, et l'empreinte calculee
  // par le serveur ne correspondrait a rien de reconnaissable.
  //
  // Le corps est mis en memoire, et c'est assume : la rotation de jeton rejoue
  // la requete, ce qu'un flux ne permet pas — un flux ne se lit qu'une fois. Le
  // cout se limite au depot d'un APK, geste rare et fait par une personne. Si
  // des depots simultanes devenaient courants, il faudrait renoncer au rejeu
  // pour ces requetes-la plutot qu'a la lecture binaire.
  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await request.arrayBuffer();

  const forward = async (token: string): Promise<Response> => {
    const headers = new Headers();
    request.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase()) && key.toLowerCase() !== 'cookie') {
        headers.set(key, value);
      }
    });
    headers.set('authorization', `Bearer ${token}`);

    return fetch(target, {
      method: request.method,
      headers,
      body,
      cache: 'no-store',
    });
  };

  let upstream: Response | null = accessToken ? await forward(accessToken) : null;
  let rotated: Awaited<ReturnType<typeof refreshTokens>> = null;

  if ((!upstream || upstream.status === 401) && refreshToken) {
    rotated = await refreshTokens(refreshToken);
    if (!rotated) {
      const expired = NextResponse.json(
        { statusCode: 401, message: 'Session expirée.' },
        { status: 401 },
      );
      expired.cookies.delete(ACCESS_COOKIE);
      expired.cookies.delete(REFRESH_COOKIE);
      return expired;
    }
    upstream = await forward(rotated.accessToken);
  }

  if (!upstream) {
    return NextResponse.json(
      { statusCode: 401, message: 'Session expirée.' },
      { status: 401 },
    );
  }

  // Reponse relayee en binaire pour la meme raison. Un corps vide reste un
  // corps vide : `new NextResponse(new ArrayBuffer(0))` produit une reponse
  // 204 malformee sur certains statuts.
  const payload = await upstream.arrayBuffer();
  const response = new NextResponse(payload.byteLength > 0 ? payload : null, {
    status: upstream.status,
    headers: {
      'content-type':
        upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
    },
  });

  if (rotated) setAuthCookies(response, rotated);
  return response;
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
