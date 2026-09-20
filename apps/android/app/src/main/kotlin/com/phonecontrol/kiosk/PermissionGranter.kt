package com.phonecontrol.kiosk

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Octroi silencieux des permissions, par le Device Owner.
 *
 * ── La panne que ça répare ──────────────────────────────────────────────
 * Un chauffeur badge, la session s'ouvre, le suivi de position démarre — et
 * l'application est tuée par le système. Constaté sur un Samsung A16 sous
 * Android 16 :
 *
 *     ForegroundServiceDidNotStartInTimeException:
 *     startForegroundService() did not then call Service.startForeground()
 *
 * Parce que `ACCESS_FINE_LOCATION` valait `granted=false`. Depuis Android 14,
 * un service de premier plan de type `location` ne PEUT PAS entrer au premier
 * plan sans cette permission : l'appel échoue, le délai de cinq secondes
 * expire, et c'est tout le processus qui tombe.
 *
 * ── Pourquoi on ne demande rien à l'utilisateur ─────────────────────────
 * Parce qu'il n'y a personne. Le téléphone est verrouillé, l'écran montre la
 * demande de badge, et le chauffeur ne doit pas — ne peut pas — répondre à
 * une boîte de dialogue système. Un kiosque qui mendie des permissions n'est
 * pas un kiosque.
 *
 * Le Device Owner peut les accorder lui-même, sans invite et sans trace à
 * l'écran. C'est précisément le privilège pour lequel on impose une
 * réinitialisation d'usine et tout le parcours de provisioning.
 *
 * ── Ce que ça n'est pas ─────────────────────────────────────────────────
 * Un contournement. Ces permissions sont annoncées au manifeste, l'appareil
 * appartient à l'entreprise, et la politique de confidentialité les couvre.
 * Ce qui serait malhonnête, ce serait de les accorder sur un téléphone
 * personnel — ce que le Device Owner rend impossible : il exige un appareil
 * réinitialisé et sans compte.
 */
@Singleton
class PermissionGranter @Inject constructor(
    @ApplicationContext private val context: Context,
) {

    private val dpm: DevicePolicyManager? =
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager

    private val adminComponent: ComponentName =
        ComponentName(context, PhoneControlDeviceAdminReceiver::class.java)

    /**
     * Accorde ce dont l'application a besoin pour tenir ses promesses.
     *
     * Renvoie la liste de ce qui a été REFUSÉ par le système, jamais une
     * supposition : `setPermissionGrantState` rend `false` sans lever
     * d'exception quand il refuse, et l'ignorer produirait exactement le
     * mensonge que la spécification §67 interdit — une application qui se
     * croit autorisée et ne l'est pas.
     */
    fun accorderLeNecessaire(): List<String> {
        val gestionnaire = dpm ?: return REQUISES.toList()

        if (!gestionnaire.isDeviceOwnerApp(context.packageName)) {
            // Sans Device Owner, ces permissions se demandent à l'utilisateur.
            // C'est le cas d'un poste de développement, pas d'un terminal en
            // service.
            Log.w(TAG, "Device Owner absent : aucune permission ne peut être accordée en silence.")
            return REQUISES.filterNot { estAccordee(it) }
        }

        val refusees = mutableListOf<String>()

        for (permission in REQUISES) {
            if (estAccordee(permission)) continue

            val ok = runCatching {
                gestionnaire.setPermissionGrantState(
                    adminComponent,
                    context.packageName,
                    permission,
                    DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED,
                )
            }.getOrElse { erreur ->
                Log.e(TAG, "Octroi de $permission impossible : ${erreur.message}")
                false
            }

            // Relu du système plutôt que déduit du retour : c'est la
            // différence entre « demandé » et « obtenu ».
            if (!ok || !estAccordee(permission)) {
                refusees += permission
                Log.e(TAG, "Permission REFUSÉE par le système : $permission")
            } else {
                Log.i(TAG, "Permission accordée sans invite : $permission")
            }
        }

        return refusees
    }

    fun estAccordee(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) ==
            PackageManager.PERMISSION_GRANTED

    companion object {
        private const val TAG = "PermissionGranter"

        /**
         * Ce qu'il faut, et pourquoi chacune.
         *
         * `ACCESS_BACKGROUND_LOCATION` n'y figure pas : Android refuse de
         * l'accorder tant que la localisation de premier plan ne l'est pas, et
         * le suivi tourne dans un service de PREMIER PLAN — elle n'est donc
         * pas nécessaire. La demander produirait un refus systématique qu'on
         * finirait par ignorer, et on ignorerait les autres avec.
         */
        val REQUISES: List<String> = buildList {
            // Sans elle, le service de suivi ne peut pas entrer au premier
            // plan sur Android 14+, et le système tue l'application.
            add(Manifest.permission.ACCESS_FINE_LOCATION)
            add(Manifest.permission.ACCESS_COARSE_LOCATION)
            // Lecture du badge.
            add(Manifest.permission.CAMERA)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                // La notification du service de premier plan s'affiche même
                // sans elle, mais tout le reste — verrouillage imminent, fin
                // de tournée — serait muet.
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }
}
