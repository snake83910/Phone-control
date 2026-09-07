package com.phonecontrol.core.rules

import java.time.Instant

/**
 * Politique d'épinglage de certificat.
 *
 * L'épinglage protège contre une autorité de certification compromise ou un
 * proxy d'inspection installé sur le réseau : le téléphone n'accepte plus
 * n'importe quel certificat valide, mais seulement ceux dont la clé publique
 * figure dans une liste.
 *
 * **C'est aussi le moyen le plus rapide d'immobiliser une flotte entière.** Le
 * jour où le certificat du serveur est renouvelé avec une nouvelle clé, tous les
 * téléphones cessent de parler à l'API — en même temps, sans préavis, et sans
 * qu'on puisse les corriger à distance puisque le canal de correction est
 * précisément celui qui est coupé.
 *
 * Ce module encode les deux garde-fous qui rendent l'épinglage acceptable
 * (docs/07 §5) :
 *
 * 1. **Au moins deux empreintes.** Une pour le certificat en service, une pour
 *    celui qui prendra sa suite. Renouveler devient alors un remplacement
 *    préparé, et non un pari.
 *
 * 2. **Une date d'expiration.** Passée cette date, l'épinglage est **levé** de
 *    lui-même : la connexion reste protégée par TLS et la validation ordinaire
 *    des autorités, mais la flotte ne s'immobilise pas. Un épinglage périmé est
 *    un défaut d'exploitation à corriger, pas une raison d'arrêter des camions.
 *
 * Module **pur** : aucune dépendance Android, aucune dépendance OkHttp. La
 * politique se relit et se teste sans téléphone ; sa traduction en
 * `CertificatePinner` vit dans le module applicatif.
 */

/** Empreinte SHA-256 d'une clé publique, encodée en base64 — format `sha256/…`. */
private val PIN_PATTERN = Regex("^[A-Za-z0-9+/]{43}=$")

data class PinningPolicy(
    /** Hôte concerné, sans schéma ni port. */
    val host: String,
    /** Empreintes acceptées, en base64 (sans le préfixe `sha256/`). */
    val pins: List<String>,
    /**
     * Date au-delà de laquelle l'épinglage cesse de s'appliquer.
     * `null` signifie « jamais » — et c'est refusé, voir [evaluatePinningPolicy].
     */
    val expiresAt: Instant?,
)

enum class PinningStatus {
    /** Épinglage actif : seules les empreintes listées sont acceptées. */
    ACTIVE,

    /** Date dépassée : épinglage levé, TLS ordinaire. Un événement est remonté. */
    EXPIRED,

    /** Politique inutilisable : épinglage non appliqué, et c'est un défaut à corriger. */
    REJECTED,

    /** Aucune politique configurée : rien à appliquer. */
    ABSENT,
}

data class PinningVerdict(
    val status: PinningStatus,
    /** Empreintes réellement appliquées. Vide sauf en [PinningStatus.ACTIVE]. */
    val activePins: List<String> = emptyList(),
    /** Explication, destinée aux journaux et à l'événement de sécurité. */
    val reason: String? = null,
    /**
     * Vrai lorsque l'expiration approche : il est temps de préparer la rotation,
     * pendant que le canal fonctionne encore.
     */
    val renewalDue: Boolean = false,
)

/** Délai avant expiration à partir duquel on réclame une rotation. */
const val PINNING_RENEWAL_WARNING_DAYS: Long = 60

/**
 * Décide si une politique s'applique, et pourquoi.
 *
 * Aucune situation ne produit d'échec de connexion : au pire l'épinglage n'est
 * pas appliqué et le défaut est signalé. C'est délibéré — voir la note sur
 * l'immobilisation de flotte en tête de fichier.
 */
fun evaluatePinningPolicy(policy: PinningPolicy?, now: Instant): PinningVerdict {
    if (policy == null || policy.pins.isEmpty()) {
        return PinningVerdict(PinningStatus.ABSENT, reason = "aucune politique configurée")
    }

    if (policy.host.isBlank()) {
        return PinningVerdict(PinningStatus.REJECTED, reason = "hôte absent")
    }

    val malformed = policy.pins.filterNot { PIN_PATTERN.matches(it) }
    if (malformed.isNotEmpty()) {
        return PinningVerdict(
            PinningStatus.REJECTED,
            reason = "empreinte malformée : ${malformed.joinToString(", ")}",
        )
    }

    if (policy.pins.distinct().size < 2) {
        // Une seule empreinte, ou deux fois la même : le jour du renouvellement,
        // la flotte s'arrête. Mieux vaut ne pas épingler du tout.
        return PinningVerdict(
            PinningStatus.REJECTED,
            reason = "au moins deux empreintes distinctes sont exigées (secours de rotation)",
        )
    }

    if (policy.expiresAt == null) {
        return PinningVerdict(
            PinningStatus.REJECTED,
            reason = "date d'expiration absente : un épinglage sans échéance n'a pas de porte de sortie",
        )
    }

    if (!policy.expiresAt.isAfter(now)) {
        return PinningVerdict(
            PinningStatus.EXPIRED,
            reason = "épinglage périmé depuis le ${policy.expiresAt} : levé pour ne pas immobiliser la flotte",
        )
    }

    val daysLeft = (policy.expiresAt.toEpochMilli() - now.toEpochMilli()) / 86_400_000
    return PinningVerdict(
        status = PinningStatus.ACTIVE,
        activePins = policy.pins.distinct(),
        reason = "épinglage actif sur ${policy.host}, ${daysLeft} jour(s) restant(s)",
        renewalDue = daysLeft <= PINNING_RENEWAL_WARNING_DAYS,
    )
}
