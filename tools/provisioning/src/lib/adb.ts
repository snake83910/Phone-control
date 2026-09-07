import { spawnSync } from 'node:child_process';
import { ProvisioningError } from '@phone-control/provisioning-payload';

/**
 * Voie ADB : développement et dépannage en atelier (docs/04 §2.2).
 *
 * `dpm set-device-owner` n'accepte qu'un terminal vierge : aucun compte, aucun
 * propriétaire déjà attribué, configuration initiale non terminée. Ces
 * conditions ne sont pas des formalités, ce sont des garde-fous d'Android
 * contre la prise de contrôle d'un téléphone en service.
 *
 * L'outil les **vérifie et les explique**. Il ne les contourne pas : remettre
 * `device_provisioned` à zéro par la porte de derrière ferait fonctionner la
 * commande, et laisserait un parc dans un état qu'aucune procédure officielle
 * ne sait reproduire. La spécification §67 est explicite là-dessus.
 */

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => CommandResult;

export const systemRunner: CommandRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
  if (result.error) {
    throw new ProvisioningError(
      `Impossible d'exécuter « ${command} » : ${result.error.message}`,
      command === 'adb'
        ? "adb n'est pas dans le PATH. Ajoutez <SDK Android>/platform-tools."
        : undefined,
    );
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
}

/** Analyse la sortie de `adb devices -l`. */
export function parseDevices(output: string): AdbDevice[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('List of devices'))
    .map((line) => {
      const parts = line.split(/\s+/);
      const model = parts.find((part) => part.startsWith('model:'));
      return {
        serial: parts[0],
        state: parts[1] ?? 'unknown',
        model: model ? model.slice('model:'.length) : undefined,
      };
    })
    .filter((device) => device.serial.length > 0);
}

/**
 * Compte les comptes déclarés sur le terminal, d'après `dumpsys account`.
 *
 * Un seul compte suffit à faire échouer `set-device-owner`, avec un message
 * qu'Android résume en « not allowed ». Autant le dire avant.
 */
export function countAccounts(dumpsysOutput: string): number {
  const matches = dumpsysOutput.match(/Account\s*\{/g);
  return matches ? matches.length : 0;
}

/** Repère un propriétaire déjà attribué dans `dumpsys device_policy`. */
export function findExistingOwner(dumpsysOutput: string): string | undefined {
  const deviceOwner = /Device Owner:\s*\r?\n?\s*(?:admin=)?(\S+)/i.exec(dumpsysOutput);
  if (deviceOwner) return deviceOwner[1];
  const profileOwner = /Profile Owner[^\n]*:\s*(?:admin=)?(\S+)/i.exec(dumpsysOutput);
  return profileOwner ? profileOwner[1] : undefined;
}

/** Vrai si le paquet apparaît dans `pm list packages`. */
export function isPackageInstalled(output: string, packageName: string): boolean {
  return output
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === `package:${packageName}`);
}

export interface Preconditions {
  blocking: string[];
  warnings: string[];
}

export interface PreconditionInput {
  devices: AdbDevice[];
  serial?: string;
  accounts: number;
  existingOwner?: string;
  packageInstalled: boolean;
  packageName: string;
}

export function analyzePreconditions(input: PreconditionInput): Preconditions {
  const blocking: string[] = [];
  const warnings: string[] = [];

  const usable = input.devices.filter((device) => device.state === 'device');
  const unauthorized = input.devices.filter((device) => device.state === 'unauthorized');

  if (unauthorized.length > 0) {
    blocking.push(
      `Terminal non autorisé (${unauthorized.map((device) => device.serial).join(', ')}) : ` +
        'acceptez la demande de débogage USB affichée sur son écran.',
    );
  }

  if (usable.length === 0 && unauthorized.length === 0) {
    blocking.push(
      'Aucun terminal connecté. Branchez le téléphone et activez le débogage USB.',
    );
  }

  if (!input.serial && usable.length > 1) {
    blocking.push(
      `${usable.length} terminaux connectés : précisez lequel avec --serial ` +
        `(${usable.map((device) => device.serial).join(', ')}).`,
    );
  }

  if (input.serial && !usable.some((device) => device.serial === input.serial)) {
    blocking.push(`Le terminal « ${input.serial} » n'est pas connecté ou n'est pas prêt.`);
  }

  if (!input.packageInstalled) {
    blocking.push(
      `L'application ${input.packageName} n'est pas installée sur le terminal. ` +
        'Installez-la avant de lui attribuer le rôle Device Owner : ' +
        'adb install -r app-release.apk',
    );
  }

  if (input.accounts > 0) {
    blocking.push(
      `${input.accounts} compte(s) configuré(s) sur le terminal. Android refuse ` +
        "d'attribuer le rôle Device Owner dans ce cas. Réinitialisez le téléphone " +
        'et ne connectez aucun compte pendant la configuration initiale.',
    );
  }

  if (input.existingOwner) {
    blocking.push(
      `Un propriétaire est déjà attribué : ${input.existingOwner}. ` +
        'Une réinitialisation d’usine est nécessaire.',
    );
  }

  warnings.push(
    'La voie ADB convient au développement et au dépannage. Pour un parc, ' +
      'le QR code de provisioning reste la méthode de référence : il transporte ' +
      "aussi le jeton d'enrôlement, ce que set-device-owner ne fait pas.",
  );

  return { blocking, warnings };
}

export interface AdbContext {
  runner: CommandRunner;
  adbPath: string;
  serial?: string;
}

function adb(context: AdbContext, args: string[]): CommandResult {
  const prefix = context.serial ? ['-s', context.serial] : [];
  return context.runner(context.adbPath, [...prefix, ...args]);
}

/** Collecte l'état du terminal sans rien modifier. */
export function inspectDevice(context: AdbContext, packageName: string): PreconditionInput {
  const devices = parseDevices(adb({ ...context, serial: undefined }, ['devices', '-l']).stdout);

  const usable = devices.filter((device) => device.state === 'device');
  const target = context.serial ?? (usable.length === 1 ? usable[0].serial : undefined);

  if (!target) {
    return {
      devices,
      serial: context.serial,
      accounts: 0,
      packageInstalled: false,
      packageName,
    };
  }

  const scoped: AdbContext = { ...context, serial: target };

  return {
    devices,
    serial: target,
    accounts: countAccounts(adb(scoped, ['shell', 'dumpsys', 'account']).stdout),
    existingOwner: findExistingOwner(adb(scoped, ['shell', 'dumpsys', 'device_policy']).stdout),
    packageInstalled: isPackageInstalled(
      adb(scoped, ['shell', 'pm', 'list', 'packages', packageName]).stdout,
      packageName,
    ),
    packageName,
  };
}

/** Attribue le rôle Device Owner. À n'appeler qu'après analyzePreconditions. */
export function setDeviceOwner(context: AdbContext, component: string): CommandResult {
  return adb(context, ['shell', 'dpm', 'set-device-owner', component]);
}
