package com.phonecontrol.data.local

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.phonecontrol.security.DatabaseKey
import com.phonecontrol.security.DatabasePassphrase
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Chiffrement de la base locale — **sur un vrai Android**.
 *
 * Ces tests ne peuvent pas tourner sous Robolectric : SQLCipher est une
 * bibliothèque native, et il n'en existe pas de version pour la JVM du poste de
 * développement. Ils s'exécutent donc sur émulateur ou sur téléphone :
 *
 *     ./gradlew :app:connectedDebugAndroidTest
 *
 * Ce qu'ils établissent, et qu'aucun test unitaire ne pouvait établir : le
 * fichier écrit sur le disque n'est plus une base SQLite lisible, la conversion
 * d'une base en clair ne perd pas la file d'événements, et une base chiffrée ne
 * s'ouvre pas avec une autre phrase.
 */
@RunWith(AndroidJUnit4::class)
class EncryptedDatabaseTest {

    private val context: Context = ApplicationProvider.getApplicationContext()

    /** En-tête d'un fichier SQLite en clair. Il ne doit plus apparaître. */
    private val sqliteHeader = "SQLite format 3".toByteArray(Charsets.US_ASCII)

    private class FixedPassphrase(private val value: String?) : DatabasePassphrase {
        var created = false
            private set

        override val exists: Boolean get() = value != null && created

        override fun getOrCreate(): String? {
            created = true
            return value
        }
    }

    private fun databaseFile(): File = context.getDatabasePath(PhoneControlDatabase.NAME)

    private fun deleteDatabaseFiles() {
        val file = databaseFile()
        file.parentFile?.mkdirs()
        listOf("", "-wal", "-shm", "-journal", ".encrypting").forEach { suffix ->
            File(file.parentFile, "${file.name}$suffix").delete()
        }
    }

    private fun header(): ByteArray = databaseFile().inputStream().use { stream ->
        ByteArray(16).also { stream.read(it) }
    }

    private fun anEvent(seq: Long) = PendingEventEntity(
        eventId = "0195e9f0-0000-7000-8000-%012d".format(seq),
        seq = seq,
        kind = EventKind.SECURITY,
        occurredAt = 1_757_000_000_000 + seq,
        securityType = "ADB_ENABLED",
        severity = "MEDIUM",
    )

    @Before
    fun setUp() {
        deleteDatabaseFiles()
    }

    @Test
    fun le_fichier_ecrit_n_est_pas_une_base_sqlite_lisible() = runBlocking {
        val passphrase = "a".repeat(DatabaseKey.KEY_SIZE_BYTES * 2)
        val factory = LocalDatabaseFactory(context, FixedPassphrase(passphrase))

        val database = factory.create()
        database.pendingEvents().insert(anEvent(1))
        database.close()

        assertEquals(LocalDatabaseFactory.Mode.ENCRYPTED, factory.mode)
        assertTrue("La base doit exister sur le disque", databaseFile().exists())

        val head = header()
        assertFalse(
            "L'en-tête SQLite est encore lisible : la base n'est pas chiffrée",
            head.copyOfRange(0, sqliteHeader.size).contentEquals(sqliteHeader),
        )

        // Le contenu, lui non plus, ne doit pas se laisser lire.
        val raw = databaseFile().readBytes().toString(Charsets.ISO_8859_1)
        assertFalse("Le type d'événement apparaît en clair", raw.contains("ADB_ENABLED"))
    }

    @Test
    fun la_base_se_relit_avec_la_meme_phrase() = runBlocking {
        val passphrase = "b".repeat(DatabaseKey.KEY_SIZE_BYTES * 2)

        val first = LocalDatabaseFactory(context, FixedPassphrase(passphrase)).create()
        first.pendingEvents().insert(anEvent(1))
        first.pendingEvents().insert(anEvent(2))
        first.close()

        // Deuxième ouverture : la phrase existe déjà, aucune conversion.
        val reopened = LocalDatabaseFactory(
            context,
            object : DatabasePassphrase {
                override val exists = true
                override fun getOrCreate() = passphrase
            },
        )
        val database = reopened.create()
        assertEquals(LocalDatabaseFactory.Mode.ENCRYPTED, reopened.mode)
        assertEquals(2, database.pendingEvents().maxSeq())
        database.close()
    }

