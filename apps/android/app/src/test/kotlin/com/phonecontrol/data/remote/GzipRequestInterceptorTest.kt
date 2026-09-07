package com.phonecontrol.data.remote

import java.util.zip.GZIPInputStream
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Compression des lots de synchronisation.
 *
 * Le pendant serveur est vérifié par `apps/api/test/sync-gzip.e2e-spec.ts` :
 * les deux moitiés du contrat sont donc tenues, chacune de son côté. Sans
 * l'une, activer l'autre casserait la synchronisation de tout le parc d'un seul
 * coup — d'où l'insistance à tester les deux.
 */
class GzipRequestInterceptorTest {

    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient

    private val jsonType = "application/json".toMediaType()

    @Before
    fun setUp() {
        server = MockWebServer().apply { start() }
        client = OkHttpClient.Builder()
            .addInterceptor(GzipRequestInterceptor())
            .build()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun post(body: String) {
        server.enqueue(MockResponse().setResponseCode(200))
        client.newCall(
            Request.Builder()
                .url(server.url("/v1/sync/events"))
                .post(body.toRequestBody(jsonType))
                .build(),
        ).execute().close()
    }

    /** Un lot réaliste : du JSON très répétitif, comme celui des positions. */
    private fun batch(count: Int): String =
        (1..count).joinToString(",", "[", "]") { index ->
            """{"eventId":"0195e9f0-0000-7000-8000-00000000%04d","kind":"LOCATION",""".format(index) +
                """"latitude":45.75,"longitude":4.85,"accuracyMeters":12,"speedMps":8.3}"""
        }

    @Test
    fun `un petit corps n est pas compresse`() {
        post("""{"deviceId":"x","events":[]}""")

        val request = server.takeRequest()
        assertNull(request.getHeader("Content-Encoding"))
        assertEquals("""{"deviceId":"x","events":[]}""", request.body.readUtf8())
    }

    @Test
    fun `un lot volumineux est compresse et reste relisible`() {
        val payload = batch(200)
        assertTrue("Le lot de test doit dépasser le seuil", payload.length > 4 * 1024)

        post(payload)

        val request = server.takeRequest()
        assertEquals("gzip", request.getHeader("Content-Encoding"))

        val received = request.body.readByteArray()
        assertTrue("Le corps envoyé doit être plus court que l'original", received.size < payload.length)

        val decompressed = GZIPInputStream(received.inputStream()).readBytes().toString(Charsets.UTF_8)
        assertEquals(payload, decompressed)
    }

    @Test
    fun `la longueur annoncee correspond au corps compresse`() {
        // Sans `contentLength`, OkHttp bascule en encodage par blocs, que
        // certains proxys d'entreprise refusent.
        post(batch(200))

        val request = server.takeRequest()
        val declared = request.getHeader("Content-Length")?.toInt()
        assertEquals(request.body.size.toInt(), declared)
    }

    @Test
    fun `le seuil est celui de la specification`() {
        assertEquals(4L * 1024, GzipRequestInterceptor.DEFAULT_MINIMUM_BYTES)
    }

    @Test
    fun `un corps deja encode n est pas recompresse`() {
        val request = Request.Builder()
            .url("https://exemple.fr/x")
            .header("Content-Encoding", "gzip")
            .post(batch(200).toRequestBody(jsonType))
            .build()

        assertFalse(GzipRequestInterceptor.willCompress(request))
    }

    @Test
    fun `une requete sans corps traverse sans modification`() {
        val request = Request.Builder().url("https://exemple.fr/x").get().build()

        assertFalse(GzipRequestInterceptor.willCompress(request))
    }
}
