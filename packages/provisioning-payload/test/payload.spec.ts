import contract from '../src/contract/admin-extras.json';
import { provisioningProfileSchema, type ProvisioningProfile } from '../src/profile';
import {
  ADMIN_EXTRAS,
  buildPayload,
  EXTRA,
  payloadJson,
  QR_MAX_BYTES,
  validatePayload,
} from '../src/payload';

const VALID_CHECKSUM = 'Dz5DmDwIO7i3ciXbErOmiMsfZMQy6geTGUDdwKZB8zg';
const TOKEN = 'ETK-ABCD2345-EFGH6789';

function profile(overrides: Record<string, unknown> = {}): ProvisioningProfile {
  return provisioningProfileSchema.parse({
    packageName: 'com.phonecontrol',
    adminComponent: 'com.phonecontrol/.kiosk.PhoneControlDeviceAdminReceiver',
    signatureChecksum: VALID_CHECKSUM,
    apkDownloadUrl: 'https://exemple.fr/provisioning/app.apk',
    serverUrl: 'https://api.exemple.fr/api/',
    ...overrides,
  });
}

const build = (
  overrides: Record<string, unknown> = {},
  options: { wifiPassword?: string } = {},
) => buildPayload(profile(overrides), { enrollmentToken: TOKEN, ...options });

describe('construction de la charge utile', () => {
  it('produit les clés Android attendues', () => {
    const payload = build();

    expect(payload[EXTRA.COMPONENT_NAME]).toBe(
      'com.phonecontrol/.kiosk.PhoneControlDeviceAdminReceiver',
    );
    expect(payload[EXTRA.SIGNATURE_CHECKSUM]).toBe(VALID_CHECKSUM);
    expect(payload[EXTRA.DOWNLOAD_LOCATION]).toBe('https://exemple.fr/provisioning/app.apk');
    expect(payload[EXTRA.SKIP_ENCRYPTION]).toBe(false);
    expect(payload[EXTRA.LEAVE_ALL_SYSTEM_APPS_ENABLED]).toBe(true);
  });

  it("transporte le jeton et l'adresse du serveur dans le bundle d'extras", () => {
    const bundle = build()[EXTRA.ADMIN_EXTRAS_BUNDLE] as Record<string, string>;

    expect(bundle[ADMIN_EXTRAS.ENROLLMENT_TOKEN]).toBe(TOKEN);
    expect(bundle[ADMIN_EXTRAS.SERVER_URL]).toBe('https://api.exemple.fr/api/');
  });

  it("n'écrit le mot de passe Wi-Fi que s'il est fourni à l'exécution", () => {
    const wifi = { ssid: 'ATELIER', securityType: 'WPA' as const };

    expect(build({ wifi })[EXTRA.WIFI_PASSWORD]).toBeUndefined();
    expect(build({ wifi }, { wifiPassword: 'secret-atelier' })[EXTRA.WIFI_PASSWORD]).toBe(
      'secret-atelier',
    );
  });

  it('respecte le contrat partagé avec le module Android', () => {
    expect(Object.keys(contract.keys).sort()).toEqual(
      [ADMIN_EXTRAS.ENROLLMENT_TOKEN, ADMIN_EXTRAS.SERVER_URL].sort(),
    );
    expect(contract.bundleExtraKey).toBe(EXTRA.ADMIN_EXTRAS_BUNDLE);
    expect(new RegExp(contract.keys.enrollmentToken.pattern).test(TOKEN)).toBe(true);
  });
});

describe('profil de provisioning', () => {
  it('refuse une clé inconnue plutôt que de l’ignorer', () => {
    // Une faute de frappe sur signatureChecksum produirait sinon un QR code
    // sans empreinte, refusé par le téléphone après plusieurs minutes.
    expect(() => profile({ signatureChecsum: 'x' })).toThrow();
  });

  it('applique les valeurs par défaut', () => {
    const parsed = profile();

    expect(parsed.skipEncryption).toBe(false);
    expect(parsed.leaveAllSystemAppsEnabled).toBe(true);
    expect(parsed.allowInsecureDownload).toBe(false);
  });
});

