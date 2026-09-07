import {
  analyzePreconditions,
  countAccounts,
  findExistingOwner,
  isPackageInstalled,
  parseDevices,
} from '../src/lib/adb';

const PACKAGE = 'com.phonecontrol';

const base = {
  devices: [{ serial: 'R58N70ABCDE', state: 'device' }],
  accounts: 0,
  packageInstalled: true,
  packageName: PACKAGE,
};

describe('lecture de la sortie adb', () => {
  it('lit la liste des terminaux', () => {
    const output = [
      'List of devices attached',
      'R58N70ABCDE            device product:a16 model:SM_A165F device:a16',
      'emulator-5554          offline',
      '',
    ].join('\n');

    expect(parseDevices(output)).toEqual([
      { serial: 'R58N70ABCDE', state: 'device', model: 'SM_A165F' },
      { serial: 'emulator-5554', state: 'offline', model: undefined },
    ]);
  });

  it('compte les comptes déclarés', () => {
    expect(countAccounts('Accounts: 0')).toBe(0);
    expect(
      countAccounts('Account {name=jean@exemple.fr, type=com.google}\nAccount {name=x}'),
    ).toBe(2);
  });

  it('repère un propriétaire déjà attribué', () => {
    expect(findExistingOwner('Device Owner: \n  admin=com.autre/.Receiver')).toBe(
      'com.autre/.Receiver',
    );
    expect(findExistingOwner('Registered device policies: none')).toBeUndefined();
  });

  it("vérifie la présence exacte du paquet, sans confondre les préfixes", () => {
    const output = 'package:com.phonecontrol.debug\npackage:com.phonecontrol\n';

    expect(isPackageInstalled(output, PACKAGE)).toBe(true);
    expect(isPackageInstalled('package:com.phonecontrol.debug\n', PACKAGE)).toBe(false);
  });
});

describe("conditions préalables d'Android", () => {
  it('accepte un terminal vierge avec l’application installée', () => {
    expect(analyzePreconditions(base).blocking).toEqual([]);
  });

  it('bloque quand un compte est configuré, et dit pourquoi', () => {
    const result = analyzePreconditions({ ...base, accounts: 1 });

    expect(result.blocking.join(' ')).toMatch(/Réinitialisez le téléphone/);
  });

  it('bloque quand un propriétaire existe déjà', () => {
    const result = analyzePreconditions({ ...base, existingOwner: 'com.autre/.Receiver' });

    expect(result.blocking.join(' ')).toMatch(/réinitialisation d’usine/);
  });

  it("bloque quand l'application n'est pas installée", () => {
    const result = analyzePreconditions({ ...base, packageInstalled: false });

    expect(result.blocking.join(' ')).toMatch(/adb install/);
  });

  it('exige --serial quand plusieurs terminaux sont branchés', () => {
    const result = analyzePreconditions({
      ...base,
      devices: [
        { serial: 'A', state: 'device' },
        { serial: 'B', state: 'device' },
      ],
    });

    expect(result.blocking.join(' ')).toMatch(/--serial/);
  });

  it('distingue un terminal non autorisé d’un terminal absent', () => {
    const unauthorized = analyzePreconditions({
      ...base,
      devices: [{ serial: 'A', state: 'unauthorized' }],
    });
    expect(unauthorized.blocking.join(' ')).toMatch(/débogage USB affichée/);

    const none = analyzePreconditions({ ...base, devices: [] });
    expect(none.blocking.join(' ')).toMatch(/Aucun terminal connecté/);
  });

  it('rappelle que le QR code reste la méthode de référence', () => {
    // La voie ADB ne transporte pas de jeton : le dire évite de croire
    // qu'un téléphone Device Owner est un téléphone enrôlé.
    expect(analyzePreconditions(base).warnings.join(' ')).toMatch(/QR code/);
  });
});
