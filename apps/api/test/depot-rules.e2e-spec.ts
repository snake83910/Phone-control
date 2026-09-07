import { randomUUID } from 'node:crypto';
import { CommandStatus, SessionState, SessionStatus } from '@prisma/client';
import {
  CompanyFixture,
  TestContext,
  adminAccessToken,
  createTestApp,
  deviceAccessToken,
  seedCompany,
  seedDevice,
  seedDriver,
} from './fixtures';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Scénarios 4 à 8 de la section 59 de la spécification :
 * retour au dépôt à 18h15, alerte de sortie, verrouillage à 22h,
 * fonctionnement hors ligne et resynchronisation.
 *
 * Les événements sont envoyés tels que le téléphone les enverrait, avec leurs
 * horodatages réels : c'est le serveur qui applique la règle horaire.
 */
describe('Règles de dépôt, alertes et commandes', () => {
  let ctx: TestContext;
  let company: CompanyFixture;

  beforeAll(async () => {
    ctx = await createTestApp();
    company = await seedCompany(ctx);
  }, 60_000);

  afterAll(async () => {
    await ctx.app.close();
  });

  async function openSession(deviceTag: string, barcode: string) {
    const device = await seedDevice(ctx, company, deviceTag);
    const { user } = await seedDriver(ctx, company, {
      firstName: 'Rémy',
      lastName: 'Simon',
      barcode,
      devices: [device],
    });
    const token = await deviceAccessToken(ctx, device);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/barcode',
      headers: { authorization: `Bearer ${token}` },
      payload: { barcode, deviceId: device.id },
    });
    expect(res.json().success).toBe(true);

    return { device, user, token, sessionId: res.json().session.id as string };
  }

  function geofenceEvent(params: {
    type: 'ENTER_DEPOT' | 'EXIT_DEPOT';
    at: string;
    seq: number;
  }) {
    return {
      eventId: randomUUID(),
      seq: params.seq,
      kind: 'GEOFENCE',
      occurredAt: params.at,
      geofenceEventType: params.type,
      latitude: 43.296482,
      longitude: 5.36978,
      accuracyMeters: 12,
      confidence: 0.95,
      evaluation: {
        samples: 3,
        windowSeconds: 120,
        note: 'trois mesures cohérentes',
      },
    };
  }

  async function pushEvents(
    token: string,
    deviceId: string,
    events: unknown[],
  ) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/sync/events',
      headers: { authorization: `Bearer ${token}` },
      payload: { deviceId, events },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  // -------------------------------------------------------------------------

  it('TEST 4 — entrée au dépôt à 18h15 : le téléphone passe à RETURNED', async () => {
    const { device, token, sessionId } = await openSession('TEL-D1', '50000001');

    await pushEvents(token, device.id, [
      geofenceEvent({ type: 'ENTER_DEPOT', at: '2026-09-07T18:15:00+02:00', seq: 1 }),
    ]);

    const session = await TenantContext.system(() =>
      ctx.prisma.raw.session.findUniqueOrThrow({ where: { id: sessionId } }),
    );

    expect(session.state).toBe(SessionState.RETURNED);
    expect(session.returnedAt?.toISOString()).toBe('2026-09-07T16:15:00.000Z');
    expect(session.returnedLatitude).toBeCloseTo(43.296482, 5);

    const event = await TenantContext.system(() =>
      ctx.prisma.raw.geofenceEvent.findFirst({ where: { deviceId: device.id } }),
    );
    // Le serveur a requalifié l'événement : le téléphone avait annoncé une
    // simple entrée, la règle horaire en fait un retour.
    expect(event?.eventType).toBe('ENTER_DEPOT_AFTER_RETURN_TIME');
    // Les mesures ayant conduit à la décision sont conservées.
    expect(event?.evaluation).toMatchObject({ samples: 3 });
  });

  it('entrée à 17h30 : pas de retour, aucune alerte possible ensuite', async () => {
    const { device, token, sessionId } = await openSession('TEL-D2', '50000002');

    await pushEvents(token, device.id, [
      geofenceEvent({ type: 'ENTER_DEPOT', at: '2026-09-07T17:30:00+02:00', seq: 1 }),
      geofenceEvent({ type: 'EXIT_DEPOT', at: '2026-09-07T17:45:00+02:00', seq: 2 }),
    ]);

    const session = await TenantContext.system(() =>
      ctx.prisma.raw.session.findUniqueOrThrow({ where: { id: sessionId } }),
    );
    expect(session.state).toBe(SessionState.ACTIVE);
    expect(session.returnedAt).toBeNull();

    const alerts = await TenantContext.system(() =>
      ctx.prisma.raw.alert.findMany({
        where: { deviceId: device.id, type: 'AFTER_RETURN_EXIT' },
      }),
    );
    expect(alerts).toHaveLength(0);
  });

  it('TEST 5 — sortie à 19h00 après un retour : ALERTE', async () => {
    const { device, token, sessionId, user } = await openSession('TEL-D3', '50000003');

    await pushEvents(token, device.id, [
      geofenceEvent({ type: 'ENTER_DEPOT', at: '2026-09-07T18:17:00+02:00', seq: 1 }),
    ]);
    await pushEvents(token, device.id, [
      geofenceEvent({ type: 'EXIT_DEPOT', at: '2026-09-07T19:42:00+02:00', seq: 2 }),
    ]);

    const alert = await TenantContext.system(() =>
      ctx.prisma.raw.alert.findFirst({
        where: { deviceId: device.id, type: 'AFTER_RETURN_EXIT' },
      }),
    );

    expect(alert).not.toBeNull();
    expect(alert?.severity).toBe('HIGH');
    expect(alert?.userId).toBe(user.id);
    expect(alert?.message).toContain('après avoir été marqué');
    // L'heure locale du dépôt figure dans le contexte : une alerte lue à 3 h du
    // matin doit être compréhensible sans conversion mentale d'UTC.
    expect(alert?.context).toMatchObject({ localTime: expect.any(String) });

    const session = await TenantContext.system(() =>
      ctx.prisma.raw.session.findUniqueOrThrow({ where: { id: sessionId } }),
    );
    // L'alerte n'est pas un état bloquant : la session redevient active.
    expect(session.state).toBe(SessionState.ACTIVE);
    expect(session.status).toBe(SessionStatus.ACTIVE);
  });

  it('l’alerte de sortie après retour n’est créée qu’une fois', async () => {
    const { device, token } = await openSession('TEL-D4', '50000004');

    await pushEvents(token, device.id, [
      geofenceEvent({ type: 'ENTER_DEPOT', at: '2026-09-07T18:10:00+02:00', seq: 1 }),
    ]);
    await pushEvents(token, device.id, [
      geofenceEvent({ type: 'EXIT_DEPOT', at: '2026-09-07T18:30:00+02:00', seq: 2 }),
    ]);
    await pushEvents(token, device.id, [
      geofenceEvent({ type: 'ENTER_DEPOT', at: '2026-09-07T18:50:00+02:00', seq: 3 }),
    ]);
    await pushEvents(token, device.id, [
      geofenceEvent({ type: 'EXIT_DEPOT', at: '2026-09-07T19:10:00+02:00', seq: 4 }),
    ]);

    const alerts = await TenantContext.system(() =>
      ctx.prisma.raw.alert.findMany({
        where: { deviceId: device.id, type: 'AFTER_RETURN_EXIT' },
      }),
    );
    // Deux sorties après retour, mais une seule alerte ouverte : sans cette
    // déduplication, un aller-retour au portail en produirait des dizaines.
    expect(alerts).toHaveLength(1);
  });

  it('TEST 8 — rejeu d’un lot après une réponse perdue : aucun doublon', async () => {
    const { device, token } = await openSession('TEL-D5', '50000005');

    const batch = [
      geofenceEvent({ type: 'ENTER_DEPOT', at: '2026-09-07T18:20:00+02:00', seq: 1 }),
      {
        eventId: randomUUID(),
        seq: 2,
        kind: 'LOCATION',
        occurredAt: '2026-09-07T18:21:00+02:00',
        latitude: 43.2965,
        longitude: 5.3698,
        accuracyMeters: 8,
        batteryLevel: 72,
      },
    ];

    const first = await pushEvents(token, device.id, batch);
    expect(first.ackedEventIds).toHaveLength(2);

    // Le téléphone n'a pas reçu la réponse : il renvoie exactement le même lot.
    const second = await pushEvents(token, device.id, batch);
    expect(second.ackedEventIds).toHaveLength(2);

    const [geofenceEvents, locations] = await TenantContext.system(() =>
      Promise.all([
        ctx.prisma.raw.geofenceEvent.count({ where: { deviceId: device.id } }),
        ctx.prisma.raw.locationEvent.count({ where: { deviceId: device.id } }),
      ]),
    );

    expect(geofenceEvents).toBe(1);
    expect(locations).toBe(1);
  });

  it('les positions alimentent la dernière position connue de l’appareil', async () => {
    const { device, token } = await openSession('TEL-D6', '50000006');

    await pushEvents(token, device.id, [
      {
        eventId: randomUUID(),
        seq: 1,
        kind: 'LOCATION',
        occurredAt: '2026-09-07T10:00:00+02:00',
        latitude: 43.2,
        longitude: 5.3,
        accuracyMeters: 20,
      },
      {
        eventId: randomUUID(),
        seq: 2,
        kind: 'LOCATION',
        occurredAt: '2026-09-07T11:00:00+02:00',
        latitude: 43.4,
        longitude: 5.5,
        accuracyMeters: 10,
      },
    ]);

    const refreshed = await TenantContext.system(() =>
      ctx.prisma.raw.device.findUniqueOrThrow({ where: { id: device.id } }),
    );

    // La plus récente, pas la dernière reçue.
    expect(refreshed.lastLatitude).toBeCloseTo(43.4, 5);
    expect(refreshed.lastLocationAt?.toISOString()).toBe('2026-09-07T09:00:00.000Z');
  });

  it('une position simulée déclenche un événement de sécurité et une alerte', async () => {
    const { device, token } = await openSession('TEL-D7', '50000007');

    await pushEvents(token, device.id, [
      {
        eventId: randomUUID(),
        seq: 1,
        kind: 'LOCATION',
        occurredAt: '2026-09-07T12:00:00+02:00',
        latitude: 48.8566,
        longitude: 2.3522,
        accuracyMeters: 5,
        isMock: true,
      },
    ]);

    const [event, alert] = await TenantContext.system(() =>
      Promise.all([
        ctx.prisma.raw.securityEvent.findFirst({
          where: { deviceId: device.id, type: 'MOCK_LOCATION' },
        }),
        ctx.prisma.raw.alert.findFirst({
          where: { deviceId: device.id, type: 'DEVICE_TAMPERING' },
        }),
      ]),
    );

    expect(event).not.toBeNull();
    expect(alert?.severity).toBe('HIGH');
  });

  it('TEST 6 — commande de verrouillage : émise, récupérée, acquittée', async () => {
    const { device, token, sessionId } = await openSession('TEL-D8', '50000008');
    const adminToken = await adminAccessToken(ctx, company);

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/v1/devices/${device.id}/commands`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { command: 'LOCK_DEVICE', idempotencyKey: 'lock-22h-test' },
    });
    expect(created.statusCode).toBe(201);
    const commandId = created.json().id as string;

    // Idempotence : le planificateur peut réémettre sans créer de doublon.
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/v1/devices/${device.id}/commands`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { command: 'LOCK_DEVICE', idempotencyKey: 'lock-22h-test' },
    });
    expect(again.json().id).toBe(commandId);

    const pulled = await ctx.app.inject({
      method: 'GET',
      url: '/v1/devices/commands',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(pulled.statusCode).toBe(200);
    expect(pulled.json().map((c: { id: string }) => c.id)).toContain(commandId);

    const ack = await ctx.app.inject({
      method: 'POST',
      url: `/v1/devices/commands/${commandId}/result`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'EXECUTED' },
    });
    expect(ack.statusCode).toBe(204);

    const [command, session, refreshed] = await TenantContext.system(() =>
      Promise.all([
        ctx.prisma.raw.deviceCommand.findUniqueOrThrow({ where: { id: commandId } }),
        ctx.prisma.raw.session.findUniqueOrThrow({ where: { id: sessionId } }),
        ctx.prisma.raw.device.findUniqueOrThrow({ where: { id: device.id } }),
      ]),
    );

    expect(command.status).toBe(CommandStatus.EXECUTED);
    // L'effet de bord n'est appliqué qu'à l'acquittement : tant que le
    // téléphone n'a pas confirmé, le serveur ne le déclare pas verrouillé.
    expect(session.status).toBe(SessionStatus.ENDED);
    expect(session.endReason).toBe('SCHEDULED_LOCK');
    expect(refreshed.state).toBe('LOCKED');

    // Rejeu de l'acquittement : sans effet, sans erreur.
    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/v1/devices/commands/${commandId}/result`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'EXECUTED' },
    });
    expect(replay.statusCode).toBe(204);
  });

  it('une commande expirée n’est jamais livrée au téléphone', async () => {
    const { device, token } = await openSession('TEL-D9', '50000009');
    const adminToken = await adminAccessToken(ctx, company);

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/v1/devices/${device.id}/commands`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { command: 'LOCK_DEVICE', ttlMinutes: 1 },
    });
    const commandId = created.json().id as string;

    await TenantContext.system(() =>
      ctx.prisma.raw.deviceCommand.update({
        where: { id: commandId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      }),
    );

    const pulled = await ctx.app.inject({
      method: 'GET',
      url: '/v1/devices/commands',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(pulled.json().map((c: { id: string }) => c.id)).not.toContain(commandId);

    const command = await TenantContext.system(() =>
      ctx.prisma.raw.deviceCommand.findUniqueOrThrow({ where: { id: commandId } }),
    );
    expect(command.status).toBe(CommandStatus.EXPIRED);
  });

  it('TEST 7 — synchronisation : configuration, dépôt et liste hors ligne', async () => {
    const { token } = await openSession('TEL-D10', '50000010');

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/sync/pull',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Le téléphone reçoit de quoi appliquer les règles seul, hors ligne.
    expect(body.depot).toMatchObject({
      returnTime: '18:00',
      lockTime: '22:00',
      timezone: 'Europe/Paris',
      radiusMeters: 250,
    });
    expect(body.settings).toMatchObject({ offlineAuthEnabled: true });
    expect(body.session).toMatchObject({ state: 'ACTIVE' });
    expect(typeof body.serverTime).toBe('string');

    // La liste hors ligne ne contient jamais de numéro de badge.
    expect(Array.isArray(body.offlineBadges)).toBe(true);
    expect(body.offlineBadges.length).toBeGreaterThan(0);
    const entry = body.offlineBadges[0];
    expect(entry).toHaveProperty('badgeHmac');
    expect(entry).toHaveProperty('badgeLast4');
    expect(entry).not.toHaveProperty('barcode');
    expect(String(entry.badgeHmac)).not.toContain('50000010');

    // Une seconde synchronisation à jour ne renvoie pas la configuration.
    const second = await ctx.app.inject({
      method: 'GET',
      url: `/v1/sync/pull?configVersion=${body.configVersion}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.json().settings).toBeNull();
    expect(second.json().depot).toBeNull();
  });

  it('l’empreinte hors ligne diffère d’un téléphone à l’autre', async () => {
    const deviceA = await seedDevice(ctx, company, 'TEL-D11');
    const deviceB = await seedDevice(ctx, company, 'TEL-D12');
    await seedDriver(ctx, company, {
      firstName: 'Claire',
      lastName: 'Noel',
      barcode: '50000011',
      devices: [deviceA, deviceB],
    });

    const [tokenA, tokenB] = await Promise.all([
      deviceAccessToken(ctx, deviceA),
      deviceAccessToken(ctx, deviceB),
    ]);

    const [pullA, pullB] = await Promise.all([
      ctx.app.inject({
        method: 'GET',
        url: '/v1/sync/pull',
        headers: { authorization: `Bearer ${tokenA}` },
      }),
      ctx.app.inject({
        method: 'GET',
        url: '/v1/sync/pull',
        headers: { authorization: `Bearer ${tokenB}` },
      }),
    ]);

    const hmacA = pullA.json().offlineBadges[0].badgeHmac as string;
    const hmacB = pullB.json().offlineBadges[0].badgeHmac as string;

    // C'est ce qui rend une liste extraite d'un téléphone volé inutilisable
    // ailleurs.
    expect(hmacA).not.toBe(hmacB);
  });

  it('heartbeat : met à jour l’état matériel et renvoie l’heure serveur', async () => {
    const { device, token } = await openSession('TEL-D13', '50000012');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/devices/heartbeat',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        deviceId: device.id,
        battery: 72,
        charging: false,
        network: 'wifi',
        gps: true,
        appVersion: '1.0.0',
        androidVersion: '14',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(typeof res.json().serverTime).toBe('string');

    const refreshed = await TenantContext.system(() =>
      ctx.prisma.raw.device.findUniqueOrThrow({ where: { id: device.id } }),
    );
    expect(refreshed.batteryLevel).toBe(72);
    expect(refreshed.networkType).toBe('wifi');
    expect(refreshed.lastSeenAt).not.toBeNull();
  });

  it('batterie sous le seuil : alerte, puis clôture automatique au retour à la normale', async () => {
    const { device, token } = await openSession('TEL-D14', '50000013');

    await ctx.app.inject({
      method: 'POST',
      url: '/v1/devices/heartbeat',
      headers: { authorization: `Bearer ${token}` },
      payload: { deviceId: device.id, battery: 9, charging: false, gps: true },
    });

    let alert = await TenantContext.system(() =>
      ctx.prisma.raw.alert.findFirst({
        where: { deviceId: device.id, type: 'BATTERY_LOW' },
      }),
    );
    expect(alert?.status).toBe('OPEN');

    await ctx.app.inject({
      method: 'POST',
      url: '/v1/devices/heartbeat',
      headers: { authorization: `Bearer ${token}` },
      payload: { deviceId: device.id, battery: 80, charging: true, gps: true },
    });

    alert = await TenantContext.system(() =>
      ctx.prisma.raw.alert.findFirst({
        where: { deviceId: device.id, type: 'BATTERY_LOW' },
      }),
    );
    // Sans cette clôture, le dashboard accumulerait des alertes que plus
    // personne ne regarde.
    expect(alert?.status).toBe('AUTO_CLOSED');
  });
});