describe('vérification de la charge utile', () => {
  const check = (payload: Record<string, unknown>) =>
    validatePayload(payload, { packageName: 'com.phonecontrol' });

  it('accepte une charge utile complète', () => {
    const result = check(build());

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('refuse une empreinte en base64 classique', () => {
    const standard = Buffer.from(VALID_CHECKSUM, 'base64url').toString('base64');
    const result = check(build({ signatureChecksum: standard }));

    expect(result.errors.join(' ')).toMatch(/URL-safe sans remplissage/);
  });

  it("refuse un APK servi en HTTP, et l'accepte si c'est un choix explicite", () => {
    const insecure = { apkDownloadUrl: 'http://exemple.fr/app.apk' };

    expect(check(build(insecure)).errors.join(' ')).toMatch(/HTTPS/);

    const allowed = validatePayload(build(insecure), {
      packageName: 'com.phonecontrol',
      allowInsecureDownload: true,
    });
    expect(allowed.errors).toEqual([]);
    expect(allowed.warnings.join(' ')).toMatch(/HTTP explicitement autorisé/);
  });

  it('refuse un composant qui ne correspond pas au paquet déployé', () => {
    // Le piège réel : l'APK de debug porte le suffixe .debug, pas le QR code.
    const result = validatePayload(build(), { packageName: 'com.phonecontrol.debug' });

    expect(result.errors.join(' ')).toMatch(/\.debug/);
  });

  it("refuse un bundle d'extras dont une valeur n'est pas une chaîne", () => {
    const payload = build();
    payload[EXTRA.ADMIN_EXTRAS_BUNDLE] = { enrollmentToken: TOKEN, retries: 3 };

    expect(check(payload).errors.join(' ')).toMatch(/que des chaînes/);
  });

  it('refuse une charge utile sans jeton', () => {
    const payload = build();
    payload[EXTRA.ADMIN_EXTRAS_BUNDLE] = { serverUrl: 'https://api.exemple.fr/api/' };

    expect(check(payload).errors.join(' ')).toMatch(/resterait non enrôlé/);
  });

  it('refuse un réseau protégé sans mot de passe', () => {
    const result = check(build({ wifi: { ssid: 'ATELIER', securityType: 'WPA' } }));

    expect(result.errors.join(' ')).toMatch(/sans mot de passe/);
  });

  it('avertit que le mot de passe Wi-Fi voyage en clair', () => {
    const result = check(
      build({ wifi: { ssid: 'ATELIER', securityType: 'WPA' } }, { wifiPassword: 'secret' }),
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/EN CLAIR/);
  });

  it('avertit quand le chiffrement du terminal est désactivé', () => {
    expect(check(build({ skipEncryption: true })).warnings.join(' ')).toMatch(
      /chiffrement du terminal est désactivé/,
    );
  });

  it("avertit quand l'adresse du serveur n'a pas de chemin", () => {
    const result = check(build({ serverUrl: 'https://api.exemple.fr' }));

    expect(result.warnings.join(' ')).toMatch(/préfixe global/);
  });

  it('refuse une charge utile trop grosse pour un QR code', () => {
    const payload = build();
    payload[EXTRA.DOWNLOAD_LOCATION] = `https://exemple.fr/${'a'.repeat(QR_MAX_BYTES)}.apk`;

    expect(check(payload).errors.join(' ')).toMatch(/aucun QR code ne peut/);
  });

  it('encode le JSON sans espaces superflus', () => {
    const json = payloadJson(build());

    expect(json.startsWith('{"')).toBe(true);
    expect(json).not.toContain('\n');
    expect(JSON.parse(json)[EXTRA.SIGNATURE_CHECKSUM]).toBe(VALID_CHECKSUM);
  });
});
