package com.phonecontrol.core.rules

/**
 * Partage d'ecran : la meme machine a etats que le serveur.
 *
 * Elle est ecrite deux fois — ici en Kotlin, la-bas en TypeScript — et les deux
 * implementations sont soumises aux **memes scenarios**
 * (`packages/state-machine-spec/scenarios/screen-share.json`). Sans ce
 * dispositif, le telephone pourrait capturer dans un etat que le serveur
 * refuse : le chauffeur verrait son ecran partir, le serveur le rejetterait, et
 * personne ne saurait ce qui a reellement ete montre.
 *
 * Module **pur** : aucune dependance Android, aucune horloge implicite. Le
 * temps est toujours un parametre.
 */

enum class ScreenShareState {
    REQUESTED,
    ACCEPTED,
    REFUSED,
    ENDED_BY_DRIVER,
    ENDED_BY_ADMIN,
    EXPIRED,
    FAILED,
    ;

    val isTerminal: Boolean
        get() = this != REQUESTED && this != ACCEPTED
}

enum class ScreenShareEvent {
    DRIVER_ACCEPTS,
    DRIVER_REFUSES,
    DRIVER_STOPS,
    ADMIN_STOPS,
    CAPTURE_FAILED,
    DEADLINE_REACHED,
}

data class ScreenShareTransition(
    val state: ScreenShareState,
    val applied: Boolean,
    val refusal: String? = null,
)

fun transitionScreenShare(
    state: ScreenShareState,
    event: ScreenShareEvent,
): ScreenShareTransition {
    if (state.isTerminal) {
        // Rejouer un arret sur une seance close n'est pas une faute : c'est ce
        // qui arrive quand une reponse HTTP se perd.
        val benin = event == ScreenShareEvent.ADMIN_STOPS ||
            event == ScreenShareEvent.DRIVER_STOPS ||
            event == ScreenShareEvent.DEADLINE_REACHED
        return ScreenShareTransition(
            state = state,
            applied = false,
            refusal = if (benin) null else "La séance est déjà terminée ($state).",
        )
    }

    return when (event) {
        ScreenShareEvent.DEADLINE_REACHED ->
            ScreenShareTransition(ScreenShareState.EXPIRED, true)

        ScreenShareEvent.ADMIN_STOPS ->
            ScreenShareTransition(ScreenShareState.ENDED_BY_ADMIN, true)

        ScreenShareEvent.CAPTURE_FAILED ->
            ScreenShareTransition(ScreenShareState.FAILED, true)

        ScreenShareEvent.DRIVER_ACCEPTS ->
            if (state == ScreenShareState.REQUESTED) {
                ScreenShareTransition(ScreenShareState.ACCEPTED, true)
            } else {
                ScreenShareTransition(
                    state,
                    false,
                    "Un accord ne peut porter que sur une demande en attente.",
                )
            }

        ScreenShareEvent.DRIVER_REFUSES ->
            if (state == ScreenShareState.REQUESTED) {
                ScreenShareTransition(ScreenShareState.REFUSED, true)
            } else {
                ScreenShareTransition(
                    state,
                    false,
                    "Un refus ne peut porter que sur une demande en attente.",
                )
            }

        ScreenShareEvent.DRIVER_STOPS ->
            if (state == ScreenShareState.ACCEPTED) {
                ScreenShareTransition(ScreenShareState.ENDED_BY_DRIVER, true)
            } else {
                ScreenShareTransition(state, false, "Aucun partage en cours à interrompre.")
            }
    }
}

/**
 * Le telephone doit-il capturer ?
 *
 * L'echeance est verifiee ici et pas seulement a la transition : sans cela, un
 * telephone qui perd le reseau juste apres l'accord continuerait a capturer
 * indefiniment, personne ne lui ayant dit d'arreter. La limite doit tenir
 * **sur le telephone**, pas seulement sur le serveur.
 */
fun shouldCapture(
    state: ScreenShareState,
    expiresAtMillis: Long,
    nowMillis: Long,
): Boolean = state == ScreenShareState.ACCEPTED && nowMillis < expiresAtMillis

/**
 * Faut-il poser la question au chauffeur ?
 *
 * Une demande perimee ne doit pas surgir devant quelqu'un qui roule depuis : il
 * repondrait a une question que plus personne ne pose.
 */
fun shouldPromptDriver(
    state: ScreenShareState,
    expiresAtMillis: Long,
    nowMillis: Long,
): Boolean = state == ScreenShareState.REQUESTED && nowMillis < expiresAtMillis

/** Ecrans de l'application, du point de vue de ce qu'ils exposent. */
enum class AppScreen {
    /** Lecture d'un code-barres : l'image contient un numero de badge. */
    SCANNER,
    ENROLLMENT,
    LOCK,
    ACTIVE,
}

/**
 * Faut-il masquer l'ecran aux captures (`FLAG_SECURE`) ?
 *
 * Cette fonction existe a cause d'un conflit reel entre deux exigences.
 *
 * `FLAG_SECURE` est pose en permanence sur la fenetre de l'application, pour
 * que le numero de badge affiche a l'ecran de scan ne se retrouve ni dans une
 * capture, ni dans la vignette du selecteur d'applications. Un badge
 * photographie se rejoue.
 *
 * Mais ce meme drapeau rend l'application **entierement noire** dans un partage
 * d'ecran — c'est son role. Or le cas d'assistance le plus frequent est
 * precisement « le chauffeur ne trouve pas le bouton dans l'application » :
 * l'ecran qu'on veut montrer serait le seul qu'on ne verrait pas.
 *
 * L'arbitrage est donc : le masquage se leve pendant un partage **accepte**, et
 * jamais sur l'ecran de scan. Le badge reste protege ; le reste devient
 * montrable, avec l'accord de la personne concernee.
 *
 * La regle vit ici, sous forme de fonction pure et testee, plutot que dans un
 * enchainement de conditions dans l'activite : un drapeau qu'on oublie de
 * remettre ne se voit pas a l'oeil nu.
 */
fun shouldMaskScreen(screen: AppScreen, sharing: Boolean): Boolean =
    screen == AppScreen.SCANNER || !sharing
