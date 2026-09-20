package com.phonecontrol.kiosk

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
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
                    DevicePolicyManager.LOCK_TASK_FEATURE_SYSTEM_INFO,
                    // GLOBAL_ACTIONS volontairement absent : masque « Éteindre ».
                    // KEYGUARD absent : notre écran remplace celui d'Android.
                    //
                    // NOTIFICATIONS absent PAR CONTRAINTE, pas par choix :
                    // Android refuse « Cannot use LOCK_TASK_FEATURE_NOTIFICATIONS
                    // without LOCK_TASK_FEATURE_HOME ». Les deux vont ensemble,
                    // et comme on ne veut pas de HOME, on perd les
                    // notifications pendant le verrouillage. Sur un téléphone
                    // verrouillé que personne ne doit toucher, c'est le moindre
                    // mal — mais c'est une contrainte subie, et l'erreur était
                    // silencieuse : `enterKiosk` échouait entièrement.
                    //
                    // HOME absent, et c'est la clé de tout le mécanisme.
                    // Autorisé, le bouton Accueil menait au lanceur PAR DÉFAUT
                    // — celui de Samsung — et toute la protection tombait. On
                    // avait d'abord répondu en imposant cette application comme
                    // écran d'accueil permanent ; ça fermait bien la porte,
                    // mais tout le temps, y compris pendant la session où le
                    // chauffeur doit pouvoir se servir du téléphone.
                    //
                    // Le désactiver rend le bouton inerte PENDANT le
                    // verrouillage, et lui rend son comportement normal dès que
                    // le verrouillage tombe. Aucun réglage à poser puis à
                    // retirer, donc aucune fenêtre entre les deux.
                )
            }
            activity.startLockTask()
            true
        }.getOrElse { error ->
            Log.e(TAG, "Entrée en mode kiosque impossible : ${error.message}")
            false
        }
    }

    /**
     * Retire cette application de la place d'écran d'accueil permanent.
     *
     * ── Pourquoi une méthode pour DÉFAIRE ───────────────────────────────
     * Elle a été imposée un temps, pour fermer la porte du bouton Accueil.
     * Ça marchait — et ça marchait trop : le réglage ne connaît pas l'état de
     * la session, donc le chauffeur badgé revenait chez nous à chaque appui,
     * sans moyen d'ouvrir quoi que ce soit d'autre. Un lanceur sans tiroir
     * d'applications est un cul-de-sac.
     *
     * La porte est maintenant fermée par l'absence de `LOCK_TASK_FEATURE_HOME`,
     * qui ne vaut que pendant le verrouillage. Mais les téléphones déjà en
     * service portent le réglage : il faut aller le retirer, sans quoi ils
     * resteraient bloqués sur un modèle qu'on a abandonné.
     *
     * Appelée à chaque démarrage. Sans effet quand rien n'est posé.
     */
    fun libererLanceur(): Boolean {
        val gestionnaire = dpm ?: return false
        if (!isDeviceOwner) return false

        return runCatching {
            gestionnaire.clearPackagePersistentPreferredActivities(
                adminComponent,
                context.packageName,
            )
            Log.i(TAG, "Écran d'accueil rendu au système : le téléphone redevient normal hors verrouillage.")
            true
        }.getOrElse { erreur ->
            Log.e(TAG, "Libération de l'écran d'accueil impossible : ${erreur.message}")
            false
        }
    }

    /**
     * Fait de cette application l'écran d'accueil permanent.
     *
     * ── La porte de sortie qui restait ouverte ──────────────────────────
     * `LOCK_TASK_FEATURE_HOME` autorise le bouton Accueil pendant le
     * verrouillage — il le faut, sans quoi l'appareil paraît figé. Mais le
     * bouton mène au lanceur PAR DÉFAUT, et sur ce terminal c'était
     * `com.sec.android.app.launcher`. Mesuré : un appui, et le chauffeur se
     * promenait dans le téléphone, verrouillage ou pas.
     *
     * Déclarer `CATEGORY_HOME` au manifeste ne suffit pas : ça rend
     * l'application éligible, pas choisie. Seul le Device Owner peut imposer
     * le choix, et c'est exactement à ça que sert ce privilège.
     *
     * ── Ce que ça change pour le terminal ───────────────────────────────
     * Il n'a plus d'autre écran d'accueil. C'est le but d'un kiosque, et
     * c'est irréversible tant que l'application est Device Owner — d'où le
     * fait que ça n'arrive qu'à des appareils provisionnés pour ça, jamais à
     * un téléphone personnel.
     */
    fun imposerLanceurPersistant(): Boolean {
        val gestionnaire = dpm ?: return false
        if (!isDeviceOwner) {
            Log.w(TAG, "Device Owner absent : le bouton Accueil reste une porte de sortie.")
            return false
        }

        val filtre = IntentFilter(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            addCategory(Intent.CATEGORY_DEFAULT)
        }

        return runCatching {
            gestionnaire.addPersistentPreferredActivity(
                adminComponent,
                filtre,
                ComponentName(context.packageName, ACTIVITE_ACCUEIL),
            )
            Log.i(TAG, "Écran d'accueil imposé : le bouton Accueil revient ici.")
            true
        }.getOrElse { erreur ->
            Log.e(TAG, "Écran d'accueil non imposé : ${erreur.message}")
            false
        }
    }

    /**
     * Ramène l'écran de verrouillage devant, depuis l'arrière-plan.
     *
     * ── Pourquoi c'est nécessaire ───────────────────────────────────────
     * `startLockTask()` n'agit que sur une activité au premier plan. Or
     * l'ordre de verrouillage arrive pendant que le chauffeur est dans une
     * AUTRE application — c'est même le seul moment où il sert. L'état passait
     * bien à « verrouillé », et le téléphone restait utilisable.
     *
     * ── Ce qui peut l'empêcher ──────────────────────────────────────────
     * Depuis Android 10, une application en arrière-plan n'a pas le droit de
     * démarrer une activité. Le propriétaire de l'appareil en est dispensé sur
     * certaines versions, pas sur toutes — et le refus est SILENCIEUX côté
     * appelant : il n'apparaît que dans le journal système, sous
     * « Background activity start blocked ».
     *
     * D'où le journal explicite ici : si le verrouillage ne prend pas, on doit
     * pouvoir distinguer « l'appel n'a pas été fait » de « le système l'a
     * refusé ».
     */
    fun ramenerAuPremierPlan(): Boolean = runCatching {
        val intention = Intent(Intent.ACTION_MAIN).apply {
            component = ComponentName(context.packageName, ACTIVITE_ACCUEIL)
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP,
            )
        }
        context.startActivity(intention)
        Log.i(TAG, "Écran de verrouillage demandé au premier plan.")
        true
    }.getOrElse { erreur ->
        Log.e(TAG, "Impossible de revenir au premier plan : ${erreur.message}")
        false
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

        /**
         * Nommée en dur plutôt que par `MainActivity::class.java` : cette
         * classe vit dans `kiosk`, et l'importer créerait une dépendance
         * circulaire entre le verrouillage et l'interface.
         */
        const val ACTIVITE_ACCUEIL = "com.phonecontrol.MainActivity"
    }
}
