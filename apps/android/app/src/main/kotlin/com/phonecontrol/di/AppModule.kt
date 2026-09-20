package com.phonecontrol.di

import android.content.Context
import com.phonecontrol.BuildConfig
import com.phonecontrol.data.local.CommandDao
import com.phonecontrol.data.local.ConfigurationDao
import com.phonecontrol.data.local.OfflineBadgeDao
import com.phonecontrol.data.local.PendingEventDao
import com.phonecontrol.data.local.LocalDatabaseFactory
import com.phonecontrol.data.local.PhoneControlDatabase
import com.phonecontrol.data.local.SessionDao
import com.phonecontrol.data.remote.DeviceAuthInterceptor
import com.phonecontrol.data.remote.GzipRequestInterceptor
import com.phonecontrol.data.remote.PhoneControlApi
import com.phonecontrol.security.CertificatePinning
import com.phonecontrol.security.DatabaseKey
import com.phonecontrol.security.SecureStore
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import java.util.concurrent.TimeUnit
import javax.inject.Singleton
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import com.phonecontrol.data.remote.AdresseServeurInterceptor
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory

@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    fun provideSecureStore(@ApplicationContext context: Context): SecureStore =
        SecureStore(context)

    @Provides
    @Singleton
    fun provideJson(): Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = false
    }

    // --- Base locale --------------------------------------------------------

    @Provides
    @Singleton
    fun provideDatabaseFactory(
        @ApplicationContext context: Context,
        databaseKey: DatabaseKey,
    ): LocalDatabaseFactory = LocalDatabaseFactory(context, databaseKey)

    @Provides
    @Singleton
    fun provideDatabase(factory: LocalDatabaseFactory): PhoneControlDatabase = factory.create()

    @Provides fun providePendingEventDao(db: PhoneControlDatabase): PendingEventDao = db.pendingEvents()
    @Provides fun provideOfflineBadgeDao(db: PhoneControlDatabase): OfflineBadgeDao = db.offlineBadges()
    @Provides fun provideConfigurationDao(db: PhoneControlDatabase): ConfigurationDao = db.configuration()
    @Provides fun provideSessionDao(db: PhoneControlDatabase): SessionDao = db.sessions()
    @Provides fun provideCommandDao(db: PhoneControlDatabase): CommandDao = db.commands()

    // --- Réseau -------------------------------------------------------------

    @Provides
    @Singleton
    fun provideOkHttp(
        authInterceptor: DeviceAuthInterceptor,
        secureStore: SecureStore,
    ): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            // Le retry par défaut d'OkHttp est conservé, mais la logique de
            // reprise réelle est dans le moteur de synchronisation : lui seul
            // sait qu'un envoi non acquitté doit être rejoué, pas abandonné.
            .retryOnConnectionFailure(true)
            // Avant l'authentification : le corps est compressé une fois, et
            // l'en-tête Authorization ajouté ensuite sur la requête compressée.
            .addInterceptor(GzipRequestInterceptor())
            // Réécrit l'hôte à CHAQUE requête, depuis le magasin sécurisé.
            //
            // ── La panne que ça répare ──────────────────────────────────────
            // `provideRetrofit` est un `@Singleton` : il lisait l'adresse UNE
            // FOIS, à sa construction. Or au premier démarrage rien n'est
            // encore enregistré, donc il se construisait sur l'adresse
            // compilée en dur — et l'adresse saisie par l'opérateur sur
            // l'écran d'enrôlement n'était jamais prise en compte. Il fallait
            // redémarrer l'application pour que l'enrôlement passe, sans que
            // rien ne le dise. Constaté sur le terminal : « serveur
            // injoignable » deux fois de suite avec la bonne adresse saisie.
            //
            // L'adresse de base de Retrofit reste, mais elle n'est plus qu'un
            // gabarit : c'est l'hôte réel qui est substitué ici.
            .addInterceptor(AdresseServeurInterceptor(secureStore))
            .addInterceptor(authInterceptor)

        // Épinglage de certificat. Le verdict décide seul : une politique
        // absente, incomplète ou périmée laisse le client sans épinglage plutôt
        // que d'immobiliser la flotte — voir core-rules/PinningRules.kt.
        val pinning = CertificatePinning.evaluate()
        CertificatePinning.pinnerFor(pinning, CertificatePinning.configuredPolicy()?.host ?: "")
            ?.let { builder.certificatePinner(it) }

        if (BuildConfig.DEBUG) {
            builder.addInterceptor(
                HttpLoggingInterceptor().apply {
                    // BASIC et non BODY : le corps contiendrait la valeur du
                    // badge scanné. Elle n'a rien à faire dans logcat, même en
                    // développement.
                    level = HttpLoggingInterceptor.Level.BASIC
                },
            )
        }

        return builder.build()
    }

    @Provides
    @Singleton
    fun provideRetrofit(
        client: OkHttpClient,
        json: Json,
        secureStore: SecureStore,
    ): Retrofit {
        val baseUrl = secureStore.serverUrl ?: BuildConfig.DEFAULT_SERVER_URL
        return Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
    }

    @Provides
    @Singleton
    fun provideApi(retrofit: Retrofit): PhoneControlApi =
        retrofit.create(PhoneControlApi::class.java)
}
