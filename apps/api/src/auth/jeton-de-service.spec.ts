import { UnauthorizedException } from '@nestjs/common';
import { AccessGuard } from './access.guard';

/**
 * La porte de service, celle que Trajelys franchit.
 *
 * ── Ce qu'elle protège ──────────────────────────────────────────────────
 * La création d'entreprises. Un jeton deviné ou reconstruit permettrait de
 * fabriquer des flottes, donc de la facturation, dans le système d'un tiers.
 * C'est la raison des deux refus testés ici — celui du jeton absent et celui
 * du jeton trop court — qui ressemblent à de la paranoïa tant qu'on ne pense
 * pas à l'installation démarrée avec `changeme` dans un fichier d'exemple.
 */

const JETON = 'x'.repeat(48);

function contexte(authorization?: string) {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  } as never;
}

function monter(jetonConfigure: string | undefined, kind = 'service') {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(kind) };
  const config = { get: jest.fn().mockReturnValue(jetonConfigure) };
  return new AccessGuard(
    reflector as never,
    {} as never,
    config as never,
    {} as never,
  );
}

describe('porte de service', () => {
  it('accepte le jeton configuré', async () => {
    const guard = monter(JETON);
    await expect(
      guard.canActivate(contexte(`Bearer ${JETON}`)),
    ).resolves.toBe(true);
  });

  it('refuse un autre jeton de même longueur', async () => {
    // Même longueur : c'est le cas que la comparaison à temps constant doit
    // traiter sans fuiter combien de caractères sont justes.
    const guard = monter(JETON);
    await expect(
      guard.canActivate(contexte(`Bearer ${'y'.repeat(48)}`)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuse un jeton de longueur différente sans planter', async () => {
    // `timingSafeEqual` LÈVE sur des tampons de tailles différentes. Sans le
    // contrôle de longueur en amont, ce cas remonterait en erreur 500 — et
    // une erreur 500 sur une porte d'authentification est un signal offert
    // à qui sonde.
    const guard = monter(JETON);
    await expect(
      guard.canActivate(contexte('Bearer court')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuse quand aucun jeton n’est configuré', async () => {
    // Une installation qui ne vend pas le module n'a pas ce secret. Le défaut
    // dangereux serait d'accepter n'importe quoi faute de référence.
    const guard = monter(undefined);
    await expect(
      guard.canActivate(contexte(`Bearer ${JETON}`)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuse un jeton configuré trop court', async () => {
    // Le secret est comparé à ce que porte l'appelant : s'il vaut `changeme`,
    // la comparaison à temps constant est parfaitement exécutée sur une
    // valeur que tout le monde connaît.
    const guard = monter('trop-court');
    await expect(
      guard.canActivate(contexte('Bearer trop-court')),
    ).rejects.toThrow(/trop court/i);
  });

  it('refuse une requête sans en-tête', async () => {
    const guard = monter(JETON);
    await expect(guard.canActivate(contexte())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('n’ouvre pas les routes administrateur', async () => {
    // Le jeton de service ne doit valoir que sur les routes qui le déclarent.
    // Ici le guard est en mode `admin` : il doit tenter une vérification JWT,
    // et le jeton de service n'en est pas un.
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue('admin') };
    const jwt = { verifyAsync: jest.fn().mockRejectedValue(new Error('nope')) };
    const guard = new AccessGuard(
      reflector as never,
      jwt as never,
      { get: () => JETON, getOrThrow: () => 'secret' } as never,
      {} as never,
    );
    await expect(
      guard.canActivate(contexte(`Bearer ${JETON}`)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwt.verifyAsync).toHaveBeenCalled();
  });
});
