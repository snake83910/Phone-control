package com.phonecontrol.core.rules

/**
 * Intégrité du terminal : observer, qualifier, signaler. **Jamais bloquer.**
 *
 * Ce module ne décide rien d'irréversible. Il transforme ce que l'application a
 * pu constater du téléphone en événements de sécurité que le serveur reçoit et
 * arbitre. La spécification (§67, docs/07 §5) est explicite : la détection de
 * compromission est *best-effort*, et une détection *best-effort* ne doit jamais
 * verrouiller un chauffeur au bord de la route.
 *
 * **Ce que ce code ne peut pas faire.** Un terminal réellement rooté peut
 * masquer chacun de ces indices : Magisk en mode furtif, `su` renommé, propriétés
 * système réécrites. Ce qui est détecté ici, ce sont les cas ordinaires — un
 * téléphone rooté sans précaution, des options développeur laissées actives, un
 * débogueur branché. C'est utile, et ce n'est pas une garantie. Prétendre le
 * contraire donnerait une fausse assurance, ce qui est pire que rien.
 *
 * Module **pur** : aucune dépendance Android. La collecte des signaux est faite
 * ailleurs ; ici on ne fait que juger, ce qui rend la politique testable sans
 * téléphone.
 */

/** Ce que l'application a observé, sans interprétation. */
data class IntegritySignals(
    /** Chemins où un binaire `su` a été trouvé. */
    val suBinariesFound: List<String> = emptyList(),
    /** Paquets de gestion de root installés (Magisk, SuperSU…). */
    val rootPackagesFound: List<String> = emptyList(),
    /** `Build.TAGS` : « test-keys » trahit une image non signée par le constructeur. */
    val buildTags: String? = null,
    /** Un débogueur est attaché à ce processus, maintenant. */
    val debuggerAttached: Boolean = false,
    /** L'application elle-même est compilée en debug. */
    val debuggableBuild: Boolean = false,
    /** Débogage USB activé dans les paramètres. */
    val adbEnabled: Boolean = false,
    /** Options développeur activées. Seules, elles ne sont qu'un indice. */
    val developerOptionsEnabled: Boolean = false,
    /**
     * La signature de l'APK correspond-elle à celle attendue ?
     * `null` quand la vérification n'a pas pu être faite — cas qu'il faut
     * distinguer d'un échec, sous peine de crier au loup après une simple
     * erreur de lecture.
     */
    val signatureMatchesExpected: Boolean? = null,
)

/**
 * Constats possibles. Les noms et sévérités correspondent aux valeurs du
 * serveur (`SecurityEventType`, `SecuritySeverity`) : ils voyagent tels quels.
 */
enum class IntegrityFinding(val eventType: String, val severity: String) {
    /** Terminal vraisemblablement rooté. */
    ROOT_DETECTED("ROOT_DETECTED", "HIGH"),

    /** Un débogueur est attaché : le processus peut être inspecté et modifié. */
    DEBUGGER_ATTACHED("DEBUGGER_ATTACHED", "HIGH"),

    /** Débogage USB actif : `pm disable`, `am force-stop` deviennent possibles. */
    ADB_ENABLED("ADB_ENABLED", "MEDIUM"),

    /** La signature de l'application ne correspond pas : APK remplacé. */
    APP_INTEGRITY_FAILED("APP_INTEGRITY_FAILED", "CRITICAL"),
}

/** Un constat, avec ce qui l'a motivé. */
data class IntegrityObservation(
    val finding: IntegrityFinding,
    /** Indices, en clair : ils doivent tenir dans un ticket de support. */
    val evidence: List<String>,
) {
    val eventType: String get() = finding.eventType
    val severity: String get() = finding.severity
}

/**
 * Qualifie les signaux.
 *
 * L'ordre du résultat est celui de l'énumération : stable, donc comparable d'une
 * exécution à l'autre et dans les tests.
 */
