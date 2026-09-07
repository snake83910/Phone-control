import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Badge, BadgeStatus, BarcodeType, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { BadgeHashService, maskBarcode } from '../crypto/badge-hash.service';
import { BadgeCipherService } from '../crypto/badge-cipher.service';
import { newId } from '../common/ids';
import { toBytes } from '../common/bytes';

export interface BadgeView {
  id: string;
  userId: string;
  maskedBarcode: string;
  barcodeLast4: string;
  barcodeType: BarcodeType;
  status: BadgeStatus;
  issuedAt: Date;
  revokedAt: Date | null;
  offlineCapable: boolean;
}

@Injectable()
export class BadgesService {
  private readonly logger = new Logger(BadgesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hash: BadgeHashService,
    private readonly cipher: BadgeCipherService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Enregistrement d'un badge existant.
   *
   * La valeur brute ne traverse cette méthode qu'en mémoire : elle est
   * normalisée, hachée, et — si le chiffrement est configuré — conservée
   * chiffrée pour permettre l'authentification hors ligne (voir
   * BadgeCipherService pour la justification de ce point).
   */
  async create(params: {
    companyId: string;
    userId: string;
    rawBarcode: string;
    barcodeType?: BarcodeType;
  }): Promise<BadgeView> {
    const user = await this.prisma.db.user.findFirst({
      where: { id: params.userId, deletedAt: null },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    const described = this.hash.describe(params.rawBarcode);
    this.assertExpectedFormat(described.normalized, described.last4, described.length);
    const barcodeHash = toBytes(described.hash);

    // L'index unique partiel (company_id, barcode_hash) WHERE status <> 'REVOKED'
    // garantit l'unicité en base ; cette vérification n'existe que pour rendre
    // le message d'erreur exploitable.
    const existing = await this.prisma.raw.badge.findFirst({
      where: {
        companyId: params.companyId,
        barcodeHash,
        status: { not: BadgeStatus.REVOKED },
      },
    });
    if (existing) {
      throw new ConflictException(
        `Ce numéro de badge (${maskBarcode(described.last4, described.length)}) est déjà actif dans cette entreprise.`,
      );
    }

    const ciphertext = this.cipher.encrypt(described.normalized);
    if (!ciphertext) {
      this.logger.warn(
        `Badge créé sans chiffrement réversible : l'authentification hors ligne ` +
          `sera indisponible pour ${maskBarcode(described.last4, described.length)}.`,
      );
    }

    const badge = await this.prisma.db.badge.create({
      data: {
        id: newId(),
        companyId: params.companyId,
        userId: params.userId,
        barcodeHash,
        hashVersion: described.hashVersion,
        barcodeLast4: described.last4,
        barcodeLength: described.length,
        barcodeCiphertext: ciphertext ? toBytes(ciphertext) : null,
        barcodeType: params.barcodeType ?? BarcodeType.CODE_128,
        status: BadgeStatus.ACTIVE,
      },
    });

    return toBadgeView(badge);
  }

  /**
   * Vérifie que le numéro saisi ressemble à un badge du parc.
   *
   * Sans ce contrôle, n'importe quelle suite de caractères devient un badge
   * valide : un copier-coller malheureux, une ligne de tableur, un mot de passe
   * collé dans le mauvais champ. Le badge est alors enregistré, ne scannera
   * jamais, et deviendra impossible à identifier — seuls les quatre derniers
   * caractères restent affichables.
   *
   * Le format est une **configuration**, pas une constante : il dépend du
   * fournisseur de badges du client (spécification §61). Vide, rien n'est
   * refusé, et le comportement est celui d'avant ce contrôle.
   *
   * Le message ne répète jamais la valeur saisie : elle n'a pas à se retrouver
   * dans un journal d'erreurs.
   */
  private assertExpectedFormat(normalized: string, last4: string, length: number): void {
    const pattern = this.config.get<string>('BADGE_FORMAT_PATTERN')?.trim();
    if (!pattern) return;

    let expected: RegExp;
    try {
      expected = new RegExp(pattern);
    } catch {
      // Une configuration fautive ne doit pas bloquer l'enregistrement des
      // badges : on journalise et on laisse passer, plutôt que d'immobiliser
      // l'exploitation sur une erreur de déploiement.
      this.logger.error(
        `BADGE_FORMAT_PATTERN n'est pas une expression régulière valide (${pattern}) : ` +
          'aucun contrôle de format ne sera appliqué.',
      );
      return;
    }

    if (!expected.test(normalized)) {
      // Le format attendu figure dans le message : ce n'est pas un secret, et
      // c'est ce qui permet de distinguer une faute de frappe de l'opérateur
      // d'une configuration `BADGE_FORMAT_PATTERN` erronée — laquelle refuserait
      // sinon tous les badges sans qu'on comprenne pourquoi.
      throw new BadRequestException(
        `Ce numéro (${maskBarcode(last4, length)}) ne correspond pas au format ` +
          `attendu des badges de ce parc (${pattern}). Vérifiez la saisie.`,
      );
    }
  }

  async findAll(params: { userId?: string; status?: BadgeStatus; take: number; skip: number }) {
    const where: Prisma.BadgeWhereInput = {
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.status ? { status: params.status } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.db.badge.findMany({
        where,
        take: params.take,
        skip: params.skip,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, firstName: true, lastName: true, status: true } },
        },
      }),
      this.prisma.db.badge.count({ where }),
    ]);

    return {
      items: items.map((b) => ({ ...toBadgeView(b), user: b.user })),
      total,
      take: params.take,
      skip: params.skip,
    };
  }

  async findOne(id: string): Promise<BadgeView> {
    const badge = await this.prisma.db.badge.findFirst({ where: { id } });
    if (!badge) throw new NotFoundException('Badge introuvable.');
    return toBadgeView(badge);
  }

  /**
   * Recherche par valeur, réservée au support.
   * On ne cherche jamais « par numéro » en base : on hache la valeur fournie et
   * on compare des empreintes.
   */
  async findByRawValue(rawBarcode: string): Promise<BadgeView | null> {
    const described = this.hash.describe(rawBarcode);
    const badge = await this.prisma.db.badge.findFirst({
      where: { barcodeHash: toBytes(described.hash) },
    });
    return badge ? toBadgeView(badge) : null;
  }

  async setStatus(
    id: string,
    status: BadgeStatus,
    reason?: string,
    adminId?: string,
  ): Promise<BadgeView> {
    const badge = await this.prisma.db.badge.findFirst({ where: { id } });
    if (!badge) throw new NotFoundException('Badge introuvable.');

    if (badge.status === BadgeStatus.REVOKED && status !== BadgeStatus.REVOKED) {
      throw new BadRequestException(
        'Un badge révoqué ne peut pas être réactivé : en créer un nouveau.',
      );
    }

    const updated = await this.prisma.db.badge.update({
      where: { id },
      data: {
        status,
        ...(status === BadgeStatus.REVOKED
          ? { revokedAt: new Date(), revokedBy: adminId ?? null, revokeReason: reason ?? null }
          : {}),
      },
    });

    return toBadgeView(updated);
  }

  /** Réaffectation d'un badge à un autre utilisateur (§38 de la spécification). */
  async reassign(id: string, userId: string): Promise<BadgeView> {
    const user = await this.prisma.db.user.findFirst({
      where: { id: userId, deletedAt: null },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    const updated = await this.prisma.db.badge.update({
      where: { id },
      data: { userId },
    });
    return toBadgeView(updated);
  }
}

function toBadgeView(badge: Badge): BadgeView {
  return {
    id: badge.id,
    userId: badge.userId,
    // Le numéro complet n'est jamais renvoyé par l'API (docs/07 §3.2).
    maskedBarcode: maskBarcode(badge.barcodeLast4, badge.barcodeLength),
    barcodeLast4: badge.barcodeLast4,
    barcodeType: badge.barcodeType,
    status: badge.status,
    issuedAt: badge.issuedAt,
    revokedAt: badge.revokedAt,
    offlineCapable: badge.barcodeCiphertext !== null,
  };
}
