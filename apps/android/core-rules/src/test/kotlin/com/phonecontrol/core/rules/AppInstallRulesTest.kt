package com.phonecontrol.core.rules

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Décision d'installation d'un APK.
 *
 * Les cas vivent dans `packages/state-machine-spec/scenarios/app-install.json`,
 * pour que la liste de ce qu'on refuse se relise comme une donnée. C'est la
 * seule barrière entre une commande de déploiement et l'exécution de code
 * arbitraire sur deux mille téléphones : elle mérite d'être lisible par
 * quelqu'un qui n'écrit pas de Kotlin.
 */
class AppInstallRulesTest {

    private val json = Json { ignoreUnknownKeys = true }

    private val spec by lazy {
        val dir = File(
            System.getProperty("scenarios.dir")
                ?: error("Propriété système scenarios.dir absente."),
        )
        json.parseToJsonElement(File(dir, "app-install.json").readText()).jsonObject
    }

    @Test
    fun `decisions conformes aux scenarios`() {
        val defaults = spec["expected"]!!.jsonObject
        var executed = 0

        for (entry in spec["scenarios"]!!.jsonArray) {
            val scenario = entry.jsonObject
            val name = scenario["name"]!!.jsonPrimitive.content
            val observedJson = scenario["observed"]!!.jsonObject

            val expected = ExpectedApk(
                packageId = "01a00000-0000-7000-8000-000000000000",
                sha256 = defaults["sha256"]!!.jsonPrimitive.content,
                signingCertSha256 = defaults["signingCertSha256"]!!.jsonPrimitive.content,
                packageName = scenario["expectedPackageName"]?.jsonPrimitive?.content,
            )

            val observed = ObservedApk(
                sha256 = observedJson["sha256"]!!.jsonPrimitive.content,
                signingCertSha256 = observedJson["signingCertSha256"]!!.jsonPrimitive.content,
                packageName = observedJson["packageName"]!!.jsonPrimitive.content,
                versionCode = observedJson["versionCode"]!!.jsonPrimitive.long,
            )

            val installedJson = scenario["installed"]
            val installed = if (installedJson == null || installedJson is JsonNull) {
                null
            } else {
                InstalledApp(
                    packageName = installedJson.jsonObject["packageName"]!!.jsonPrimitive.content,
                    versionCode = installedJson.jsonObject["versionCode"]!!.jsonPrimitive.long,
                    signingCertSha256 = installedJson.jsonObject["signingCertSha256"]!!
                        .jsonPrimitive.content,
                )
            }

            when (val decision = decideInstall(expected, observed, installed)) {
                is InstallDecision.Install ->
                    assertEquals("$name : décision", "INSTALL", scenario["decision"]!!.jsonPrimitive.content)

                is InstallDecision.Refuse -> {
                    assertEquals(
                        "$name : décision",
                        "REFUSE",
                        scenario["decision"]!!.jsonPrimitive.content,
                    )
                    assertEquals(
                        "$name : motif",
                        InstallRefusal.valueOf(scenario["reason"]!!.jsonPrimitive.content),
                        decision.reason,
                    )
                    assertEquals(
                        "$name : anomalie ?",
                        scenario["anomaly"]!!.jsonPrimitive.boolean,
                        isAnomaly(decision.reason),
                    )
                }
            }

            executed++
        }

        assertTrue("Aucun scénario exécuté : le fichier est-il bien lu ?", executed >= 12)
    }

    /**
     * Un fichier dont l'empreinte ne correspond pas ne doit **jamais** être
     * installé, quelles que soient les autres conditions. Énoncé ici de façon
     * exhaustive plutôt que par l'exemple : c'est l'invariant qui porte tout le
     * reste.
     */
    @Test
    fun `une empreinte fausse est toujours refusee`() {
        val expected = ExpectedApk(
            packageId = "p",
            sha256 = "attendu",
            signingCertSha256 = "cert",
        )

        for (versionCode in listOf(0L, 1L, 999L)) {
            for (installed in listOf(
                null,
                InstalledApp("com.exemple", 1, "cert"),
                InstalledApp("com.exemple", 999, "autre"),
            )) {
                val decision = decideInstall(
                    expected,
                    ObservedApk("different", "cert", "com.exemple", versionCode),
                    installed,
                )
                assertEquals(
                    InstallDecision.Refuse(InstallRefusal.CHECKSUM_MISMATCH),
                    decision,
                )
            }
        }
    }

    /**
     * Le rejeu d'une commande déjà exécutée est le fonctionnement normal du
     * système. Le remonter comme un incident noierait les vrais problèmes.
     */
    @Test
    fun `un rejeu sur un telephone a jour n est pas une anomalie`() {
        assertFalse(isAnomaly(InstallRefusal.ALREADY_UP_TO_DATE))
        for (reason in InstallRefusal.entries - InstallRefusal.ALREADY_UP_TO_DATE) {
            assertTrue("$reason devrait être signalé", isAnomaly(reason))
        }
    }
}