fun evaluateIntegrity(signals: IntegritySignals): List<IntegrityObservation> {
    val observations = mutableListOf<IntegrityObservation>()

    val rootEvidence = buildList {
        signals.suBinariesFound.forEach { add("binaire su : $it") }
        signals.rootPackagesFound.forEach { add("paquet : $it") }
        // Une image de développement n'est pas un root en soi, mais elle
        // autorise ce que le root autorise. Elle ne compte que si elle
        // accompagne un autre indice, ou seule sur un terminal de production.
        if (signals.buildTags?.contains("test-keys") == true) add("build : test-keys")
    }
    if (rootEvidence.isNotEmpty()) {
        observations += IntegrityObservation(IntegrityFinding.ROOT_DETECTED, rootEvidence)
    }

    if (signals.debuggerAttached) {
        observations += IntegrityObservation(
            IntegrityFinding.DEBUGGER_ATTACHED,
            listOf("débogueur attaché au processus"),
        )
    }

    if (signals.adbEnabled) {
        val evidence = buildList {
            add("débogage USB activé")
            if (signals.developerOptionsEnabled) add("options développeur activées")
        }
        observations += IntegrityObservation(IntegrityFinding.ADB_ENABLED, evidence)
    }

    // `false` seulement : `null` signifie « pas pu vérifier », ce qui n'est pas
    // un échec d'intégrité. Confondre les deux produirait une alerte CRITICAL
    // sur un incident de lecture.
    if (signals.signatureMatchesExpected == false) {
        observations += IntegrityObservation(
            IntegrityFinding.APP_INTEGRITY_FAILED,
            listOf("signature de l'APK différente de celle attendue"),
        )
    }

    // Une compilation debug n'est un constat que si elle n'est pas attendue :
    // l'appelant le sait, pas nous. Elle est donc jointe comme indice à
    // DEBUGGER_ATTACHED lorsqu'elle coexiste, et ignorée sinon.
    if (signals.debuggableBuild && signals.debuggerAttached) {
        val index = observations.indexOfFirst { it.finding == IntegrityFinding.DEBUGGER_ATTACHED }
        observations[index] = observations[index].copy(
            evidence = observations[index].evidence + "application compilée en debug",
        )
    }

    return observations.sortedBy { it.finding.ordinal }
}

/** Dernières remontées connues, par constat. Persistée entre deux exécutions. */
data class IntegrityState(val reportedAtMillis: Map<IntegrityFinding, Long> = emptyMap())

data class IntegrityReport(
    /** Ce qu'il faut envoyer maintenant. */
    val toEmit: List<IntegrityObservation>,
    /** État à persister en retour. */
    val state: IntegrityState,
)

/**
 * Cadence des remontées.
 *
 * Sans cette règle, un téléphone dont les options développeur restent activées
 * émettrait un événement à chaque cycle de synchronisation — quatre-vingt-seize
 * par jour, pour une information constante. Le journal de sécurité deviendrait
 * illisible, et le seul remède serait de cesser de le lire.
 *
 * Trois cas :
 *  - constat nouveau → remonté immédiatement ;
 *  - constat déjà remonté → répété seulement après `repeatAfterMillis` ;
 *  - constat disparu → oublié, pour que son retour soit de nouveau immédiat.
 */
fun planIntegrityReports(
    observations: List<IntegrityObservation>,
    state: IntegrityState,
    nowMillis: Long,
    repeatAfterMillis: Long,
): IntegrityReport {
    val current = observations.associateBy { it.finding }
    val emitted = mutableListOf<IntegrityObservation>()
    val next = mutableMapOf<IntegrityFinding, Long>()

    for ((finding, observation) in current) {
        val previous = state.reportedAtMillis[finding]
        val due = previous == null || nowMillis - previous >= repeatAfterMillis
        if (due) {
            emitted += observation
            next[finding] = nowMillis
        } else {
            next[finding] = previous
        }
    }

    return IntegrityReport(
        toEmit = emitted.sortedBy { it.finding.ordinal },
        // Les constats absents ne sont volontairement pas reportés dans le
        // nouvel état : leur réapparition doit être signalée sans délai.
        state = IntegrityState(next),
    )
}

/** Répétition par défaut : une fois par jour tant que la situation dure. */
const val INTEGRITY_REPEAT_AFTER_MILLIS: Long = 24L * 60 * 60 * 1000

/** Emplacements ordinaires d'un binaire `su`. Liste indicative, non exhaustive. */
val SU_BINARY_PATHS: List<String> = listOf(
    "/sbin/su",
    "/system/bin/su",
    "/system/xbin/su",
    "/system/sd/xbin/su",
    "/vendor/bin/su",
    "/su/bin/su",
    "/data/local/su",
    "/data/local/bin/su",
    "/data/local/xbin/su",
)

/** Gestionnaires de root répandus. Liste indicative, non exhaustive. */
val ROOT_PACKAGES: List<String> = listOf(
    "com.topjohnwu.magisk",
    "eu.chainfire.supersu",
    "com.koushikdutta.superuser",
    "com.noshufou.android.su",
    "com.thirdparty.superuser",
    "com.yellowes.su",
)
