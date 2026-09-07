package com.phonecontrol.security

import android.util.Log
import com.phonecontrol.BuildConfig
import com.phonecontrol.core.rules.PinningPolicy
import com.phonecontrol.core.rules.PinningStatus
import com.phonecontrol.core.rules.PinningVerdict
import com.phonecontrol.core.rules.evaluatePinningPolicy
import java.time.Instant
import okhttp3.CertificatePinner

/**
 * Traduction de la politique d'épinglage en configuration OkHttp.
 *
 * La décision — appliquer, lever, refuser — appartient à
 * `core-rules/PinningRules.kt`, qui se teste sans Android. Ici il ne reste que
 * la mécanique : lire la configuration de compilation, et construire un
 * `CertificatePinner`.
 *
 * **Aucun chemin ne mène à un échec de connexion.** Une politique absente,
 * incomplète ou périmée laisse le client sans épinglage : la connexion reste
 * protégée par TLS et la validation ordinaire des autorités. C'est le
 * raisonnement expliqué dans `PinningRules` — un épinglage mal configuré ne
 * doit pas arrêter des camions.
 */
object CertificatePinning {

    /**
     * Politique issue de la configuration de compilation.
     *
     * Les empreintes sont fixées à la construction de l'APK. Une rotation exige
     * donc une nouvelle version — c'est précisément ce que la seconde empreinte
     * et la date d'expiration rendent supportable : on publie la version qui
     * contient la future empreinte **avant** de changer le certificat, et
     * l'échéance sert de filet si cette publication tarde.
     *
     * La forme aboutie ferait descendre la politique depuis le serveur. Elle
     * suppose de décider ce qui fait autorité quand les deux se contredisent, et
     * n'a pas sa place dans une première version.
     */
    fun configuredPolicy(): PinningPolicy? {
        val host = BuildConfig.PINNED_HOST.trim()
        val pins = BuildConfig.PINNED_PUBLIC_KEYS
            .split(',')
            .map { it.trim() }
            .filter { it.isNotEmpty() }

        if (host.isEmpty() && pins.isEmpty()) return null

        val expiresAt = BuildConfig.PINNING_EXPIRES_AT.trim().takeIf { it.isNotEmpty() }
            ?.let { runCatching { Instant.parse(it) }.getOrNull() }

        return PinningPolicy(host = host, pins = pins, expiresAt = expiresAt)
    }

    /**
     * Construit l'épingleur correspondant au verdict, ou `null` s'il n'y a rien
     * à appliquer.
     */
    fun pinnerFor(verdict: PinningVerdict, host: String): CertificatePinner? {
        if (verdict.status != PinningStatus.ACTIVE) return null

        val builder = CertificatePinner.Builder()
        for (pin in verdict.activePins) {
            builder.add(host, "sha256/$pin")
        }
        return builder.build()
    }

    /**
     * Évalue la politique configurée et journalise le résultat.
     *
     * Le journal est le seul canal de remontée pour l'instant : signaler un
     * épinglage périmé au serveur demanderait un type d'événement de sécurité
     * supplémentaire. C'est noté comme reste à faire plutôt que bricolé sur un
     * type existant, qui rendrait le tableau de bord trompeur.
     */
    fun evaluate(now: Instant = Instant.now()): PinningVerdict {
        val verdict = evaluatePinningPolicy(configuredPolicy(), now)

        when (verdict.status) {
            PinningStatus.ACTIVE ->
                if (verdict.renewalDue) {
                    Log.w(TAG, "Épinglage : ${verdict.reason} — préparer la rotation.")
                } else {
                    Log.i(TAG, "Épinglage : ${verdict.reason}")
                }

            PinningStatus.EXPIRED ->
                Log.e(TAG, "Épinglage levé : ${verdict.reason}")

            PinningStatus.REJECTED ->
                Log.e(TAG, "Épinglage NON appliqué : ${verdict.reason}")

            PinningStatus.ABSENT ->
                Log.i(TAG, "Aucun épinglage configuré.")
        }

        return verdict
    }

    private const val TAG = "CertificatePinning"
}
