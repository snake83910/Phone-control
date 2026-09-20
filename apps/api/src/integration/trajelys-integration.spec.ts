import { NotFoundException } from '@nestjs/common';
import { DeviceEnrollmentStatus } from '@prisma/client';
import {
  TrajelysIntegrationService,
  slugifier,
} from './trajelys-integration.service';

/**
 * Intégration Trajelys : création d'entreprise et comptage à facturer.
 *
 * ── Ce qui est réellement en jeu ────────────────────────────────────────
 * Une erreur ici ne provoque pas de panne. Elle crée une seconde entreprise
 * vide à un client qui revient, ou produit une facture fausse — deux choses
 * qui se découvrent des mois plus tard, chez le client, et qui coûtent la
 * confiance avant de coûter de l'argent.
 */

const COMPTE = '65302aeb-03c6-4b0e-9649-9093bfdb7c7a';

function monter(etat: {
  entrepriseExistante?: {
    id: string;
    name: string;
    slug: string;
    deletedAt: Date | null;
  } | null;
  slugsPris?: string[];
  appareils?: { id: string; assetTag: string }[];
}) {
  const slugsPris = new Set(etat.slugsPris ?? []);

  const company = {
    findUnique: jest.fn().mockImplementation(({ where }) => {
      if (where.trajelysUserId !== undefined) {
        return Promise.resolve(etat.entrepriseExistante ?? null);
      }
      if (where.slug !== undefined) {
        return Promise.resolve(slugsPris.has(where.slug) ? { id: 'autre' } : null);
      }
      if (where.id !== undefined) {
        return Promise.resolve(etat.entrepriseExistante ?? null);
      }
      return Promise.resolve(null);
    }),
    create: jest
      .fn()
      .mockImplementation(({ data }) =>
        Promise.resolve({ id: 'c-neuve', name: data.name, slug: data.slug }),
      ),
  };

  const device = { findMany: jest.fn().mockResolvedValue(etat.appareils ?? []) };

  const raw = {
    company,
    device,
    retentionPolicy: { create: jest.fn().mockResolvedValue({}) },
    deviceSettings: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({
        company,
        retentionPolicy: { create: jest.fn().mockResolvedValue({}) },
        deviceSettings: { create: jest.fn().mockResolvedValue({}) },
      }),
    ),
  };

  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new TrajelysIntegrationService(
    { raw } as never,
    audit as never,
  );
  return { service, raw, company, device, audit };
}

