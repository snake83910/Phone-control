package com.phonecontrol.screenshare

import android.util.Log
import com.phonecontrol.core.rules.ScreenShareState
import com.phonecontrol.core.rules.shouldCapture
import com.phonecontrol.core.rules.shouldPromptDriver
import com.phonecontrol.data.remote.PhoneControlApi
import com.phonecontrol.data.remote.ScreenShareConsentRequest
import com.phonecontrol.data.remote.ScreenShareDto
import com.phonecontrol.data.remote.ScreenShareFrameRequest
import com.phonecontrol.data.remote.ScreenShareStopRequest
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Etat du partage d'ecran sur le telephone.
 *
 * Une seule source de verite pour trois consommateurs : l'ecran qui pose la
 * question au chauffeur, le service qui capture, et le drapeau qui masque ou
 * non l'application aux captures. Les faire dependre d'objets distincts
 * reviendrait a esperer qu'ils restent d'accord.
 *
 * **L'echeance est tenue ici, localement.** Le coordinateur ne demande la
 * permission de continuer a personne : il compare l'heure a l'echeance qu'il
 * connait. Un telephone qui perd le reseau juste apres l'accord cesse donc de
 * capturer tout seul, alors qu'aucun ordre d'arret ne peut lui parvenir.
 */
@Singleton
class ScreenShareCoordinator @Inject constructor(
    private val api: PhoneControlApi,
) {

    data class Snapshot(
        val sessionId: String? = null,
        val state: ScreenShareState? = null,
        /** Motif saisi par l'exploitation, affiche tel quel au chauffeur. */
        val reason: String = "",
        /** Qui demande. Une demande anonyme ne se refuse pas de la meme facon. */
        val requestedBy: String = "",
        val expiresAtMillis: Long = 0,
        val framesSent: Int = 0,
        /** Renseigne quand la capture a echoue : affiche au chauffeur. */
        val error: String? = null,
    ) {
        val awaitingDecision: Boolean
            get() = state != null &&
                shouldPromptDriver(state, expiresAtMillis, System.currentTimeMillis())

        val sharing: Boolean
            get() = state != null &&
                shouldCapture(state, expiresAtMillis, System.currentTimeMillis())
    }

    private val _state = MutableStateFlow(Snapshot())
    val state: StateFlow<Snapshot> = _state.asStateFlow()

    /** Serialise les envois : deux images concurrentes n'apportent rien. */
    private val sendMutex = Mutex()

    /**
     * Intervalle entre deux captures.
     *
     * Fixe pour l'instant, et volontairement pas dans la configuration serveur :
     * le contrat n'est pas « une image toutes les N millisecondes » mais « des
     * images regulieres et lisibles ». Le serveur, lui, impose une borne basse
     * qu'un telephone trop bavard depasserait.
     */
    val frameIntervalMs: Long = 800

    /**
     * Rafraichit l'etat depuis le serveur.
     *
     * Appelee au demarrage et a la reception d'une commande. Necessaire parce
     * qu'une demande peut avoir ete emise pendant que le telephone etait hors
     * reseau : la commande expire, mais la seance, elle, peut encore attendre.
     */
    suspend fun refresh() {
        val response = runCatching { api.currentScreenShare() }.getOrNull() ?: return
        if (!response.isSuccessful) return

        val session = response.body()
        if (session == null) {
            // Plus rien en cours : on efface, y compris une eventuelle erreur.
            // Laisser trainer une demande close ferait apparaitre un ecran de
            // consentement pour une question deja tranchee.
            _state.value = Snapshot()
            return
        }

        apply(session)
    }

    /** Reponse du chauffeur. Le seul chemin vers un partage ouvert. */
    suspend fun respond(accepted: Boolean): Boolean {
        val sessionId = _state.value.sessionId ?: return false

        val response = runCatching {
            api.respondToScreenShare(sessionId, ScreenShareConsentRequest(accepted))
        }.getOrNull()

        if (response?.isSuccessful != true) {
            Log.w(TAG, "Réponse au partage refusée par le serveur : ${response?.code()}")
            // On efface plutot que d'insister : la demande a probablement
            // expire, et reposer la question serait pire que ne rien faire.
            refresh()
            return false
        }

        response.body()?.let { apply(it) }
        return accepted && _state.value.state == ScreenShareState.ACCEPTED
    }

    /** Le chauffeur coupe. */
    suspend fun stoppedByDriver(detail: String? = null) {
        val sessionId = _state.value.sessionId ?: return
        runCatching { api.stopScreenShare(sessionId, ScreenShareStopRequest(detail)) }
        _state.value = Snapshot()
    }

    /**
     * La capture n'a pas pu demarrer.
     *
     * Remonte comme un echec explicite : sans cela, l'administrateur verrait un
     * ecran vide et conclurait a une lenteur du reseau. C'est la regle §67
     * appliquee a un cas ou l'absence d'information ressemble a une panne
     * ordinaire.
     */
    suspend fun captureFailed(reason: String) {
        val sessionId = _state.value.sessionId
        if (sessionId != null) {
            runCatching {
                api.reportScreenShareFailure(sessionId, ScreenShareStopRequest(reason))
            }
        }
        _state.value = Snapshot(error = reason)
    }

    /** Le service de capture demande s'il doit continuer. */
    fun shouldCaptureNow(): Boolean = _state.value.sharing

    /**
     * Envoi d'une image.
     *
     * Un refus par 403 signifie que la seance n'a plus le droit d'exister : on
     * arrete immediatement plutot que de reessayer. Reessayer reviendrait a
     * insister pour capturer un ecran qu'on n'a plus le droit de voir.
     */
    suspend fun sendFrame(image: String, width: Int, height: Int) {
        val sessionId = _state.value.sessionId ?: return

        sendMutex.withLock {
            val response = runCatching {
                api.sendScreenShareFrame(
                    sessionId,
                    ScreenShareFrameRequest(
                        image = image,
                        width = width,
                        height = height,
                        capturedAt = Instant.now().toString(),
                    ),
                )
            }.getOrNull()

            when {
                response == null -> Unit // Reseau : on retentera au tour suivant.

                response.code() == 403 -> {
                    Log.i(TAG, "Le serveur refuse les images : fin de la séance.")
                    _state.value = Snapshot()
                }

                response.isSuccessful ->
                    _state.value = _state.value.copy(
                        framesSent = _state.value.framesSent + 1,
                    )

                else -> Log.w(TAG, "Image rejetée : ${response.code()}")
            }
        }
    }

    private fun apply(dto: ScreenShareDto) {
        val state = runCatching { ScreenShareState.valueOf(dto.state) }.getOrNull()
        if (state == null || state.isTerminal) {
            _state.value = Snapshot()
            return
        }

        _state.value = Snapshot(
            sessionId = dto.id,
            state = state,
            reason = dto.reason,
            requestedBy = dto.requestedBy
                ?.let { "${it.firstName} ${it.lastName}" }
                .orEmpty(),
            expiresAtMillis = runCatching { Instant.parse(dto.expiresAt).toEpochMilli() }
                // Une echeance illisible vaut une echeance atteinte : dans le
                // doute, on ne capture pas.
                .getOrDefault(0L),
            framesSent = _state.value.framesSent,
        )
    }

    private companion object {
        const val TAG = "ScreenShareCoordinator"
    }
}
