package com.phonecontrol.data.local

import android.content.Context
import android.util.Log
import androidx.room.Room
import com.phonecontrol.security.DatabasePassphrase
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton
import net.zetetic.database.sqlcipher.SQLiteDatabase
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory

/**
 * Ouverture de la base locale, chiffrée par SQLCipher.
 *
 * Trois situations, et une seule est ordinaire :
 *
 * 1. **Base chiffrée existante ou première installation** — cas normal. La
 *    phrase secrète vient du magasin sécurisé, SQLCipher ouvre ou crée la base.
 *
 * 2. **Base en clair héritée d'une version précédente** — elle est convertie sur
 *    place, par `sqlcipher_export`, avant que Room ne l'ouvre. Ce chemin existe
 *    parce que la file d'événements non synchronisés ne doit pas disparaître à
 *    l'occasion d'une mise à jour : ce sont des preuves, pas un cache
 *    (docs/11 §4.2).
 *
 * 3. **Magasin sécurisé indisponible** — keystore corrompu, restauration
 *    d'image. La base est alors ouverte **en mémoire** : l'application démarre,
 *    affiche « téléphone non enrôlé », et rien de sensible n'est écrit sur le
 *    disque en clair. Le terminal est de toute façon inutilisable sans ses
 *    identifiants ; autant ne pas aggraver la situation en abandonnant le
 *    chiffrement.
 */
@Singleton
class LocalDatabaseFactory @Inject constructor(
    private val context: Context,
    private val databaseKey: DatabasePassphrase,
) {

    /** Comment la base a réellement été ouverte. Affiché en cas de dégradation. */
    enum class Mode { ENCRYPTED, MIGRATED, IN_MEMORY }

    @Volatile
    var mode: Mode = Mode.ENCRYPTED
        private set

    fun create(): PhoneControlDatabase {
        val file = context.getDatabasePath(PhoneControlDatabase.NAME)
        val hadPlaintextDatabase = file.exists() && !databaseKey.exists

        val passphrase = databaseKey.getOrCreate()
        if (passphrase == null) {
            mode = Mode.IN_MEMORY
            Log.e(
                TAG,
                "Magasin sécurisé indisponible : base ouverte en mémoire, " +
                    "aucune donnée ne sera conservée.",
            )
            return Room.inMemoryDatabaseBuilder(context, PhoneControlDatabase::class.java)
                .build()
        }

        System.loadLibrary(SQLCIPHER_LIBRARY)

        if (hadPlaintextDatabase) {
            encryptInPlace(file, passphrase)
            mode = Mode.MIGRATED
        } else {
            mode = Mode.ENCRYPTED
        }

        return Room.databaseBuilder(context, PhoneControlDatabase::class.java, PhoneControlDatabase.NAME)
            .openHelperFactory(SupportOpenHelperFactory(passphrase.toByteArray(Charsets.UTF_8)))
            // Pas de `fallbackToDestructiveMigration` : perdre la file
            // d'événements non synchronisés reviendrait à effacer des preuves.
            // Une migration manquante doit échouer bruyamment.
            .addMigrations(*ALL_MIGRATIONS)
            .build()
    }

    /**
     * Convertit une base en clair en base chiffrée, sur place.
     *
     * La recette est celle de SQLCipher : ouvrir l'original avec une phrase
     * vide — SQLCipher le traite alors comme un fichier SQLite ordinaire —,
     * attacher une base chiffrée, y exporter le contenu, puis substituer les
     * fichiers.
     *
     * L'ordre compte : le fichier chiffré est écrit **à côté**, et l'original
     * n'est supprimé qu'une fois l'export terminé. Une coupure de courant au
     * mauvais moment laisse donc soit l'ancien fichier intact, soit les deux —
     * jamais rien.
     */
    private fun encryptInPlace(file: File, passphrase: String) {
        val encrypted = File(file.parentFile, "${file.name}.encrypting")
        if (encrypted.exists()) encrypted.delete()

        Log.i(TAG, "Base locale en clair détectée : conversion en base chiffrée.")

        val plaintext = SQLiteDatabase.openOrCreateDatabase(file.absolutePath, "", null, null)
        try {
            plaintext.execSQL(
                "ATTACH DATABASE ? AS encrypted KEY ?",
                arrayOf(encrypted.absolutePath, passphrase),
            )
            plaintext.rawQuery("SELECT sqlcipher_export('encrypted')", null).use { it.moveToFirst() }
            // La version de schéma n'est pas transportée par sqlcipher_export :
            // sans cette ligne, Room croirait ouvrir une base neuve et
            // rejouerait la création des tables sur des données existantes.
            plaintext.execSQL("PRAGMA encrypted.user_version = ${plaintext.version}")
            plaintext.execSQL("DETACH DATABASE encrypted")
        } finally {
            plaintext.close()
        }

        // Journaux de l'ancienne base : les laisser ferait échouer l'ouverture
        // de la nouvelle, qui n'a pas la même clé.
        listOf("", "-wal", "-shm", "-journal").forEach { suffix ->
            File(file.parentFile, "${file.name}$suffix").takeIf { it.exists() }?.delete()
        }

        if (!encrypted.renameTo(file)) {
            throw IllegalStateException(
                "Conversion de la base impossible : le fichier chiffré n'a pas pu être mis en place.",
            )
        }

        Log.i(TAG, "Base locale convertie : le contenu est désormais chiffré au repos.")
    }

    companion object {
        private const val TAG = "LocalDatabase"
        private const val SQLCIPHER_LIBRARY = "sqlcipher"
    }
}
