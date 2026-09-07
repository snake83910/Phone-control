import { Injectable, NotFoundException } from '@nestjs/common';
import { BadgeStatus, Prisma, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { maskBarcode } from '../crypto/badge-hash.service';
import { newId } from '../common/ids';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: {
    companyId: string;
    firstName: string;
    lastName: string;
    depotId?: string | null;
    employeeNumber?: string | null;
    phone?: string | null;
    email?: string | null;
  }) {
    // La clé étrangère ne contraint que l'existence du dépôt, pas son
    // appartenance : sans cette vérification, un administrateur pourrait
    // rattacher un chauffeur au dépôt d'une autre entreprise. Le client `db`
    // applique le filtre d'entreprise, donc un dépôt étranger est introuvable.
    if (params.depotId) {
      const depot = await this.prisma.db.depot.findFirst({
        where: { id: params.depotId, deletedAt: null },
      });
      if (!depot) throw new NotFoundException('Dépôt introuvable.');
    }

    return this.prisma.db.user.create({
      data: {
        id: newId(),
        companyId: params.companyId,
        firstName: params.firstName,
        lastName: params.lastName,
        depotId: params.depotId ?? null,
        employeeNumber: params.employeeNumber ?? null,
        phone: params.phone ?? null,
        email: params.email ?? null,
      },
    });
  }

  async findAll(params: {
    status?: UserStatus;
    depotId?: string;
    search?: string;
    take: number;
    skip: number;
  }) {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(params.status ? { status: params.status } : {}),
      ...(params.depotId ? { depotId: params.depotId } : {}),
      ...(params.search
        ? {
            OR: [
              { firstName: { contains: params.search, mode: 'insensitive' } },
              { lastName: { contains: params.search, mode: 'insensitive' } },
              { employeeNumber: { contains: params.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.db.user.findMany({
        where,
        take: params.take,
        skip: params.skip,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        include: {
          depot: { select: { id: true, name: true } },
          badges: { where: { status: BadgeStatus.ACTIVE }, take: 1 },
        },
      }),
      this.prisma.db.user.count({ where }),
    ]);

    return {
      items: items.map((u) => ({
        id: u.id,
        firstName: u.firstName,
        lastName: u.lastName,
        employeeNumber: u.employeeNumber,
        status: u.status,
        depot: u.depot,
        badge: u.badges[0]
          ? {
              id: u.badges[0].id,
              maskedBarcode: maskBarcode(
                u.badges[0].barcodeLast4,
                u.badges[0].barcodeLength,
              ),
            }
          : null,
      })),
      total,
      take: params.take,
      skip: params.skip,
    };
  }

  /** Fiche complète : badges masqués, téléphones autorisés, dernière connexion. */
  async findOne(id: string) {
    const user = await this.prisma.db.user.findFirst({
      where: { id, deletedAt: null },
      include: {
        depot: { select: { id: true, name: true } },
        badges: true,
        assignments: {
          where: { revokedAt: null },
          include: { device: { select: { id: true, assetTag: true, state: true } } },
        },
        sessions: {
          orderBy: { startedAt: 'desc' },
          take: 1,
          include: { device: { select: { id: true, assetTag: true } } },
        },
      },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      employeeNumber: user.employeeNumber,
      phone: user.phone,
      email: user.email,
      status: user.status,
      depot: user.depot,
      badges: user.badges.map((b) => ({
        id: b.id,
        maskedBarcode: maskBarcode(b.barcodeLast4, b.barcodeLength),
        barcodeType: b.barcodeType,
        status: b.status,
        issuedAt: b.issuedAt,
        revokedAt: b.revokedAt,
      })),
      authorizedDevices: user.assignments.map((a) => a.device),
      lastSession: user.sessions[0]
        ? {
            id: user.sessions[0].id,
            startedAt: user.sessions[0].startedAt,
            endedAt: user.sessions[0].endedAt,
            status: user.sessions[0].status,
            device: user.sessions[0].device,
          }
        : null,
    };
  }

  async setStatus(id: string, status: UserStatus) {
    return this.prisma.db.user.update({ where: { id }, data: { status } });
  }

  /** Affecte un téléphone à un chauffeur (§10 de la spécification). */
  async assignDevice(companyId: string, userId: string, deviceId: string, adminId: string) {
    const [user, device] = await Promise.all([
      this.prisma.db.user.findFirst({ where: { id: userId, deletedAt: null } }),
      this.prisma.db.device.findFirst({ where: { id: deviceId, deletedAt: null } }),
    ]);
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    if (!device) throw new NotFoundException('Téléphone introuvable.');

    const existing = await this.prisma.raw.deviceAssignment.findFirst({
      where: { userId, deviceId, revokedAt: null },
    });
    if (existing) return existing;

    return this.prisma.db.deviceAssignment.create({
      data: {
        id: newId(),
        companyId,
        userId,
        deviceId,
        createdBy: adminId,
      },
    });
  }

  async unassignDevice(userId: string, deviceId: string) {
    await this.prisma.db.deviceAssignment.updateMany({
      where: { userId, deviceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Anonymisation RGPD : l'identité disparaît, les événements restent.
   * Les badges sont révoqués, les affectations closes, les sessions terminées.
   */
  async anonymize(id: string): Promise<void> {
    const user = await this.prisma.db.user.findFirst({ where: { id } });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    const now = new Date();
    await this.prisma.raw.$transaction(async (tx) => {
      await tx.badge.updateMany({
        where: { userId: id, status: { not: BadgeStatus.REVOKED } },
        data: {
          status: BadgeStatus.REVOKED,
          revokedAt: now,
          revokeReason: 'ANONYMIZATION',
          // La valeur chiffrée est effacée : elle deviendrait une donnée
          // personnelle conservée sans finalité.
          barcodeCiphertext: null,
        },
      });
      await tx.deviceAssignment.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.user.update({
        where: { id },
        data: {
          firstName: 'Utilisateur',
          lastName: 'anonymisé',
          phone: null,
          email: null,
          employeeNumber: null,
          status: UserStatus.ARCHIVED,
          anonymizedAt: now,
        },
      });
    });
  }
}
