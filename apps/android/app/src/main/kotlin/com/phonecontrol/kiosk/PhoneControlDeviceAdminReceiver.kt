package com.phonecontrol.kiosk

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import android.os.PersistableBundle
import android.util.Log

/**
 * Récepteur d'administration de l'appareil.
 *
 * C'est le composant que le QR code de provisioning désigne comme Device Owner
 * (`PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME`). Il doit donc exister et être
 * déclaré au manifeste **avant** toute tentative de provisioning : sans lui, le
 * QR code échoue sans message utile.
 *
 * **Phase 4 : il se contente d'observer et de journaliser.** L'application des
 * politiques — restrictions système, Lock Task, lanceur persistant, octroi
 * silencieux des permissions — relève de la Phase 5, où elle sera écrite avec
 * un téléphone réel pour la vérifier. Prétendre le contraire ici reviendrait à
 * livrer un kiosque qui n'en est pas un.
 */
class PhoneControlDeviceAdminReceiver : DeviceAdminReceiver() {

    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
        Log.i(TAG, "Administration de l'appareil activée.")
    }

    override fun onDisabled(context: Context, intent: Intent) {
        super.onDisabled(context, intent)
        // Perdre ce privilège est un incident majeur : le kiosque cesse d'être
        // garanti. La Phase 5 remontera un événement DEVICE_OWNER_LOST.
        Log.e(TAG, "Administration de l'appareil RETIRÉE : le kiosque n'est plus garanti.")
    }

    /**
     * Fin du provisioning : le jeton d'enrôlement transmis par le QR code est
     * disponible ici. La Phase 5 s'en servira pour enrôler l'appareil sans
     * aucune saisie sur le terminal.
     */
    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        super.onProfileProvisioningComplete(context, intent)

        val extras: PersistableBundle? =
            intent.getParcelableExtra(EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE)
        val enrollmentToken = extras?.getString(EXTRA_ENROLLMENT_TOKEN)
        val serverUrl = extras?.getString(EXTRA_SERVER_URL)

        Log.i(
            TAG,
            "Provisioning terminé (jeton ${if (enrollmentToken != null) "présent" else "absent"}, " +
                "serveur ${serverUrl ?: "non fourni"}).",
        )
    }

    companion object {
        private const val TAG = "DeviceAdmin"

        /** Clés transportées par PROVISIONING_ADMIN_EXTRAS_BUNDLE (docs/04 §2.1). */
        const val EXTRA_ENROLLMENT_TOKEN = "enrollmentToken"
        const val EXTRA_SERVER_URL = "serverUrl"

        private const val EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE =
            "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE"
    }
}
