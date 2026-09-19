import { ConflictException, NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CompaniesController, RattachementTrajelysDto } from './companies.controller';

/**
 * Rattachement d'une entreprise à un compte Trajelys.
 *
 * ── Ce que ce lien autorise ─────────────────────────────────────────────
 * Le porteur du compte rattaché devient administrateur de l'entreprise, donc
 * de toute sa flotte de téléphones. C'est le geste le plus lourd de
 * conséquences de ce contrôleur, et le seul qui relie deux produits.
 *
 * On teste donc ce qui protège : l'impossibilité de détacher par accident,
 * l'impossibilité de voler le compte d'un autre client, et la coupure
 * effective des sessions déjà ouvertes quand le lien est retiré.
 */

type Faux = {
  company: { findFirst: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
  adminRefreshToken: { updateMany: jest.Mock };
};

function monterControleur(etat: {
  entreprise?: { id: string; name: string; trajelysUserId: string | null } | null;
  occupant?: { id: string; name: string } | null;
  sessionsOuvertes?: number;
}) {
  const raw: Faux = {
    company: {
      findFirst: jest.fn().mockResolvedValue(
        etat.entreprise === undefined
          ? { id: 'c1', name: 'Transports Martin', trajelysUserId: null }
          : etat.entreprise,
      ),
      findUnique: jest.fn().mockResolvedValue(etat.occupant ?? null),
      update: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'c1',
          name: 'Transports Martin',
          trajelysUserId: data.trajelysUserId,
        }),
      ),
    },
    adminRefreshToken: {
      updateMany: jest.fn().mockResolvedValue({ count: etat.sessionsOuvertes ?? 0 }),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const controleur = new CompaniesController(
    { raw } as never,
    audit as never,
  );
  return { controleur, raw, audit };
}

const UN_COMPTE = '65302aeb-03c6-4b0e-9649-9093bfdb7c7a';
const UN_AUTRE = '0195e9f0-0000-7000-8000-000000000001';

describe('validation de la requête', () => {
  const valider = async (corps: unknown) =>
    validate(plainToInstance(RattachementTrajelysDto, corps));

  it('refuse un corps sans la clé', async () => {
    // LE cas qui justifie `@IsDefined` : avec `@IsOptional`, `{}` aurait été
    // accepté et aurait détaché l'entreprise en silence — c'est-à-dire coupé
    // au client l'accès à toute sa flotte, sur une requête malformée.
    const erreurs = await valider({});
    expect(erreurs).toHaveLength(1);
    expect(erreurs[0].constraints).toHaveProperty('isDefined');
  });

  it('accepte `null`, qui est le détachement explicite', async () => {
    expect(await valider({ trajelysUserId: null })).toHaveLength(0);
  });

  it('accepte un identifiant bien formé', async () => {
    expect(await valider({ trajelysUserId: UN_COMPTE })).toHaveLength(0);
  });

  it('refuse ce qui n’est pas un identifiant', async () => {
    const erreurs = await valider({ trajelysUserId: 'pas-un-uuid' });
    expect(erreurs[0].constraints).toHaveProperty('isUuid');
  });
});

