package com.phonecontrol.core.rules

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Politique d'applications.
 *
 * Les cas vivent dans `packages/state-machine-spec/scenarios/app-policy.json`,
 * pour que la liste des paquets qu'on refuse de masquer se relise comme une
 * donnée plutôt que de se déduire d'un `when`. Cette liste est la seule chose
 * qui empêche une configuration maladroite de rendre un téléphone inutilisable
 * à distance : elle mérite d'être lisible par quelqu'un qui n'écrit pas de
 * Kotlin.
 */
class AppPolicyRulesTest {

    private val json = Json { ignoreUnknownKeys = true }

    private val spec by lazy {
        val dir = File(
            System.getProperty("scenarios.dir")
                ?: error("Propriété système scenarios.dir absente."),
        )
        json.parseToJsonElement(File(dir, "app-policy.json").readText()).jsonObject
    }

    @Test
    fun `plan conforme aux scenarios`() {
        val ownPackage = spec["ownPackage"]!!.jsonPrimitive.content
        var executed = 0

        for (entry in spec["scenarios"]!!.jsonArray) {
            val scenario = entry.jsonObject
            val name = scenario["name"]!!.jsonPrimitive.content
            val policy = scenario["policy"]!!.jsonObject

            val plan = planAppPolicy(
                policy = AppPolicy(
                    allowedApps = policy["allowedApps"]!!.jsonArray.map { it.jsonPrimitive.content },
                    blockedApps = policy["blockedApps"]!!.jsonArray.map { it.jsonPrimitive.content },
                ),
                installedPackages = scenario["installed"]!!.jsonArray
                    .map { it.jsonPrimitive.content }
                    .toSet(),
                ownPackage = ownPackage,
                currentlyHidden = scenario["hidden"]!!.jsonArray
                    .map { it.jsonPrimitive.content }
                    .toSet(),
            )

            val expected = scenario["expect"]!!.jsonObject

            assertEquals(
                "$name : à masquer",
                expected["toHide"]!!.jsonArray.map { it.jsonPrimitive.content },
                plan.toHide,
            )
            assertEquals(
                "$name : à démasquer",
                expected["toReveal"]!!.jsonArray.map { it.jsonPrimitive.content },
                plan.toReveal,
            )
            assertEquals(
                "$name : allowlist kiosque",
                expected["lockTaskPackages"]!!.jsonArray.map { it.jsonPrimitive.content },
                plan.lockTaskPackages,
            )
            assertEquals(
                "$name : refus",
                expected["refusals"]!!.jsonArray.map {
                    AppRefusal(
                        packageName = it.jsonObject["packageName"]!!.jsonPrimitive.content,
                        reason = AppRefusalReason.valueOf(
                            it.jsonObject["reason"]!!.jsonPrimitive.content,
                        ),
                    )
                },
                plan.refusals,
            )

            executed++
        }

        assertTrue("Aucun scénario exécuté : le fichier est-il bien lu ?", executed >= 15)
    }

    /**
     * Le serveur porte la même liste, pour refuser la saisie avant qu'elle
     * n'atteigne la flotte. Une divergence entre les deux produirait le pire des
     * cas : un tableau de bord qui affiche un blocage accepté, et des téléphones
     * qui le refusent en silence.
     *
     * Le fichier partagé arbitre. Les deux côtés s'y comparent — ici, et dans
     * `apps/api/src/settings/app-policy.spec.ts`.
     */
    @Test
    fun `la liste protegee est celle du fichier partage`() {
        val partagee = spec["protectedPackages"]!!.jsonArray.map { it.jsonPrimitive.content }

        assertEquals(
            "Liste protégée divergente entre le fichier partagé et le Kotlin",
            partagee.toSet(),
            PROTECTED_PACKAGES,
        )
    }

    /**
     * La liste doit rester **non contournable** : un appelant peut y ajouter des
     * paquets, il ne doit pas pouvoir la vider. Ces quelques paquets sont ceux
     * dont le masquage rend un téléphone irrécupérable à distance.
     */
    @Test
    fun `la liste protegee couvre ce qui tient le telephone debout`() {
        val indispensables = listOf(
            "android",
            "com.android.systemui",
            "com.android.phone",
            "com.google.android.gms",
            "com.android.packageinstaller",
        )

        for (pkg in indispensables) {
            assertTrue("$pkg devrait être protégé", pkg in PROTECTED_PACKAGES)
        }
    }

    @Test
    fun `un appelant peut durcir la liste protegee`() {
        // Cas réel : un client dont l'exploitation dépend d'une application
        // métier tierce veut la mettre hors de portée d'une fausse manœuvre.
        val plan = planAppPolicy(
            policy = AppPolicy(blockedApps = listOf("fr.transporteur.tournees")),
            installedPackages = setOf("com.phonecontrol", "fr.transporteur.tournees"),
            ownPackage = "com.phonecontrol",
            protectedPackages = PROTECTED_PACKAGES + "fr.transporteur.tournees",
        )

        assertTrue(plan.toHide.isEmpty())
        assertEquals(
            listOf(AppRefusal("fr.transporteur.tournees", AppRefusalReason.PROTECTED)),
            plan.refusals,
        )
    }

    /**
     * Appliquer deux fois la même politique ne doit rien produire la seconde
     * fois. Sans cette propriété, chaque synchronisation re-masquerait ce qui
     * l'est déjà — bruit inutile dans les journaux, et surtout impossibilité de
     * distinguer « la politique a changé » de « la politique est stable ».
     */
    @Test
    fun `le plan est idempotent`() {
        val policy = AppPolicy(blockedApps = listOf("com.jeu.exemple"))
        val installed = setOf("com.phonecontrol", "com.jeu.exemple")

        val premier = planAppPolicy(policy, installed, "com.phonecontrol")
        assertFalse(premier.isNoop)

        val second = planAppPolicy(
            policy,
            installed,
            "com.phonecontrol",
            currentlyHidden = premier.toHide.toSet(),
        )
        assertTrue("Le second passage devrait être sans effet", second.isNoop)
    }

    /**
     * Un refus doit rester réversible : c'est ce qui distingue un blocage
     * administrable d'un téléphone à rapporter en atelier.
     */
    @Test
    fun `vider la liste demasque tout ce qui etait masque`() {
        val plan = planAppPolicy(
            policy = AppPolicy(),
            installedPackages = setOf("com.phonecontrol", "a.b", "c.d"),
            ownPackage = "com.phonecontrol",
            currentlyHidden = setOf("a.b", "c.d"),
        )

        assertEquals(listOf("a.b", "c.d"), plan.toReveal)
        assertTrue(plan.toHide.isEmpty())
    }
}
