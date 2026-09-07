import { ConfigService } from '@nestjs/config';
import { BadgeStatus } from '@prisma/client';
import {
  CompanyFixture,
  TestContext,
  adminAccessToken,
  createTestApp,
  seedCompany,
  seedDriver,
  uniqueSuffix,
} from './fixtures';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Rattachement d'un badge existant à un chauffeur.
 *
 * **On ne fabrique aucun badge.** Les chauffeurs ont déjà leur carte, avec un
 * numéro imprimé dessus. Tout ce que le système enregistre, c'est que ce
 * numéro-là appartient à cette personne-là — et il l'enregistre sous forme
 * d'empreinte, jamais en clair.
 *
 * Ces tests couvrent le parcours tel que le dashboard l'emprunte : la route
 * HTTP, pas le service. C'est ce qui manquait — le service était éprouvé par
 * les scénarios de scan, la route ne l'était par personne.
 */
describe('POST /v1/badges — rattachement d’un badge existant', () => {
  let ctx: TestContext;
  let company: CompanyFixture;
  let other: CompanyFixture;
  let adminToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    company = await seedCompany(ctx);
    other = await seedCompany(ctx);
    adminToken = await adminAccessToken(ctx, company);
  }, 60_000);

  afterAll(async () => {
    await ctx.app.close();
  });

  async function attach(
    userId: string,
    barcode: string,
    token = adminToken,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/badges',
      headers: { authorization: `Bearer ${token}` },
      payload: { userId, barcode },
    });
    return { status: response.statusCode, body: response.json() };
  }

  async function driver(firstName = 'Rémy', lastName = 'Simon') {
    const { user } = await seedDriver(ctx, company, {
      firstName,
      lastName,
      barcode: `9${uniqueSuffix().replace(/\D/g, '').padEnd(7, '0').slice(0, 7)}`,
    });
    return user;
  }

  it('rattache un numéro à un chauffeur', async () => {
    const { user } = await seedDriver(ctx, company, {
      firstName: 'Claire',
      lastName: 'Dubois',
      barcode: `1000${uniqueSuffix().replace(/\D/g, '').slice(0, 4).padEnd(4, '0')}`,
    });
    // Le chauffeur existe déjà avec un badge : on lui en rattache un second,
    // cas réel du badge de remplacement remis avant la restitution de l'ancien.
    const numero = '14557719';

    const { status, body } = await attach(user.id, numero);

    expect(status).toBe(201);
    expect(body.status).toBe(BadgeStatus.ACTIVE);
    expect(body.userId).toBe(user.id);
  });

  it('ne renvoie jamais le numéro en clair', async () => {
    const user = await driver('Marc', 'Lefèvre');

    const { body } = await attach(user.id, '20250131');

    // §9 de la spécification : seuls les quatre derniers chiffres sont
    // affichables. Le reste ne sort ni de la base ni de l'API.
    expect(JSON.stringify(body)).not.toContain('20250131');
    expect(body.maskedBarcode).toContain('0131');
  });

  it('conserve le numéro sous forme d’empreinte, jamais en clair', async () => {
    const user = await driver('Sophie', 'Bernard');
    const numero = '20250202';

    const { body } = await attach(user.id, numero);

    const stored = await TenantContext.system(() =>
      ctx.prisma.raw.badge.findUnique({ where: { id: body.id as string } }),
    );

    expect(stored?.barcodeHash).toBeDefined();
    expect(stored?.barcodeLast4).toBe('0202');
    // Aucune colonne ne contient la valeur : ni en texte, ni dans un champ
    // binaire lisible. Le chiffré réversible, lui, est illisible sans la clé.
    expect(JSON.stringify(stored)).not.toContain(numero);
  });

  it('refuse un numéro déjà rattaché, en disant lequel', async () => {
    const premier = await driver('Paul', 'Girard');
    const second = await driver('Léa', 'Moreau');
    const numero = '20250303';

    expect((await attach(premier.id, numero)).status).toBe(201);

    const { status, body } = await attach(second.id, numero);

    expect(status).toBe(409);
    // Le message doit être exploitable par l'opérateur — masqué, mais
    // reconnaissable : c'est ce qui lui permet de retrouver la carte.
    expect(String(body.message)).toContain('0303');
    expect(String(body.message)).not.toContain(numero);
  });

  it('accepte de nouveau un numéro après révocation', async () => {
    // Cas réel : un badge perdu est révoqué, puis retrouvé et réédité avec le
    // même numéro. Le refuser à vie obligerait à changer la carte physique.
    const user = await driver('Hugo', 'Fabre');
    const numero = '20250404';

    const first = await attach(user.id, numero);
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/badges/${first.body.id as string}/status`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: BadgeStatus.REVOKED, reason: 'perdu' },
    });

    expect((await attach(user.id, numero)).status).toBe(201);
  });

  it('normalise la saisie : espaces et tirets sont ignorés', async () => {
    // Une douchette peut ajouter un séparateur, un opérateur peut en taper un.
    // Les deux doivent désigner le même badge.
    const user = await driver('Inès', 'Roche');

    expect((await attach(user.id, '2025 05-05')).status).toBe(201);
    expect((await attach(user.id, '20250505')).status).toBe(409);
  });

  it('refuse un chauffeur d’une autre entreprise', async () => {
    // §45 : aucune donnée d'une entreprise n'est accessible par une autre. Ici
    // la faute serait silencieuse — un badge attribué à quelqu'un qu'on ne voit
    // même pas dans son propre dashboard.
    const { user } = await seedDriver(ctx, other, {
      firstName: 'Étranger',
      lastName: 'Autre',
      barcode: '30000001',
    });

    expect((await attach(user.id, '20250606')).status).toBe(404);
  });

  it('refuse une saisie trop courte pour être un badge', async () => {
    const user = await driver('Nadia', 'Perrin');

    expect((await attach(user.id, '12')).status).toBe(400);
  });

  describe('format attendu du parc', () => {
    /**
     * Sans format configuré, tout est accepté — y compris du texte collé par
     * erreur. Le badge est alors enregistré, ne scannera jamais, et devient
     * impossible à identifier puisque seuls quatre caractères restent visibles.
     *
     * Le format est une configuration et non une constante : il dépend du
     * fournisseur de badges du client (§61).
     */
    const withPattern = async <T>(pattern: string, run: () => Promise<T>): Promise<T> => {
      const config = ctx.app.get(ConfigService);
      const original = config.get<string>('BADGE_FORMAT_PATTERN');
      (config as unknown as { set: (k: string, v: unknown) => void }).set(
        'BADGE_FORMAT_PATTERN',
        pattern,
      );
      try {
        return await run();
      } finally {
        (config as unknown as { set: (k: string, v: unknown) => void }).set(
          'BADGE_FORMAT_PATTERN',
          original ?? '',
        );
      }
    };

    it('accepte du texte quelconque tant qu’aucun format n’est fixé', async () => {
      const user = await driver('Karim', 'Benali');

      expect((await attach(user.id, 'TEXTE COLLE PAR ERREUR')).status).toBe(201);
    });

    it('refuse ce qui ne suit pas le format une fois celui-ci fixé', async () => {
      const user = await driver('Alice', 'Nguyen');

      await withPattern('^[0-9]{8}$', async () => {
        const refuse = await attach(user.id, 'TEXTE COLLE PAR ERREUR 2');
        expect(refuse.status).toBe(400);
        expect(String(refuse.body.message)).toContain('format');
        // Le message ne répète jamais la saisie : elle n'a rien à faire dans
        // un journal d'erreurs.
        expect(String(refuse.body.message)).not.toContain('TEXTE');

        expect((await attach(user.id, '20250808')).status).toBe(201);
      });
    });

    it('ignore un format syntaxiquement invalide plutôt que de bloquer l’exploitation', async () => {
      // Une erreur de déploiement ne doit pas immobiliser l'enregistrement des
      // badges. Noter que « ^[0-9]{8 » ne conviendrait pas comme cas de test :
      // JavaScript l'accepte et traite « {8 » comme des caractères littéraux.
      const user = await driver('Yves', 'Colin');

      await withPattern('([0-9]', async () => {
        expect((await attach(user.id, '20250909')).status).toBe(201);
      });
    });

    it('dit quel format il attendait, pour qu’une configuration fautive se voie', async () => {
      // Un motif valide mais trop strict refuserait tous les badges. Sans
      // l'afficher, l'exploitation ne pourrait pas distinguer sa propre faute
      // de frappe d'une erreur de configuration.
      const user = await driver('Théo', 'Marchand');

      await withPattern('^[0-9]{8}$', async () => {
        const refuse = await attach(user.id, 'ABCDEFGH');
        expect(String(refuse.body.message)).toContain('[0-9]{8}');
      });
    });
  });
});
