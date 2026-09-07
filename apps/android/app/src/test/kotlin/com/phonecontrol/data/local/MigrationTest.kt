package com.phonecontrol.data.local

import android.database.sqlite.SQLiteDatabase
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.room.testing.MigrationTestHelper
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Migrations de la base locale.
 *
 * Ce test existe parce que la fabrique refuse volontairement
 * `fallbackToDestructiveMigration` : une migration manquante ou fausse ne se
 * traduit pas par une perte discrète de données, mais par une application qui
 * **ne démarre plus**. Sur une flotte, cela arrive à tous les téléphones à la
 * fois, le jour de la mise à jour, et se répare terminal par terminal.
 *
 * Le risque n'est pas théorique : ajouter une colonne à une entité Room sans
 * l'ajouter à la migration compile parfaitement et passe tous les autres tests.
 * Seule une migration réellement exécutée le montre.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class, sdk = [33])
class MigrationTest {

    @get:Rule
    val helper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        PhoneControlDatabase::class.java,
        emptyList(),
        FrameworkSQLiteOpenHelperFactory(),
    )

    /**
     * Room compare le schéma obtenu après migration à celui qu'il attend pour la
     * version cible, et échoue sur la moindre divergence — colonne manquante,
     * type différent, contrainte oubliée. C'est cette comparaison qui fait la
     * valeur du test, plus que les assertions écrites ici.
     */
    @Test
    fun `migration v1 vers v2 accepte par Room`() {
        helper.createDatabase(TEST_DB, 1).close()

        val migrated = helper.runMigrationsAndValidate(TEST_DB, 2, true, MIGRATION_1_2)
        migrated.close()
    }

    /**
     * La configuration existante doit survivre : au moment de la mise à jour, le
     * téléphone peut être hors réseau depuis des heures et n'avoir que cette
     * copie de ses réglages. La perdre le laisserait sans horaire de retour ni
     * liste de badges hors ligne.
     */
    @Test
    fun `la configuration existante survit a la migration`() {
        helper.createDatabase(TEST_DB, 1).use { db ->
            db.execSQL(
                """
                INSERT INTO device_settings (
                    id, locationIntervalActiveSeconds, locationIntervalIdleSeconds,
                    locationMinDistanceMeters, heartbeatIntervalSeconds, syncIntervalSeconds,
                    offlineAuthEnabled, offlineAuthMaxDurationMinutes, offlineCacheMaxAgeMinutes,
                    sessionMaxDurationMinutes, batteryAlertThreshold, offlineAlertDelayMinutes,
                    gpsAccuracyThresholdMeters, geofenceConfirmationSeconds,
                    geofenceConfirmationSamples, allowedAppsJson, version
                ) VALUES (1, 45, 240, 30, 300, 900, 1, 480, 1440, 960, 12, 30, 100, 120, 3,
                          '["com.google.android.apps.maps"]', 7)
                """.trimIndent(),
            )
        }

        helper.runMigrationsAndValidate(TEST_DB, 2, true, MIGRATION_1_2).close()

        val db = SQLiteDatabase.openDatabase(
            InstrumentationRegistry.getInstrumentation()
                .targetContext
                .getDatabasePath(TEST_DB)
                .absolutePath,
            null,
            SQLiteDatabase.OPEN_READONLY,
        )
        db.use {
            it.rawQuery("SELECT * FROM device_settings WHERE id = 1", null).use { cursor ->
                assertTrue("La ligne de configuration a disparu", cursor.moveToFirst())
                assertEquals(
                    45,
                    cursor.getInt(cursor.getColumnIndexOrThrow("locationIntervalActiveSeconds")),
                )
                assertEquals(
                    """["com.google.android.apps.maps"]""",
                    cursor.getString(cursor.getColumnIndexOrThrow("allowedAppsJson")),
                )
                // Le point qui compte : une base migrée ne bloque aucune
                // application d'elle-même. Toute autre valeur par défaut ferait
                // disparaître des applications que personne n'a désignées.
                assertEquals(
                    "[]",
                    cursor.getString(cursor.getColumnIndexOrThrow("blockedAppsJson")),
                )
            }
        }
    }

    private companion object {
        const val TEST_DB = "migration-test.db"
    }
}
