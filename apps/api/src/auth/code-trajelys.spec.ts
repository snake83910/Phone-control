import { UnauthorizedException } from '@nestjs/common';
import { AdminStatus } from '@prisma/client';
import { AdminAuthService } from './admin-auth.service';

/**
 * Code à usage unique de l'authentification depuis Trajelys.
 *
 * ── Ce qu'il porte, et pourquoi il est si court ─────────────────────────
 * Trajelys vit sur `www.<domaine>`, le tableau de bord sur `admin.<domaine>`.
 * Le navigateur interdit à l'un de poser la session de l'autre : des jetons
 * obtenus côté Trajelys y resteraient enfermés. Le code franchit cette
 * frontière — et comme il traverse l'URL, donc l'historique du navigateur et
 * les journaux des proxys, tout le reste découle de là : usage unique, une
 * minute, et rien qui vaille par lui-même.
 */

type Faux = {
  redis: { setWithTtl: jest.Mock; consommerUneFois: jest.Mock };
  admin: { findUnique: jest.Mock };
  jetons: jest.Mock;
};

function monter(etat: {
  adminEnCache?: string | null;
  admin?: { id: string; status: AdminStatus; deletedAt: Date | null } | null;
}) {
  const faux: Faux = {
    redis: {
      setWithTtl: jest.fn().mockResolvedValue(undefined),
      consommerUneFois: jest.fn().mockResolvedValue(etat.adminEnCache ?? null),
    },
    admin: {
      findUnique: jest.fn().mockResolvedValue(
        etat.admin === undefined
          ? { id: 'a1', status: AdminStatus.ACTIVE, deletedAt: null }
          : etat.admin,
      ),
    },
    jetons: jest.fn().mockResolvedValue({ accessToken: 'jwt', refreshToken: 'r' }),
  };

  const service = Object.create(AdminAuthService.prototype) as AdminAuthService;
  Object.assign(service, {
    redis: faux.redis,
    prisma: { raw: { admin: faux.admin } },
    tokens: { generateOpaqueToken: () => 'code-opaque-de-quarante-caracteres-xxx' },
    issueTokens: faux.jetons,
    resoudreAdministrateurTrajelys: jest
      .fn()
      .mockResolvedValue({ adminId: 'a1', companyId: 'c1' }),
  });
  return { service, faux };
}

describe('émission du code', () => {
  it('range l’identifiant de l’administrateur, pas celui du compte Trajelys', async () => {
    // C'est la clé de voûte : le code ne désigne pas un compte Supabase, il
    // désigne un administrateur DÉJÀ résolu et contrôlé. L'échange n'a donc
    // plus aucune vérification de rattachement à refaire.
    const { service, faux } = monter({});

    const { code, expireDansSecondes } = await service.emettreCodeTrajelys({
      userId: 'u1',
    });

    expect(faux.redis.setWithTtl).toHaveBeenCalledWith(
      expect.stringContaining(code),
      'a1',
      expireDansSecondes,
    );
  });

  it('ne vit pas plus d’une minute', async () => {
    // Il traverse l'historique du navigateur et les journaux des proxys : plus
    // il vit, plus cette trace vaut quelque chose.
    const { service } = monter({});
    const { expireDansSecondes } = await service.emettreCodeTrajelys({ userId: 'u1' });
    expect(expireDansSecondes).toBeLessThanOrEqual(60);
  });

  it('passe par les mêmes contrôles que la connexion directe', async () => {
    // Deux portes avec deux jeux de vérifications finissent par diverger, et
    // c'est la moins surveillée qui devient la faille.
    const { service } = monter({});
    await service.emettreCodeTrajelys({ userId: 'u1' });
    expect(
      (service as unknown as { resoudreAdministrateurTrajelys: jest.Mock })
        .resoudreAdministrateurTrajelys,
    ).toHaveBeenCalledWith({ userId: 'u1' });
  });
});

describe('échange du code', () => {
  it('rend des jetons et consomme le code', async () => {
    const { service, faux } = monter({ adminEnCache: 'a1' });

    await expect(service.echangerCodeTrajelys('un-code')).resolves.toMatchObject({
      accessToken: 'jwt',
    });
    // `consommerUneFois` lit et supprime dans la même opération : entre un
    // `get` et un `del`, deux requêtes concurrentes consommeraient le même
    // code, et un code rejouable est un code partagé.
    expect(faux.redis.consommerUneFois).toHaveBeenCalledTimes(1);
  });

  it('refuse un code inconnu, expiré ou déjà utilisé', async () => {
    // Les trois cas se confondent volontairement dans une seule réponse :
    // distinguer « expiré » de « inconnu » dirait à un attaquant que sa valeur
    // a existé.
    const { service } = monter({ adminEnCache: null });
    await expect(service.echangerCodeTrajelys('x')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuse un compte désactivé pendant la minute de vie du code', async () => {
    // Fenêtre étroite, mais c'est exactement celle qu'exploiterait quelqu'un
    // dont l'accès vient d'être retiré.
    //
    // `DISABLED` et non `SUSPENDED` : ce dernier n'existe pas dans
    // l'énumération. Écrit ainsi, il valait `undefined` — le test passait en
    // vérifiant « un statut inconnu est refusé », ce qui est vrai mais n'est
    // pas ce que son intitulé promet. Seul `tsc` l'a vu, les tests non.
    const { service } = monter({
      adminEnCache: 'a1',
      admin: { id: 'a1', status: AdminStatus.DISABLED, deletedAt: null },
    });
    await expect(service.echangerCodeTrajelys('un-code')).rejects.toThrow(/inactif/i);
  });

  it('refuse un compte supprimé entre-temps', async () => {
    const { service } = monter({
      adminEnCache: 'a1',
      admin: { id: 'a1', status: AdminStatus.ACTIVE, deletedAt: new Date() },
    });
    await expect(service.echangerCodeTrajelys('un-code')).rejects.toThrow(/inactif/i);
  });

  it('n’émet aucun jeton quand le code est refusé', async () => {
    const { service, faux } = monter({ adminEnCache: null });
    await expect(service.echangerCodeTrajelys('x')).rejects.toBeTruthy();
    expect(faux.jetons).not.toHaveBeenCalled();
  });
});
