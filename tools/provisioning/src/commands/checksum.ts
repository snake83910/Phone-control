import {
  EXTRA,
  ProvisioningError,
  describeCertificate,
  readCertificateFile,
  readSigningCertificate,
} from '@phone-control/provisioning-payload';
import { boolean, optionalString } from '../lib/args';
import { loadConfig } from '../lib/config';
import { ui } from '../lib/ui';

/**
 * Calcule l'empreinte de signature à placer dans le QR code.
 *
 * C'est la valeur la plus souvent fausse d'une campagne de provisioning, et
 * celle dont l'erreur coûte le plus cher : le téléphone télécharge l'APK, le
 * refuse, et affiche « Impossible de configurer l'appareil ». Rien n'indique
 * que le problème vient d'une chaîne de 43 caractères.
 */
export async function runChecksum(flags: Record<string, string | boolean>): Promise<void> {
  const apk = optionalString(flags, 'apk');
  const certificate = optionalString(flags, 'cert');

  if (!apk && !certificate) {
    throw new ProvisioningError(
      'Indiquez soit --apk <fichier.apk>, soit --cert <certificat.pem|.der>.',
      "L'APK est la source la plus sûre : c'est le fichier que les téléphones téléchargeront.",
    );
  }

  const source = apk
    ? readSigningCertificate(apk)
    : { der: readCertificateFile(certificate as string), scheme: 'certificat fourni' };

  const summary = describeCertificate(source.der);

  ui.heading('Certificat de signature');
  ui.detail('Source', apk ?? (certificate as string));
  ui.detail('Schéma', source.scheme);
  ui.detail('Sujet', summary.subject);
  ui.detail('Émetteur', summary.issuer);
  ui.detail('Valide du', summary.validFrom);
  ui.detail("Valide jusqu'au", summary.validTo);
  ui.detail('SHA-256 (hex)', summary.sha256Hex);

  ui.heading('Empreinte pour le QR code');
  ui.line(summary.checksum);

  if (boolean(flags, 'json')) {
    ui.line('');
    ui.line(JSON.stringify({ [EXTRA.SIGNATURE_CHECKSUM]: summary.checksum }, null, 2));
  }

  if (summary.expired) {
    ui.warn(
      'Ce certificat est EXPIRÉ. Un APK signé avec lui sera refusé : ' +
        'regénérez une clé de signature avant tout déploiement.',
    );
  } else if (summary.expiresSoon) {
    ui.warn(
      "Ce certificat expire dans moins de 25 ans. C'est la durée attendue d'une clé " +
        "de signature applicative : un certificat de debug (30 ans) passe, une clé " +
        'improvisée pour un essai, non. Vérifiez que ce n’est pas une clé jetable.',
    );
  }

  const configPath = optionalString(flags, 'config');
  if (configPath) {
    const { config } = loadConfig(configPath);
    const configured = config.provisioning.signatureChecksum;

    ui.heading('Comparaison avec la configuration');
    if (!configured) {
      ui.warn(
        `Aucune empreinte dans ${configPath}. Ajoutez : ` +
          `"signatureChecksum": "${summary.checksum}"`,
      );
    } else if (configured === summary.checksum) {
      ui.success("L'empreinte configurée correspond à cet APK.");
    } else {
      ui.fail(
        "L'empreinte configurée NE correspond PAS.\n" +
          `  configurée : ${configured}\n` +
          `  calculée   : ${summary.checksum}`,
      );
      throw new ProvisioningError(
        'Les QR codes produits avec cette configuration seront refusés par les téléphones.',
        "Corrigez signatureChecksum, ou vérifiez que l'APK publié est bien celui-ci.",
      );
    }
  }
}
