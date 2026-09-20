package com.phonecontrol.kiosk

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.os.Bundle
import android.util.Log

/**
 * Le dialogue que la plateforme engage avec le DPC pendant le provisioning.
 *
 * ── Ce que son absence provoquait ───────────────────────────────────────
 * Depuis Android 10, l'assistant de configuration ne décide plus seul du mode
 * de provisioning : il installe le DPC, puis **lui demande** lequel appliquer,
 * en lançant une activité pour `GET_PROVISIONING_MODE`. Sans activité capable
 * de répondre, il abandonne — juste après le téléchargement de l'APK, sur un
 * « Un problème est survenu » qui ne nomme rien.
 *
 * Constaté sur un Samsung A16 sous Android 16 : l'APK était bien téléchargé
 * (200 dans le journal d'accès), et tout s'arrêtait là. Le manifeste
 * déclarait le récepteur d'administration, correctement, mais aucune de ces
 * deux activités — et rien dans le projet ne les mentionnait.
 *
 * ── Pourquoi elle n'affiche rien ────────────────────────────────────────
 * Ces deux échanges sont des questions du système, pas des écrans pour
 * l'opérateur. Elle répond et se termine. Un thème sans affichage évite le
 * clignotement d'une fenêtre vide au milieu de l'assistant.
 */
class ProvisioningActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        when (intent?.action) {
            ACTION_GET_PROVISIONING_MODE -> repondreModeDeProvisioning()

            // Lancée après le provisioning pour que le DPC vérifie que
            // l'appareil est conforme à sa politique. L'application des
            // politiques relève de la phase 5 ; y répondre `RESULT_OK` sans
            // rien faire est correct aujourd'hui, et c'est ici qu'elle se
            // branchera.
            ACTION_ADMIN_POLICY_COMPLIANCE -> {
                Log.i(TAG, "Conformité demandée par le système : rien à appliquer à ce stade.")
                setResult(RESULT_OK)
            }

            else -> {
                // Ni l'une ni l'autre : quelqu'un a lancé cette activité à la
                // main. Elle est exportée — elle doit l'être, le système
                // l'appelle depuis un autre processus — donc elle refuse
                // plutôt que de répondre à une question qu'on ne lui a pas
                // posée.
                Log.w(TAG, "Action inattendue : ${intent?.action}")
                setResult(RESULT_CANCELED)
            }
        }

        finish()
    }

    /**
     * Répond « appareil entièrement géré », et rien d'autre.
     *
     * Ce produit verrouille des téléphones qui appartiennent à l'entreprise.
     * Un profil professionnel sur un appareil personnel ne permettrait ni le
     * mode kiosque, ni le lanceur persistant, ni les restrictions système :
     * ce serait un autre produit.
     *
     * Le système peut restreindre les modes acceptables. Quand il le fait et
     * que le nôtre n'y figure pas, on abandonne explicitement — poursuivre
     * donnerait une installation à moitié gérée, bien pire qu'un refus net.
     */
    private fun repondreModeDeProvisioning() {
        val modesAutorises = intent.getIntegerArrayListExtra(EXTRA_ALLOWED_MODES)

        if (modesAutorises != null &&
            modesAutorises.isNotEmpty() &&
            !modesAutorises.contains(DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE)
        ) {
            Log.e(
                TAG,
                "Le système n'autorise pas l'appareil entièrement géré " +
                    "(modes proposés : $modesAutorises). Provisioning abandonné.",
            )
            setResult(RESULT_CANCELED)
            return
        }

        Log.i(TAG, "Mode demandé par le système : appareil entièrement géré.")
        setResult(
            RESULT_OK,
            Intent().putExtra(
                EXTRA_PROVISIONING_MODE,
                DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE,
            ),
        )
    }

    companion object {
        private const val TAG = "Provisioning"

        /**
         * Déclarées en dur plutôt que reprises de `DevicePolicyManager`.
         *
         * `minSdk` vaut 28 et ces constantes sont apparues en 29. Ce sont des
         * chaînes, donc le compilateur les incorporerait sans rien dire —
         * mais les écrire ici rend visible qu'elles n'existent pas sur tous
         * les terminaux visés, et qu'un Android 9 ne passera jamais par ces
         * actions.
         */
        private const val ACTION_GET_PROVISIONING_MODE =
            "android.app.action.GET_PROVISIONING_MODE"
        private const val ACTION_ADMIN_POLICY_COMPLIANCE =
            "android.app.action.ADMIN_POLICY_COMPLIANCE"
        private const val EXTRA_PROVISIONING_MODE =
            "android.app.extra.PROVISIONING_MODE"
        private const val EXTRA_ALLOWED_MODES =
            "android.app.extra.PROVISIONING_ALLOWED_PROVISIONING_MODES"
    }
}
