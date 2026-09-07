package com.phonecontrol.core.rules

/**
 * Politique d'applications : ce que le téléphone laisse ouvrir, ce qu'il masque.
 *
 * Deux listes, deux effets distincts, qu'il ne faut pas confondre :
 *
 * - **Autorisées** — les paquets qui peuvent s'ouvrir *à côté* de l'application
 *   pendant une session (navigation, appareil photo métier…). Elles alimentent
 *   l'allowlist du mode kiosque : hors de cette liste, rien ne s'ouvre.
 *
 * - **Bloquées** — les paquets activement masqués, qui disparaissent du menu et
 *   ne se lancent plus, session ouverte ou non. C'est ce qu'on veut pour un jeu
 *   ou une messagerie personnelle installés avant la mise en flotte.
 *
 * Masquer est une opération dangereuse : certains paquets tiennent le téléphone
 * debout. Masquer `com.android.systemui`, c'est un écran noir ; masquer
 * `com.google.android.gms`, c'est perdre la notification qui sert justement à
 * envoyer les commandes à distance — donc perdre le moyen de réparer la faute.
 * Ce module refuse ces paquets-là et **le dit**, plutôt que de laisser
 * l'administrateur découvrir le résultat sur un téléphone mort.
 *
 * Module **pur** : aucune dépendance Android. La décision se relit et se teste
 * sans téléphone ; son application par `DevicePolicyManager` vit dans le module
 * applicatif, qui ne décide de rien.
 */

/**
 * Paquets qu'on ne masque jamais, quoi qu'en dise la configuration.
 *
 * Ce n'est pas une valeur métier codée en dur au sens de la spécification §61 :
 * ce sont des identités de la plateforme Android, invariantes, et non des seuils
 * propres au client. La configuration peut **ajouter** à cette liste ; elle ne
 * peut pas en retirer, parce qu'aucune configuration ne devrait pouvoir rendre
 * un téléphone inutilisable à distance.
 */
val PROTECTED_PACKAGES: Set<String> = setOf(
    // Le cadre Android lui-même et son interface.
    "android",
    "com.android.systemui",

    // Téléphonie. Masquer ces paquets coupe les appels — y compris ceux du
    // chauffeur vers le dépôt, et la voix sur le réseau mobile en général.
    "com.android.phone",
    "com.android.server.telecom",
    "com.android.dialer",
    "com.samsung.android.dialer",
    "com.samsung.android.incallui",
    "com.android.emergency",

    // Alertes gouvernementales (FR-Alert en France). Les masquer priverait le
    // chauffeur d'un avertissement de sécurité publique.
    "com.android.cellbroadcastreceiver",
    "com.google.android.cellbroadcastreceiver",

    // Services Google Play : ils portent la notification push, c'est-à-dire le
    // canal par lequel une commande de déblocage arriverait. Les masquer, c'est
    // se couper la main qui répare.
    "com.google.android.gms",
    "com.android.vending",

    // Installation de paquets : sans elle, plus de mise à jour de l'application.
    "com.android.packageinstaller",
    "com.google.android.packageinstaller",

    // Lanceur du constructeur. Tant que l'application n'est pas elle-même le
    // lanceur persistant, le masquer laisse le téléphone sans écran d'accueil.
    "com.sec.android.app.launcher",
    "com.android.launcher3",
)

/** Les deux listes telles qu'elles arrivent du serveur. */
data class AppPolicy(
    /** Paquets autorisés à s'ouvrir à côté de l'application, en session. */
    val allowedApps: List<String> = emptyList(),
    /** Paquets à masquer. */
    val blockedApps: List<String> = emptyList(),
)

enum class AppRefusalReason {
    /** L'application de gestion elle-même : la masquer supprimerait le contrôle. */
    SELF,

    /** Paquet système : le masquer rendrait le téléphone inutilisable. */
    PROTECTED,

    /** Absent du téléphone : rien à masquer, et ce n'est pas une erreur. */
    NOT_INSTALLED,

    /** Présent dans les deux listes : configuration contradictoire. */
    CONFLICT,

