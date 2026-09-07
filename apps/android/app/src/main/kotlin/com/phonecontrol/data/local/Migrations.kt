package com.phonecontrol.data.local

import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Migrations de la base locale.
 *
 * La fabrique n'active volontairement pas `fallbackToDestructiveMigration` :
 * recreer la base a chaque montee de version effacerait la file d'evenements
 * non encore synchronises, c'est-a-dire des preuves d'activite qu'aucune autre
 * copie ne detient. Une migration manquante doit donc echouer bruyamment
 * plutot que de se resoudre en perte silencieuse.
 *
 * Corollaire : toute nouvelle colonne exige une entree ici, sans quoi la
 * premiere mise a jour de l'application immobilise le telephone.
 */

/**
 * v1 -> v2 : liste des applications a masquer.
 *
 * `DEFAULT '[]'` importe : au moment de la migration, le telephone n'a pas
 * encore reparle au serveur. Une valeur nulle ferait echouer la lecture, et
 * n'importe quelle autre valeur par defaut bloquerait des applications que
 * personne n'a demande de bloquer.
 */
val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL(
            "ALTER TABLE device_settings ADD COLUMN blockedAppsJson TEXT NOT NULL DEFAULT '[]'",
        )
    }
}

/** Toutes les migrations connues, dans l'ordre. */
val ALL_MIGRATIONS: Array<Migration> = arrayOf(MIGRATION_1_2)
