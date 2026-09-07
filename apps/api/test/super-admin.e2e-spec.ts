import { AdminRole } from '@prisma/client';
import {
  TestContext,
  createTestApp,
  seedCompany,
  uniqueSuffix,
} from './fixtures';
import { TenantContext } from '../src/common/tenant-context';
import { newId } from '../src/common/ids';

/**
 * Compte super-administrateur, non rattaché à une entreprise.
 *
 * Ces tests existent à cause d'un défaut trouvé au premier démarrage d'une
 * installation neuve : le seul compte présent est le super-administrateur, et
 * la page d'accueil répondait **500**. Les contrôleurs écrivaient
 * `admin.companyId!` — une assertion qui ment au compilateur, et que Prisma
 * refusait ensuite avec une erreur interne.
 *
 * Un 400 qui dit quoi faire vaut mieux qu'un 500 qui dit qu'il y a un bug. Et
 * ce cas se rencontre exactement une fois par installation : à la première
 * connexion, quand personne ne sait encore si le déploiement a réussi.
 */
describe('Super-administrateur sans entreprise', () => {
  let ctx: TestContext;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();

    // Une entreprise existe, pour que les compteurs aient de quoi compter : le
    // refus ne doit pas venir d'une base vide, mais du compte lui-même.
    await seedCompany(ctx);

    const suffix = uniqueSuffix();
    const email = `super-${suffix}@test.local`;
    const password = 'TestPassword!2026';

    const hash = await ctx.tokens.hashPassword(password);
    await TenantContext.system(() =>
      ctx.prisma.raw.admin.create({
        data: {
          id: newId(),
          email,
          passwordHash: hash,
          firstName: 'Super',
          lastName: 'Admin',
          role: AdminRole.SUPER_ADMIN,
          // Le point du test : aucune entreprise.
          companyId: null,
          depotScope: [],
        },
      }),
    );

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });
    expect(login.statusCode).toBe(200);
    token = login.json().accessToken as string;
  }, 60_000);

  afterAll(async () => {
    await ctx.app.close();
  });

  const get = (url: string) =>
    ctx.app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}` },
    });

  it('se connecte, et se déclare sans entreprise', async () => {
    const me = await get('/v1/auth/me');

    expect(me.statusCode).toBe(200);
    expect(me.json().companyId).toBeNull();
    expect(me.json().role).toBe(AdminRole.SUPER_ADMIN);
  });

  it('reçoit une explication, pas une erreur interne, sur la page d’accueil', async () => {
    const response = await get('/v1/dashboard/summary');

    expect(response.statusCode).toBe(400);
    expect(String(response.json().message)).toContain('entreprise');
  });

  it.each([
    ['/v1/dashboard/summary'],
    ['/v1/dashboard/activity?days=7'],
    ['/v1/app-packages'],
  ])('%s : refus explicite plutôt qu’erreur interne', async (url) => {
    // Ces routes ont besoin d'UNE entreprise : il n'existe pas d'indicateur
    // « toutes entreprises confondues » qui veuille dire quelque chose.
    const response = await get(url);

    expect(response.statusCode).toBe(400);
    expect(String(response.json().message)).toContain('entreprise');
  });

  it.each([
    ['/v1/devices'],
    ['/v1/users'],
    ['/v1/depots'],
    ['/v1/badges'],
    ['/v1/screen-share'],
  ])('%s : liste toutes entreprises confondues', async (url) => {
    // Celles-ci sont cloisonnées par le contexte d'exécution et non par un
    // paramètre : un super-administrateur y voit l'ensemble du parc, ce qui est
    // le comportement voulu et non un oubli de filtre.
    const response = await get(url);

    expect(response.statusCode).toBe(200);
  });

  it.each([
    ['/v1/dashboard/summary'],
    ['/v1/dashboard/activity?days=7'],
    ['/v1/devices'],
    ['/v1/users'],
    ['/v1/depots'],
    ['/v1/badges'],
    ['/v1/app-packages'],
    ['/v1/screen-share'],
    ['/v1/alerts'],
    ['/v1/sessions'],
  ])('%s : jamais d’erreur serveur', async (url) => {
    // L'invariant qui compte, et celui qui manquait : quel que soit l'écran
    // ouvert par un super-administrateur, le serveur répond quelque chose
    // d'exploitable. Un 5xx ici, c'est un bug — et c'est ce qui se produisait.
    const response = await get(url);

    expect(response.statusCode).toBeLessThan(500);
  });

  it('accède quand même aux entreprises, qui sont son rôle', async () => {
    // Le super-administrateur n'est pas privé de tout : créer des entreprises
    // est précisément ce pour quoi il existe.
    const response = await get('/v1/companies');

    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json())).toBe(true);
  });
});
