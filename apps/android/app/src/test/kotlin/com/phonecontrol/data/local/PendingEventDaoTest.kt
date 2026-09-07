package com.phonecontrol.data.local

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.util.UUID
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * File d'événements locale.
 *
 * Ces tests vérifient les trois propriétés dont dépend le fonctionnement hors
 * ligne : l'ordre de transmission, l'idempotence, et le fait que rien ne soit
 * purgé avant acquittement. Ils tournent sur la JVM via Robolectric, sans
 * émulateur.
 */
// Application nue : ces tests portent sur la base locale, pas sur le graphe
// Hilt ni sur le Keystore, indisponible hors appareil réel.
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class, sdk = [33])
class PendingEventDaoTest {

    private lateinit var database: PhoneControlDatabase
    private lateinit var dao: PendingEventDao

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            PhoneControlDatabase::class.java,
        ).allowMainThreadQueries().build()
        dao = database.pendingEvents()
    }

    @After
    fun tearDown() {
        database.close()
    }

    private fun event(
        kind: String,
        seq: Long,
        eventId: String = UUID.randomUUID().toString(),
    ) = PendingEventEntity(
        eventId = eventId,
        seq = seq,
        kind = kind,
        occurredAt = 1_000_000 + seq,
    )

    // -----------------------------------------------------------------------

    @Test
    fun `les evenements de securite passent avant les positions`() = runTest {
        // Insérés dans l'ordre inverse de la priorité attendue.
        dao.insert(event(EventKind.LOCATION, 1))
        dao.insert(event(EventKind.LOCATION, 2))
        dao.insert(event(EventKind.GEOFENCE, 3))
        dao.insert(event(EventKind.SECURITY, 4))
        dao.insert(event(EventKind.BARCODE_SCAN, 5))

        val batch = dao.nextBatch(10)

        // Une alerte ne doit jamais attendre derrière des milliers de points GPS.
        assertEquals(
            listOf(
                EventKind.SECURITY,
                EventKind.GEOFENCE,
                EventKind.BARCODE_SCAN,
                EventKind.LOCATION,
                EventKind.LOCATION,
            ),
            batch.map { it.kind },
        )
        // À priorité égale, l'ordre chronologique est préservé.
        assertEquals(listOf(1L, 2L), batch.filter { it.kind == EventKind.LOCATION }.map { it.seq })
    }

    @Test
    fun `un evenement deja en file n est pas duplique`() = runTest {
        val shared = UUID.randomUUID().toString()
        dao.insert(event(EventKind.LOCATION, 1, shared))
        dao.insert(event(EventKind.LOCATION, 2, shared))

        assertEquals(1, dao.totalCount())
    }

    @Test
    fun `un evenement en cours d envoi n est pas ecrase par une reinsertion`() = runTest {
        val shared = UUID.randomUUID().toString()
        dao.insert(event(EventKind.LOCATION, 1, shared))
        dao.markState(listOf(shared), SyncState.SENDING)

        // Réinsertion : `IGNORE` et non `REPLACE`. Écraser la ligne perdrait
        // son état d'envoi, et l'événement partirait deux fois.
        dao.insert(event(EventKind.LOCATION, 9, shared))

        val stored = dao.findByEventId(shared)
        assertNotNull(stored)
        assertEquals(SyncState.SENDING, stored!!.syncState)
        assertEquals(1L, stored.seq)
    }

    @Test
    fun `rien n est purge avant acquittement`() = runTest {
        val a = UUID.randomUUID().toString()
        val b = UUID.randomUUID().toString()
        dao.insert(event(EventKind.LOCATION, 1, a))
        dao.insert(event(EventKind.LOCATION, 2, b))

        dao.markState(listOf(a, b), SyncState.SENDING)
        // Le serveur n'acquitte que le premier.
        dao.deleteAcked(listOf(a))
        dao.markState(listOf(b), SyncState.PENDING)

        val remaining = dao.nextBatch(10)
        assertEquals(1, remaining.size)
        assertEquals(b, remaining.first().eventId)
        assertEquals(SyncState.PENDING, remaining.first().syncState)
    }

    @Test
    fun `le compteur de sequence reprend apres redemarrage`() = runTest {
        dao.insert(event(EventKind.LOCATION, 41))
        dao.insert(event(EventKind.LOCATION, 42))

        // C'est cette valeur que le recorder relit au démarrage pour ne pas
        // réutiliser des numéros déjà transmis.
        assertEquals(42L, dao.maxSeq())
    }

    @Test
    fun `la saturation sacrifie les positions, jamais la securite`() = runTest {
        repeat(10) { dao.insert(event(EventKind.LOCATION, it.toLong())) }
        dao.insert(event(EventKind.SECURITY, 100))
        dao.insert(event(EventKind.GEOFENCE, 101))

        dao.dropOldestLocations(6)

        val remaining = dao.nextBatch(50)
        assertEquals(4, remaining.count { it.kind == EventKind.LOCATION })
        assertEquals(1, remaining.count { it.kind == EventKind.SECURITY })
        assertEquals(1, remaining.count { it.kind == EventKind.GEOFENCE })

        // Les plus anciennes partent en premier.
        assertTrue(remaining.filter { it.kind == EventKind.LOCATION }.all { it.seq >= 6 })
    }

    @Test
    fun `le lot est borne par la limite demandee`() = runTest {
        repeat(20) { dao.insert(event(EventKind.LOCATION, it.toLong())) }
        assertEquals(5, dao.nextBatch(5).size)
    }
}