    @Test
    fun une_autre_phrase_n_ouvre_pas_la_base() = runBlocking {
        val passphrase = "c".repeat(DatabaseKey.KEY_SIZE_BYTES * 2)
        val database = LocalDatabaseFactory(context, FixedPassphrase(passphrase)).create()
        database.pendingEvents().insert(anEvent(1))
        database.close()

        val wrong = LocalDatabaseFactory(
            context,
            object : DatabasePassphrase {
                override val exists = true
                override fun getOrCreate() = "d".repeat(DatabaseKey.KEY_SIZE_BYTES * 2)
            },
        ).create()

        val failed = runCatching { wrong.pendingEvents().maxSeq() }.isFailure
        assertTrue("Une phrase erronée doit échouer à ouvrir la base", failed)
        runCatching { wrong.close() }
        Unit
    }

    @Test
    fun une_base_en_clair_est_convertie_sans_perdre_la_file() = runBlocking {
        // Une base telle que l'aurait laissée une version antérieure : Room,
        // sans fabrique SQLCipher, donc en clair.
        val plaintext = Room.databaseBuilder(
            context,
            PhoneControlDatabase::class.java,
            PhoneControlDatabase.NAME,
        ).build()
        repeat(25) { index -> plaintext.pendingEvents().insert(anEvent(index.toLong() + 1)) }
        plaintext.close()

        assertTrue(
            "Le témoin doit bien être une base SQLite en clair",
            header().copyOfRange(0, sqliteHeader.size).contentEquals(sqliteHeader),
        )

        val passphrase = "e".repeat(DatabaseKey.KEY_SIZE_BYTES * 2)
        val factory = LocalDatabaseFactory(context, FixedPassphrase(passphrase))
        val converted = factory.create()

        assertEquals(LocalDatabaseFactory.Mode.MIGRATED, factory.mode)
        assertEquals(
            "La file d'événements doit survivre à la conversion",
            25L,
            converted.pendingEvents().maxSeq(),
        )
        assertEquals(25, converted.pendingEvents().nextBatch(100).size)
        converted.close()

        assertFalse(
            "Après conversion, l'en-tête SQLite ne doit plus être lisible",
            header().copyOfRange(0, sqliteHeader.size).contentEquals(sqliteHeader),
        )
        assertFalse(
            "Le fichier intermédiaire doit avoir été mis en place, pas laissé de côté",
            File(databaseFile().parentFile, "${databaseFile().name}.encrypting").exists(),
        )
    }

    @Test
    fun sans_phrase_rien_n_est_ecrit_sur_le_disque() = runBlocking {
        // Cas du keystore illisible : la base est ouverte en mémoire plutôt
        // qu'en clair. Le téléphone démarre, et rien de sensible ne touche le
        // disque.
        val factory = LocalDatabaseFactory(context, FixedPassphrase(null))
        val database = factory.create()

        database.pendingEvents().insert(anEvent(1))
        assertEquals(LocalDatabaseFactory.Mode.IN_MEMORY, factory.mode)
        assertFalse("Aucun fichier de base ne doit être créé", databaseFile().exists())
        database.close()
    }

    @Test
    fun deux_phrases_generees_different() {
        // Garde-fou élémentaire : une phrase constante rendrait le chiffrement
        // décoratif. Le tirage est vérifié ici, où le SecureRandom est celui
        // d'Android et non celui de la JVM du poste.
        val first = ByteArray(DatabaseKey.KEY_SIZE_BYTES)
        val second = ByteArray(DatabaseKey.KEY_SIZE_BYTES)
        java.security.SecureRandom().nextBytes(first)
        java.security.SecureRandom().nextBytes(second)

        assertNotEquals(first.toList(), second.toList())
    }
}