describe('rattachement', () => {
  it('écrit le lien et l’enregistre au journal', async () => {
    const { controleur, raw, audit } = monterControleur({});

    const reponse = await controleur.rattacherTrajelys('c1', {
      trajelysUserId: UN_COMPTE,
    });

    expect(raw.company.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { trajelysUserId: UN_COMPTE } }),
    );
    expect(reponse.trajelysUserId).toBe(UN_COMPTE);
    // Le lien donne accès à une flotte entière : il doit laisser une trace.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ADMIN_LINK_TRAJELYS' }),
    );
  });

  it('refuse un compte déjà rattaché ailleurs, en nommant l’entreprise', async () => {
    // Sans ce pré-contrôle, la contrainte d'unicité de la base remonterait une
    // erreur opaque. Dire QUI détient déjà le compte est exactement ce qu'on a
    // besoin de savoir pour trancher.
    const { controleur } = monterControleur({
      occupant: { id: 'c2', name: 'Logistique Durand' },
    });

    await expect(
      controleur.rattacherTrajelys('c1', { trajelysUserId: UN_COMPTE }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      controleur.rattacherTrajelys('c1', { trajelysUserId: UN_COMPTE }),
    ).rejects.toThrow(/Logistique Durand/);
  });

  it('laisse réécrire le même compte sur la même entreprise', async () => {
    // Le pré-contrôle ne doit pas confondre « déjà pris ailleurs » et « déjà
    // à moi » : réenregistrer la même valeur est une opération banale.
    const { controleur } = monterControleur({
      entreprise: { id: 'c1', name: 'Transports Martin', trajelysUserId: UN_COMPTE },
      occupant: { id: 'c1', name: 'Transports Martin' },
    });

    await expect(
      controleur.rattacherTrajelys('c1', { trajelysUserId: UN_COMPTE }),
    ).resolves.toMatchObject({ trajelysUserId: UN_COMPTE });
  });

  it('refuse une entreprise inconnue', async () => {
    const { controleur } = monterControleur({ entreprise: null });
    await expect(
      controleur.rattacherTrajelys('c1', { trajelysUserId: UN_COMPTE }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('détachement', () => {
  it('révoque les sessions ouvertes par authentification unique', async () => {
    // Couper le lien n'empêche que les PROCHAINES connexions. Sans révocation,
    // un accès retiré resterait effectif jusqu'à l'expiration du jeton de
    // rafraîchissement, c'est-à-dire des jours.
    const { controleur, raw } = monterControleur({
      entreprise: { id: 'c1', name: 'Transports Martin', trajelysUserId: UN_COMPTE },
      sessionsOuvertes: 3,
    });

    const reponse = await controleur.rattacherTrajelys('c1', { trajelysUserId: null });

    expect(reponse.sessionsRevoquees).toBe(3);
    expect(raw.adminRefreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          revokedAt: null,
          admin: { companyId: 'c1', ssoOnly: true },
        }),
      }),
    );
  });

  it('ne touche pas aux comptes à mot de passe de l’entreprise', async () => {
    // Le filtre `ssoOnly` est ce qui distingue « accès venu de Trajelys » de
    // « compte créé ici ». Sans lui, détacher le module mettrait dehors des
    // administrateurs qui n'ont jamais eu affaire à Trajelys.
    const { controleur, raw } = monterControleur({
      entreprise: { id: 'c1', name: 'Transports Martin', trajelysUserId: UN_COMPTE },
      sessionsOuvertes: 1,
    });

    await controleur.rattacherTrajelys('c1', { trajelysUserId: null });

    const filtre = raw.adminRefreshToken.updateMany.mock.calls[0][0].where;
    expect(filtre.admin.ssoOnly).toBe(true);
  });

  it('révoque aussi quand le lien change de titulaire', async () => {
    // Remplacer un compte par un autre retire l'accès au premier tout autant
    // qu'un détachement : ses sessions doivent tomber de la même façon.
    const { controleur, raw } = monterControleur({
      entreprise: { id: 'c1', name: 'Transports Martin', trajelysUserId: UN_COMPTE },
      sessionsOuvertes: 2,
    });

    await controleur.rattacherTrajelys('c1', { trajelysUserId: UN_AUTRE });

    expect(raw.adminRefreshToken.updateMany).toHaveBeenCalled();
  });

  it('ne révoque rien quand il n’y avait aucun lien', async () => {
    // Rattacher une entreprise qui n'était liée à personne ne doit pas
    // déconnecter ses administrateurs.
    const { controleur, raw } = monterControleur({
      entreprise: { id: 'c1', name: 'Transports Martin', trajelysUserId: null },
    });

    await controleur.rattacherTrajelys('c1', { trajelysUserId: UN_COMPTE });

    expect(raw.adminRefreshToken.updateMany).not.toHaveBeenCalled();
  });
});
