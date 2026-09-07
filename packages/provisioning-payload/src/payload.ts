import contract from './contract/admin-extras.json';
import { isValidChecksum } from './checksum';
import type { ProvisioningProfile } from './profile';

/**
 * Construction et vérification de la charge utile du QR code de provisioning.
 *
 * Ce module est **pur** : aucun accès réseau, aucun accès disque. C'est ce qui
 * permet de le couvrir entièrement par des tests, alors même que la seule
 * validation définitive — un téléphone qui s'enrôle — demande du matériel.
 *
 * Les clés sont celles d'Android (`android.app.extra.PROVISIONING_*`). Elles ne
 * s'inventent pas : une clé mal orthographiée est silencieusement ignorée par
 * le système, et le provisioning échoue plus tard, sans rapport apparent.
 */

export const EXTRA = {
  COMPONENT_NAME: 'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME',
  SIGNATURE_CHECKSUM: 'android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM',
  DOWNLOAD_LOCATION: 'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION',
  DOWNLOAD_COOKIE_HEADER:
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_COOKIE_HEADER',
  MINIMUM_VERSION_CODE: 'android.app.extra.PROVISIONING_DEVICE_ADMIN_MINIMUM_VERSION_CODE',
  SKIP_ENCRYPTION: 'android.app.extra.PROVISIONING_SKIP_ENCRYPTION',
  LEAVE_ALL_SYSTEM_APPS_ENABLED: 'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED',
  WIFI_SSID: 'android.app.extra.PROVISIONING_WIFI_SSID',
  WIFI_SECURITY_TYPE: 'android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE',
  WIFI_PASSWORD: 'android.app.extra.PROVISIONING_WIFI_PASSWORD',
  WIFI_HIDDEN: 'android.app.extra.PROVISIONING_WIFI_HIDDEN',
  LOCALE: 'android.app.extra.PROVISIONING_LOCALE',
  TIME_ZONE: 'android.app.extra.PROVISIONING_TIME_ZONE',
  ADMIN_EXTRAS_BUNDLE: 'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE',
} as const;

/** Clés du bundle d'extras, partagées avec le module Android. */
export const ADMIN_EXTRAS = {
  ENROLLMENT_TOKEN: 'enrollmentToken',
  SERVER_URL: 'serverUrl',
} as const;

export type ProvisioningPayload = Record<string, unknown>;

export interface BuildOptions {
  enrollmentToken: string;
  /** Mot de passe du Wi-Fi d'atelier, jamais lu depuis le fichier de configuration. */
  wifiPassword?: string;
  /** Surcharge ponctuelle de l'adresse du serveur (recette, démonstration). */
  serverUrl?: string;
}

export function buildPayload(
  provisioning: ProvisioningProfile,
  options: BuildOptions,
): ProvisioningPayload {
  const payload: ProvisioningPayload = {
    [EXTRA.COMPONENT_NAME]: provisioning.adminComponent,
  };

  if (provisioning.signatureChecksum) {
    payload[EXTRA.SIGNATURE_CHECKSUM] = provisioning.signatureChecksum;
  }
  if (provisioning.apkDownloadUrl) {
    payload[EXTRA.DOWNLOAD_LOCATION] = provisioning.apkDownloadUrl;
  }
  if (provisioning.apkDownloadCookieHeader) {
    payload[EXTRA.DOWNLOAD_COOKIE_HEADER] = provisioning.apkDownloadCookieHeader;
  }
  if (provisioning.minimumVersionCode !== undefined) {
    payload[EXTRA.MINIMUM_VERSION_CODE] = provisioning.minimumVersionCode;
  }

  payload[EXTRA.SKIP_ENCRYPTION] = provisioning.skipEncryption;
  payload[EXTRA.LEAVE_ALL_SYSTEM_APPS_ENABLED] = provisioning.leaveAllSystemAppsEnabled;

  if (provisioning.wifi) {
    payload[EXTRA.WIFI_SSID] = provisioning.wifi.ssid;
    payload[EXTRA.WIFI_SECURITY_TYPE] = provisioning.wifi.securityType;
    if (options.wifiPassword) payload[EXTRA.WIFI_PASSWORD] = options.wifiPassword;
    if (provisioning.wifi.hidden) payload[EXTRA.WIFI_HIDDEN] = true;
  }

  if (provisioning.locale) payload[EXTRA.LOCALE] = provisioning.locale;
  if (provisioning.timeZone) payload[EXTRA.TIME_ZONE] = provisioning.timeZone;

  // Le bundle d'extras est le seul endroit où circule un secret propre à ce
  // téléphone. Ses valeurs sont des chaînes : Android convertit le bundle en
  // PersistableBundle, les autres types n'y survivent pas.
  payload[EXTRA.ADMIN_EXTRAS_BUNDLE] = {
    [ADMIN_EXTRAS.ENROLLMENT_TOKEN]: options.enrollmentToken,
    [ADMIN_EXTRAS.SERVER_URL]: options.serverUrl ?? provisioning.serverUrl,
  };

  return payload;
}

