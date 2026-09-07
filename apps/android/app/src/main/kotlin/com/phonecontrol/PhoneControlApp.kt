package com.phonecontrol

import android.app.Application
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import com.phonecontrol.security.SecureStore
import com.phonecontrol.sync.SyncWorker
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

/**
 * Point d'entrée de l'application.
 *
 * WorkManager est initialisé ici plutôt qu'automatiquement : les workers ont
 * besoin d'injection (moteur de synchronisation, gestionnaire de session), et
 * l'initialiseur par défaut ne sait pas la leur fournir.
 */
@HiltAndroidApp
class PhoneControlApp : Application(), Configuration.Provider {

    @Inject lateinit var workerFactory: HiltWorkerFactory
    @Inject lateinit var secureStore: SecureStore

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setWorkerFactory(workerFactory)
            .setMinimumLoggingLevel(
                if (BuildConfig.DEBUG) android.util.Log.INFO else android.util.Log.WARN,
            )
            .build()

    override fun onCreate() {
        super.onCreate()

        // Les tâches périodiques ne sont planifiées qu'une fois l'appareil
        // enrôlé : avant cela, elles n'auraient rien à synchroniser et
        // consommeraient de la batterie pour rien.
        runCatching {
            if (secureStore.isEnrolled) {
                SyncWorker.schedule(this)
            }
        }.onFailure {
            // Un magasin illisible ne doit pas empêcher l'application de
            // démarrer : l'écran de verrouillage affichera « non enrôlé »,
            // ce qui est diagnostiquable, contrairement à un plantage.
            android.util.Log.e("PhoneControlApp", "Démarrage dégradé : ${it.message}")
        }
    }
}
