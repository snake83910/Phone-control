import { NextRequest, NextResponse } from 'next/server';
import {
  buildPayload,
  payloadJson,
  maskToken,
  qrMatrix,
  recommendedPrintSizeMm,
  renderSvg,
  validatePayload,
} from '@phone-control/provisioning-payload';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  apiBaseUrl,
  refreshTokens,
  setAuthCookies,
  type TokenPair,
} from '@/lib/server/session';
import { loadProvisioningSetup } from '@/lib/server/provisioning';

/**
 * Émission des QR codes de provisioning depuis le dashboard.
 *
 * Ce gestionnaire est le pendant web de `pcprov batch` : il émet des jetons
 * d'enrôlement et fabrique les charges utiles. Il partage avec lui le paquet
 * `@phone-control/provisioning-payload`, donc exactement le même format et les
 * mêmes contrôles — deux constructions divergentes du même QR code ne se
 * verraient qu'au moment où un téléphone neuf refuse de se configurer.
 *
 * Deux précautions valent d'être dites.
 *
 * 1. **Le profil est vérifié avant tout appel qui écrit.** Un jeton est à usage
 *    unique : en émettre trente avec une empreinte de signature erronée revient
 *    à les jeter. La vérification utilise un jeton factice au format réel, donc
 *    elle traverse les mêmes contrôles que les vrais.
 *
 * 2. **Le jeton en clair ne revient jamais comme donnée JSON.** Il est encodé
 *    dans le SVG, ce qui est le but, et masqué partout ailleurs. Une capture
 *    d'écran de l'onglet réseau ne le laisse pas lire.
 */

/** Au-delà, la page devient illisible et l'émission trop longue. */
const MAX_DEVICES = 60;

const DUMMY_TOKEN = 'ETK-AAAAAAAA-AAAAAAAA';

interface DeviceRow {
  id: string;
  assetTag: string;
  kioskMode?: string;
  depot?: { id: string; name: string } | null;
}

interface EnrollmentTokenRow {
  id: string;
  token: string;
  expiresAt: string;
}

export interface ProvisioningLabel {
  deviceId: string;
  assetTag: string;
  depotName: string | null;
  kioskMode: string | null;
  expiresAt: string;
  maskedToken: string;
  /** QR code prêt à insérer dans la page. Le jeton y est encodé, non écrit. */
  svg: string;
  /** Taille de la charge utile, en octets : utile pour juger de la densité. */
  payloadBytes: number;
  /**
   * Côté minimal à l'impression, en millimètres, calculé depuis le nombre de
   * modules. Rien n'est figé dans la feuille de style : un QR plus dense exige
   * une étiquette plus grande, et c'est le serveur qui le sait.
   */
  printSizeMm: number;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const accessToken = request.cookies.get(ACCESS_COOKIE)?.value;
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;

  if (!accessToken && !refreshToken) {
    return NextResponse.json({ message: 'Session expirée.' }, { status: 401 });
  }