/** JSON compact : c'est cette chaîne exacte qui est encodée dans le QR code. */
export function payloadJson(payload: ProvisioningPayload): string {
  return JSON.stringify(payload);
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * Capacité maximale d'un QR code de version 40 en mode binaire, correction L.
 * Au-delà, il n'y a tout simplement pas de QR code possible.
 */
export const QR_MAX_BYTES = 2953;

/**
 * Seuil d'alerte pratique. Un QR de plus de 1200 octets dépasse la version 25 :
 * ses modules deviennent assez fins pour que la lecture depuis l'écran d'accueil
 * d'Android devienne capricieuse, surtout imprimé en petit format.
 */
export const QR_COMFORT_BYTES = 1200;

const COMPONENT_PATTERN = /^[a-zA-Z][\w.]*\/\.?[a-zA-Z][\w.$]*$/;
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0)/;

/**
 * Vérifie une charge utile avant impression.
 *
 * La distinction entre `errors` et `warnings` est celle-ci : une erreur rend le
 * provisioning impossible, un avertissement le rend fragile ou discutable. Les
 * deux sont affichés ; seule l'erreur arrête la commande.
 */
export function validatePayload(
  payload: ProvisioningPayload,
  options: { packageName?: string; allowInsecureDownload?: boolean } = {},
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const component = payload[EXTRA.COMPONENT_NAME];
  if (typeof component !== 'string' || component.length === 0) {
    errors.push('Le composant Device Owner est absent : le QR code ne désigne aucune application.');
  } else if (!COMPONENT_PATTERN.test(component)) {
    errors.push(
      `Composant Device Owner malformé : « ${component} ». Format attendu : ` +
        'paquet/.ClasseDuRecepteur.',
    );
  } else if (options.packageName && !component.startsWith(`${options.packageName}/`)) {
    errors.push(
      `Le composant « ${component} » ne correspond pas au paquet déclaré ` +
        `« ${options.packageName} ». Un APK de debug porte le suffixe .debug : ` +
        'son QR code doit le porter aussi.',
    );
  }

  const checksum = payload[EXTRA.SIGNATURE_CHECKSUM];
  if (typeof checksum !== 'string' || checksum.length === 0) {
    errors.push(
      "L'empreinte de signature est absente : Android refusera l'APK téléchargé.",
    );
  } else if (!isValidChecksum(checksum)) {
    errors.push(
      "L'empreinte de signature n'est pas un SHA-256 en base64 URL-safe sans remplissage " +
        `(43 caractères parmi A-Z a-z 0-9 - _). Reçu : « ${checksum} ».`,
    );
  }

  const download = payload[EXTRA.DOWNLOAD_LOCATION];
  if (typeof download !== 'string' || download.length === 0) {
    warnings.push(
      "Aucune URL de téléchargement : le provisioning ne fonctionnera que si l'application " +
        'est déjà présente sur le téléphone (image constructeur ou installation préalable).',
    );
  } else {
    let parsed: URL | undefined;
    try {
      parsed = new URL(download);
    } catch {
      errors.push(`URL de téléchargement invalide : « ${download} ».`);
    }

    if (parsed) {
      if (parsed.protocol !== 'https:' && !options.allowInsecureDownload) {
        errors.push(
          `L'APK doit être servi en HTTPS (reçu : ${parsed.protocol}//). Un APK téléchargé ` +
            'en clair peut être remplacé en chemin, et il devient Device Owner.',
        );
      } else if (parsed.protocol !== 'https:') {
        warnings.push(
          'Téléchargement en HTTP explicitement autorisé. Acceptable sur un réseau ' +
            "d'atelier isolé, jamais en production.",
        );
      }
      if (PRIVATE_HOST.test(parsed.hostname)) {
        warnings.push(
          `L'APK est servi depuis « ${parsed.hostname} » : le téléphone doit pouvoir ` +
            "joindre cette adresse depuis le Wi-Fi d'atelier, avant tout enrôlement.",
        );
      }
    }
  }

  if (payload[EXTRA.SKIP_ENCRYPTION] === true) {
    warnings.push(
      'Le chiffrement du terminal est désactivé (PROVISIONING_SKIP_ENCRYPTION). ' +
        'Le provisioning est plus rapide, mais les données locales ne sont plus ' +
        'protégées en cas de perte du téléphone.',
    );
  }

  validateWifi(payload, warnings, errors);
  validateAdminExtras(payload, warnings, errors);

  const size = Buffer.byteLength(payloadJson(payload), 'utf8');
  if (size > QR_MAX_BYTES) {
    errors.push(
      `Charge utile de ${size} octets : au-delà de ${QR_MAX_BYTES}, aucun QR code ne peut ` +
        "la contenir. Retirez la configuration Wi-Fi ou raccourcissez l'URL de l'APK.",
    );
  } else if (size > QR_COMFORT_BYTES) {
    warnings.push(
      `Charge utile de ${size} octets : le QR code sera dense. Imprimez-le sur au moins ` +
        '4 cm de côté, et vérifiez la lecture avant de lancer une série.',
    );
  }

  return { errors, warnings };
}

