package com.phonecontrol.data.remote

import android.util.Log
import com.phonecontrol.security.SecureStore
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Substitue l'adresse du serveur à chaque requête.
 *
 * ── Pourquoi Retrofit ne peut pas s'en charger ──────────────────────────
 * Son adresse de base est fixée à la construction, et le client est un
 * `@Singleton` : il se construisait au premier accès, avant qu'aucune adresse
 * ne soit enregistrée, donc sur la valeur compilée en dur. L'adresse saisie
 * ensuite par l'opérateur n'était jamais relue.
 *
 * Effet observé : l'enrôlement échouait deux fois de suite sur « serveur
 * injoignable » avec pourtant la bonne adresse dans le champ, et ne passait
 * qu'après un redémarrage complet de l'application. Rien ne le disait.
 *
 * Ici, l'hôte est relu à chaque appel. Le changement prend effet
 * immédiatement, sans redémarrage et sans reconstruire quoi que ce soit.
 */
@Singleton
class AdresseServeurInterceptor @Inject constructor(
    private val secureStore: SecureStore,
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val requete = chain.request()
        val configuree = secureStore.serverUrl?.trim()

        // Rien d'enregistré : on laisse passer vers l'adresse de repli. C'est
        // le cas avant l'enrôlement, et c'est ce qui permet à l'écran de
        // saisie d'exister.
        if (configuree.isNullOrEmpty()) return chain.proceed(requete)

        val base = configuree.toHttpUrlOrNull()
        if (base == null) {
            // Une adresse illisible ne doit pas faire tomber la requête : on
            // la signale et on poursuit avec celle d'origine, qui échouera
            // peut-être — mais avec un message réseau ordinaire, pas une
            // exception au milieu d'un intercepteur.
            Log.e(TAG, "Adresse de serveur illisible : $configuree")
            return chain.proceed(requete)
        }

        // Seuls l'hôte, le port et le schéma sont repris. Le CHEMIN de la
        // requête vient de Retrofit et ne doit surtout pas être écrasé : c'est
        // lui qui distingue `/v1/devices/heartbeat` de `/v1/sync/pull`.
        val reecrite = requete.url.newBuilder()
            .scheme(base.scheme)
            .host(base.host)
            .port(base.port)
            .build()

        return chain.proceed(requete.newBuilder().url(reecrite).build())
    }

    private companion object {
        const val TAG = "AdresseServeur"
    }
}
