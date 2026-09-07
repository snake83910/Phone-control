import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoSecretsInFile, loadConfig, parseConfig } from '../src/lib/config';
import { ProvisioningError } from '@phone-control/provisioning-payload';

const minimal = {
  api: { baseUrl: 'https://api.exemple.fr/api', email: 'atelier@exemple.fr' },
  provisioning: {
    packageName: 'com.phonecontrol',
    adminComponent: 'com.phonecontrol/.kiosk.PhoneControlDeviceAdminReceiver',
    serverUrl: 'https://api.exemple.fr/api/',
  },
};

function writeConfig(content: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'pcprov-config-'));
  const path = join(directory, 'provisioning.config.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

describe('configuration', () => {
  it('applique les valeurs par défaut', () => {
    const config = parseConfig(minimal);

    expect(config.provisioning.skipEncryption).toBe(false);
    expect(config.provisioning.leaveAllSystemAppsEnabled).toBe(true);
    expect(config.output.errorCorrectionLevel).toBe('M');
    expect(config.output.labelsPerPage).toBe(6);
    expect(config.api.timeoutMs).toBe(15_000);
  });

  it('refuse une clé inconnue plutôt que de l’ignorer', () => {
    // Une faute de frappe sur signatureChecksum produirait sinon des QR codes
    // sans empreinte, refusés par le téléphone après plusieurs minutes.
    const typo = {
      ...minimal,
      provisioning: { ...minimal.provisioning, signatureChecsum: 'x' },
    };

    expect(() => parseConfig(typo)).toThrow(/signatureChecsum/);
  });

  it('refuse un mot de passe écrit dans le fichier, en nommant la variable à utiliser', () => {
    const refus = (raw: unknown): ProvisioningError => {
      try {
        assertNoSecretsInFile(raw);
      } catch (error) {
        return error as ProvisioningError;
      }
      throw new Error('aucun refus : le secret serait passé');
    };

    const admin = refus({ api: { password: 'motdepasse' } });
    expect(admin.message).toMatch(/api\.password/);
    expect(admin.hint).toMatch(/PC_ADMIN_PASSWORD/);

    const wifi = refus({ provisioning: { wifi: { password: 'cle-wifi' } } });
    expect(wifi.message).toMatch(/provisioning\.wifi\.password/);
    expect(wifi.hint).toMatch(/PC_WIFI_PASSWORD/);
  });

  it('laisse passer un fichier sans secret', () => {
    expect(() => assertNoSecretsInFile(minimal)).not.toThrow();
  });

  it('nomme le champ fautif dans le message', () => {
    const broken = { ...minimal, api: { ...minimal.api, email: 'pas-une-adresse' } };

    expect(() => parseConfig(broken)).toThrow(/api\.email/);
  });

  it('lit les secrets dans l’environnement, jamais dans le fichier', () => {
    const path = writeConfig(minimal);
    const { config, secrets } = loadConfig(path, {
      PC_ADMIN_PASSWORD: 'mot-de-passe',
      PC_WIFI_PASSWORD: 'cle-atelier',
    } as NodeJS.ProcessEnv);

    expect(secrets.adminPassword).toBe('mot-de-passe');
    expect(secrets.wifiPassword).toBe('cle-atelier');
    expect(JSON.stringify(config)).not.toContain('mot-de-passe');
  });

  it('permet de basculer de recette en production par l’environnement', () => {
    const path = writeConfig(minimal);
    const { config } = loadConfig(path, {
      PC_API_URL: 'https://recette.exemple.fr/api',
      PC_SERVER_URL: 'https://recette.exemple.fr/api/',
    } as NodeJS.ProcessEnv);

    expect(config.api.baseUrl).toBe('https://recette.exemple.fr/api');
    expect(config.provisioning.serverUrl).toBe('https://recette.exemple.fr/api/');
  });

  it('explique un fichier absent', () => {
    expect(() => loadConfig(join(tmpdir(), 'inexistant-pcprov.json'))).toThrow(
      ProvisioningError,
    );
  });

  it('valide le fichier d’exemple livré avec l’outil', () => {
    // Il sert de point de départ à chaque atelier : il doit rester valide.
    const example = join(__dirname, '..', 'provisioning.config.example.json');

    expect(() => loadConfig(example, {} as NodeJS.ProcessEnv)).not.toThrow();
  });
});