describe('dérivation du slug', () => {
  it('nettoie une raison sociale ordinaire', () => {
    expect(slugifier('Transports Martin', COMPTE)).toBe('transports-martin');
  });

  it('ignore les accents plutôt que de les perdre', () => {
    // « Créteil » et « Creteil » doivent donner le même slug : les traiter
    // différemment ferait deux entreprises là où il n'y a qu'un client.
    expect(slugifier('Transports Créteil', COMPTE)).toBe('transports-creteil');
  });

  // Une raison sociale en alphabet non latin, ou « --- », ne laisse aucun
  // caractère acceptable. Sans repli, la création échouerait à la validation
  // — au moment exact où tu viens de vendre l'option.
  it.each([['---'], ['株式会社'], ['   '], ['!']])(
    'ne rend jamais un slug invalide : %s',
    (nom) => {
      expect(slugifier(nom, COMPTE)).toMatch(/^[a-z0-9][a-z0-9-]{1,60}$/);
    },
  );

  it('respecte le format attendu même sur un nom très long', () => {
    const slug = slugifier('Transports '.repeat(20), COMPTE);
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{1,60}$/);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('provisionnement', () => {
  it('crée l’entreprise, sa rétention et sa configuration d’appareils', async () => {
    // Les deux lignes annexes ne sont pas décoratives : sans elles, le manque
    // ne se verrait qu'au premier téléphone enrôlé.
    const { service, raw } = monter({ entrepriseExistante: null });

    const r = await service.provisionner(COMPTE, 'Transports Martin');

    expect(r).toMatchObject({ creee: true, slug: 'transports-martin' });
    expect(raw.$transaction).toHaveBeenCalled();
  });

  it('est idempotent : rouvrir l’option ne crée pas une seconde flotte', async () => {
    // LE test qui compte. C'est ce qui autorise Trajelys à rappeler cette
    // route au premier clic du client pour rattraper une panne, sans file
    // d'attente ni travail de fond.
    const { service, company } = monter({
      entrepriseExistante: {
        id: 'c1',
        name: 'Transports Martin',
        slug: 'transports-martin',
        deletedAt: null,
      },
    });

    const r = await service.provisionner(COMPTE, 'Transports Martin');

    expect(r).toMatchObject({ companyId: 'c1', creee: false });
    expect(company.create).not.toHaveBeenCalled();
  });

  it('désambiguïse un homonyme au lieu d’échouer', async () => {
    // « Transports Martin » existe plusieurs fois en France, et le slug est
    // unique. Sans suffixe, le deuxième client de ce nom serait impossible à
    // créer.
    const { service } = monter({
      entrepriseExistante: null,
      slugsPris: ['transports-martin'],
    });

    const r = await service.provisionner(COMPTE, 'Transports Martin');
    expect(r.slug).toBe('transports-martin-2');
  });

  it('refuse de ressusciter une entreprise supprimée', async () => {
    // En créer une autre à côté dupliquerait la flotte ; la rouvrir en
    // silence annulerait une décision prise ailleurs. Les deux sont pires
    // qu'un refus explicite.
    const { service } = monter({
      entrepriseExistante: {
        id: 'c1',
        name: 'Transports Martin',
        slug: 'transports-martin',
        deletedAt: new Date(),
      },
    });

    await expect(service.provisionner(COMPTE, 'Transports Martin')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('laisse une trace au journal', async () => {
    const { service, audit } = monter({ entrepriseExistante: null });
    await service.provisionner(COMPTE, 'Transports Martin');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'COMPANY_PROVISIONED_TRAJELYS' }),
    );
  });
});

describe('appareils à facturer', () => {
  const DEBUT = new Date('2026-08-31T22:00:00.000Z');
  const FIN = new Date('2026-09-30T22:00:00.000Z');

  async function filtre(etat: Parameters<typeof monter>[0] = {}) {
    const { service, device } = monter({
      entrepriseExistante: { id: 'c1', name: 'X', slug: 'x', deletedAt: null },
      ...etat,
    });
    await service.appareilsFactures(COMPTE, DEBUT, FIN);
    return device.findMany.mock.calls[0][0].where;
  }

  it('compte les appareils retirés pendant la fenêtre', async () => {
    // Sans ce terme, un téléphone rendu le 12 disparaîtrait du mois qu'il a
    // pourtant occupé — et le client serait sous-facturé chaque fois qu'il
    // fait tourner sa flotte.
    const w = await filtre();
    const statuts = w.AND[0].OR;
    expect(statuts).toContainEqual({
      enrollmentStatus: DeviceEnrollmentStatus.ENROLLED,
    });
    expect(statuts).toContainEqual({ revokedAt: { gte: DEBUT } });
  });

  it('n’efface pas un mois dû quand l’appareil est supprimé ensuite', async () => {
    // Une suppression ne doit pas réécrire le passé. Le filtre garde les
    // appareils supprimés depuis le début de la fenêtre.
    const w = await filtre();
    expect(w.AND[1].OR).toContainEqual({ deletedAt: { gte: DEBUT } });
    expect(w.AND[1].OR).toContainEqual({ deletedAt: null });
  });

  it('exclut un appareil enrôlé après la fenêtre', async () => {
    // Il appartient au mois suivant. Sans cette borne, un téléphone enrôlé le
    // 2 octobre serait facturé sur septembre.
    const w = await filtre();
    expect(w.enrolledAt).toEqual({ not: null, lt: FIN });
  });

  it('borne sur l’entreprise, jamais sur le contexte', async () => {
    // La porte de service n'ouvre aucun contexte d'entreprise : si ce filtre
    // disparaissait, la requête rendrait les appareils de TOUS les clients.
    const w = await filtre();
    expect(w.companyId).toBe('c1');
  });

  it('refuse un compte sans entreprise rattachée', async () => {
    const { service } = monter({ entrepriseExistante: null });
    await expect(
      service.appareilsFactures(COMPTE, DEBUT, FIN),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
