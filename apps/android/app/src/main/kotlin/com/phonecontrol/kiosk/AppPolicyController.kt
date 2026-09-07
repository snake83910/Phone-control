package com.phonecontrol.kiosk

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import com.phonecontrol.core.rules.AppPolicy
import com.phonecontrol.core.rules.AppRefusal
import com.phonecontrol.core.rules.AppRefusalReason
import com.phonecontrol.core.rules.planAppPolicy
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Application de la politique d'applications sur le telephone.
 *
 * Cette classe n'invente aucune regle : elle demande le plan a
 * [planAppPolicy] et se contente de l'executer, puis de dire ce qui s'est
 * reellement passe. La separation est deliberee — la decision se teste sur un
 * poste de developpement, l'execution exige un telephone.
 *
 * **Sans Device Owner, elle ne masque rien et le declare.** C'est la regle §67
 * de la specification : ne jamais laisser croire qu'une protection est en place
 * quand le privilege qui la porte n'a pas ete accorde. Un tableau de bord qui
 * afficherait « 4 applications bloquees » sur un telephone ou elles restent
 * toutes ouvrables serait pire qu'un tableau de bord vide.
 *
 * Le masquage utilise `setApplicationHidden`, qui retire l'application du menu
 * et empeche son lancement sans la desinstaller ni toucher a ses donnees. Un
 * paquet retire de la liste redevient donc visible tel qu'il etait. C'est ce
 * qui rend l'operation reversible depuis le tableau de bord — condition pour
 * qu'un blocage errone ne se repare pas en atelier, telephone par telephone.
 */
@Singleton
class AppPolicyController @Inject constructor(
    @ApplicationContext private val context: Context,
    private val kiosk: KioskController,
) {

    private val dpm: DevicePolicyManager? =
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager

    private val adminComponent: ComponentName =
        ComponentName(context, PhoneControlDeviceAdminReceiver::class.java)

    /**
     * Constat destine au serveur.
     *
     * [hidden] est ce que le telephone masque *effectivement* apres coup, relu
     * du systeme et non deduit du plan : si Android a refuse en silence, la
     * liste ne le contiendra pas.
     */
    data class Report(
        val enforced: Boolean,
        val configVersion: Int,
        val hidden: List<String>,
        val refusals: List<AppRefusal>,
    )

    /**
     * La derniere application a-t-elle abouti ?
     *
     * En memoire volontairement : au redemarrage de l'application, la politique
     * est reappliquee une fois. C'est ce qui fait qu'un telephone devenu Device
     * Owner apres coup — cas normal, le privilege s'obtient au provisioning —
     * applique enfin la politique sans attendre qu'un administrateur la modifie.
     */
    @Volatile
    var lastApplyEnforced: Boolean = false
        private set

    fun apply(policy: AppPolicy, configVersion: Int): Report {
        val dpm = this.dpm
        if (dpm == null || !kiosk.isDeviceOwner) {
            Log.w(
                TAG,
                "Device Owner absent : AUCUNE application n'est masquee. " +
                    "La politique demandee (${policy.blockedApps.size} paquets) reste sans effet.",
            )
            lastApplyEnforced = false
            return Report(
                enforced = false,
                configVersion = configVersion,
                hidden = emptyList(),
                refusals = emptyList(),
            )
        }

        val installed = installedPackages()
        val plan = planAppPolicy(
            policy = policy,
            installedPackages = installed,
            ownPackage = context.packageName,
            currentlyHidden = currentlyHidden(dpm, installed),
        )

        val refusals = plan.refusals.toMutableList()

        for (pkg in plan.toHide) {
            // La valeur de retour compte : `setApplicationHidden` renvoie `false`
            // quand le systeme refuse, sans lever d'exception. L'ignorer
            // produirait exactement le mensonge que §67 interdit.
            val ok = runCatching { dpm.setApplicationHidden(adminComponent, pkg, true) }
                .getOrElse { error ->
                    Log.e(TAG, "Masquage de $pkg impossible : ${error.message}")
                    false
                }
            if (!ok) refusals += AppRefusal(pkg, AppRefusalReason.SYSTEM_REFUSED)
        }

        for (pkg in plan.toReveal) {
            // Un echec de demasquage laisse une application bloquee alors que
            // l'administrateur l'a debloquee. Il se voit dans le constat, au meme
            // titre qu'un echec de blocage.
            val ok = runCatching { dpm.setApplicationHidden(adminComponent, pkg, false) }
                .getOrElse { error ->
                    Log.e(TAG, "Demasquage de $pkg impossible : ${error.message}")
                    false
                }
            if (!ok) refusals += AppRefusal(pkg, AppRefusalReason.SYSTEM_REFUSED)
        }

        runCatching {
            dpm.setLockTaskPackages(adminComponent, plan.lockTaskPackages.toTypedArray())
        }.onFailure { Log.e(TAG, "Allowlist kiosque refusee : ${it.message}") }

        lastApplyEnforced = true
        return Report(
            enforced = true,
            configVersion = configVersion,
            // Relu du systeme, pas deduit : c'est la difference entre « demande »
            // et « obtenu ».
            hidden = currentlyHidden(dpm, installedPackages()).sorted(),
            refusals = refusals,
        )
    }

    /**
     * Paquets installes sur le telephone.
     *
     * La liste depend de `QUERY_ALL_PACKAGES` (voir le manifeste). On lit
     * parfois qu'un Device Owner echappe au filtrage de visibilite introduit
     * par Android 11 ; **la documentation Google ne le dit pas**, et rien ici ne
     * repose sur cette hypothese.
     *
     * L'enjeu se voit dans le constat plutot que dans le code : si la liste
     * revenait tronquee, des paquets bien presents seraient rapportes
     * `NOT_INSTALLED` au lieu d'etre masques. C'est un point a constater sur un
     * telephone reel, pas a supposer (§67) — et c'est precisement ce que la
     * remontee du constat permet de voir.
     */
    private fun installedPackages(): Set<String> =
        runCatching {
            context.packageManager
                .getInstalledApplications(PackageManager.GET_META_DATA)
                .map { it.packageName }
                .toSet()
        }.getOrElse { error ->
            Log.e(TAG, "Inventaire des paquets impossible : ${error.message}")
            emptySet()
        }

    private fun currentlyHidden(dpm: DevicePolicyManager, installed: Set<String>): Set<String> =
        installed.filterTo(mutableSetOf()) { pkg ->
            runCatching { dpm.isApplicationHidden(adminComponent, pkg) }.getOrDefault(false)
        }

    private companion object {
        const val TAG = "AppPolicyController"
    }
}
