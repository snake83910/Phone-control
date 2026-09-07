package com.phonecontrol.data.local

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Liste d'authentification hors ligne.
 *
 * Le point vérifié ici n'est pas anodin : la liste est **remplacée en bloc**,
 * jamais fusionnée. Une fusion laisserait un badge révoqué valide
 * indéfiniment sur le téléphone — exactement ce que le mode hors ligne ne doit
 * pas permettre.
 */
// Application nue : ces tests portent sur la base locale, pas sur le graphe
// Hilt ni sur le Keystore, indisponible hors appareil réel.
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class, sdk = [33])
class OfflineBadgeDaoTest {

    private lateinit var database: PhoneControlDatabase
    private lateinit var dao: OfflineBadgeDao

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            PhoneControlDatabase::class.java,
        ).allowMainThreadQueries().build()
        dao = database.offlineBadges()
    }

    @After
    fun tearDown() = database.close()

    private fun badge(hmac: String, name: String, validUntil: Long = FUTURE) =
        OfflineBadgeEntity(
            badgeHmac = hmac,
            userId = "user-$name",
            firstName = name,
            lastName = "Test",
            badgeLast4 = "7719",
            validUntil = validUntil,
            refreshedAt = System.currentTimeMillis(),
        )

    @Test
    fun `un badge revoque disparait apres remplacement`() = runTest {
        dao.replaceAll(listOf(badge("hmac-a", "Remy"), badge("hmac-b", "Jean")))
        assertNotNull(dao.findByHmac("hmac-b"))

        // Le serveur ne renvoie plus le badge de Jean : il a été révoqué.
        dao.replaceAll(listOf(badge("hmac-a", "Remy")))

        assertNotNull(dao.findByHmac("hmac-a"))
        assertNull("Le badge révoqué doit disparaître", dao.findByHmac("hmac-b"))
        assertEquals(1, dao.all().size)
    }

    @Test
    fun `la recherche se fait par empreinte, jamais par numero`() = runTest {
        dao.replaceAll(listOf(badge("empreinte-opaque", "Remy")))

        val found = dao.findByHmac("empreinte-opaque")
        assertNotNull(found)
        // La table ne contient que les quatre derniers caractères, pour
        // l'affichage. Le numéro complet n'existe nulle part sur le téléphone.
        assertEquals("7719", found!!.badgeLast4)
    }

    @Test
    fun `l age de la liste est connu et sert a la refuser si elle est perimee`() = runTest {
        assertEquals(0L, dao.lastRefreshedAt())

        dao.replaceAll(listOf(badge("hmac-a", "Remy")))
        val refreshed = dao.lastRefreshedAt()

        // Sans cette date, une liste vieille de trois semaines serait utilisée
        // comme si elle venait d'arriver.
        assert(refreshed > 0L)
    }

    private companion object {
        val FUTURE = System.currentTimeMillis() + 86_400_000
    }
}
