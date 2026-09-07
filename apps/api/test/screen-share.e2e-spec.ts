import { ConfigService } from '@nestjs/config';
import { ScreenShareState } from '@prisma/client';
import {
  CompanyFixture,
  TestContext,
  adminAccessToken,
  createTestApp,
  deviceAccessToken,
  seedCompany,
  seedDevice,
  uniqueSuffix,
} from './fixtures';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Partage d'écran avec accord du chauffeur.
 *
 * Ces tests ne vérifient pas qu'on peut voir un écran — ils vérifient qu'on ne
 * peut PAS le voir sans accord, pas plus longtemps que prévu, et pas sans
 * laisser de trace. C'est la partie du dispositif qui a une valeur juridique
 * autant que technique.
 */
describe('Partage d’écran', () => {
  let ctx: TestContext;
  let company: CompanyFixture;
  let adminToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    company = await seedCompany(ctx);
    adminToken = await adminAccessToken(ctx, company);
  }, 60_000);

  afterAll(async () => {
    await ctx.app.close();
  });

  const REASON = 'Le chauffeur ne trouve pas le bouton de fin de tournée.';

  async function newDevice() {
    const device = await seedDevice(ctx, company, `SCR-${uniqueSuffix()}`);
    return { device, token: await deviceAccessToken(ctx, device) };
  }

  async function requestShare(deviceId: string, reason = REASON) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v1/screen-share/devices/${deviceId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { reason },
    });
    return { status: response.statusCode, body: response.json() };
  }

  async function respond(
    token: string,
    sessionId: string,
    accepted: boolean,
  ) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v1/devices/screen-share/${sessionId}/consent`,
      headers: { authorization: `Bearer ${token}` },
      payload: { accepted },
    });
    return { status: response.statusCode, body: response.json() };
  }

  async function sendFrame(token: string, sessionId: string) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v1/devices/screen-share/${sessionId}/frame`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        // Un JPEG minuscule mais réel : le contenu importe peu, le chemin oui.
        image: Buffer.from('capture-de-test').toString('base64'),
        width: 540,
        height: 1140,
      },
    });
    return { status: response.statusCode, body: response.json() };
  }

  describe('la demande', () => {
    it('crée une demande en attente, sans rien ouvrir', async () => {
      const { device } = await newDevice();

      const { status, body } = await requestShare(device.id);

      expect(status).toBe(201);
      expect(body.state).toBe(ScreenShareState.REQUESTED);
      // Le partage n'a pas commencé : le chauffeur n'a pas encore répondu.
      expect(body.respondedAt).toBeNull();
      expect(body.frameCount).toBe(0);
    });

    it('exige un motif, et le transmet tel quel au téléphone', async () => {
      const { device, token } = await newDevice();

      const trop_court = await requestShare(device.id, 'aide');
      expect(trop_court.status).toBe(400);

      const { body } = await requestShare(device.id);
      const vu = await ctx.app.inject({
        method: 'GET',
        url: '/v1/devices/screen-share/current',
        headers: { authorization: `Bearer ${token}` },
      });

      // Le chauffeur décide en sachant pourquoi : le motif ne doit être ni
      // reformulé ni tronqué entre la saisie et l'écran du téléphone.
      expect(vu.json().reason).toBe(REASON);
      expect(vu.json().id).toBe(body.id);
    });

    it('émet une commande de réveil vers le téléphone', async () => {
      const { device, token } = await newDevice();
      await requestShare(device.id);

      const commands = await ctx.app.inject({
        method: 'GET',
        url: '/v1/devices/commands',
        headers: { authorization: `Bearer ${token}` },
      });

      const pending = commands.json() as Array<{ command: string; payload: unknown }>;
      const demande = pending.find((c) => c.command === 'REQUEST_SCREEN_SHARE');
      expect(demande).toBeDefined();
      expect((demande!.payload as { reason: string }).reason).toBe(REASON);
    });

    it('refuse un second partage sur un téléphone qui en a déjà un', async () => {
      // Deux partages simultanés rendraient impossible de dire à qui l'écran a
      // été montré.
      const { device } = await newDevice();
      expect((await requestShare(device.id)).status).toBe(201);

      const second = await requestShare(device.id);
      expect(second.status).toBe(400);
    });

    it('n’expose pas le téléphone d’une autre entreprise', async () => {
      const autre = await seedCompany(ctx);
      const etranger = await seedDevice(ctx, autre, `OTH-${uniqueSuffix()}`);

      expect((await requestShare(etranger.id)).status).toBe(404);
    });
  });

  describe('l’accord du chauffeur', () => {
    it('ouvre le partage quand le chauffeur accepte', async () => {
      const { device, token } = await newDevice();
      const { body } = await requestShare(device.id);

      const reponse = await respond(token, body.id as string, true);

      expect(reponse.status).toBe(200);
      expect(reponse.body.state).toBe(ScreenShareState.ACCEPTED);
      expect(reponse.body.respondedAt).not.toBeNull();
    });

    it('ferme définitivement le partage quand le chauffeur refuse', async () => {
      const { device, token } = await newDevice();
      const { body } = await requestShare(device.id);

      const refus = await respond(token, body.id as string, false);
      expect(refus.body.state).toBe(ScreenShareState.REFUSED);

      // Un refus ne se rouvre pas : il faut une nouvelle demande, donc une
      // nouvelle décision.
      const insistance = await respond(token, body.id as string, true);
      expect(insistance.status).toBe(400);
    });

    it('n’est donnable que par le téléphone concerné', async () => {
      // Le point le plus important du dispositif : personne d'autre que le
      // porteur du téléphone ne peut donner cet accord.
      const { device } = await newDevice();
      const { token: autreToken } = await newDevice();
      const { body } = await requestShare(device.id);

      expect((await respond(autreToken, body.id as string, true)).status).toBe(404);
    });

    it('n’est pas donnable par un administrateur', async () => {
      const { device } = await newDevice();
      const { body } = await requestShare(device.id);

      const tentative = await ctx.app.inject({
        method: 'POST',
        url: `/v1/devices/screen-share/${body.id as string}/consent`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { accepted: true },
      });

      expect(tentative.statusCode).toBe(401);
    });
  });

  describe('les images', () => {
    it('accepte une capture pendant un partage accordé', async () => {
      const { device, token } = await newDevice();
      const { body } = await requestShare(device.id);
      await respond(token, body.id as string, true);

      const image = await sendFrame(token, body.id as string);

      expect(image.status).toBe(200);
      expect(image.body.sequence).toBe(1);
    });

    it('refuse toute capture avant la réponse du chauffeur', async () => {
      const { device, token } = await newDevice();
      const { body } = await requestShare(device.id);

      const image = await sendFrame(token, body.id as string);

      expect(image.status).toBe(403);
      expect(String(image.body.message)).toContain('pas encore répondu');
    });

    it('refuse toute capture après un refus', async () => {
      const { device, token } = await newDevice();
      const { body } = await requestShare(device.id);
      await respond(token, body.id as string, false);

      expect((await sendFrame(token, body.id as string)).status).toBe(403);
    });

    it('refuse toute capture après la fin du partage', async () => {
      const { device, token } = await newDevice();
      const { body } = await requestShare(device.id);
      await respond(token, body.id as string, true);
      expect((await sendFrame(token, body.id as string)).status).toBe(200);

      await ctx.app.inject({
        method: 'POST',
        url: `/v1/devices/screen-share/${body.id as string}/stop`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });

      expect((await sendFrame(token, body.id as string)).status).toBe(403);
    });

    it('refuse toute capture une fois la durée maximale atteinte', async () => {
      // La garantie qui distingue une assistance d'une surveillance : la séance
      // se ferme seule, sans que personne n'ait à y penser.
      const { device, token } = await newDevice();
      const { body } = await requestShare(device.id);
      await respond(token, body.id as string, true);

      await TenantContext.system(() =>
        ctx.prisma.raw.screenShareSession.update({
          where: { id: body.id as string },
          data: { expiresAt: new Date(Date.now() - 1000) },
        }),
      );

      const image = await sendFrame(token, body.id as string);
      expect(image.status).toBe(403);
      expect(String(image.body.message)).toContain('durée maximale');
    });

    it('refuse une image trop volumineuse', async () => {
      const { device, token } = await newDevice();
      const { body } = await requestShare(device.id);
      await respond(token, body.id as string, true);

      const config = ctx.app.get(ConfigService);
      const max = config.get<number>('SCREEN_SHARE_MAX_FRAME_BYTES', 400_000);

      const response = await ctx.app.inject({
        method: 'POST',
        url: `/v1/devices/screen-share/${body.id as string}/frame`,
        headers: { authorization: `Bearer ${token}` },
        payload: { image: 'A'.repeat(max + 1), width: 540, height: 1140 },
      });

      expect(response.statusCode).toBe(400);
    });

    it('ne conserve aucune image, seulement leur nombre', async () => {
      // Le cœur du dispositif. Si une image se retrouvait en base, cet outil
      // changerait de nature — et de qualification juridique.
      const { device, token } = await newDevice();
      const { body } = await requestShare(device.id);
      await respond(token, body.id as string, true);
      await sendFrame(token, body.id as string);
      await sendFrame(token, body.id as string);

      const stored = await TenantContext.system(() =>
        ctx.prisma.raw.screenShareSession.findUnique({
          where: { id: body.id as string },
        }),
      );

      expect(stored?.frameCount).toBe(2);
      expect(JSON.stringify(stored)).not.toContain(
        Buffer.from('capture-de-test').toString('base64'),
      );
    });
  });

  describe('la fin de séance', () => {
    it('peut être coupée par le chauffeur à tout moment', async () => {
      // Un consentement qu'on ne peut pas retirer n'en est plus un.
      const { device, token } = await newDevice();
      const { body } = await requestShare(device.id);
      await respond(token, body.id as string, true);

      const arret = await ctx.app.inject({
        method: 'POST',
        url: `/v1/devices/screen-share/${body.id as string}/stop`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });

      expect(arret.statusCode).toBe(200);
      expect(arret.json().state).toBe(ScreenShareState.ENDED_BY_DRIVER);
    });

    it('peut être coupée par l’exploitation', async () => {
      const { device, token } = await newDevice();
      const { body } = await requestShare(device.id);
      await respond(token, body.id as string, true);

      const arret = await ctx.app.inject({
        method: 'POST',
        url: `/v1/screen-share/${body.id as string}/stop`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(arret.json().state).toBe(ScreenShareState.ENDED_BY_ADMIN);
    });

    it('supporte un arrêt rejoué sans erreur', async () => {
      // Arrive quand le chauffeur coupe au moment où l'administrateur ferme sa
      // fenêtre. Ce n'est la faute de personne.
      const { device, token } = await newDevice();
      const { body } = await requestShare(device.id);
      await respond(token, body.id as string, true);

      const url = `/v1/screen-share/${body.id as string}/stop`;
      const premier = await ctx.app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const second = await ctx.app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(premier.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json().state).toBe(ScreenShareState.ENDED_BY_ADMIN);
    });

    it('remonte un échec de capture comme un échec, pas comme un écran vide', async () => {
      const { device, token } = await newDevice();
      const { body } = await requestShare(device.id);
      await respond(token, body.id as string, true);

      const echec = await ctx.app.inject({
        method: 'POST',
        url: `/v1/devices/screen-share/${body.id as string}/failed`,
        headers: { authorization: `Bearer ${token}` },
        payload: { detail: 'MediaProjection refusé par le système.' },
      });

      expect(echec.json().state).toBe(ScreenShareState.FAILED);
      expect(echec.json().detail).toContain('MediaProjection');
    });

    it('cesse d’être « en cours » une fois l’échéance passée', async () => {
      const { device, token } = await newDevice();
      const { body } = await requestShare(device.id);

      await TenantContext.system(() =>
        ctx.prisma.raw.screenShareSession.update({
          where: { id: body.id as string },
          data: { expiresAt: new Date(Date.now() - 1000) },
        }),
      );

      // Le téléphone ne doit pas afficher une demande périmée : il répondrait à
      // une question que plus personne ne pose.
      const courant = await ctx.app.inject({
        method: 'GET',
        url: '/v1/devices/screen-share/current',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(courant.json()).toBeNull();

      const stored = await TenantContext.system(() =>
        ctx.prisma.raw.screenShareSession.findUnique({
          where: { id: body.id as string },
        }),
      );
      expect(stored?.state).toBe(ScreenShareState.EXPIRED);
    });
  });

  describe('la trace', () => {
    it('conserve qui a demandé, pourquoi, et ce qui a été répondu', async () => {
      const { device, token } = await newDevice();
      const { body } = await requestShare(device.id);
      await respond(token, body.id as string, false);

      const historique = await ctx.app.inject({
        method: 'GET',
        url: `/v1/screen-share?deviceId=${device.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const entry = historique.json().items[0];
      expect(entry.reason).toBe(REASON);
      expect(entry.state).toBe(ScreenShareState.REFUSED);
      expect(entry.requestedBy.id).toBe(company.adminId);
    });

    it('journalise la demande et la réponse dans le journal d’audit', async () => {
      const { device, token } = await newDevice();
      const { body } = await requestShare(device.id);
      await respond(token, body.id as string, true);

      const logs = await TenantContext.system(() =>
        ctx.prisma.raw.auditLog.findMany({
          where: { resourceId: body.id as string },
          orderBy: { createdAt: 'asc' },
        }),
      );

      const actions = logs.map((l) => l.action);
      expect(actions).toContain('ADMIN_REQUEST_SCREEN_SHARE');
      expect(actions).toContain('DRIVER_ACCEPT_SCREEN_SHARE');
    });
  });
});
