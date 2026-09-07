import QRCode from 'qrcode';
import { ProvisioningError } from './errors';

/**
 * Rendu des QR codes.
 *
 * Deux sorties, deux usages : une image PNG par téléphone, pour l'archivage et
 * l'affichage à l'écran, et une matrice de modules brute pour la planche PDF —
 * dessiner les carrés en vectoriel donne des bords nets à l'impression, là où
 * un PNG agrandi devient flou. Or c'est précisément l'impression qui doit être
 * lisible : un QR code de provisioning se scanne une fois, sur un téléphone
 * neuf, souvent en lumière médiocre.
 */

export type ErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

/**
 * Marge silencieuse, en modules.
 *
 * La norme QR en exige **quatre** de chaque côté. Moins, et le décodeur peine à
 * délimiter le code quand il jouxte un cadre ou un bord de page — exactement la
 * situation d'une étiquette collée au dos d'un téléphone. Le gain de place
 * qu'offre une marge plus étroite ne vaut pas ce risque-là.
 */
const QUIET_ZONE_MODULES = 4;

export interface QrMatrix {
  size: number;
  version: number;
  /** Vrai si le module (x, y) est sombre. */
  isDark(x: number, y: number): boolean;
}

function wrap(error: unknown, bytes: number): ProvisioningError {
  return new ProvisioningError(
    `Impossible d'encoder le QR code (${bytes} octets) : ${(error as Error).message}`,
    "Raccourcissez l'URL de téléchargement, ou retirez la configuration Wi-Fi du QR " +
      "et connectez le téléphone au réseau à la main.",
  );
}

export function qrMatrix(text: string, level: ErrorCorrectionLevel = 'M'): QrMatrix {
  try {
    const code = QRCode.create(text, { errorCorrectionLevel: level });
    const size = code.modules.size;
    const data = code.modules.data;

    return {
      size,
      version: code.version,
      isDark: (x, y) => data[y * size + x] === 1,
    };
  } catch (error) {
    throw wrap(error, Buffer.byteLength(text, 'utf8'));
  }
}

export async function renderPng(
  text: string,
  level: ErrorCorrectionLevel = 'M',
  scale = 8,
): Promise<Buffer> {
  try {
    return await QRCode.toBuffer(text, {
      errorCorrectionLevel: level,
      type: 'png',
      scale,
      margin: QUIET_ZONE_MODULES,
    });
  } catch (error) {
    throw wrap(error, Buffer.byteLength(text, 'utf8'));
  }
}

export async function renderSvg(
  text: string,
  level: ErrorCorrectionLevel = 'M',
): Promise<string> {
  try {
    return await QRCode.toString(text, {
      errorCorrectionLevel: level,
      type: 'svg',
      margin: QUIET_ZONE_MODULES,
    });
  } catch (error) {
    throw wrap(error, Buffer.byteLength(text, 'utf8'));
  }
}

/**
 * Côté minimal recommandé à l'impression, en millimètres.
 *
 * Règle d'usage des lecteurs de QR : un module doit mesurer au moins 0,4 mm
 * pour rester lisible par une caméra de téléphone à 15-20 cm. On arrondit au
 * demi-centimètre supérieur, et jamais en dessous de 30 mm.
 */
export function recommendedPrintSizeMm(matrix: QrMatrix): number {
  const quietZone = QUIET_ZONE_MODULES * 2;
  const millimeters = (matrix.size + quietZone) * 0.4;
  return Math.max(30, Math.ceil(millimeters / 5) * 5);
}
