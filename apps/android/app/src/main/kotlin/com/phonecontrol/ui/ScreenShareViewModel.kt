package com.phonecontrol.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.phonecontrol.screenshare.ScreenShareCoordinator
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Partage d'ecran, cote interface.
 *
 * Ne decide de rien : le coordinateur detient l'etat, les regles pures
 * detiennent les conditions. Cette classe fait le lien avec Compose et gere le
 * seul etat qui lui appartienne — l'attente pendant un appel reseau, pour que
 * les boutons ne soient pas actionnables deux fois.
 */
@HiltViewModel
class ScreenShareViewModel @Inject constructor(
    private val coordinator: ScreenShareCoordinator,
) : ViewModel() {

    val state: StateFlow<ScreenShareCoordinator.Snapshot> = coordinator.state

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    /**
     * Le chauffeur a accepte : reste a passer la boite de dialogue systeme
     * d'Android. [onAccepted] la declenche — elle ne peut l'etre que depuis une
     * activite, ce que ce modele n'est pas.
     */
    fun accept(onAccepted: () -> Unit) {
        viewModelScope.launch {
            _busy.value = true
            val ok = runCatching { coordinator.respond(accepted = true) }.getOrDefault(false)
            _busy.value = false
            if (ok) onAccepted()
        }
    }

    fun refuse() {
        viewModelScope.launch {
            _busy.value = true
            runCatching { coordinator.respond(accepted = false) }
            _busy.value = false
        }
    }

    fun stop() {
        viewModelScope.launch { coordinator.stoppedByDriver("Arrêt par le chauffeur.") }
    }

    /**
     * La boite de dialogue systeme a ete refusee ou annulee.
     *
     * Remonte comme un echec explicite plutot que comme un silence : sinon,
     * l'administrateur attendrait devant un ecran vide en concluant a une
     * lenteur du reseau.
     */
    fun systemConsentDeclined() {
        viewModelScope.launch {
            coordinator.captureFailed(
                "Le partage n’a pas été confirmé dans la fenêtre système d’Android.",
            )
        }
    }

    fun refresh() {
        viewModelScope.launch { runCatching { coordinator.refresh() } }
    }
}
