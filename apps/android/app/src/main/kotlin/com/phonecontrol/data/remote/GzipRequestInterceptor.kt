package com.phonecontrol.data.remote

import java.io.IOException
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.Buffer
import okio.BufferedSink
import okio.GzipSink
import okio.buffer

/**
 * Compression des corps de requête volumineux.
 *
 * Un lot de synchronisation est du JSON très répétitif : cinq cents positions
 * partagent les mêmes noms de champs, les mêmes préfixes d'identifiants, des
 * coordonnées voisines. La compression y gagne beaucoup — et ce gain se paie en
 * données mobiles réelles, sur des téléphones qui roulent toute la journée.
 *
 * En dessous du seuil, on ne compresse pas : sur un petit corps, l'en-tête gzip
 * et le temps processeur coûtent plus qu'ils ne rapportent, et un heartbeat de
 * deux cents octets n'a rien à y gagner.
 *
 * Le serveur doit accepter `Content-Encoding: gzip` — Fastify le fait via
 * `@fastify/compress` côté requête. Si ce n'était pas le cas, la requête
 * échouerait bruyamment plutôt que silencieusement, ce qui est le bon sens de
 * l'échec ici.
 */
class GzipRequestInterceptor(
    private val minimumBytes: Long = DEFAULT_MINIMUM_BYTES,
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val body = request.body

        if (body == null || request.header(CONTENT_ENCODING) != null) {
            return chain.proceed(request)
        }

        val length = runCatching { body.contentLength() }.getOrDefault(-1L)
        // Une longueur inconnue (-1) n'est pas compressée : il faudrait
        // matérialiser le corps pour la connaître, et ce corps peut être un flux.
        if (length < minimumBytes) return chain.proceed(request)

        return chain.proceed(
            request.newBuilder()
                .header(CONTENT_ENCODING, "gzip")
                .method(request.method, gzip(body))
                .build(),
        )
    }

    companion object {
        /** Seuil de docs/05 §4 : quatre kilo-octets. */
        const val DEFAULT_MINIMUM_BYTES: Long = 4 * 1024
        private const val CONTENT_ENCODING = "Content-Encoding"

        /**
         * Compresse en mémoire.
         *
         * On matérialise le corps compressé plutôt que de l'écrire à la volée :
         * OkHttp doit connaître `contentLength` pour éviter l'encodage par
         * blocs, que certains proxys d'entreprise refusent. Un lot borné à cinq
         * cents événements tient largement en mémoire.
         */
        fun gzip(body: RequestBody): RequestBody {
            val compressed = Buffer()
            GzipSink(compressed).buffer().use { sink -> body.writeTo(sink) }
            val bytes = compressed.readByteArray()

            return object : RequestBody() {
                override fun contentType(): MediaType? = body.contentType()

                override fun contentLength(): Long = bytes.size.toLong()

                @Throws(IOException::class)
                override fun writeTo(sink: BufferedSink) {
                    sink.write(bytes)
                }
            }
        }

        /** Vrai si cette requête sera compressée. Rendu public pour les tests. */
        fun willCompress(request: Request, minimumBytes: Long = DEFAULT_MINIMUM_BYTES): Boolean {
            val body = request.body ?: return false
            if (request.header(CONTENT_ENCODING) != null) return false
            return runCatching { body.contentLength() }.getOrDefault(-1L) >= minimumBytes
        }
    }
}
