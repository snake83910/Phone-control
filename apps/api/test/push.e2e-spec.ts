import { ConfigService } from '@nestjs/config';
import { CommandType } from '@prisma/client';
import {
  CompanyFixture,
  TestContext,
  createTestApp,
  deviceAccessToken,
  seedCompany,
  seedDevice,
  uniqueSuffix,
} from './fixtures';
import { PushService } from '../src/push/push.service';
import { CommandsService } from '../src/devices/commands.service';
import type { PushResult, PushTransport, WakePayload } from '../src/push/fcm';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Réveil des téléphones.
 *
 * Ce que ces tests vérifient est la **décision** : faut-il envoyer un message, à
 * quel jeton, et à quelle fréquence. Le transport est remplacé par un enregistreur
 * — non pas pour éviter le réseau, mais parce qu'il n'existe aucun projet
 * Firebase auquel parler (prérequis P4 de docs/08). La forme des messages, elle,
 * est vérifiée dans `src/push/fcm.spec.ts`, signature comprise.
 *
 * La propriété qui compte : **aucun de ces chemins ne peut faire échouer une
 * commande.** Le sondage périodique du téléphone reste le canal fiable.
 */
class RecordingTransport implements PushTransport {
  readonly name = 'enregistreur';
  configured = true;
  readonly sent: Array<{ token: string; payload: WakePayload }> = [];
  nextResult: PushResult = { ok: true };

  async send(token: string, payload: WakePayload): Promise<PushResult> {
    this.sent.push({ token, payload });
    return this.nextResult;
  }
}

