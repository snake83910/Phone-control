package com.phonecontrol.security

import com.phonecontrol.core.rules.PinningPolicy
import com.phonecontrol.core.rules.PinningStatus
import com.phonecontrol.core.rules.evaluatePinningPolicy
import java.net.InetAddress
import java.time.Instant
import javax.net.ssl.SSLPeerUnverifiedException
import okhttp3.CertificatePinner
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test

/**
 * Épinglage de certificat, contre un vrai serveur TLS.
 *
 * `PinningRulesTest` vérifie la politique ; ici on vérifie qu'elle **fait ce
 * qu'elle dit** sur une poignée de main réelle : un certificat inattendu est
 * refusé, le bon est accepté, et une politique périmée laisse passer au lieu de
 * couper.
 *
 * Ce dernier point est le plus important à tenir. Un épinglage qui coupe est
 * facile à écrire ; c'est la garantie qu'il ne coupera *pas* la flotte le jour
 * du renouvellement qui demande d'être vérifiée.
 */
class CertificatePinningTest {

    private lateinit var certificate: HeldCertificate
    private lateinit var server: MockWebServer
    private lateinit var clientCertificates: HandshakeCertificates

    private val future: Instant = Instant.parse("2027-09-05T00:00:00Z")
    private val now: Instant = Instant.parse("2026-09-05T12:00:00Z")

    /** Empreinte quelconque, valide en forme : sert de secours de rotation. */
    private val backupPin = "B".repeat(43) + "="

    @Before
    fun setUp() {
        // MockWebServer publie son adresse sous le nom canonique de la machine,
        // qui n'est pas « localhost » sur tous les postes. Sans ce nom dans le
        // certificat, la poignée de main échoue avant même l'épinglage — et
        // l'erreur ressemble à s'y méprendre à un défaut d'épinglage.
        val canonical = InetAddress.getByName("localhost").canonicalHostName

        certificate = HeldCertificate.Builder()
            .addSubjectAlternativeName("localhost")
            .addSubjectAlternativeName(canonical)
            .addSubjectAlternativeName("127.0.0.1")
            .build()

        val serverCertificates = HandshakeCertificates.Builder()
            .heldCertificate(certificate)
            .build()

        clientCertificates = HandshakeCertificates.Builder()
            .addTrustedCertificate(certificate.certificate)
            .build()

        server = MockWebServer().apply {
            useHttps(serverCertificates.sslSocketFactory(), false)
            enqueue(MockResponse().setResponseCode(200).setBody("ok"))
            start()
        }
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    /** Empreinte réelle de la clé publique du certificat de test. */
    private fun realPin(): String =
        CertificatePinner.pin(certificate.certificate).removePrefix("sha256/")

    private fun clientWith(policy: PinningPolicy?): OkHttpClient {
        val verdict = evaluatePinningPolicy(policy, now)
        val builder = OkHttpClient.Builder().sslSocketFactory(
            clientCertificates.sslSocketFactory(),
            clientCertificates.trustManager,
        )
        CertificatePinning.pinnerFor(verdict, policy?.host ?: server.hostName)
            ?.let { builder.certificatePinner(it) }
        return builder.build()
    }

    private fun call(client: OkHttpClient) {
        client.newCall(Request.Builder().url(server.url("/")).build()).execute().use { response ->
            assertEquals(200, response.code)
        }
    }

    @Test
    fun `la bonne empreinte laisse passer`() {
        val policy = PinningPolicy(server.hostName, listOf(realPin(), backupPin), future)

        call(clientWith(policy))
    }

    @Test
    fun `une empreinte inattendue coupe la connexion`() {
        // C'est le cas que l'épinglage doit attraper : proxy d'inspection,
        // autorité compromise, certificat substitué en chemin.
        val policy = PinningPolicy(server.hostName, listOf("A".repeat(43) + "=", backupPin), future)

        assertThrows(SSLPeerUnverifiedException::class.java) { call(clientWith(policy)) }
    }

    @Test
    fun `le secours de rotation est accepte comme le principal`() {
        // L'empreinte en service est en seconde position : le certificat doit
        // être accepté quand même. C'est ce qui permet de publier la version
        // contenant la future empreinte AVANT de changer le certificat.
        val policy = PinningPolicy(server.hostName, listOf(backupPin, realPin()), future)

        call(clientWith(policy))
    }

    @Test
    fun `une politique perimee laisse passer plutot que d immobiliser la flotte`() {
        val expired = PinningPolicy(
            "localhost",
            listOf("A".repeat(43) + "=", backupPin),
            now.minusSeconds(1),
        )

        assertEquals(PinningStatus.EXPIRED, evaluatePinningPolicy(expired, now).status)
        // Les empreintes sont fausses, et pourtant la connexion aboutit :
        // l'épinglage a bien été levé.
        call(clientWith(expired))
    }

    @Test
    fun `une politique a une seule empreinte n est pas appliquee`() {
        val single = PinningPolicy(server.hostName, listOf("A".repeat(43) + "="), future)

        assertEquals(PinningStatus.REJECTED, evaluatePinningPolicy(single, now).status)
        call(clientWith(single))
    }

    @Test
    fun `sans politique aucun epingleur n est construit`() {
        val verdict = evaluatePinningPolicy(null, now)

        assertNull(CertificatePinning.pinnerFor(verdict, server.hostName))
        call(clientWith(null))
    }

    @Test
    fun `un epingleur est bien construit quand la politique est active`() {
        val policy = PinningPolicy(server.hostName, listOf(realPin(), backupPin), future)
        val verdict = evaluatePinningPolicy(policy, now)

        assertEquals(PinningStatus.ACTIVE, verdict.status)
        assertNotNull(CertificatePinning.pinnerFor(verdict, server.hostName))
    }
}
