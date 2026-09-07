package com.phonecontrol.core.rules

import java.time.Duration
import java.time.Instant
import kotlin.math.abs
import kotlin.math.max

/**
 * Moteur de geofencing local — le cœur de la lutte contre les fausses alertes.
 *
 * Il n'existe **que côté téléphone** : le serveur reçoit des transitions déjà
 * confirmées et se contente d'appliquer la règle horaire (docs/06 §5). C'est
 * aussi pourquoi ses scénarios de référence ne sont exécutés que par JUnit.
 *
 * Ce que fait ce moteur, et que l'API Geofencing d'Android ne fait pas :
 *  - il écarte les mesures inexploitables au lieu de les subir ;
 *  - il exige plusieurs mesures cohérentes avant de conclure ;
 *  - il rend la sortie plus difficile que l'entrée (hystérésis) ;
 *  - il conserve les mesures ayant conduit à la décision, pour qu'une alerte
 *    contestée puisse être justifiée.
 *
 * Fonction pure au sens utile du terme : aucune horloge interne, aucun accès
 * système. Tout entre par [accept].
 */

data class LocationFix(
    val recordedAt: Instant,
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Double,
    val isMock: Boolean = false,
    val speedMps: Double? = null,
    /** Le téléphone voit-il le Wi-Fi du dépôt ? Indice, jamais preuve. */
    val wifiSuggestsDepot: Boolean = false,
    /** Reconnaissance d'activité : appareil immobile. Indice, jamais preuve. */
    val deviceIsStill: Boolean = false,
)

data class GeofenceConfig(
    val latitude: Double,
    val longitude: Double,
    val radiusMeters: Double = 250.0,
    val hysteresisMeters: Double = 75.0,
    /** Au-delà, la mesure n'est pas exploitable pour décider. */
    val accuracyThresholdMeters: Double = 100.0,
    val confirmationSamples: Int = 3,
    val confirmationSeconds: Long = 120,
    /** Vitesse implicite au-delà de laquelle un saut est jugé impossible. */
    val maxSpeedMps: Double = 50.0,
    /** Âge maximal d'une mesure encore recevable. */
    val maxFixAgeSeconds: Long = 120,
)

enum class ZoneState { OUTSIDE, ENTER_PENDING, INSIDE, EXIT_PENDING }

enum class RejectionReason {
    /** Précision insuffisante pour trancher. */
    ACCURACY,
    /** Position simulée : signal de fraude, jamais silencieux. */
    MOCK,
    /** Saut de position impossible entre deux mesures. */
    SPEED_JUMP,
    /** Mesure antérieure à la précédente, ou trop ancienne. */
    STALE,
}

data class SampleEvaluation(
    val recordedAt: Instant,
    val distanceMeters: Double,
    val accuracyMeters: Double,
    val classification: FixClassification,
)

data class ConfirmedTransition(
    val kind: TransitionKind,
    val occurredAt: Instant,
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Double,
    /** 0 à 1. Sert au support, pas à la décision — celle-ci est déjà prise. */
    val confidence: Double,
    /** Mesures ayant conduit à la décision. */
    val evaluation: List<SampleEvaluation>,
)

data class FixOutcome(
    val transition: ConfirmedTransition?,
    val state: ZoneState,
    val rejected: RejectionReason?,
    val classification: FixClassification?,
    val distanceMeters: Double?,
)

