package com.phonecontrol.core.rules

/**
 * Decision d'installation d'un APK.
 *
 * Ces regles decident si un fichier telecharge doit etre installe. Elles vivent
 * ici, isolees et testees, parce que **la commande d'installation est la
 * fonction la plus dangereuse du systeme** : « installe l'APK qui se trouve la »
 * est une execution de code arbitraire sur la flotte entiere.
 *
 * Les verifications sont ordonnees du moins couteux au plus couteux, et surtout
 * du plus decisif au moins decisif. Une empreinte qui ne correspond pas arrete
 * tout : inutile d'aller lire le certificat d'un fichier dont on sait deja qu'il
 * n'est pas celui qu'on attendait.
 *
 * Ce que ces regles NE protegent pas, et il faut le dire : un serveur compromis
 * ecrit lui-meme les empreintes attendues, donc peut faire installer ce qu'il
 * veut. C'est vrai de toute solution de gestion de parc. Ce qui est protege,
 * c'est le trajet — un fichier substitue entre le serveur et le telephone est
 * refuse — et le fait que rien ne s'installe sans laisser de trace.
 */

/** Ce que le serveur annonce dans la commande. */
data class ExpectedApk(
    val packageId: String,
    /** Empreinte SHA-256 du fichier, en hexadecimal minuscule. */
    val sha256: String,
    /** Empreinte SHA-256 du certificat de signature, en base64url. */
    val signingCertSha256: String,
    /**
     * Nom de paquet attendu. Nul tant qu'aucun telephone n'a installe : le
     * serveur ne sait pas lire le manifeste binaire d'un APK.
     */
    val packageName: String? = null,
)

/** Ce que le telephone constate reellement du fichier telecharge. */
data class ObservedApk(
    val sha256: String,
    val signingCertSha256: String,
    val packageName: String,
    val versionCode: Long,
)

/** Ce qui est deja installe sous ce nom de paquet, s'il y a lieu. */
data class InstalledApp(
    val packageName: String,
    val versionCode: Long,
    /** Empreinte du certificat de l'application deja installee. */
    val signingCertSha256: String,
)

enum class InstallRefusal {
    /** L'empreinte du fichier telecharge ne correspond pas. */
    CHECKSUM_MISMATCH,

    /** Le fichier est intact, mais signe par quelqu'un d'autre. */
    SIGNATURE_MISMATCH,

    /** L'APK ne declare pas le paquet annonce par le serveur. */
    PACKAGE_MISMATCH,

    /**
     * Android refuse de remplacer une application par une version signee
     * differemment. Le refuser ici plutot que d'echouer a l'installation donne
     * un message exploitable au lieu d'un code d'erreur systeme.
     */
    SIGNER_CHANGED,

    /**
     * Version deja installee identique ou plus recente. Ce n'est pas une faute :
     * c'est le cas normal d'une commande rejouee.
     */
    ALREADY_UP_TO_DATE,

    /**
     * Version plus ancienne que celle installee. Android refuserait de toute
     * facon ; le dire clairement evite un « echec d'installation » incomprehensible.
     */
    DOWNGRADE,
}

sealed interface InstallDecision {
    data object Install : InstallDecision
    data class Refuse(val reason: InstallRefusal) : InstallDecision
}

/**
 * Faut-il installer ?
 *
 * @param installed l'application deja presente sous ce nom de paquet, ou `null`.
 */
fun decideInstall(
    expected: ExpectedApk,
    observed: ObservedApk,
    installed: InstalledApp?,
): InstallDecision {
    // 1. Le fichier est-il celui qu'on attendait ? Comparaison insensible a la
    //    casse : rien ne garantit que les deux cotes formatent l'hexadecimal de
    //    la meme facon, et une difference de casse ferait echouer toutes les
    //    installations sans que personne ne comprenne pourquoi.
    if (!observed.sha256.equals(expected.sha256, ignoreCase = true)) {
        return InstallDecision.Refuse(InstallRefusal.CHECKSUM_MISMATCH)
    }

    // 2. Est-il signe par qui il faut ? La casse compte ici : base64url est
    //    sensible a la casse, et deux empreintes qui ne different que par elle
    //    sont deux empreintes differentes.
    if (observed.signingCertSha256 != expected.signingCertSha256) {
        return InstallDecision.Refuse(InstallRefusal.SIGNATURE_MISMATCH)
    }

    // 3. Declare-t-il le paquet annonce ? Verification disponible seulement
    //    quand un telephone a deja installe cette application une fois.
    if (expected.packageName != null && observed.packageName != expected.packageName) {
        return InstallDecision.Refuse(InstallRefusal.PACKAGE_MISMATCH)
    }

    if (installed == null) return InstallDecision.Install

    // 4. Remplacer une application par une version signee differemment est
    //    refuse par Android. Le dire ici produit un message utile.
    if (installed.signingCertSha256 != observed.signingCertSha256) {
        return InstallDecision.Refuse(InstallRefusal.SIGNER_CHANGED)
    }

    return when {
        observed.versionCode > installed.versionCode -> InstallDecision.Install
        observed.versionCode == installed.versionCode ->
            InstallDecision.Refuse(InstallRefusal.ALREADY_UP_TO_DATE)
        else -> InstallDecision.Refuse(InstallRefusal.DOWNGRADE)
    }
}

/**
 * Un refus est-il une anomalie a signaler ?
 *
 * Tous ne le sont pas. Une commande rejouee sur un telephone deja a jour est le
 * fonctionnement normal du systeme ; la remonter comme un echec noierait les
 * vrais problemes sous du bruit. Une empreinte qui ne correspond pas, en
 * revanche, merite qu'on se leve.
 */
fun isAnomaly(reason: InstallRefusal): Boolean = when (reason) {
    InstallRefusal.ALREADY_UP_TO_DATE -> false
    InstallRefusal.CHECKSUM_MISMATCH,
    InstallRefusal.SIGNATURE_MISMATCH,
    InstallRefusal.PACKAGE_MISMATCH,
    InstallRefusal.SIGNER_CHANGED,
    InstallRefusal.DOWNGRADE,
    -> true
}
