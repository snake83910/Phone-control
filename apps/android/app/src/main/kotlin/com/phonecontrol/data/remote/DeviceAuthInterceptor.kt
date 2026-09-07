package com.phonecontrol.data.remote

import android.util.Log
import com.phonecontrol.security.SecureStore
import javax.inject.Inject
import javax.inject.Provider
import javax.inject.Singleton
import kotlinx.serialization.json.Json
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * Authentification des appels sortants et rotation du jeton.
 *
 * Le jeton d'accès de l'appareil vit soixante minutes. Sans rotation
 * automatique, chaque téléphone devrait être réenrôlé à la main toutes les
 * heures ; avec une durée de vie allongée, la révocation d'un terminal volé
 * mettrait des jours à prendre effet. La rotation est donc la seule réponse
 * acceptable, et elle appartient à cette couche.
 *
 * Un 401 déclenche UNE tentative de rafraîchissement, puis un rejeu. Si elle
 * échoue, les identifiants sont effacés : l'application se retrouve dans l'état
 * « non enrôlé » et l'écran de verrouillage le dit, plutôt que de tourner en
 * boucle sur des requêtes refusées.
 */
@Singleton
class DeviceAuthInterceptor @Inject constructor(
    private val secureStore: SecureStore,
    private val json: Json,
) : Interceptor {

    /**
     * Client dédié au rafraîchissement, sans cet intercepteur : sinon un 401 sur
     * l'appel de rafraîchissement déclencherait un nouveau rafraîchissement,
     * indéfiniment.
     */
    private val refreshClient: OkHttpClient by lazy { OkHttpClient.Builder().build() }

    private val lock = Any()

    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()

        if (isPublic(original)) {
            return chain.proceed(original)
        }

        val token = secureStore.accessToken
            ?: return chain.proceed(original)

        var response = chain.proceed(original.withToken(token))

        if (response.code == 401) {
            response.close()

            val refreshed = synchronized(lock) {
                // Un autre appel a peut-être déjà rafraîchi pendant l'attente.
                val current = secureStore.accessToken
                if (current != null && current != token) current else refreshTokens(chain)
            }

            response = if (refreshed != null) {
                chain.proceed(original.withToken(refreshed))
            } else {
                chain.proceed(original.withToken(token))
            }
        }

        return response
    }

    private fun Request.withToken(token: String): Request =
        newBuilder().header("Authorization", "Bearer $token").build()

    private fun isPublic(request: Request): Boolean {
        val path = request.url.encodedPath
        // L'enrôlement et le rafraîchissement portent leur propre secret.
        return path.endsWith("/devices/enroll") || path.endsWith("/devices/token/refresh")
    }

    private fun refreshTokens(chain: Interceptor.Chain): String? {
        val refreshToken = secureStore.refreshToken ?: return null
        val baseUrl = chain.request().url.newBuilder()
            .encodedPath(basePathOf(chain.request()) + "v1/devices/token/refresh")
            .query(null)
            .build()

        val body = json
            .encodeToString(RefreshRequest.serializer(), RefreshRequest(refreshToken))
            .toRequestBody("application/json".toMediaType())

        return runCatching {
            refreshClient.newCall(
                Request.Builder().url(baseUrl).post(body).build(),
            ).execute().use { response ->
                if (!response.code.let { it in 200..299 }) {
                    // Le jeton de rafraîchissement est mort : l'appareil a été
                    // révoqué, ou son jeton a été rejoué ailleurs. Dans les deux
                    // cas, il faut cesser d'essayer.
                    Log.w(TAG, "Rafraîchissement refusé (${response.code}) : identifiants effacés.")
                    secureStore.clearCredentials()
                    return null
                }

                val payload = response.body?.string() ?: return null
                val tokens = json.decodeFromString(TokenResponse.serializer(), payload)
                secureStore.accessToken = tokens.accessToken
                secureStore.refreshToken = tokens.refreshToken
                tokens.accessToken
            }
        }.getOrElse { error ->
            // Panne réseau : on ne touche surtout pas aux identifiants, sinon
            // une coupure de tunnel désenrôlerait la flotte.
            Log.w(TAG, "Rafraîchissement impossible : ${error.message}")
            null
        }
    }

    /** Conserve le préfixe de l'API (`/api/`) tel qu'il est configuré. */
    private fun basePathOf(request: Request): String {
        val path = request.url.encodedPath
        val marker = path.indexOf("/v1/")
        return if (marker >= 0) path.substring(0, marker + 1) else "/"
    }

    private companion object {
        const val TAG = "DeviceAuth"
    }
}

/** Utilisé par Hilt pour rompre le cycle Retrofit -> intercepteur -> Retrofit. */
typealias ApiProvider = Provider<PhoneControlApi>
