import PDFDocument from 'pdfkit';
import { qrMatrix, type ErrorCorrectionLevel } from '@phone-control/provisioning-payload';

/**
 * Planche d'étiquettes à imprimer.
 *
 * Une étiquette par téléphone : le QR code de provisioning, l'étiquette
 * d'inventaire, le dépôt, et la date d'expiration du jeton. Elle se découpe et
 * se colle au dos du terminal le temps de la mise en service.
 *
 * Deux choix de fabrication méritent d'être dits :
 *
 * 1. **Le QR est dessiné en vectoriel**, module par module, et non collé comme
 *    une image. Une image PNG mise à l'échelle par l'imprimante perd ses bords ;
 *    des rectangles vectoriels restent nets à n'importe quelle résolution. Sur
 *    un code dense, c'est la différence entre un scan immédiat et cinq minutes
 *    d'énervement devant un téléphone neuf.
 *
 * 2. **Le jeton n'est jamais écrit en clair sur l'étiquette.** Il est dans le
 *    QR code, ce qui est inévitable, mais l'imprimer en toutes lettres à côté
 *    reviendrait à le laisser lisible par-dessus l'épaule de quiconque passe.
 *    Seuls quatre caractères apparaissent, pour rapprocher une étiquette d'une
 *    ligne du manifeste.
 */

export interface LabelData {
  assetTag: string;
  depotName?: string | null;
  kioskMode?: string | null;
  expiresAt: Date;
  /** Jeton masqué, tel que produit par maskToken(). */
  maskedToken: string;
  /** Contenu exact encodé dans le QR code. */
  payload: string;
}

export interface SheetOptions {
  pageSize?: 'A4' | 'LETTER';
  labelsPerPage?: number;
  errorCorrectionLevel?: ErrorCorrectionLevel;
  companyName?: string;
  generatedAt?: Date;
}

const MARGIN = 28;
const COLUMNS = 2;

const formatDate = (date: Date): string =>
  new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);

export function buildSheet(labels: LabelData[], options: SheetOptions = {}): Promise<Buffer> {
  const pageSize = options.pageSize ?? 'A4';
  const perPage = options.labelsPerPage ?? 6;
  const level = options.errorCorrectionLevel ?? 'M';
  const generatedAt = options.generatedAt ?? new Date();

  const document = new PDFDocument({ size: pageSize, margin: MARGIN, autoFirstPage: false });
  const chunks: Buffer[] = [];
  document.on('data', (chunk: Buffer) => chunks.push(chunk));

  const finished = new Promise<Buffer>((resolve, reject) => {
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
  });

  const rows = Math.max(1, Math.ceil(perPage / COLUMNS));
  const pages = Math.max(1, Math.ceil(labels.length / (COLUMNS * rows)));

  for (let page = 0; page < pages; page++) {
    document.addPage();

    const width = document.page.width;
    const height = document.page.height;
    const headerBottom = drawHeader(document, width, generatedAt, options.companyName);
    const footerTop = drawFooter(document, width, height, page + 1, pages);

    const gridTop = headerBottom + 12;
    const gridHeight = footerTop - 12 - gridTop;
    const cellWidth = (width - 2 * MARGIN) / COLUMNS;
    const cellHeight = gridHeight / rows;

    for (let slot = 0; slot < COLUMNS * rows; slot++) {
      const label = labels[page * COLUMNS * rows + slot];
      if (!label) break;

      const x = MARGIN + (slot % COLUMNS) * cellWidth;
      const y = gridTop + Math.floor(slot / COLUMNS) * cellHeight;
      drawLabel(document, label, x, y, cellWidth, cellHeight, level);
    }
  }

  document.end();
  return finished;
}

function drawHeader(
  document: PDFKit.PDFDocument,
  width: number,
  generatedAt: Date,
  companyName?: string,
): number {
  document
    .font('Helvetica-Bold')
    .fontSize(13)
    .fillColor('#111111')
    .text(
      companyName
        ? `Mise en service des téléphones — ${companyName}`
        : 'Mise en service des téléphones',
      MARGIN,
      MARGIN,
    );

  document
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#7a2020')
    .text(
      `Planche générée le ${formatDate(generatedAt)}. DOCUMENT CONFIDENTIEL : chaque QR code ` +
        "contient un jeton d'enrôlement à usage unique. Ne pas photocopier, ne pas diffuser, " +
        'détruire après la mise en service.',
      MARGIN,
      MARGIN + 18,
      { width: width - 2 * MARGIN },
    );

  return document.y;
}

function drawFooter(
  document: PDFKit.PDFDocument,
  width: number,
  height: number,
  page: number,
  pages: number,
): number {
  const top = height - MARGIN - 10;
  document
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#666666')
    .text(
      `Réinitialiser le téléphone, puis appuyer six fois sur l'écran de bienvenue ` +
        `pour ouvrir le lecteur de QR code.        Page ${page}/${pages}`,
      MARGIN,
      top,
      { width: width - 2 * MARGIN, align: 'left' },
    );
  return top;
}

function drawLabel(
  document: PDFKit.PDFDocument,
  label: LabelData,
  x: number,
  y: number,
  width: number,
  height: number,
  level: ErrorCorrectionLevel,
): void {
  const padding = 10;

  // Trait de découpe : pointillé clair, il guide les ciseaux sans salir la page.
  document
    .save()
    .lineWidth(0.5)
    .strokeColor('#bbbbbb')
    .dash(3, { space: 2 })
    .rect(x + 2, y + 2, width - 4, height - 4)
    .stroke()
    .undash()
    .restore();

  const matrix = qrMatrix(label.payload, level);
  const qrSide = Math.min(height - 2 * padding - 14, width * 0.46);
  const moduleSize = qrSide / matrix.size;
  const qrX = x + padding;
  const qrY = y + padding;

  document.save().fillColor('#000000');
  for (let row = 0; row < matrix.size; row++) {
    for (let column = 0; column < matrix.size; column++) {
      if (!matrix.isDark(column, row)) continue;
      // +0.02 : les modules se recouvrent d'un cheveu pour éviter les liserés
      // blancs que certaines imprimantes laissent entre deux rectangles jointifs.
      document.rect(
        qrX + column * moduleSize,
        qrY + row * moduleSize,
        moduleSize + 0.02,
        moduleSize + 0.02,
      );
    }
  }
  document.fill().restore();

  document
    .font('Helvetica')
    .fontSize(6)
    .fillColor('#999999')
    .text(`version ${matrix.version} · correction ${level}`, qrX, qrY + qrSide + 3, {
      width: qrSide,
      align: 'center',
    });

  const textX = qrX + qrSide + padding;
  const textWidth = width - (textX - x) - padding;
  let cursor = y + padding + 2;

  document
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor('#111111')
    .text(label.assetTag, textX, cursor, { width: textWidth });
  cursor = document.y + 4;

  const lines: Array<[string, string]> = [
    ['Dépôt', label.depotName ?? 'non affecté'],
    ['Mode', label.kioskMode ?? 'KIOSK'],
    ['Jeton valable jusqu’au', formatDate(label.expiresAt)],
    ['Jeton', label.maskedToken],
  ];

  for (const [name, value] of lines) {
    document
      .font('Helvetica')
      .fontSize(7)
      .fillColor('#888888')
      .text(name.toUpperCase(), textX, cursor, { width: textWidth });
    document
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#222222')
      .text(value, textX, document.y, { width: textWidth });
    cursor = document.y + 5;
  }
}
