package com.phonecontrol.kiosk

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Verrouillage kiosque.
 *
 * **Phase 4 : cette classe CONSTATE, elle n'impose pas encore.**
 *
 * Le mode kiosque réel — Lock Task, restrictions système, application déclarée
 * comme lanceur persistant — relève du Device Owner, donc de la Phase 5. Tant
 * que ce privilège n'est pas attribué, [isDeviceOwner] renvoie `false` et
 * l'application le dit : à l'écran, au serveur, et dans ses journaux.
 *
 * C'est un point de la règle absolue de la spécification (§67) : ne jamais
 * prétendre qu'une fonctionnalité Android fonctionne si elle exige un privilège
 * qui n'a pas été réellement accordé. Un écran plein qui *ressemble* à un
 * kiosque, sans Lock Task, se referme d'un appui sur « Accueil ».
 */
@Singleton
class KioskController @Inject constructor(
    @ApplicationContext private val context: Context,
) {

    private val dpm: DevicePolicyManager? =
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager

    private val adminComponent: ComponentName =
        ComponentName(context, PhoneControlDeviceAdminReceiver::class.java)

    /**
     * L'application est-elle réellement administrateur de l'appareil ?
     * Déclaratif nulle part : c'est le système qui répond.
     */
    val isDeviceOwner: Boolean
        get() = dpm?.isDeviceOwnerApp(context.packageName) == true

    /**
     * Entre en mode kiosque si — et seulement si — le privilège existe.
     * Renvoie `false` sinon, pour que l'appelant puisse le signaler plutôt que
     * de supposer un verrouillage inexistant.
     */
    fun enterKiosk(activity: Activity): Boolean {
        if (!isDeviceOwner) {
            Log.w(
                TAG,
                "Device Owner absent : le mode kiosque n'est PAS actif. " +
                    "L'écran de verrouillage reste contournable par le bouton Accueil.",
            )
            return false
        }

        return runCatching {
            dpm?.setLockTaskPackages(adminComponent, arrayOf(context.packageName))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                dpm?.setLockTaskFeatures(
                    adminComponent,
                    DevicePolicyManager.LOCK_TASK_FEATURE_SYSTEM_INFO or
                        DevicePolicyManager.LOCK_TASK_FEATURE_NOTIFICATIONS or
                        DevicePolicyManager.LOCK_TASK_FEATURE_HOME,
                    // GLOBAL_ACTIONS volontairement absent : masque « Éteindre ».
                    // KEYGUARD absent : notre écran remplace celui d'Android.
                )
            }
            activity.startLockTask()
            true
        }.getOrElse { error ->
            Log.e(TAG, "Entrée en mode kiosque impossible : ${error.message}")
            false
        }
    }

    fun exitKiosk(activity: Activity) {
        if (!isDeviceOwner) return
        runCatching { activity.stopLockTask() }
            .onFailure { Log.w(TAG, "Sortie du mode kiosque : ${it.message}") }
    }

    /**
     * Diagnostic remonté au serveur et affiché sur la fiche du téléphone.
     * Le dashboard affiche « Device Owner : non confirmé » tant que ce n'est
     * pas vrai — plutôt qu'une protection qui n'existe pas.
     */
    fun status(): KioskStatus = KioskStatus(
        deviceOwnerActive = isDeviceOwner,
        lockTaskSupported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P,
    )

    data class KioskStatus(
        val deviceOwnerActive: Boolean,
        val lockTaskSupported: Boolean,
    )

    private companion object {
        const val TAG = "KioskController"
    }
}
