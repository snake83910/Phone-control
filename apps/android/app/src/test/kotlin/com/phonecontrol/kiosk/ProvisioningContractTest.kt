package com.phonecontrol.kiosk

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Parité du contrat de provisioning.
 *
 * Le QR code de mise en service est **fabriqué** par l'outil d'atelier
 * (`tools/provisioning`, en TypeScript) et **consommé** ici, par
 * [PhoneControlDeviceAdminReceiver]. Les deux côtés se mettent d'accord sur les
 * noms des clés du bundle d'extras, et rien dans le compilateur ne les y oblige.
 *
 * C'est exactement le genre de divergence qui ne se voit pas : renommer
 * `enrollmentToken` d'un seul côté laisserait le provisioning se dérouler
 * normalement, jusqu'à ce que le téléphone se retrouve Device Owner, connecté,
 * et **jamais enrôlé** — sans message d'erreur, sur tout un parc.
 *
 * Ce test lit le fichier de contrat partagé et compare. Il est au module Android
 * ce que `SharedScenariosTest` est au moteur de règles.
 */
class ProvisioningContractTest {

    private val contract: File by lazy {
        val path = System.getProperty("provisioning.contract")
            ?: error(
                "La propriété provisioning.contract n'est pas définie : " +
                    "voir testOptions dans app/build.gradle.kts.",
            )
        File(path).also {
            assertTrue("Contrat de provisioning introuvable : $path", it.isFile)
        }
    }

    private val root by lazy { Json.parseToJsonElement(contract.readText()).jsonObject }

    private val keys by lazy { root["keys"]!!.jsonObject }

    /**
     * Lit la description d'une clé, en disant clairement ce qui manque.
     *
     * Un `!!` produirait ici une NullPointerException nue : le lecteur ne
     * saurait pas que le contrat et le code ne parlent plus de la même clé.
     */
    private fun spec(key: String) = keys[key]?.jsonObject
        ?: error(
            "Le contrat ne déclare pas la clé « $key », attendue par " +
                "PhoneControlDeviceAdminReceiver. Clés déclarées : ${keys.keys}. " +
                "L'un des deux côtés a été renommé sans l'autre.",
        )

    @Test
    fun `les cles du bundle sont exactement celles du contrat`() {
        assertEquals(
            setOf(
                PhoneControlDeviceAdminReceiver.EXTRA_ENROLLMENT_TOKEN,
                PhoneControlDeviceAdminReceiver.EXTRA_SERVER_URL,
            ),
            keys.keys,
        )
    }

    @Test
    fun `le jeton d enrolement est declare obligatoire`() {
        val token = spec(PhoneControlDeviceAdminReceiver.EXTRA_ENROLLMENT_TOKEN)
        assertEquals(true, token["required"]!!.jsonPrimitive.content.toBoolean())
    }

    @Test
    fun `le format du jeton decrit dans le contrat correspond a celui emis par l API`() {
        val pattern = spec(PhoneControlDeviceAdminReceiver.EXTRA_ENROLLMENT_TOKEN)["pattern"]!!
            .jsonPrimitive.content

        // Format produit par TokenService.generateEnrollmentToken() côté serveur :
        // préfixe ETK-, puis deux groupes de huit caractères sans O, I, 0 ni 1.
        assertTrue(Regex(pattern).matches("ETK-ABCD2345-EFGH6789"))
        assertTrue(!Regex(pattern).matches("ETK-ABCD2345"))
        assertTrue(!Regex(pattern).matches("ABCD2345-EFGH6789"))
    }

    @Test
    fun `la cle du bundle est celle definie par Android`() {
        assertEquals(
            "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE",
            root["bundleExtraKey"]!!.jsonPrimitive.content,
        )
    }
}
