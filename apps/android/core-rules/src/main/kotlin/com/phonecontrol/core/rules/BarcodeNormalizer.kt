package com.phonecontrol.core.rules

/**
 * Normalisation de la valeur d'un badge — **règle figée, version 1**.
 *
 * Portage exact de `normalizeBarcode` dans
 * `apps/api/src/crypto/badge-hash.service.ts`. Les deux doivent produire le
 * même résultat au caractère près : le téléphone hache localement pour
 * l'authentification hors ligne, le serveur hache pour la recherche en base.
 * Une divergence, même sur un espace, rendrait un badge valide en ligne et
 * refusé hors ligne — panne intermittente, incompréhensible sur le terrain.
 *
 * Format confirmé par le client : numérique, 8 chiffres (exemple : 14557719).
 * La normalisation reste un peu plus large pour absorber les variations de
 * lecture des scanners, sans changer de version.
 *
 * Règles :
 *  1. suppression des espaces et caractères de contrôle en tête et en fin ;
 *  2. passage en majuscules ;
 *  3. suppression de tout caractère hors `[A-Z0-9]` ;
 *  4. LES ZÉROS DE TÊTE SONT CONSERVÉS — « 01455771 » ≠ « 1455771 ».
 *
 * ATTENTION : modifier cette fonction rend introuvables tous les badges déjà
 * enregistrés. Toute évolution passe par une nouvelle version de hachage et un
 * réenregistrement des badges.
 */
object BarcodeNormalizer {

    const val HASH_VERSION: Int = 1

    private const val MIN_LENGTH = 4
    private const val MAX_LENGTH = 32

    private val DISALLOWED = Regex("[^A-Z0-9]")

    class InvalidBarcodeException(message: String) : IllegalArgumentException(message)

    fun normalize(raw: String): String {
        val normalized = raw.trim().uppercase().replace(DISALLOWED, "")

        if (normalized.length < MIN_LENGTH || normalized.length > MAX_LENGTH) {
            throw InvalidBarcodeException(
                "Longueur de code-barres invalide après normalisation : " +
                    "${normalized.length} caractères (attendu entre $MIN_LENGTH et $MAX_LENGTH).",
            )
        }

        return normalized
    }

    /** Variante non levante, pour le flux du scanner où un rejet est banal. */
    fun normalizeOrNull(raw: String): String? =
        try {
            normalize(raw)
        } catch (error: InvalidBarcodeException) {
            null
        }

    /** Masque d'affichage : 14557719 -> ****7719. Jamais la valeur complète. */
    fun mask(normalized: String): String {
        if (normalized.length <= 4) return normalized
        return "*".repeat(normalized.length - 4) + normalized.takeLast(4)
    }

    fun last4(normalized: String): String = normalized.takeLast(4)
}
