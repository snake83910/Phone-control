import {
  analyzePreconditions,
  inspectDevice,
  setDeviceOwner,
  systemRunner,
  type AdbContext,
} from '../lib/adb';
import { boolean, optionalString, requireString } from '../lib/args';
import { loadConfig } from '../lib/config';
import { ProvisioningError } from '@phone-control/provisioning-payload';
import { ui } from '../lib/ui';

/**
 * Attribution du rôle Device Owner par ADB (docs/04 §2.2).
 *
 * Réservé au développement et au dépannage. Cette voie ne transporte **pas** de
 * jeton d'enrôlement : le téléphone devient Device Owner, puis attend qu'on
 * l'enrôle par l'écran de mise en service. Sur un parc, c'est le QR code qui
 * fait les deux d'un coup.
 */
export async function runAdbOwner(flags: Record<string, string | boolean>): Promise<void> {
  const { config } = loadConfig(requireString(flags, 'config'));
  const context: AdbContext = {
    runner: systemRunner,
    adbPath: optionalString(flags, 'adb') ?? 'adb',
    serial: optionalString(flags, 'serial'),
  };

  ui.heading('État du terminal');
  const state = inspectDevice(context, config.provisioning.packageName);

  ui.table(
    ['Série', 'État', 'Modèle'],
    state.devices.map((device) => [device.serial, device.state, device.model ?? '—']),
  );

  ui.detail('Comptes configurés', String(state.accounts));
  ui.detail('Propriétaire actuel', state.existingOwner ?? 'aucun');
  ui.detail(
    'Application installée',
    state.packageInstalled ? `oui (${config.provisioning.packageName})` : 'non',
  );

  const preconditions = analyzePreconditions(state);

  ui.heading('Conditions préalables');
  for (const warning of preconditions.warnings) ui.warn(warning);
  for (const blocker of preconditions.blocking) ui.fail(blocker);

  if (preconditions.blocking.length > 0) {
    throw new ProvisioningError(
      "Les conditions d'Android ne sont pas réunies : rien n'a été tenté.",
      "Ces conditions protègent un téléphone en service contre une prise de contrôle. " +
        'Elles ne se contournent pas.',
    );
  }

  ui.success('Toutes les conditions sont réunies.');

  const component = config.provisioning.adminComponent;

  if (!boolean(flags, 'yes')) {
    ui.line('');
    ui.info('Commande qui sera exécutée :');
    ui.line(
      `  adb${state.serial ? ` -s ${state.serial}` : ''} shell dpm set-device-owner ${component}`,
    );
    ui.line('');
    ui.info('Relancez avec --yes pour l’exécuter réellement.');
    return;
  }

  ui.heading('Attribution du rôle Device Owner');
  const result = setDeviceOwner({ ...context, serial: state.serial }, component);

  const output = `${result.stdout}${result.stderr}`.trim();
  if (result.status !== 0 || /error|failure|not allowed/i.test(output)) {
    ui.line(output);
    throw new ProvisioningError(
      "Android a refusé d'attribuer le rôle Device Owner.",
      'Le cas le plus fréquent : la configuration initiale du téléphone a été menée ' +
        'à son terme. Réinitialisez-le et arrêtez-vous à l’écran de bienvenue.',
    );
  }

  ui.line(output);
  ui.success(`${component} est désormais Device Owner.`);
  ui.warn(
    "Le téléphone n'est pas encore enrôlé : il n'a reçu aucun jeton par cette voie. " +
      'Ouvrez l’application et saisissez un jeton, ou repassez par le QR code.',
  );
}