describe('Réveil des téléphones', () => {
  let ctx: TestContext;
  let company: CompanyFixture;
  let transport: RecordingTransport;
  let push: PushService;

  beforeAll(async () => {
    ctx = await createTestApp();
    company = await seedCompany(ctx);
  }, 60_000);

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(() => {
    transport = new RecordingTransport();
    push = new PushService(ctx.prisma, ctx.app.get(ConfigService), transport);
  });

  async function deviceWithToken(token: string | null) {
    const device = await seedDevice(ctx, company, `TEL-PUSH-${uniqueSuffix()}`);
    if (token) {
      await TenantContext.system(() =>
        ctx.prisma.raw.device.update({ where: { id: device.id }, data: { fcmToken: token } }),
      );
    }
    return device;
  }

  it('réveille un téléphone qui a remonté un jeton', async () => {
    const device = await deviceWithToken('jeton-abc');

    expect(await push.wake(device.id, { reason: 'LOCK_DEVICE' })).toBe(true);
    expect(transport.sent).toEqual([
      { token: 'jeton-abc', payload: { reason: 'LOCK_DEVICE' } },
    ]);
  });

  it('n’envoie rien à un téléphone sans jeton', async () => {
    // Terminal d'entreprise sans services Google : cas prévu, pas une panne.
    const device = await deviceWithToken(null);

    expect(await push.wake(device.id, { reason: 'LOCK_DEVICE' })).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });

  it('n’envoie rien quand aucun transport n’est configuré', async () => {
    const device = await deviceWithToken('jeton-abc');
    transport.configured = false;

    expect(await push.wake(device.id, { reason: 'LOCK_DEVICE' })).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });

  it('n’envoie qu’un message pour une rafale de commandes', async () => {
    // Verrouiller, synchroniser, verrouiller à nouveau : le premier réveil
    // suffit, le téléphone récupère toute la file d'un coup.
    const device = await deviceWithToken('jeton-abc');
    const now = Date.now();

    await push.wake(device.id, { reason: 'LOCK_DEVICE' }, now);
    await push.wake(device.id, { reason: 'REFRESH_CONFIGURATION' }, now + 1_000);
    await push.wake(device.id, { reason: 'FORCE_LOGOUT' }, now + 29_000);

    expect(transport.sent).toHaveLength(1);
  });

  it('réveille de nouveau une fois l’intervalle écoulé', async () => {
    const device = await deviceWithToken('jeton-abc');
    const now = Date.now();

    await push.wake(device.id, { reason: 'A' }, now);
    await push.wake(device.id, { reason: 'B' }, now + PushService.MIN_INTERVAL_MS);

    expect(transport.sent).toHaveLength(2);
  });

  it('étrangle chaque téléphone séparément', async () => {
    const first = await deviceWithToken('jeton-1');
    const second = await deviceWithToken('jeton-2');
    const now = Date.now();

    await push.wake(first.id, { reason: 'A' }, now);
    await push.wake(second.id, { reason: 'A' }, now + 1_000);

    expect(transport.sent.map((s) => s.token)).toEqual(['jeton-1', 'jeton-2']);
  });

  it('ne lève pas sur un appareil inconnu', async () => {
    expect(
      await push.wake('0195e9f0-0000-7000-8000-000000000999', { reason: 'X' }),
    ).toBe(false);
  });

  it('signale un envoi refusé sans le faire échouer', async () => {
    const device = await deviceWithToken('jeton-perime');
    transport.nextResult = { ok: false, detail: 'jeton FCM rejeté (HTTP 404)' };

    expect(await push.wake(device.id, { reason: 'X' })).toBe(false);
    expect(transport.sent).toHaveLength(1);
  });

  describe('jeton remonté par le téléphone', () => {
    it('est enregistré au heartbeat', async () => {
      const device = await seedDevice(ctx, company, `TEL-HB-${uniqueSuffix()}`);
      const token = await deviceAccessToken(ctx, device);

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/devices/heartbeat',
        headers: { authorization: `Bearer ${token}` },
        payload: { deviceId: device.id, battery: 72, fcmToken: 'jeton-du-heartbeat' },
      });

      expect(response.statusCode).toBe(200);

      const stored = await TenantContext.system(() =>
        ctx.prisma.raw.device.findUnique({ where: { id: device.id } }),
      );
      expect(stored?.fcmToken).toBe('jeton-du-heartbeat');
    });

    it('n’est pas effacé par un heartbeat qui n’en contient pas', async () => {
      // Un terminal peut envoyer un heartbeat allégé ; perdre le jeton à cette
      // occasion priverait l'appareil de réveil rapide sans raison.
      const device = await deviceWithToken('jeton-conserve');
      const token = await deviceAccessToken(ctx, device);

      await ctx.app.inject({
        method: 'POST',
        url: '/v1/devices/heartbeat',
        headers: { authorization: `Bearer ${token}` },
        payload: { deviceId: device.id, battery: 50 },
      });

      const stored = await TenantContext.system(() =>
        ctx.prisma.raw.device.findUnique({ where: { id: device.id } }),
      );
      expect(stored?.fcmToken).toBe('jeton-conserve');
    });
  });

  describe('déclenchement par une commande', () => {
    it('une commande mise en file réveille son téléphone', async () => {
      const device = await deviceWithToken('jeton-commande');
      const commands = new CommandsService(ctx.prisma, push);

      const command = await TenantContext.system(() =>
        commands.enqueue({
          companyId: company.company.id,
          deviceId: device.id,
          command: CommandType.LOCK_DEVICE,
        }),
      );

      // `wake` n'est pas attendu par `enqueue` : on laisse la microtâche passer.
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0].payload).toEqual({
        reason: 'LOCK_DEVICE',
        commandId: command.id,
      });
    });

    it('la commande existe même si le réveil échoue', async () => {
      const device = await deviceWithToken('jeton-commande');
      transport.nextResult = { ok: false, detail: 'HTTP 500' };
      const commands = new CommandsService(ctx.prisma, push);

      const command = await TenantContext.system(() =>
        commands.enqueue({
          companyId: company.company.id,
          deviceId: device.id,
          command: CommandType.LOCK_DEVICE,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      const stored = await TenantContext.system(() =>
        ctx.prisma.raw.deviceCommand.findUnique({ where: { id: command.id } }),
      );
      expect(stored).not.toBeNull();
    });
  });

  it('le service câblé par Nest est désactivé faute de projet Firebase', () => {
    // Constat, pas reproche : sans FCM_SERVICE_ACCOUNT, le réveil rapide
    // n'existe pas et le sondage périodique fait tout le travail.
    expect(ctx.app.get(PushService).configured).toBe(false);
  });
});
