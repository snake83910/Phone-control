package com.phonecontrol.core.rules

import java.io.File
import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Parité cryptographique entre le téléphone et le serveur.
 *
 * Ces vecteurs sont produits par l'implémentation Node du serveur et vérifiés
 * ici par l'implémentation Kotlin. Ils garantissent qu'un badge accepté en
 * ligne le sera aussi hors ligne — c'est-à-dire que la liste d'empreintes
 * envoyée au téléphone lui est réellement exploitable.
 *
 * Sans ce test, une divergence d'encodage (base64 contre base64url, préfixe de
 * version oublié) ne se verrait qu'en clientèle, un soir de panne réseau.
 */
class BadgeHmacParityTest {

    private val json = Json { ignoreUnknownKeys = true }

    private val vectors = File(
        System.getProperty("scenarios.dir")
            ?: error("Propriété système scenarios.dir absente."),
        "badge-hash-vectors.json",
    )

    @Test
    fun `les empreintes correspondent a celles produites par le serveur`() {
        val spec = json.parseToJsonElement(vectors.readText()).jsonObject
        val version = spec["hashVersion"]!!.jsonPrimitive.content.toInt()
        val pepper = spec["pepper"]!!.jsonPrimitive.content.toByteArray(Charsets.UTF_8)
        val deviceKey = Base64.getDecoder()
            .decode(spec["deviceKeyBase64"]!!.jsonPrimitive.content)

        var checked = 0
        for (entry in spec["vectors"]!!.jsonArray) {
            val vector = entry.jsonObject
            val normalized = vector["normalized"]!!.jsonPrimitive.content

            assertEquals(
                "empreinte serveur pour $normalized",
                vector["serverHash"]!!.jsonPrimitive.content,
                BadgeHmac.deviceScopedHash(pepper, normalized, version),
            )

            assertEquals(
                "empreinte appareil pour $normalized",
                vector["deviceHash"]!!.jsonPrimitive.content,
                BadgeHmac.deviceScopedHash(deviceKey, normalized, version),
            )

            checked++
        }

        assertTrue("Aucun vecteur vérifié", checked > 0)
    }

    @Test
    fun `la derivation HKDF reproduit celle du serveur`() {
        val spec = json.parseToJsonElement(vectors.readText()).jsonObject
        val masterKey = spec["masterKey"]!!.jsonPrimitive.content.toByteArray(Charsets.UTF_8)
        val deviceId = spec["deviceId"]!!.jsonPrimitive.content
        val expected = spec["deviceKeyBase64"]!!.jsonPrimitive.content

        val derived = BadgeHmac.deriveDeviceKey(masterKey, deviceId)

        // Implémentation manuelle de HKDF côté Kotlin, `crypto.hkdfSync` côté
        // Node : c'est précisément le genre d'endroit où deux implémentations
        // divergent sans prévenir.
        assertEquals(expected, Base64.getEncoder().encodeToString(derived))
    }

    @Test
    fun `une cle differente produit une empreinte differente`() {
        val a = BadgeHmac.deriveDeviceKey("maitre".toByteArray(), "appareil-a")
        val b = BadgeHmac.deriveDeviceKey("maitre".toByteArray(), "appareil-b")

        // C'est ce qui rend inexploitable, sur un autre téléphone, une liste
        // extraite de celui-ci.
        assertTrue(
            BadgeHmac.deviceScopedHash(a, "14557719") !=
                BadgeHmac.deviceScopedHash(b, "14557719"),
        )
    }
}
