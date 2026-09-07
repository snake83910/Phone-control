package com.phonecontrol.security

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.phonecontrol.core.rules.BadgeHmac
import com.phonecontrol.core.rules.BarcodeNormalizer
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Stockage des secrets de l'appareil.
 *
 * Trois niveaux, du plus au moins sensible :
 *
 *  1. **La clé HMAC hors ligne** est importée dans l'Android Keystore et n'en
 *     ressort JAMAIS. On ne peut que demander au Keystore de calculer un HMAC
 *     avec elle. Un attaquant qui obtient un accès root lit les préférences,
 *     mais pas cette clé — c'est précisément ce qui rend inexploitable, sur un
 *     autre téléphone, la liste de badges extraite de celui-ci.
 *
 *  2. **Les jetons** vivent dans des préférences chiffrées (clé maîtresse du
 *     Keystore, StrongBox si le terminal en dispose).
 *
 *  3. Le reste — identifiant d'appareil, version de configuration — n'est pas
 *     secret et suit le même chemin par simplicité.
 */
@Singleton
class SecureStore @Inject constructor(
    private val context: Context,
) {

    /**
     * Un magasin illisible ne doit JAMAIS faire planter l'application.
     *
     * Ce cas se produit réellement : keystore corrompu après une mise à jour du
     * système, restauration d'image, matériel défaillant. Un plantage au
     * démarrage rendrait le téléphone inutilisable sur le terrain, sans aucun
     * message. On tente donc une reconstruction, puis on bascule en mode
     * dégradé explicite — l'écran affiche « téléphone non enrôlé » et il faut
     * le réenrôler, ce qui est désagréable mais réparable.
     */
    private var available: Boolean = true

    val isAvailable: Boolean get() = available

    private val preferences: SharedPreferences? by lazy {
        openPreferences() ?: run {
            Log.w(TAG, "Magasin sécurisé illisible : tentative de reconstruction.")
            context.deleteSharedPreferences(PREFS_NAME)
            runCatching {
                KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
                    .deleteEntry(OFFLINE_KEY_ALIAS)
            }
            openPreferences().also { rebuilt ->
                if (rebuilt == null) {
                    available = false
                    Log.e(
                        TAG,
                        "Magasin sécurisé indisponible : l'appareil devra être réenrôlé.",
                    )
                }
            }
        }
    }

    private fun openPreferences(): SharedPreferences? = runCatching {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .setRequestStrongBoxBacked(hasStrongBox())
            .build()

        EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }.getOrNull()

    private fun hasStrongBox(): Boolean =
        context.packageManager.hasSystemFeature(
            android.content.pm.PackageManager.FEATURE_STRONGBOX_KEYSTORE,
        )

    // --- Identité et jetons -------------------------------------------------

    var deviceId: String?
        get() = preferences?.getString(KEY_DEVICE_ID, null)
        set(value) { preferences?.edit()?.putString(KEY_DEVICE_ID, value)?.apply() }

    var assetTag: String?
        get() = preferences?.getString(KEY_ASSET_TAG, null)
        set(value) { preferences?.edit()?.putString(KEY_ASSET_TAG, value)?.apply() }

    var accessToken: String?
        get() = preferences?.getString(KEY_ACCESS_TOKEN, null)
        set(value) { preferences?.edit()?.putString(KEY_ACCESS_TOKEN, value)?.apply() }

    var refreshToken: String?
        get() = preferences?.getString(KEY_REFRESH_TOKEN, null)
        set(value) { preferences?.edit()?.putString(KEY_REFRESH_TOKEN, value)?.apply() }

    var serverUrl: String?
        get() = preferences?.getString(KEY_SERVER_URL, null)
        set(value) { preferences?.edit()?.putString(KEY_SERVER_URL, value)?.apply() }

    var configVersion: Int
        get() = preferences?.getInt(KEY_CONFIG_VERSION, -1) ?: -1
        set(value) { preferences?.edit()?.putInt(KEY_CONFIG_VERSION, value)?.apply() }

    /** Décalage entre l'horloge de l'appareil et celle du serveur, en millisecondes. */
    var serverTimeOffsetMs: Long
        get() = preferences?.getLong(KEY_TIME_OFFSET, 0L) ?: 0L
        set(value) { preferences?.edit()?.putLong(KEY_TIME_OFFSET, value)?.apply() }

    /**
     * Phrase secrète de la base locale (SQLCipher), en hexadécimal.
     *
     * Elle vit ici et nulle part ailleurs : le magasin est chiffré par une clé
     * maîtresse du Keystore, ce qui la protège au repos aussi bien que les
     * jetons. Voir [com.phonecontrol.security.DatabaseKey] pour le raisonnement.
     */
    var databasePassphrase: String?
        get() = preferences?.getString(KEY_DB_PASSPHRASE, null)
        set(value) { preferences?.edit()?.putString(KEY_DB_PASSPHRASE, value)?.apply() }

    /**
     * Dernières remontées d'intégrité, sérialisées.
     *
     * Rien de secret : cet état sert seulement à ne pas répéter le même constat
     * à chaque cycle de synchronisation. Il suit le même chemin que le reste par
     * simplicité.
     */
    var integrityStateJson: String?
        get() = preferences?.getString(KEY_INTEGRITY_STATE, null)
        set(value) { preferences?.edit()?.putString(KEY_INTEGRITY_STATE, value)?.apply() }

    val isEnrolled: Boolean
        get() = deviceId != null && accessToken != null

    fun clearCredentials() {
        preferences?.edit()
            ?.remove(KEY_ACCESS_TOKEN)
            ?.remove(KEY_REFRESH_TOKEN)
            ?.apply()
    }

    /** Effacement complet : décommissionnement ou révocation de l'appareil. */
    fun wipe() {
        preferences?.edit()?.clear()?.apply()
        runCatching {
            KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
                .deleteEntry(OFFLINE_KEY_ALIAS)
        }
    }

    // --- Clé HMAC hors ligne ------------------------------------------------

    /**
     * Importe la clé reçue à l'enrôlement. Elle est stockée comme clé HMAC non
     * exportable : à partir de cet instant, elle ne quitte plus le Keystore.
     */
    fun storeOfflineKey(base64Key: String) {
        val raw = Base64.decode(base64Key, Base64.DEFAULT)
        val keystore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        keystore.setEntry(
            OFFLINE_KEY_ALIAS,
            KeyStore.SecretKeyEntry(javax.crypto.spec.SecretKeySpec(raw, HMAC_ALGORITHM)),
            KeyProtection(),
        )
        preferences?.edit()?.putBoolean(KEY_HAS_OFFLINE_KEY, true)?.apply()
    }

    val hasOfflineKey: Boolean
        get() = preferences?.getBoolean(KEY_HAS_OFFLINE_KEY, false) ?: false

    /**
     * Calcule l'empreinte d'un code-barres avec la clé de CET appareil.
     * Le format doit être identique à celui du serveur
     * (`BadgeHashService.deviceScopedHash`) : `HMAC(clé, "v<version>:<valeur>")`,
     * encodé en base64url sans remplissage.
     */
    fun deviceScopedHash(
        normalizedBarcode: String,
        hashVersion: Int = BarcodeNormalizer.HASH_VERSION,
    ): String? {
        val keystore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val entry = keystore.getEntry(OFFLINE_KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
            ?: return null

        val mac = Mac.getInstance(HMAC_ALGORITHM)
        mac.init(entry.secretKey)
        // Le message et l'encodage viennent de BadgeHmac : c'est le seul
        // endroit où le format est défini, et il est vérifié contre les
        // vecteurs de référence du serveur.
        return BadgeHmac.encode(mac.doFinal(BadgeHmac.message(normalizedBarcode, hashVersion)))
    }

    private fun KeyProtection(): KeyStore.ProtectionParameter =
        android.security.keystore.KeyProtection.Builder(KeyProperties.PURPOSE_SIGN)
            .setDigests(KeyProperties.DIGEST_SHA256)
            // Aucune authentification utilisateur requise : le calcul doit
            // fonctionner avec l'écran verrouillé, pendant une synchronisation.
            .setUserAuthenticationRequired(false)
            .build()

    companion object {
        private const val PREFS_NAME = "phone_control_secure"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val OFFLINE_KEY_ALIAS = "phone_control_offline_hmac"
        private const val HMAC_ALGORITHM = "HmacSHA256"

        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_ASSET_TAG = "asset_tag"
        private const val KEY_ACCESS_TOKEN = "access_token"
        private const val KEY_REFRESH_TOKEN = "refresh_token"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_CONFIG_VERSION = "config_version"
        private const val KEY_TIME_OFFSET = "server_time_offset"
        private const val KEY_HAS_OFFLINE_KEY = "has_offline_key"
        private const val KEY_DB_PASSPHRASE = "database_passphrase"
        private const val KEY_INTEGRITY_STATE = "integrity_state"
        private const val TAG = "SecureStore"

        /** Rendu accessible aux tests : génère une clé locale de démonstration. */
        fun generateLocalKey(): javax.crypto.SecretKey =
            KeyGenerator.getInstance(HMAC_ALGORITHM).apply { init(256) }.generateKey()
    }
}
