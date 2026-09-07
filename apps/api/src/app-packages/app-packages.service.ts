import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppPackage,
  CommandType,
  DeviceEnrollmentStatus,
} from '@prisma/client';
import {
  describeCertificate,
  readSigningCertificate,
  signatureChecksum,
} from '@phone-control/provisioning-payload';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../prisma/prisma.service';
import { CommandsService } from '../devices/commands.service';
import { AuditService } from '../audit/audit.service';
import { newId } from '../common/ids';
import { ApkUploadError, storeUploadedApk } from './apk-upload';

export interface AppPackageView {
  id: string;
  label: string;
  sha256: string;
  signingCertSha256: string;
  sizeBytes: number;
  packageName: string | null;
  versionName: string | null;
  versionCode: number | null;
  createdAt: Date;
  retiredAt: Date | null;
  /** Résumé lisible du certificat : qui a signé, et jusqu'à quand. */
  certificate: {
    subject: string;
    validTo: string | null;
    expired: boolean;
  } | null;
}

/**
 * Catalogue des APK deployables, et emission des commandes d'installation.
 *
 * Une remarque preliminaire, parce qu'elle gouverne toute la conception : la
 * commande « installe l'APK qui se trouve la » est **une execution de code
 * arbitraire sur la flotte entiere**. C'est la fonction la plus puissante du
 * systeme et la plus dangereuse.
 *
 * Trois choses en decoulent :
 *
 * 1. **Les empreintes sont calculees ici**, a la reception du fichier, jamais
 *    saisies. Une empreinte fournie par celui qui depose le fichier decrirait
 *    le fichier depose, quel qu'il soit — elle ne verifierait rien.
 * 2. **Le telephone verifie avant d'installer** : l'empreinte du fichier
 *    telecharge, puis l'empreinte du certificat de signature. Les deux, pas
 *    l'une ou l'autre.
 * 3. **Tout est journalise** : qui a depose quoi, qui l'a pousse sur quels
 *    telephones.
 *
 * Ce que cela ne protege pas, et il faut le dire : un serveur compromis peut
 * pousser ce qu'il veut, puisqu'il ecrit lui-meme les empreintes attendues.
 * C'est vrai de toute solution de gestion de parc. Ce qui est protege, c'est le
 * trajet — un fichier substitue en chemin ou sur le disque est refuse — et
 * l'attribution.
 */
