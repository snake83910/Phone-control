import {
  provisioningProfileSchema,
  type ProvisioningProfile,
} from '@phone-control/provisioning-payload';

/**
 * Profil de provisioning du dashboard.
 *
 * Le même schéma que celui de l'outil d'atelier — il vient du paquet partagé —
 * mais alimenté par l'environnement plutôt que par un fichier : un dashboard se
 * déploie avec des variables, pas avec un JSON qu'il faudrait monter dans le
 * conteneur.
 *
 * **Ces valeurs ne sortent jamais vers le navigateur.** Aucune n'est préfixée
 * `NEXT_PUBLIC_`, et le mot de passe du Wi-Fi n'est lu qu'ici, au moment de
 * construire la charge utile. Il finit certes dans le QR code — Android le lit
 * là — mais il ne transite jamais comme donnée JSON dans une réponse.
 *
 * Ce qui est décrit ici relève du **déploiement**, non de l'entreprise : un même
 * APK, une même clé de signature, un même serveur. Ce qui rattache un téléphone
 * à une entreprise précise est le jeton d'enrôlement, émis par l'API et vérifié
 * par elle. Un Wi-Fi d'atelier par entreprise supposerait de stocker le profil
 * en base ; ce n'est pas fait, et c'est signalé dans docs/12.
 */

export interface ProvisioningSetup {
  profile: ProvisioningProfile;
  wifiPassword?: string;
}

export type ProvisioningSetupResult =
  | { ok: true; setup: ProvisioningSetup }
  | { ok: false; problems: string[] };

const truthy = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'oui', 'yes'].includes(value.trim().toLowerCase());
};

const trimmed = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text && text.length > 0 ? text : undefined;
};

export function loadProvisioningSetup(
  env: NodeJS.ProcessEnv = process.env,
): ProvisioningSetupResult {
  const serverUrl = trimmed(env.PROVISIONING_SERVER_URL);

  if (!serverUrl) {
    return {
      ok: false,
      problems: [
        'PROVISIONING_SERVER_URL n’est pas renseignée. C’est l’adresse publique de ' +
          'l’API, celle que le téléphone appellera depuis le réseau mobile — et non ' +
          'API_INTERNAL_URL, qui n’est joignable que depuis le serveur.',
      ],
    };
  }

  const ssid = trimmed(env.PROVISIONING_WIFI_SSID);
  const raw = {
    packageName: trimmed(env.PROVISIONING_PACKAGE_NAME) ?? 'com.phonecontrol',
    adminComponent:
      trimmed(env.PROVISIONING_ADMIN_COMPONENT) ??
      'com.phonecontrol/.kiosk.PhoneControlDeviceAdminReceiver',
    signatureChecksum: trimmed(env.PROVISIONING_SIGNATURE_CHECKSUM),
    apkDownloadUrl: trimmed(env.PROVISIONING_APK_URL),
    serverUrl,
    skipEncryption: truthy(env.PROVISIONING_SKIP_ENCRYPTION, false),
    leaveAllSystemAppsEnabled: truthy(env.PROVISIONING_LEAVE_SYSTEM_APPS, true),
    locale: trimmed(env.PROVISIONING_LOCALE),
    timeZone: trimmed(env.PROVISIONING_TIMEZONE),
    allowInsecureDownload: truthy(env.PROVISIONING_ALLOW_INSECURE_DOWNLOAD, false),
    wifi: ssid
      ? {
          ssid,
          securityType: (trimmed(env.PROVISIONING_WIFI_SECURITY) ?? 'WPA') as never,
          hidden: truthy(env.PROVISIONING_WIFI_HIDDEN, false),
        }
      : undefined,
  };

  const parsed = provisioningProfileSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(profil)'} : ${issue.message}`,
      ),
    };
  }

  return {
    ok: true,
    setup: {
      profile: parsed.data,
      wifiPassword: trimmed(env.PROVISIONING_WIFI_PASSWORD),
    },
  };
}