class GeofenceEngine(
    private val config: GeofenceConfig,
    initialState: ZoneState = ZoneState.OUTSIDE,
) {
    var state: ZoneState = initialState
        private set

    private val pending = mutableListOf<SampleEvaluation>()
    private var lastAcceptedFix: LocationFix? = null

    /** Dernière position retenue pour la décision. Utile au diagnostic. */
    val lastFix: LocationFix? get() = lastAcceptedFix

    fun accept(fix: LocationFix): FixOutcome {
        rejectionFor(fix)?.let { reason ->
            // La mesure est écartée de la DÉCISION, mais l'appelant l'enregistre
            // quand même : une position simulée doit remonter au serveur.
            return FixOutcome(null, state, reason, null, null)
        }

        val distance = haversineMeters(
            config.latitude,
            config.longitude,
            fix.latitude,
            fix.longitude,
        )
        val classification = classifyFix(
            distanceMeters = distance,
            accuracyMeters = fix.accuracyMeters,
            radiusMeters = config.radiusMeters,
            hysteresisMeters = config.hysteresisMeters,
        )

        lastAcceptedFix = fix
        val sample = SampleEvaluation(fix.recordedAt, distance, fix.accuracyMeters, classification)

        val transition = advance(sample, fix)
        return FixOutcome(transition, state, null, classification, distance)
    }

    private fun rejectionFor(fix: LocationFix): RejectionReason? {
        if (fix.isMock) return RejectionReason.MOCK
        if (fix.accuracyMeters > config.accuracyThresholdMeters) return RejectionReason.ACCURACY

        val previous = lastAcceptedFix ?: return null

        if (!fix.recordedAt.isAfter(previous.recordedAt)) return RejectionReason.STALE

        val elapsed = Duration.between(previous.recordedAt, fix.recordedAt).seconds
        if (elapsed > config.maxFixAgeSeconds * 60) return null // trop ancienne pour comparer

        val moved = haversineMeters(
            previous.latitude,
            previous.longitude,
            fix.latitude,
            fix.longitude,
        )
        // Marge de tolérance égale à la somme des précisions : deux mesures
        // imprécises peuvent sembler s'éloigner sans que rien n'ait bougé.
        val tolerance = previous.accuracyMeters + fix.accuracyMeters
        if (elapsed > 0 && (moved - tolerance) / elapsed > config.maxSpeedMps) {
            return RejectionReason.SPEED_JUMP
        }
        return null
    }

    private fun advance(sample: SampleEvaluation, fix: LocationFix): ConfirmedTransition? {
        return when (state) {
            ZoneState.OUTSIDE ->
                if (sample.classification == FixClassification.INSIDE_CERTAIN) {
                    startPending(ZoneState.ENTER_PENDING, sample)
                    confirmIfReady(TransitionKind.ENTER, fix, required = requiredSamples(TransitionKind.ENTER, fix))
                } else null

            ZoneState.ENTER_PENDING ->
                when (sample.classification) {
                    FixClassification.INSIDE_CERTAIN -> {
                        pending += sample
                        confirmIfReady(TransitionKind.ENTER, fix, required = requiredSamples(TransitionKind.ENTER, fix))
                    }
                    // Une seule mesure certainement dehors annule l'entrée en cours.
                    FixClassification.OUTSIDE_CERTAIN -> {
                        reset(ZoneState.OUTSIDE)
                        null
                    }
                    FixClassification.UNDETERMINED -> null
                }

            ZoneState.INSIDE ->
                if (sample.classification == FixClassification.OUTSIDE_CERTAIN) {
                    startPending(ZoneState.EXIT_PENDING, sample)
                    confirmIfReady(TransitionKind.EXIT, fix, required = requiredSamples(TransitionKind.EXIT, fix))
                } else null

            ZoneState.EXIT_PENDING ->
                when (sample.classification) {
                    FixClassification.OUTSIDE_CERTAIN -> {
                        pending += sample
                        confirmIfReady(TransitionKind.EXIT, fix, required = requiredSamples(TransitionKind.EXIT, fix))
                    }
                    // Une seule mesure certainement dedans annule la sortie en cours :
                    // c'est ce qui absorbe un aller-retour au portail.
                    FixClassification.INSIDE_CERTAIN -> {
                        reset(ZoneState.INSIDE)
                        null
                    }
                    FixClassification.UNDETERMINED -> null
                }
        }
    }

    /**
     * Signaux complémentaires (docs/06 §3.4).
     *
     * Ils ne déclenchent jamais une transition : ils la RENDENT PLUS EXIGEANTE.
     * Un téléphone connecté au Wi-Fi du dépôt, ou immobile, n'est probablement
     * pas en train d'en sortir — mais l'affirmer serait aussi faux que de
     * l'ignorer, d'où le doublement du seuil plutôt qu'un blocage.
     */
    private fun requiredSamples(kind: TransitionKind, fix: LocationFix): Int {
        if (kind == TransitionKind.ENTER) return config.confirmationSamples
        val doubted = fix.wifiSuggestsDepot || fix.deviceIsStill
        return if (doubted) config.confirmationSamples * 2 else config.confirmationSamples
    }

    private fun startPending(next: ZoneState, sample: SampleEvaluation) {
        state = next
        pending.clear()
        pending += sample
    }

    private fun reset(next: ZoneState) {
        state = next
        pending.clear()
    }

    private fun confirmIfReady(
        kind: TransitionKind,
        fix: LocationFix,
        required: Int,
    ): ConfirmedTransition? {
        if (pending.size < required) return null

        val elapsed = Duration.between(pending.first().recordedAt, pending.last().recordedAt).seconds
        if (elapsed < config.confirmationSeconds) return null

        val evaluation = pending.toList()
        val transition = ConfirmedTransition(
            kind = kind,
            // La transition est datée de la PREMIÈRE mesure cohérente, pas de
            // celle qui la confirme : le chauffeur est entré quand il est entré,
            // pas deux minutes plus tard.
            occurredAt = evaluation.first().recordedAt,
            latitude = fix.latitude,
            longitude = fix.longitude,
            accuracyMeters = fix.accuracyMeters,
            confidence = confidenceOf(evaluation, kind),
            evaluation = evaluation,
        )

        reset(if (kind == TransitionKind.ENTER) ZoneState.INSIDE else ZoneState.OUTSIDE)
        return transition
    }

    /**
     * Confiance : marge par rapport à la limite, rapportée à l'incertitude.
     * Une mesure à 800 m de la zone avec 10 m de précision vaut mieux qu'une
     * mesure à 330 m avec 90 m, même si les deux concluent « dehors ».
     */
    private fun confidenceOf(
        samples: List<SampleEvaluation>,
        kind: TransitionKind,
    ): Double {
        val boundary =
            if (kind == TransitionKind.ENTER) config.radiusMeters
            else config.radiusMeters + config.hysteresisMeters

        val ratios = samples.map { sample ->
            val margin = abs(sample.distanceMeters - boundary)
            margin / (margin + max(sample.accuracyMeters, 1.0))
        }
        // La plus faible des mesures fixe la confiance : une décision ne vaut
        // pas mieux que son maillon le plus incertain.
        return ratios.minOrNull()?.coerceIn(0.0, 1.0) ?: 0.0
    }
}
