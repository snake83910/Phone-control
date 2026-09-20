package com.phonecontrol.sync

import android.content.Context
import android.util.Log
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.phonecontrol.data.repository.EnrollmentManager
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject

/**
 * Enrôlement sans aucune saisie, depuis le QR code de provisioning.
 *
 * ── Ce qui manquait ─────────────────────────────────────────────────────
 * Le QR transportait déjà `enrollmentToken` et `serverUrl` dans
 * `PROVISIONING_ADMIN_EXTRAS_BUNDLE`, et `EnrollmentManager.enroll()` savait
 * déjà tout faire. Le récepteur d'administration recevait les deux valeurs et
 * se contentait de les JOURNALISER. Les deux bouts existaient ; personne ne
 * les reliait, et l'opérateur devait saisir le jeton à la main sur chaque
 * téléphone.
 *
 * ── Pourquoi un travail et pas un appel direct ──────────────────────────
 * `onProfileProvisioningComplete` est une diffusion : une dizaine de secondes,
 * et l'interdiction d'attendre le réseau. Or l'enrôlement est un appel serveur,
 * au pire moment possible — un Wi-Fi d'atelier, sur un téléphone qui vient de
 * terminer son assistant de configuration.
 *
 * WorkManager survit à la mort du processus et réessaie quand la connexion
 * revient. Un `goAsync()` marcherait sur un bureau et raterait un téléphone
 * sur dix en conditions réelles.
 *
 * ── Le jeton est à usage unique ─────────────────────────────────────────
 * Le serveur le consomme. Un travail rejoué après un succès échouera donc
 * proprement, sans créer de doublon — c'est pourquoi on peut réessayer sans
 * précaution particulière.
 */
@HiltWorker
class EnrolementWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val enrollment: EnrollmentManager,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val jeton = inputData.getString(CLE_JETON)
        if (jeton.isNullOrBlank()) {
            Log.e(TAG, "Aucun jeton transmis : enrôlement automatique abandonné.")
            return Result.failure()
        }

        val serveur = inputData.getString(CLE_SERVEUR)

        return when (val resultat = enrollment.enroll(jeton, serveur)) {
            is EnrollmentManager.Result.Success -> {
                Log.i(TAG, "Téléphone enrôlé sans saisie : ${resultat.assetTag}.")
                Result.success()
            }

            is EnrollmentManager.Result.Failure -> {
                // `retry` sans distinguer la cause : au provisioning, l'échec
                // le plus probable est un réseau qui n'est pas encore prêt. Un
                // jeton réellement invalide échouera à chaque tentative, et
                // l'opérateur le verra sur l'écran de saisie, qui reste le
                // recours.
                Log.e(TAG, "Enrôlement automatique échoué : ${resultat.message}")
                Result.retry()
            }
        }
    }

    companion object {
        private const val TAG = "EnrolementAuto"
        private const val CLE_JETON = "enrollmentToken"
        private const val CLE_SERVEUR = "serverUrl"
        private const val NOM_TRAVAIL = "enrolement-automatique"

        /**
         * `KEEP` et non `REPLACE` : si le provisioning est rejoué, on ne veut
         * pas remplacer un enrôlement en cours par un second qui présenterait
         * le même jeton déjà consommé.
         */
        fun lancer(context: Context, jeton: String, serveur: String?) {
            val donnees = Data.Builder()
                .putString(CLE_JETON, jeton)
                .apply { serveur?.takeIf { it.isNotBlank() }?.let { putString(CLE_SERVEUR, it) } }
                .build()

            WorkManager.getInstance(context).enqueueUniqueWork(
                NOM_TRAVAIL,
                ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<EnrolementWorker>().setInputData(donnees).build(),
            )
        }
    }
}