@Injectable()
export class AppPackagesService {
  private readonly logger = new Logger(AppPackagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: CommandsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private get storageDir(): string {
    const configured = this.config.get<string>(
      'APP_PACKAGE_STORAGE_DIR',
      './storage/app-packages',
    );
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  }

  /**
   * Depot d'un APK.
   *
   * Le nom du fichier sur disque est l'identifiant genere, jamais le libelle
   * saisi : un libelle contenant `../` ecrirait ailleurs que prevu.
   */
  async upload(params: {
    companyId: string;
    adminId: string;
    label: string;
    request: FastifyRequest;
  }): Promise<AppPackageView> {
    const label = params.label.trim();
    if (label.length < 2) {
      throw new BadRequestException(
        'Donnez un nom à ce dépôt : c’est ce qui permettra de le retrouver.',
      );
    }

    const id = newId();
    const storagePath = `${id}.apk`;
    const maxBytes = this.config.get<number>(
      'APP_PACKAGE_MAX_BYTES',
      150 * 1024 * 1024,
    );

    let stored;
    try {
      stored = await storeUploadedApk(
        params.request,
        join(this.storageDir, storagePath),
        maxBytes,
      );
    } catch (error) {
      // Le refus vient du flux lui-même — taille dépassée, corps vide. Il doit
      // arriver à l'opérateur avec son message, et non en 500 anonyme.
      if (error instanceof ApkUploadError) {
        throw new HttpException(error.message, error.status);
      }
      throw error;
    }

    // Lecture du bloc de signature. Un fichier qui n'est pas un APK signé
    // échoue ici, avant toute écriture en base : mieux vaut le refuser au dépôt
    // que le découvrir sur deux mille téléphones.
    let signingCertSha256: string;
    let summary: ReturnType<typeof describeCertificate>;
    try {
      const der = readSigningCertificate(stored.path).der;
      signingCertSha256 = signatureChecksum(der);
      summary = describeCertificate(der);
    } catch (error) {
      await unlink(stored.path).catch(() => undefined);
      throw new BadRequestException(
        `Ce fichier n’est pas un APK signé exploitable : ${(error as Error).message}`,
      );
    }

    const created = await this.prisma.db.appPackage.create({
      data: {
        id,
        companyId: params.companyId,
        label,
        sha256: stored.sha256,
        signingCertSha256,
        signingCertSubject: summary.subject,
        signingCertValidTo: new Date(summary.validTo),
        sizeBytes: stored.sizeBytes,
        storagePath,
        createdBy: params.adminId,
      },
    });

    await this.audit.record({
      action: 'ADMIN_UPLOAD_APP_PACKAGE',
      resourceType: 'app_package',
      resourceId: created.id,
      after: {
        label,
        sha256: stored.sha256,
        signingCertSha256,
        sizeBytes: stored.sizeBytes,
      },
    });

    return this.toView(created);
  }

  async findAll(companyId: string): Promise<AppPackageView[]> {
    const rows = await this.prisma.db.appPackage.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((row) => this.toView(row));
  }

  /**
   * Deploiement sur un ensemble de telephones.
   *
   * Une commande par appareil : la file existante apporte l'expiration,
   * l'idempotence et l'acquittement, qu'il serait absurde de reecrire.
   */
  async deploy(params: {
    companyId: string;
    adminId: string;
    packageId: string;
    /** Absent : tous les telephones enroles de l'entreprise. */
    deviceIds?: string[];
  }): Promise<{ queued: number }> {
    const pkg = await this.load(params.companyId, params.packageId);
    if (pkg.retiredAt) {
      throw new BadRequestException(
        'Ce dépôt a été retiré : son fichier n’existe plus.',
      );
    }

    // Sans liste explicite, la flotte est resolue ici. Le tableau de bord ne
    // peut pas enumerer deux mille identifiants : la route de liste s'arrete a
    // deux cents par page, et lui faire pagineer pour reconstruire ce que le
    // serveur sait deja serait une gymnastique inutile et fragile.
    const devices = await this.prisma.db.device.findMany({
      where: {
        deletedAt: null,
        enrollmentStatus: DeviceEnrollmentStatus.ENROLLED,
        ...(params.deviceIds?.length ? { id: { in: params.deviceIds } } : {}),
      },
      select: { id: true },
    });
    if (devices.length === 0) {
      throw new NotFoundException(
        'Aucun téléphone enrôlé à qui envoyer cette application.',
      );
    }

    for (const device of devices) {
      await this.commands.enqueue({
        companyId: params.companyId,
        deviceId: device.id,
        command: CommandType.INSTALL_APP,
        payload: {
          packageId: pkg.id,
          label: pkg.label,
          sha256: pkg.sha256,
          signingCertSha256: pkg.signingCertSha256,
          sizeBytes: pkg.sizeBytes,
          // Nul tant qu'aucun téléphone n'a installé. Renseigné, il devient une
          // vérification de plus : l'APK téléchargé doit déclarer ce paquet-là.
          packageName: pkg.packageName,
          versionCode: pkg.versionCode,
        },
        // Une même version poussée deux fois ne produit qu'une commande : le
        // dashboard n'a pas à se souvenir de ce qu'il a déjà envoyé.
        idempotencyKey: `install:${pkg.id}`,
        createdBy: params.adminId,
      });
    }

    await this.audit.record({
      action: 'ADMIN_DEPLOY_APP_PACKAGE',
      resourceType: 'app_package',
      resourceId: pkg.id,
      after: { label: pkg.label, devices: devices.length },
    });

    return { queued: devices.length };
  }

  async uninstall(params: {
    companyId: string;
    adminId: string;
    packageName: string;
    deviceIds: string[];
  }): Promise<{ queued: number }> {
    const devices = await this.prisma.db.device.findMany({
      where: { id: { in: params.deviceIds }, deletedAt: null },
      select: { id: true },
    });
    if (devices.length === 0) {
      throw new NotFoundException('Aucun téléphone désigné.');
    }

    for (const device of devices) {
      await this.commands.enqueue({
        companyId: params.companyId,
        deviceId: device.id,
        command: CommandType.UNINSTALL_APP,
        payload: { packageName: params.packageName },
        idempotencyKey: `uninstall:${params.packageName}`,
        createdBy: params.adminId,
      });
    }

    await this.audit.record({
      action: 'ADMIN_UNINSTALL_APP',
      resourceType: 'app_package',
      resourceId: params.packageName,
      after: { devices: devices.length },
    });

    return { queued: devices.length };
  }

  /**
   * Retrait du catalogue.
   *
   * Le fichier est supprime, la ligne reste : elle explique les installations
   * deja faites, et un journal d'audit qui renverrait vers une ligne disparue
   * ne servirait a rien.
   */
  async retire(companyId: string, id: string): Promise<AppPackageView> {
    const pkg = await this.load(companyId, id);

    await unlink(join(this.storageDir, pkg.storagePath)).catch((error) => {
      // Fichier deja absent : ce n'est pas une faute, et cela ne doit pas
      // empecher le retrait logique.
      this.logger.warn(
        `Fichier de ${pkg.label} déjà absent : ${(error as Error).message}`,
      );
    });

    const updated = await this.prisma.db.appPackage.update({
      where: { id },
      data: { retiredAt: new Date() },
    });

    await this.audit.record({
      action: 'ADMIN_RETIRE_APP_PACKAGE',
      resourceType: 'app_package',
      resourceId: id,
      before: { label: pkg.label },
    });

    return this.toView(updated);
  }

  /**
   * Ouverture du fichier pour un telephone.
   *
   * Aucune route statique ne sert ce repertoire : un APK ne se telecharge
   * qu'avec le jeton d'un appareil enrole, et seulement de son entreprise.
   */
  async openForDevice(companyId: string, packageId: string) {
    const pkg = await this.prisma.raw.appPackage.findFirst({
      where: { id: packageId, companyId, retiredAt: null },
    });
    if (!pkg) throw new NotFoundException('Application introuvable.');

    const path = join(this.storageDir, pkg.storagePath);
    const info = await stat(path).catch(() => null);
    if (!info) {
      // Le fichier a disparu du disque alors que la ligne existe : c'est un
      // defaut d'exploitation, pas une requete fautive. Il doit se voir.
      this.logger.error(
        `Fichier manquant pour ${pkg.label} (${pkg.id}) : ${path}`,
      );
      throw new NotFoundException('Fichier indisponible sur le serveur.');
    }

    return { stream: createReadStream(path), pkg, sizeBytes: info.size };
  }

  /**
   * Identite reelle du paquet, rapportee par un telephone apres installation.
   *
   * Le premier rapport fait foi. Un rapport divergent est journalise sans
   * ecraser : deux telephones qui ne voient pas le meme nom de paquet dans le
   * meme fichier signalent un probleme qu'un ecrasement silencieux masquerait.
   */
  async recordInstalledIdentity(
    packageId: string,
    identity: { packageName: string; versionName: string; versionCode: number },
  ): Promise<void> {
    const pkg = await this.prisma.raw.appPackage.findUnique({
      where: { id: packageId },
    });
    if (!pkg) return;

    if (pkg.packageName && pkg.packageName !== identity.packageName) {
      this.logger.error(
        `Identité divergente pour ${pkg.label} : ${pkg.packageName} en base, ` +
          `${identity.packageName} rapporté par un téléphone.`,
      );
      return;
    }

    if (pkg.packageName) return;

    await this.prisma.raw.appPackage.update({
      where: { id: packageId },
      data: {
        packageName: identity.packageName,
        versionName: identity.versionName,
        versionCode: identity.versionCode,
      },
    });
  }

  private async load(companyId: string, id: string): Promise<AppPackage> {
    const pkg = await this.prisma.db.appPackage.findFirst({
      where: { id, companyId },
    });
    if (!pkg) throw new NotFoundException('Application introuvable.');
    return pkg;
  }

  private toView(pkg: AppPackage): AppPackageView {
    return {
      id: pkg.id,
      label: pkg.label,
      sha256: pkg.sha256,
      signingCertSha256: pkg.signingCertSha256,
      sizeBytes: pkg.sizeBytes,
      packageName: pkg.packageName,
      versionName: pkg.versionName,
      versionCode: pkg.versionCode,
      createdAt: pkg.createdAt,
      retiredAt: pkg.retiredAt,
      certificate: pkg.signingCertSubject
        ? {
            subject: pkg.signingCertSubject,
            validTo: pkg.signingCertValidTo?.toISOString() ?? null,
            // Calcule a la lecture, jamais conserve : un certificat valide au
            // depot ne l'est plus forcement six mois plus tard.
            expired:
              pkg.signingCertValidTo !== null &&
              pkg.signingCertValidTo.getTime() < Date.now(),
          }
        : null,
    };
  }
}
