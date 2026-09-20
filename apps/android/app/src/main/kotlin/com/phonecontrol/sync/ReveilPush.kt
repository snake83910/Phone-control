package com.phonecontrol.sync

import android.content.Context
import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.tasks.await

/**
 * Réveil du téléphone par notification.
 *
 * ── Le problème que ça résout ───────────────────────────────────────────
 * `SyncWorker` tourne toutes les quinze minutes, et c'est le plancher imposé
 * par WorkManager — on ne peut pas descendre en dessous. Un verrouillage
 * demandé depuis le tableau de bord mettait donc jusqu'à un quart d'heure à
 * prendre effet, ce qui est inutilisable le jour où il faut couper vite.
 *
 * La notification ne transporte AUCUNE instruction : elle dit seulement
 * « va voir ». Le téléphone redemande alors ses commandes au serveur, par le
 * canal authentifié habituel. Une notification forgée ne peut donc rien faire
 * d'autre que provoquer une synchronisation — qui ne trouvera rien.
 *
 * ── Ce que Google voit ──────────────────────────────────────────────────
 * L'existence et l'horodatage d'un réveil, jamais son motif. C'est le
 * compromis normal d'Android, et il doit figurer dans la politique de
 * confidentialité au même titre que les autres tiers.
 */
class ReveilPushService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        Log.i(TAG, "Réveil reçu : synchronisation immédiate.")
        SyncWorker.syncNow(applicationContext)
    }

    /**
     * Android renouvelle ce jeton tout seul — réinstallation, purge des
     * services Play, restauration. Un jeton périmé côté serveur est un
     * téléphone qu'on croit joignable et qui ne l'est pas : la panne la plus
     * discrète de ce mécanisme.
     *
     * On ne l'envoie pas d'ici : on déclenche une synchronisation, et c'est
     * le heartbeat qui le porte. Un seul chemin pour ce jeton, donc un seul
     * endroit où il peut se perdre.
     */
    override fun onNewToken(token: String) {
        Log.i(TAG, "Jeton de réveil renouvelé.")
        SyncWorker.syncNow(applicationContext)
    }

    private companion object {
        const val TAG = "ReveilPush"
    }
}

/**
 * Le jeton à joindre au heartbeat, ou `null`.
 *
 * ── Pourquoi ça peut échouer sans que ce soit grave ─────────────────────
 * Firebase exige `google-services.json`, présent à la construction, et des
 * services Play fonctionnels sur le terminal. Ni l'un ni l'autre n'est
 * garanti : une installation qui ne veut pas de Google construit sans le
 * fichier, et certains terminaux reconditionnés n'ont pas les services Play.
 *
 * Dans ces cas-là, le réveil n'existe pas et le sondage de quinze minutes
 * reprend son rôle. C'est dégradé, pas cassé — et c'est pourquoi l'échec est
 * journalisé puis avalé, au lieu de faire tomber le heartbeat qui, lui,
 * fonctionne.
 */
suspend fun jetonDeReveil(context: Context): String? = runCatching {
    FirebaseMessaging.getInstance().token.await()
}.getOrElse { erreur ->
    Log.w("ReveilPush", "Jeton de réveil indisponible : ${erreur.message}")
    null
}