    /**
     * Android a refusé le masquage.
     *
     * Seul motif que ce module ne produit **pas** : il naît à l'application, pas
     * à la décision. Il vit néanmoins dans la même énumération, pour que le
     * téléphone, le serveur et le tableau de bord parlent d'un seul vocabulaire.
     */
    SYSTEM_REFUSED,
}

data class AppRefusal(
    val packageName: String,
    val reason: AppRefusalReason,
)

/**
 * Ce que le téléphone doit faire, et ce qu'il refuse de faire.
 *
 * [toHide] et [toReveal] sont des *différences* par rapport à l'état constaté :
 * appliquer deux fois le même plan ne produit rien la seconde fois, et retirer
 * un paquet de la liste des bloqués le fait réellement réapparaître. Sans ce
 * second point, bloquer serait irréversible à distance.
 */
data class AppPolicyPlan(
    val toHide: List<String>,
    val toReveal: List<String>,
    /** Allowlist du mode kiosque. Contient toujours l'application elle-même. */
    val lockTaskPackages: List<String>,
    val refusals: List<AppRefusal>,
) {
    /** Vrai quand l'état constaté correspond déjà à la politique. */
    val isNoop: Boolean get() = toHide.isEmpty() && toReveal.isEmpty()
}

/**
 * Traduit une politique en actions, sans en exécuter aucune.
 *
 * @param installedPackages ce que le téléphone porte réellement. Un paquet
 *   demandé mais absent est signalé, pas ignoré : c'est le plus souvent une
 *   faute de frappe dans le nom du paquet, et elle resterait invisible.
 * @param currentlyHidden les paquets actuellement masqués, tels que le système
 *   les rapporte — et non tels que le serveur les imagine.
 */
fun planAppPolicy(
    policy: AppPolicy,
    installedPackages: Set<String>,
    ownPackage: String,
    currentlyHidden: Set<String> = emptySet(),
    protectedPackages: Set<String> = PROTECTED_PACKAGES,
): AppPolicyPlan {
    val allowed = policy.allowedApps.map(::normalizePackage).filter { it.isNotEmpty() }.toSet()
    val requested = policy.blockedApps.map(::normalizePackage).filter { it.isNotEmpty() }

    val refusals = mutableListOf<AppRefusal>()
    val toHide = mutableListOf<String>()

    for (pkg in requested.distinct()) {
        when {
            pkg == ownPackage -> refusals += AppRefusal(pkg, AppRefusalReason.SELF)

            pkg in protectedPackages -> refusals += AppRefusal(pkg, AppRefusalReason.PROTECTED)

            pkg !in installedPackages -> refusals += AppRefusal(pkg, AppRefusalReason.NOT_INSTALLED)

            else -> {
                // Un paquet présent dans les deux listes est une contradiction de
                // configuration. On tranche dans le sens restrictif — un système de
                // verrouillage qui hésite doit fermer, pas ouvrir — et on le
                // signale, pour que l'administrateur corrige au lieu de subir.
                if (pkg in allowed) refusals += AppRefusal(pkg, AppRefusalReason.CONFLICT)
                toHide += pkg
            }
        }
    }

    val desired = toHide.toSet()

    return AppPolicyPlan(
        toHide = toHide.filterNot { it in currentlyHidden },
        // Tout ce qui est masqué sans être demandé redevient visible : c'est ce
        // qui rend un blocage réversible depuis le tableau de bord.
        toReveal = currentlyHidden.filterNot { it in desired }.sorted(),
        lockTaskPackages = (listOf(ownPackage) + allowed.filterNot { it in desired }.sorted())
            .distinct(),
        refusals = refusals,
    )
}

/**
 * Nettoie un nom de paquet saisi ou colle.
 *
 * Un copier-coller depuis une fiche du Play Store rapporte souvent une espace
 * insecable ou une espace de largeur nulle, invisibles a la relecture. Sans ce
 * nettoyage, le blocage serait accepte puis silencieusement inoperant.
 *
 * La casse est **preservee** : un nom de paquet Android peut legalement porter
 * des majuscules, et les uniformiser ferait echouer le blocage de ces
 * applications-la, precisement le defaut que ce nettoyage cherche a eviter.
 */
private fun normalizePackage(raw: String): String =
    raw.trim().trim('\u00a0', '\u200b', '\ufeff')
