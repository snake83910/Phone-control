import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE } from '@/lib/server/session';

/**
 * Jeton pour la poignee de main WebSocket.
 *
 * Socket.IO ne peut pas lire un cookie httpOnly cote navigateur : le client a
 * besoin de la valeur du jeton pour l'envoyer dans le handshake. On la lui
 * fournit ici, et elle reste en memoire dans l'onglet, sans jamais etre ecrite
 * dans localStorage. La duree de vie courte du jeton d'acces (15 minutes) borne
 * la portee de cette exposition.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ message: 'Non authentifie.' }, { status: 401 });
  }
  return NextResponse.json({ token });
}