  let body: { deviceIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: 'Requête illisible.' }, { status: 400 });
  }

  const deviceIds = Array.isArray(body.deviceIds)
    ? body.deviceIds.filter((id): id is string => typeof id === 'string')
    : [];

  if (deviceIds.length === 0) {
    return NextResponse.json(
      { message: 'Aucun téléphone sélectionné.' },
      { status: 400 },
    );
  }

  if (deviceIds.length > MAX_DEVICES) {
    return NextResponse.json(
      {
        message:
          `${deviceIds.length} téléphones demandés : le maximum est de ${MAX_DEVICES}. ` +
          'Pour un parc entier, utilisez l’outil d’atelier, qui produit une planche PDF.',
      },
      { status: 400 },
    );
  }

  const configuration = loadProvisioningSetup();
  if (!configuration.ok) {
    return NextResponse.json(
      {
        message: 'Le provisioning n’est pas configuré sur ce dashboard.',
        problems: configuration.problems,
      },
      { status: 503 },
    );
  }

  const { profile, wifiPassword } = configuration.setup;

  // Contrôle à blanc : aucun jeton n'est émis si le profil est fautif.
  const dryRun = validatePayload(
    buildPayload(profile, { enrollmentToken: DUMMY_TOKEN, wifiPassword }),
    {
      packageName: profile.packageName,
      allowInsecureDownload: profile.allowInsecureDownload,
    },
  );

  if (dryRun.errors.length > 0) {
    return NextResponse.json(
      {
        message:
          'Le profil de provisioning est invalide : aucun jeton n’a été émis.',
        problems: dryRun.errors,
      },
      { status: 503 },
    );
  }

  const session = new UpstreamSession(accessToken, refreshToken);
  const labels: ProvisioningLabel[] = [];

  try {
    for (const deviceId of deviceIds) {
      const device = await session.json<DeviceRow>('GET', `/v1/devices/${deviceId}`);
      const issued = await session.json<EnrollmentTokenRow>(
        'POST',
        `/v1/devices/${device.id}/enrollment-token`,
      );

      const payload = buildPayload(profile, {
        enrollmentToken: issued.token,
        wifiPassword,
      });
      const json = payloadJson(payload);

      labels.push({
        deviceId: device.id,
        assetTag: device.assetTag,
        depotName: device.depot?.name ?? null,
        kioskMode: device.kioskMode ?? null,
        expiresAt: issued.expiresAt,
        maskedToken: maskToken(issued.token),
        svg: await renderSvg(json),
        payloadBytes: Buffer.byteLength(json, 'utf8'),
        printSizeMm: recommendedPrintSizeMm(qrMatrix(json)),
      });
    }
  } catch (error) {
    if (error instanceof UpstreamError) {
      // Des jetons ont pu être émis avant l'échec : le dire, sinon l'opérateur
      // relance et double la consommation sans le savoir.
      return NextResponse.json(
        {
          message: error.message,
          emitted: labels.length,
        },
        { status: error.status },
      );
    }
    throw error;
  }

  const response = NextResponse.json({ labels, warnings: dryRun.warnings });
  if (session.rotated) setAuthCookies(response, session.rotated);
  return response;
}

class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Appels à l'API avec rotation du jeton, comme le fait le proxy.
 *
 * Sans cela, une campagne lancée quinze minutes après la connexion échouerait
 * au milieu — en ayant déjà consommé des jetons d'enrôlement.
 */
class UpstreamSession {
  rotated: TokenPair | null = null;

  constructor(
    private accessToken: string | undefined,
    private readonly refreshToken: string | undefined,
  ) {}

  async json<T>(method: string, path: string): Promise<T> {
    let response = this.accessToken ? await this.call(method, path, this.accessToken) : null;

    if ((!response || response.status === 401) && this.refreshToken) {
      const rotated = await refreshTokens(this.refreshToken);
      if (!rotated) throw new UpstreamError(401, 'Session expirée.');
      this.rotated = rotated;
      this.accessToken = rotated.accessToken;
      response = await this.call(method, path, rotated.accessToken);
    }

    if (!response) throw new UpstreamError(401, 'Session expirée.');

    const payload = await response.text();
    if (!response.ok) {
      let detail = payload.slice(0, 300);
      try {
        const parsed = JSON.parse(payload) as { message?: string | string[] };
        if (Array.isArray(parsed.message)) detail = parsed.message.join(' ; ');
        else if (parsed.message) detail = parsed.message;
      } catch {
        // Réponse non JSON : on garde le texte brut, tronqué.
      }
      throw new UpstreamError(response.status, `${method} ${path} — ${detail}`);
    }

    return JSON.parse(payload) as T;
  }

  private call(method: string, path: string, token: string): Promise<Response> {
    return fetch(`${apiBaseUrl()}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      cache: 'no-store',
    });
  }
}
