import { z } from 'zod';

/**
 * Profil de provisioning : ce qui décrit *comment* un téléphone rejoint le parc.
 *
 * Ce schéma est partagé par les deux producteurs de QR codes — l'outil
 * d'atelier, qui le lit dans un fichier, et le dashboard, qui le lit dans son
 * environnement. Un seul schéma, donc une seule définition de ce qui est
 * obligatoire, de ce qui est facultatif, et de ce qui vaut par défaut.
 *
 * **Aucun mot de passe n'y figure.** Le mot de passe du Wi-Fi d'atelier est
 * fourni séparément, au moment de construire la charge utile : il ne doit
 * traverser ni un fichier versionné, ni une réponse d'API.
 */

export const WIFI_SECURITY_TYPES = ['NONE', 'WEP', 'WPA', 'EAP'] as const;

export const wifiSchema = z
  .object({
    ssid: z.string().min(1).max(32),
    securityType: z.enum(WIFI_SECURITY_TYPES),
    hidden: z.boolean().optional().default(false),
  })
  .strict();

export const provisioningProfileSchema = z
  .object({
    /** Identifiant applicatif de l'APK réellement déployé. */
    packageName: z.string().min(3),
    /** `paquet/classe` désigné comme Device Owner. */
    adminComponent: z.string().min(3),
    /** SHA-256 du certificat de signature, base64 URL-safe sans remplissage. */
    signatureChecksum: z.string().optional(),
    /** URL HTTPS publique où le téléphone télécharge l'APK, avant tout enrôlement. */
    apkDownloadUrl: z.string().url().optional(),
    apkDownloadCookieHeader: z.string().optional(),
    minimumVersionCode: z.number().int().positive().optional(),
    /** Adresse de l'API transmise à l'application dans le bundle d'extras. */
    serverUrl: z.string().url(),
    skipEncryption: z.boolean().optional().default(false),
    leaveAllSystemAppsEnabled: z.boolean().optional().default(true),
    locale: z.string().optional(),
    timeZone: z.string().optional(),
    /** Autorise explicitement un téléchargement en HTTP. Refusé par défaut. */
    allowInsecureDownload: z.boolean().optional().default(false),
    wifi: wifiSchema.optional(),
  })
  .strict();

export type ProvisioningProfile = z.infer<typeof provisioningProfileSchema>;
