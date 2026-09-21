package com.phonecontrol.core.rules

/**
 * Le kiosque doit-il tenir sur cet ecran ?
 *
 * ── La porte de sortie trouvee sur le telephone ──────────────────────────
 * Verrouille, impossible de sortir de l'application : correct. Mais un appui
 * sur SCANNER, sans presenter aucun badge, et le telephone redevenait libre.
 *
 * La cause tenait en une ligne : le kiosque suivait l'ecran courant avec
 * `if (ecran == LOCK) entrer() else sortir()`. Passer au scanner n'est PAS
 * l'ecran de verrouillage, donc `stopLockTask()` partait — alors que
 * personne ne s'etait identifie. Il suffisait d'ouvrir le scanner et
 * d'appuyer sur Accueil.
 *
 * ── Pourquoi le scanner compte comme verrouille ──────────────────────────
 * [DeviceStateMachine] ne laisse partir `ScanRequested` que depuis `LOCKED`.
 * SCANNING et AUTHENTICATING ne s'atteignent donc que par la, et le telephone
 * y est toujours verrouille : seul `AccessGranted` ouvre la session, et c'est
 * lui, et lui seul, qui emet `ExitKiosk`.
 *
 * Presenter un badge est la seule facon de sortir. Renoncer au scan ramene a
 * `LOCKED` sans que le verrouillage ait jamais cede.
 *
 * ── Pourquoi une fonction plutot qu'une condition sur place ──────────────
 * Meme motif que [shouldMaskScreen] : une protection qui se leve quand elle
 * ne devrait pas ne se voit pas a l'oeil nu. Elle ne se constate qu'en
 * essayant de sortir, sur un vrai telephone — ce qui est exactement comment
 * celle-ci a ete trouvee, et tard.
 *
 * L'inscription reste dehors : un appareil qui n'est rattache a aucune
 * entreprise n'a ni session a proteger ni personne a identifier, et
 * l'enfermer avant sa mise en service le rendrait inutilisable.
 */
fun shouldEnforceKiosk(screen: AppScreen): Boolean = when (screen) {
    AppScreen.LOCK, AppScreen.SCANNER -> true
    AppScreen.ACTIVE, AppScreen.ENROLLMENT -> false
}
