package com.phonecontrol.security

import java.security.SecureRandom
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Ce dont l'ouverture de la base a besoin, et rien de plus.
 *
 * L'interface existe pour que la fabrique de base soit testable sans magasin
 * sécurisé : un test peut alors reproduire le cas « keystore indisponible »,
 * qui est précisément celui qu'on ne veut pas découvrir sur le terrain.
 */
interface DatabasePassphrase {
    /** Vrai si une phrase existe déjà : la base a donc déjà été chiffrée. */
    val exists: Boolean

    fun getOrCreate(): String?
}

/**
 * Phrase secrète de la base locale.
 *
 * 256 bits tirés au hasard au premier démarrage, conservés dans le magasin
 * sécurisé — des préférences chiffrées dont la clé maîtresse vit dans l'Android
 * Keystore, en StrongBox quand le terminal en dispose.
 *
 * **Pourquoi une chaîne hexadécimale plutôt que des octets bruts.** La phrase
 * doit apparaître telle quelle dans un `ATTACH DATABASE … KEY '…'` au moment de
 * migrer une base en clair. Des octets quelconques y poseraient un problème
 * d'échappement — apostrophes, octets nuls — dont la moindre erreur produirait
 * une base illisible. Sur soixante-quatre caractères hexadécimaux, la question
 * ne se pose pas, et l'entropie est la même.
 *
 * **Pourquoi pas une seconde clé du Keystore pour envelopper celle-ci.**
 * SQLCipher a besoin de la phrase en clair pour ouvrir la base : elle existe
 * donc en mémoire, quelle que soit sa protection au repos. Une enveloppe
 * n'aurait rien changé à cela et aurait ajouté un mode de panne — une clé
 * invalidée par une mise à jour du système rend la base définitivement
 * illisible. Le magasin chiffré offre la même protection au repos avec un seul
 * point de défaillance au lieu de deux.
 *
 * **Portée de la protection.** Elle couvre la lecture du fichier de base par
 * extraction physique ou par une sauvegarde : positions, badges en cache, file
 * d'événements. Elle ne couvre pas un attaquant qui exécute déjà du code en
 * tant que l'application — celui-là lit la mémoire du processus. C'est la
 * limite de tout chiffrement au repos, et il vaut mieux l'écrire que la laisser
 * supposer.
 */
@Singleton
class DatabaseKey @Inject constructor(
    private val secureStore: SecureStore,
) : DatabasePassphrase {

    /**
     * Phrase secrète, créée au besoin.
     *
     * `null` quand le magasin sécurisé est indisponible, ou quand la phrase
     * enregistrée est illisible. Dans les deux cas l'appelant doit refuser
     * d'ouvrir une base en clair : dégrader la protection sans le dire serait
     * pire que s'arrêter.
     */
    override fun getOrCreate(): String? {
        if (!secureStore.isAvailable) return null

        secureStore.databasePassphrase?.let { stored ->
            // Une phrase de mauvaise forme n'est jamais remplacée en silence :
            // la base existante deviendrait indéchiffrable, et la file
            // d'événements non synchronisés serait perdue sans un mot.
            return if (isWellFormed(stored)) stored else null
        }

        val generated = ByteArray(KEY_SIZE_BYTES)
            .also { SecureRandom().nextBytes(it) }
            .joinToString("") { byte -> "%02x".format(byte) }

        secureStore.databasePassphrase = generated
        return generated
    }

    override val exists: Boolean get() = secureStore.databasePassphrase != null

    companion object {
        const val KEY_SIZE_BYTES = 32
        private val HEX = Regex("^[0-9a-f]{${KEY_SIZE_BYTES * 2}}$")

        fun isWellFormed(passphrase: String): Boolean = HEX.matches(passphrase)
    }
}
