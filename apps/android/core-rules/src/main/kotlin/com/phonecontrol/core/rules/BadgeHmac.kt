package com.phonecontrol.core.rules

import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Format des empreintes de badge.
 *
 * Ce fichier n'existe que pour une raison : **le téléphone et le serveur
 * doivent produire exactement la même chaîne**. Si l'un encode en base64
 * standard et l'autre en base64url, ou si l'un oublie le préfixe de version, un
 * badge valide en ligne sera refusé hors ligne — panne intermittente,
 * incompréhensible pour le chauffeur comme pour l'exploitation.
 *
 * Le format est donc défini ici, une seule fois, et vérifié des deux côtés
 * contre les mêmes vecteurs de référence
 * (`packages/state-machine-spec/scenarios/badge-hash-vectors.json`).
 *
 * Message haché : `v<version>:<valeur normalisée>`, encodé en UTF-8.
 * Sortie : base64url, sans remplissage.
 */
object BadgeHmac {

    private const val HMAC_ALGORITHM = "HmacSHA256"

    fun message(normalizedBarcode: String, version: Int = BarcodeNormalizer.HASH_VERSION): ByteArray =
        "v$version:$normalizedBarcode".toByteArray(Charsets.UTF_8)

    fun encode(digest: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(digest)

    /**
     * Empreinte calculée avec une clé brute.
     *
     * Sur le téléphone, la clé ne quitte jamais le Keystore : c'est
     * `SecureStore` qui fait le calcul, avec ce même format. Cette variante
     * sert aux tests et au serveur.
     */
    fun deviceScopedHash(
        key: ByteArray,
        normalizedBarcode: String,
        version: Int = BarcodeNormalizer.HASH_VERSION,
    ): String {
        val mac = Mac.getInstance(HMAC_ALGORITHM)
        mac.init(SecretKeySpec(key, HMAC_ALGORITHM))
        return encode(mac.doFinal(message(normalizedBarcode, version)))
    }

    /**
     * Dérivation HKDF-SHA256 de la clé propre à un appareil.
     *
     * Implémentée à la main : la JVM 17 n'expose pas HKDF, et une dépendance
     * cryptographique supplémentaire ne se justifie pas pour trente lignes
     * dont le comportement est vérifié par des vecteurs de référence.
     *
     * Doit produire exactement le même résultat que `crypto.hkdfSync` côté
     * serveur, sans quoi les listes hors ligne seraient inutilisables.
     */
    fun deriveDeviceKey(
        masterKey: ByteArray,
        deviceId: String,
        info: String = "offline-badge-v1",
        length: Int = 32,
    ): ByteArray {
        val salt = deviceId.toByteArray(Charsets.UTF_8)
        val infoBytes = info.toByteArray(Charsets.UTF_8)

        // Extract
        val extractMac = Mac.getInstance(HMAC_ALGORITHM)
        extractMac.init(SecretKeySpec(salt, HMAC_ALGORITHM))
        val pseudoRandomKey = extractMac.doFinal(masterKey)

        // Expand
        val expandMac = Mac.getInstance(HMAC_ALGORITHM)
        expandMac.init(SecretKeySpec(pseudoRandomKey, HMAC_ALGORITHM))

        val output = ByteArray(length)
        var previous = ByteArray(0)
        var position = 0
        var counter = 1

        while (position < length) {
            expandMac.reset()
            expandMac.update(previous)
            expandMac.update(infoBytes)
            expandMac.update(counter.toByte())
            previous = expandMac.doFinal()

            val take = minOf(previous.size, length - position)
            previous.copyInto(output, position, 0, take)
            position += take
            counter++
        }

        return output
    }
}
