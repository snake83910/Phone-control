#!/usr/bin/env node
import { parseArgs } from './lib/args';
import { ProvisioningError } from '@phone-control/provisioning-payload';
import { ui } from './lib/ui';
import { runChecksum } from './commands/checksum';
import { runPayload, runVerify } from './commands/payload';
import { runBatch, runDevice } from './commands/batch';
import { runAdbOwner } from './commands/adb-owner';

/**
 * pcprov — outillage d'atelier de Phone Control.
 *
 * Objet : transformer une liste de téléphones en étiquettes à coller, chacune
 * portant un QR code qui provisionne le terminal et l'enrôle dans l'entreprise
 * sans aucune saisie.
 */

const HELP = `
pcprov — mise en service des téléphones Phone Control

  pcprov batch     --config <fichier> --csv <parc.csv> [--out <dossier>] [--dry-run]
                   Parc complet : crée les fiches, émet les jetons, produit les
                   QR codes, la planche à imprimer et le manifeste.

  pcprov device    --config <fichier> --asset-tag TEL-023 [--depot "Lyon Est"]
                   Un seul téléphone : remplacement, dépannage, ajout.

  pcprov checksum  --apk <fichier.apk> | --cert <certificat.pem>
                   Empreinte de signature à placer dans le QR code. Avec
                   --config, la compare à celle configurée.

  pcprov payload   --config <fichier> --token ETK-XXXXXXXX-XXXXXXXX
                   Fabrique et vérifie une charge utile à partir d'un jeton déjà
                   émis. Aucun accès réseau.

  pcprov verify    --payload <fichier.json> [--config <fichier>]
                   Contrôle une charge utile existante avant réimpression.

  pcprov adb-owner --config <fichier> [--serial <série>] [--yes]
                   Voie ADB pour le développement (docs/04 §2.2). Vérifie les
                   conditions d'Android et les explique ; ne les contourne pas.

Options communes

  --env-file <fichier>   Charge les secrets depuis un fichier .env.
  --help, -h             Cette aide.

Secrets — jamais dans le fichier de configuration

  PC_ADMIN_PASSWORD   mot de passe de l'administrateur du dashboard
  PC_WIFI_PASSWORD    clé du Wi-Fi d'atelier encodée dans le QR code

Surcharges d'environnement

  PC_API_URL, PC_ADMIN_EMAIL, PC_SERVER_URL, PC_SIGNATURE_CHECKSUM, PC_APK_URL
`;

type Handler = (flags: Record<string, string | boolean>) => Promise<void>;

const COMMANDS: Record<string, Handler> = {
  batch: runBatch,
  device: runDevice,
  checksum: runChecksum,
  payload: runPayload,
  verify: runVerify,
  'adb-owner': runAdbOwner,
};

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (flags.help === true || command === undefined || command === 'help') {
    ui.line(HELP.trim());
    return command === undefined && flags.help !== true ? 1 : 0;
  }

  const envFile = flags['env-file'];
  if (typeof envFile === 'string') {
    try {
      process.loadEnvFile(envFile);
    } catch (error) {
      throw new ProvisioningError(
        `Fichier d'environnement illisible (${envFile}) : ${(error as Error).message}`,
      );
    }
  }

  const handler = COMMANDS[command];
  if (!handler) {
    ui.fail(`Commande inconnue : ${command}`);
    ui.line('');
    ui.line(HELP.trim());
    return 1;
  }

  await handler(flags);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof ProvisioningError) {
      ui.line('');
      ui.fail(error.message);
      if (error.hint) ui.info(`  ${error.hint}`);
      process.exitCode = 1;
      return;
    }
    // Tout le reste est un défaut de l'outil : la pile complète est utile.
    ui.fail('Erreur inattendue :');
    ui.line(String((error as Error)?.stack ?? error));
    process.exitCode = 2;
  });
