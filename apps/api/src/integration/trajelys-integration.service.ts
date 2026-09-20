import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DeviceEnrollmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TenantContext } from '../common/tenant-context';
import { newId } from '../common/ids';

/**
 * Longueur maximale du slug, imposée par la validation de `CreateCompanyDto`.
 * On tronque en dessous pour laisser la place au suffixe de désambiguïsation.
 */
const SLUG_MAX = 54;

/**
 * Fabrique un slug à partir d'une raison sociale.
 *
 * ── Pourquoi ce n'est pas trivial ───────────────────────────────────────
 * « Transports Martin » existe plusieurs fois en France, et le slug est
 * unique. Une slugification naïve ferait échouer la création du deuxième
 * client portant ce nom — au pire moment, celui où tu viens de lui vendre
 * l'option.
 *
 * Et certaines raisons sociales ne laissent rien après nettoyage : un nom en
 * alphabet non latin, ou « --- ». D'où le repli sur l'identifiant du compte,
 * qui n'est pas beau mais qui existe toujours.
 */
export function slugifier(nom: string, trajelysUserId: string): string {
  const base = nom
    .normalize('NFD')
    // Retire les diacritiques : « Transports Créteil » et « Transports Creteil »
    // doivent donner le même slug, pas deux entreprises distinctes.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');

  // La validation exige au moins deux caractères et un début alphanumérique.
  if (base.length < 2) return `dsp-${trajelysUserId.slice(0, 8)}`;
  return base;
}