function validateWifi(
  payload: ProvisioningPayload,
  warnings: string[],
  errors: string[],
): void {
  const ssid = payload[EXTRA.WIFI_SSID];
  if (ssid === undefined) return;

  if (typeof ssid !== 'string' || ssid.length === 0) {
    errors.push('SSID Wi-Fi vide.');
    return;
  }

  const security = payload[EXTRA.WIFI_SECURITY_TYPE];
  const password = payload[EXTRA.WIFI_PASSWORD];

  if (security !== 'NONE' && (typeof password !== 'string' || password.length === 0)) {
    errors.push(
      `Le réseau « ${ssid} » est déclaré en ${String(security)} sans mot de passe. ` +
        'Renseignez PC_WIFI_PASSWORD, sinon le téléphone ne rejoindra aucun réseau ' +
        "et le provisioning s'arrêtera à l'écran de connexion.",
    );
  }

  if (security === 'EAP') {
    warnings.push(
      'Wi-Fi en EAP : le provisioning par QR code ne transporte pas les certificats ' +
        "d'entreprise. Prévoyez un réseau d'atelier en WPA-PSK dédié.",
    );
  }

  if (typeof password === 'string' && password.length > 0) {
    warnings.push(
      "Le mot de passe du Wi-Fi d'atelier voyage EN CLAIR dans le QR code. " +
        'Utilisez un réseau dédié au provisioning, isolé, et changez sa clé ' +
        'après chaque campagne.',
    );
  }
}

function validateAdminExtras(
  payload: ProvisioningPayload,
  warnings: string[],
  errors: string[],
): void {
  const bundle = payload[EXTRA.ADMIN_EXTRAS_BUNDLE];

  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    errors.push("Le bundle d'extras est absent : le téléphone n'aurait aucun jeton d'enrôlement.");
    return;
  }

  const entries = Object.entries(bundle as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (typeof value !== 'string') {
      errors.push(
        `Le bundle d'extras ne peut contenir que des chaînes : « ${key} » est de type ` +
          `${Array.isArray(value) ? 'tableau' : typeof value}. Android le convertit en ` +
          'PersistableBundle, où les autres types disparaissent silencieusement.',
      );
    }
  }

  const token = (bundle as Record<string, unknown>)[ADMIN_EXTRAS.ENROLLMENT_TOKEN];
  const tokenSpec = contract.keys.enrollmentToken;

  if (typeof token !== 'string' || token.length === 0) {
    errors.push(
      `Le bundle d'extras ne contient pas « ${ADMIN_EXTRAS.ENROLLMENT_TOKEN} » : le ` +
        "téléphone se provisionnerait, puis resterait non enrôlé.",
    );
  } else if (!new RegExp(tokenSpec.pattern).test(token)) {
    warnings.push(
      `Le jeton ne suit pas le format attendu (${tokenSpec.pattern}). Vérifiez qu'il ` +
        "provient bien de l'API et n'a pas été recopié à la main.",
    );
  }

  const serverUrl = (bundle as Record<string, unknown>)[ADMIN_EXTRAS.SERVER_URL];
  if (typeof serverUrl === 'string' && serverUrl.length > 0) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(serverUrl);
    } catch {
      errors.push(`Adresse du serveur invalide : « ${serverUrl} ».`);
    }

    if (parsed) {
      if (parsed.protocol !== 'https:') {
        warnings.push(
          `L'application joindra l'API en ${parsed.protocol}// : acceptable en recette, ` +
            'jamais sur un parc en service.',
        );
      }
      if (parsed.pathname === '/') {
        warnings.push(
          "L'adresse du serveur ne comporte aucun chemin. L'API est servie sous un " +
            'préfixe global (par défaut « /api/ ») : sans lui, tous les appels ' +
            'répondront 404.',
        );
      }
      if (!serverUrl.endsWith('/')) {
        warnings.push(
          "L'adresse du serveur ne se termine pas par « / ». L'application corrige " +
            "d'elle-même, mais autant l'écrire correctement.",
        );
      }
    }
  } else {
    warnings.push(
      "Aucune adresse de serveur transmise : l'application retombera sur celle compilée " +
        "dans l'APK. Correct sur un parc mono-serveur, faux dès qu'il y en a deux.",
    );
  }
}
