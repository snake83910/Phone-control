import { AdminRole, AdminStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  CompanyFixture,
  TestContext,
  createTestApp,
  seedCompany,
  uniqueSuffix,
} from './fixtures';
import { AdminAuthService } from '../src/auth/admin-auth.service';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Authentification unique depuis Trajelys.
 *
 * La vérification cryptographique du jeton est l'affaire de `jose` et du JWKS
 * de Supabase ; ce qui se teste ici est ce qui nous appartient : le
 * rattachement à une entreprise, le provisionnement au premier passage, et
 * surtout le fait que l'ouverture du SSO ne crée pas de porte parallèle par
 * mot de passe.
 */
describe('Authentification unique Trajelys', () => {
  let ctx: TestContext;
  let auth: AdminAuthService;

  beforeAll(async () => {
    ctx = await createTestApp();
    auth = ctx.app.get(AdminAuthService);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  async function rattacher(company: CompanyFixture, userId: string) {
    await TenantContext.system(() =>
      ctx.prisma.raw.company.update({
        where: { id: company.company.id },
        data: { trajelysUserId: userId, trajelysDspId: randomUUID() },
      }),
    );
  }

  it('refuse un compte Trajelys non rattaché à une entreprise', async () => {
    // C'est le contrôle qui empêche n'importe quel titulaire d'un compte
    // Supabase de se provisionner une entreprise ici en s'inscrivant sur
    // Trajelys. Le rattachement est un acte commercial, pas un effet de bord.
    await expect(
      TenantContext.system(() =>
        auth.connecterParTrajelys({ userId: randomUUID(), email: 'inconnu@test.local' }),
      ),
    ).rejects.toThrow(/Aucune entreprise/);
  });

  it('crée l’administrateur au premier passage, et le réutilise ensuite', async () => {
    const company = await seedCompany(ctx);
    const userId = randomUUID();
    await rattacher(company, userId);

    const premiere = await TenantContext.system(() =>
      auth.connecterParTrajelys({ userId, email: `sso-${uniqueSuffix()}@test.local` }),
    );
    expect(premiere.accessToken).toBeTruthy();

    const admins = await TenantContext.system(() =>
      ctx.prisma.raw.admin.findMany({ where: { trajelysUserId: userId } }),
    );
    expect(admins).toHaveLength(1);
    expect(admins[0].companyId).toBe(company.company.id);
    expect(admins[0].role).toBe(AdminRole.COMPANY_ADMIN);
    expect(admins[0].ssoOnly).toBe(true);

    // Deuxième connexion : aucun doublon, sinon chaque ouverture de session
    // créerait un administrateur de plus dans la liste du client.
    await TenantContext.system(() => auth.connecterParTrajelys({ userId }));
    const apres = await TenantContext.system(() =>
      ctx.prisma.raw.admin.findMany({ where: { trajelysUserId: userId } }),
    );
    expect(apres).toHaveLength(1);
  });

  it('n’ouvre JAMAIS un compte SSO par mot de passe', async () => {
    // Le défaut que cette fonctionnalité aurait pu introduire : des comptes
    // supplémentaires, jamais destinés à la connexion directe, avec un
    // hachage que plus personne ne surveille.
    const company = await seedCompany(ctx);
    const userId = randomUUID();
    await rattacher(company, userId);

    const email = `sso-${uniqueSuffix()}@test.local`;
    await TenantContext.system(() => auth.connecterParTrajelys({ userId, email }));

    // Même en lui imposant un mot de passe connu, le compte reste fermé.
    const motDePasse = 'MotDePasseConnu!2026';
    const hachage = await ctx.tokens.hashPassword(motDePasse);
    await TenantContext.system(() =>
      ctx.prisma.raw.admin.update({
        where: { trajelysUserId: userId },
        data: { passwordHash: hachage },
      }),
    );

    await expect(
      TenantContext.system(() => auth.login(email, motDePasse)),
    ).rejects.toThrow(/Identifiants invalides/);
  });

  it('refuse un compte désactivé dans ce produit', async () => {
    // L'authentification unique ne doit pas servir de contournement à une
    // exclusion décidée ici : un manager écarté de Phone Control le reste,
    // même s'il garde une session Trajelys valide.
    const company = await seedCompany(ctx);
    const userId = randomUUID();
    await rattacher(company, userId);

    await TenantContext.system(() => auth.connecterParTrajelys({ userId }));
    await TenantContext.system(() =>
      ctx.prisma.raw.admin.update({
        where: { trajelysUserId: userId },
        data: { status: AdminStatus.DISABLED },
      }),
    );

    await expect(
      TenantContext.system(() => auth.connecterParTrajelys({ userId })),
    ).rejects.toThrow(/inactif/);
  });

  it('cloisonne : deux comptes Trajelys mènent à deux entreprises distinctes', async () => {
    const a = await seedCompany(ctx);
    const b = await seedCompany(ctx);
    const userA = randomUUID();
    const userB = randomUUID();
    await rattacher(a, userA);
    await rattacher(b, userB);

    await TenantContext.system(() => auth.connecterParTrajelys({ userId: userA }));
    await TenantContext.system(() => auth.connecterParTrajelys({ userId: userB }));

    const adminA = await TenantContext.system(() =>
      ctx.prisma.raw.admin.findUniqueOrThrow({ where: { trajelysUserId: userA } }),
    );
    const adminB = await TenantContext.system(() =>
      ctx.prisma.raw.admin.findUniqueOrThrow({ where: { trajelysUserId: userB } }),
    );

    expect(adminA.companyId).toBe(a.company.id);
    expect(adminB.companyId).toBe(b.company.id);
    expect(adminA.companyId).not.toBe(adminB.companyId);
  });

  it('la route HTTP refuse proprement quand Trajelys n’est pas configuré', async () => {
    // Une installation qui ne vend pas le module n'a aucune raison de
    // configurer Trajelys. L'échange doit alors répondre « non autorisé » et
    // non planter : un 500 sur une route publique est une invitation à
    // insister.
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/trajelys',
      payload: { token: 'a'.repeat(40) },
    });

    expect(res.statusCode).toBe(401);
    expect(res.statusCode).not.toBe(500);
  });

  it('la route HTTP valide sa charge utile', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/trajelys',
      payload: { token: 'court' },
    });

    expect(res.statusCode).toBe(400);
  });
});