@Injectable()
export class TrajelysIntegrationService {
  private readonly logger = new Logger(TrajelysIntegrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Crée l'entreprise et la rattache, ou rend celle qui existe déjà.
   *
   * ── Idempotent, et pas seulement par politesse ──────────────────────────
   * C'est ce qui permet à Trajelys de réessayer sans file d'attente : si ce
   * service est injoignable au moment où l'exploitant ouvre l'option,
   * l'ouverture n'échoue pas, et le premier clic du client refait exactement
   * le même appel. La panne se rattrape toute seule.
   *
   * ── Le rattachement ne se défait jamais ici ─────────────────────────────
   * `trajelysUserId` est la clé qui retrouve l'entreprise. La fermeture de
   * l'option ne doit pas l'effacer, sans quoi une réouverture ne la
   * retrouverait plus et créerait une SECONDE entreprise vide : le client
   * résilié qui revient perdrait sa flotte. La barrière commerciale vit chez
   * Trajelys ; le détachement reste un geste manuel d'exception.
   */
  async provisionner(trajelysUserId: string, nom: string) {
    const existante = await this.prisma.raw.company.findUnique({
      where: { trajelysUserId },
      select: { id: true, name: true, slug: true, deletedAt: true },
    });

    if (existante) {
      // Y compris supprimée : la ressusciter silencieusement masquerait une
      // décision prise ici, et en créer une autre à côté dupliquerait la
      // flotte. L'exploitant tranche.
      if (existante.deletedAt) {
        throw new NotFoundException(
          `L’entreprise « ${existante.name} » rattachée à ce compte a été supprimée. ` +
            'Sa restauration est une décision manuelle.',
        );
      }
      return {
        companyId: existante.id,
        nom: existante.name,
        slug: existante.slug,
        creee: false,
      };
    }

    const slug = await this.slugLibre(slugifier(nom, trajelysUserId));

    try {
      const creee = await this.prisma.raw.$transaction(async (tx) => {
        const company = await tx.company.create({
          data: {
            id: newId(),
            name: nom,
            slug,
            trajelysUserId,
            settings: { detailedDenialMessages: true },
          },
          select: { id: true, name: true, slug: true },
        });
        // Mêmes deux lignes que la création manuelle : sans elles, une
        // entreprise neuve n'a ni durée de conservation ni configuration
        // d'appareil, et ça ne se verrait qu'au premier téléphone enrôlé.
        await tx.retentionPolicy.create({ data: { companyId: company.id } });
        await tx.deviceSettings.create({
          data: { id: newId(), companyId: company.id },
        });
        return company;
      });

      // Le journal d'audit prend son entreprise du contexte, que la porte de
      // service laisse volontairement vide. On la renseigne ici : une création
      // d'entreprise non attribuée serait la ligne la plus inutile du journal.
      const ctx = TenantContext.get();
      if (ctx) ctx.companyId = creee.id;

      await this.audit.record({
        action: 'COMPANY_PROVISIONED_TRAJELYS',
        resourceType: 'company',
        resourceId: creee.id,
        after: { trajelysUserId, nom: creee.name, slug: creee.slug },
      });

      this.logger.log(`Entreprise « ${creee.name} » créée depuis Trajelys.`);
      return { companyId: creee.id, nom: creee.name, slug: creee.slug, creee: true };
    } catch (e) {
      // Deux appels concurrents — l'ouverture de l'option et le premier clic
      // du client, par exemple — arrivent ici. La contrainte d'unicité est le
      // dernier rempart de l'idempotence : on relit et on rend l'existante.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const concurrente = await this.prisma.raw.company.findUnique({
          where: { trajelysUserId },
          select: { id: true, name: true, slug: true },
        });
        if (concurrente) {
          return {
            companyId: concurrente.id,
            nom: concurrente.name,
            slug: concurrente.slug,
            creee: false,
          };
        }
      }
      throw e;
    }
  }

  /** Ajoute un suffixe numérique tant que le slug est pris. */
  private async slugLibre(souhaite: string): Promise<string> {
    for (let suffixe = 0; suffixe < 50; suffixe++) {
      const candidat = suffixe === 0 ? souhaite : `${souhaite}-${suffixe + 1}`;
      const pris = await this.prisma.raw.company.findUnique({
        where: { slug: candidat },
        select: { id: true },
      });
      if (!pris) return candidat;
    }
    // Cinquante homonymes est invraisemblable ; s'y arrêter plutôt que de
    // boucler indéfiniment sur une contrainte qu'on aurait mal comprise.
    throw new Error(`Impossible de dériver un slug libre depuis « ${souhaite} ».`);
  }

  /**
   * Appareils à facturer sur la fenêtre donnée.
   *
   * ── Ce que ce service PEUT honnêtement affirmer ─────────────────────────
   * Pas « qui était enrôlé en janvier ». Le ré-enrôlement réutilise la ligne
   * de l'appareil, écrase `enrolled_at` et remet `revoked_at` à null : le
   * couple ne décrit que l'épisode EN COURS, et les précédents sont perdus.
   *
   * Ce service répond donc à la seule question qu'il sait trancher : « qui,
   * à cet instant, est enrôlé, ou l'a été pendant cette fenêtre ». C'est
   * Trajelys qui accumule ces réponses dans sa table figée, et cette table
   * est la seule mémoire durable de ce qui a été facturé.
   *
   * ── Trois filtres, trois raisons différentes ────────────────────────────
   *  - `enrolled_at < fin` : un appareil enrôlé APRÈS la fenêtre appartient
   *    au mois suivant ;
   *  - enrôlé maintenant OU retiré depuis le début de la fenêtre : sans le
   *    second terme, un appareil rendu le 12 disparaîtrait du mois qu'il a
   *    pourtant occupé ;
   *  - supprimé jamais, ou depuis le début de la fenêtre : sans quoi une
   *    suppression effacerait rétroactivement un mois déjà dû.
   */
  async appareilsFactures(trajelysUserId: string, debut: Date, fin: Date) {
    const company = await this.prisma.raw.company.findUnique({
      where: { trajelysUserId },
      select: { id: true, deletedAt: true },
    });
    if (!company || company.deletedAt) {
      throw new NotFoundException(
        'Aucune entreprise Phone Control rattachée à ce compte Trajelys.',
      );
    }

    const appareils = await this.prisma.raw.device.findMany({
      where: {
        companyId: company.id,
        enrolledAt: { not: null, lt: fin },
        AND: [
          {
            OR: [
              { enrollmentStatus: DeviceEnrollmentStatus.ENROLLED },
              { revokedAt: { gte: debut } },
            ],
          },
          { OR: [{ deletedAt: null }, { deletedAt: { gte: debut } }] },
        ],
      },
      select: { id: true, assetTag: true },
      orderBy: { assetTag: 'asc' },
    });

    return { companyId: company.id, appareils };
  }
}
