package com.phonecontrol.kiosk

import com.phonecontrol.core.rules.ROOT_PACKAGES
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Parité entre la liste des gestionnaires de root et le bloc `<queries>` du
 * manifeste.
 *
 * Depuis Android 11, un paquet non déclaré est **invisible** : `getPackageInfo`
 * lève `NameNotFoundException` exactement comme s'il n'était pas installé. Un
 * gestionnaire de root ajouté à `ROOT_PACKAGES` sans l'être au manifeste ne
 * serait donc jamais détecté — et la détection continuerait à rapporter
 * « terminal sain », ce qui est pire que de ne rien rapporter.
 *
 * Rien dans le compilateur ne relie ces deux listes. Ce test est le seul lien.
 */
class ManifestQueriesTest {

    private val manifest: String by lazy {
        // Le manifeste vit hors du répertoire des sources Kotlin ; il est
        // déclaré comme entrée de la tâche de test (build.gradle.kts) pour que
        // Gradle réexécute ce test quand il change.
        File("src/main/AndroidManifest.xml").readText()
    }

    @Test
    fun `chaque gestionnaire de root est declare dans le manifeste`() {
        assertTrue("ROOT_PACKAGES est vide", ROOT_PACKAGES.isNotEmpty())

        val declares = Regex("""<package android:name="([^"]+)" />""")
            .findAll(manifest)
            .map { it.groupValues[1] }
            .toSet()

        for (pkg in ROOT_PACKAGES) {
            assertTrue(
                "$pkg est cherché par le contrôle d'intégrité mais absent du bloc <queries> : " +
                    "il ne serait jamais détecté sur Android 11 et plus.",
                pkg in declares,
            )
        }
    }

    @Test
    fun `le manifeste ne declare rien de plus que necessaire`() {
        // Un paquet déclaré sans raison élargit inutilement la visibilité, et
        // c'est exactement ce qu'un examen de DPC regarde.
        val declares = Regex("""<package android:name="([^"]+)" />""")
            .findAll(manifest)
            .map { it.groupValues[1] }
            .toList()

        assertEquals(ROOT_PACKAGES.sorted(), declares.sorted())
    }
}
