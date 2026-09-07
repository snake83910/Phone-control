import { z } from 'zod';

/**
 * Validation stricte de l'environnement au démarrage.
 *
 * Le principe : l'application refuse de démarrer si un secret est absent ou
 * manifestement laissé à sa valeur d'exemple en production. Un démarrage
 * silencieux avec un poivre de badge par défaut serait bien pire qu'un crash.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  API_GLOBAL_PREFIX: z.string().default('api'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),

  DEVICE_JWT_SECRET: z.string().min(16),
  DEVICE_ACCESS_TTL: z.string().default('60m'),
  DEVICE_REFRESH_TTL: z.string().default('30d'),
  ENROLLMENT_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

  /**
   * Tolérance sur l'horloge des téléphones, en secondes.
   *
   * Au-delà, un événement daté dans le futur est accepté mais marqué
   * `clock_suspect` (docs/05, résolution des conflits). Il n'est jamais rejeté :
   * une preuve horodatée de travers reste une preuve, et la refuser reviendrait
   * à effacer ce qu'on cherche justement à constater.
   */
  CLOCK_SKEW_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),

  /**
   * Delai laisse au chauffeur pour repondre a une demande de partage d'ecran.
   *
   * Passe ce delai, la demande expire d'elle-meme. Une demande qui attendrait
   * indefiniment finirait par surgir devant quelqu'un qui roule depuis, en
   * reponse a un probleme resolu depuis longtemps.
   */
  SCREEN_SHARE_RESPONSE_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(120),

  /**
   * Duree maximale d'un partage d'ecran, accord donne.
   *
   * C'est la garantie qui distingue une assistance d'une surveillance : la
   * seance se ferme SEULE, sans que personne n'ait a y penser. Configurable,
   * jamais absente (§61).
   */
  SCREEN_SHARE_MAX_DURATION_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(600),

  /**
   * Taille maximale d'une image, en octets. Une capture JPEG d'ecran de
   * telephone reduite tourne autour de 60 a 150 ko ; la borne protege le
   * serveur d'un envoi aberrant.
   */
  SCREEN_SHARE_MAX_FRAME_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(400_000),

  /**
   * Intervalle minimal entre deux images d'une meme seance, en millisecondes.
   *
   * Le partage transmet des images, pas de la video : c'est suffisant pour
   * accompagner quelqu'un a l'ecran, et cela divise la consommation de donnees
   * mobiles par un ordre de grandeur.
   */
  SCREEN_SHARE_MIN_FRAME_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(700),

  /**
   * Repertoire ou sont conserves les APK deposes pour deploiement.
   *
   * Hors du depot de sources, et hors de tout repertoire servi statiquement :
   * un APK n'est telechargeable que par une route authentifiee par le jeton
   * d'un appareil.
   */
  APP_PACKAGE_STORAGE_DIR: z.string().default('./storage/app-packages'),

  /**
   * Taille maximale d'un APK accepte, en octets.
   *
   * Le flux est coupe des que cette borne est franchie : le fichier n'est
   * jamais entierement recu avant d'etre refuse. Defaut a 150 Mo, au-dela de
   * ce que pese une application metier ordinaire.
   */
  APP_PACKAGE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(150 * 1024 * 1024),

  /**
   * Relais SMTP pour les notifications par courriel, sous forme d'URL
   * (`smtps://utilisateur:motdepasse@relais:465`). Absente, le canal courriel se
   * déclare non configuré et n'essaie rien — mieux qu'un envoi qui échoue
   * silencieusement à chaque alerte.
   */
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  /**
   * Clé de compte de service Firebase, en JSON, pour le réveil des téléphones.
   * Absente, les téléphones sont réveillés par leur sondage périodique — plus
   * lent, mais complet. FCM n'est jamais une dépendance (docs/01 §2.5).
   */
  FCM_SERVICE_ACCOUNT: z.string().optional(),

  BADGE_HMAC_PEPPER: z.string().min(16),
  BADGE_HASH_VERSION: z.coerce.number().int().positive().default(1),

  /**
   * Format attendu d'un numéro de badge, en expression régulière, appliqué
   * **à l'enregistrement** sur la valeur normalisée (majuscules, sans espaces
   * ni tirets).
   *
   * Vide par défaut : tout est accepté, ce qui convient tant qu'on ignore le
   * format réel du parc. Une fois ce format connu — par exemple huit chiffres —
   * le renseigner évite qu'une saisie fautive devienne un badge que personne ne
   * pourra jamais scanner, et qu'on ne saura plus identifier ensuite puisque
   * seuls les quatre derniers caractères restent visibles.
   *
   * Exemple : BADGE_FORMAT_PATTERN=^[0-9]{8}$
   */
  BADGE_FORMAT_PATTERN: z.string().optional().default(''),
  DEVICE_MASTER_KEY: z.string().min(16),
  BADGE_ENCRYPTION_KEY: z.string().optional().default(''),

  THROTTLE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  THROTTLE_LIMIT: z.coerce.number().int().positive().default(120),
  BARCODE_THROTTLE_PER_DEVICE_PER_MIN: z.coerce.number().int().positive().default(10),
  BARCODE_THROTTLE_PER_BADGE_PER_MIN: z.coerce.number().int().positive().default(5),
  BARCODE_DEVICE_LOCKOUT_FAILURES: z.coerce.number().int().positive().default(30),
  BARCODE_DEVICE_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  DASHBOARD_URL: z.string().default('http://localhost:3000'),

  // Tâches planifiées : activées par défaut en développement (une seule
  // instance), à désactiver sur les répliques d'API lorsqu'un processus worker
  // dédié tourne à côté.
  WORKER_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),

  FCM_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional().default(''),
});

export type Env = z.infer<typeof envSchema>;

const PLACEHOLDER = /^change-me/i;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuration invalide :\n${details}`);
  }

  const env = parsed.data;

  if (env.NODE_ENV === 'production') {
    const secrets: (keyof Env)[] = [
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
      'DEVICE_JWT_SECRET',
      'BADGE_HMAC_PEPPER',
      'DEVICE_MASTER_KEY',
    ];
    const placeholders = secrets.filter((k) => PLACEHOLDER.test(String(env[k])));
    if (placeholders.length > 0) {
      throw new Error(
        `Secrets laissés à leur valeur d'exemple en production : ${placeholders.join(', ')}. ` +
          `Générer chaque valeur avec « openssl rand -hex 32 ».`,
      );
    }
  }

  return env;
}

export const configuration = () => validateEnv(process.env);
