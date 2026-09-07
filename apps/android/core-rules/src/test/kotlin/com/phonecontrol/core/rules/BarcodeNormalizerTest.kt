package com.phonecontrol.core.rules

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Normalisation des badges.
 *
 * Ces cas sont les mêmes que ceux de `apps/api/src/crypto/badge-hash.spec.ts`.
 * Ils ne protègent pas seulement d'une régression : ils documentent un contrat
 * irréversible, puisque le hachage qui en découle ne l'est pas.
 */
class BarcodeNormalizerTest {

    @Test
    fun `accepte le format cible - huit chiffres`() {
        assertEquals("14557719", BarcodeNormalizer.normalize("14557719"))
    }

    @Test
    fun `tolere les variations de lecture des scanners`() {
        val variants = listOf(
            " 14557719 ",
            "14557719\r\n",
            "1455-7719",
            "14 55 77 19",
            "1455.7719",
        )
        for (variant in variants) {
            assertEquals(
                "variante « $variant »",
                "14557719",
                BarcodeNormalizer.normalize(variant),
            )
        }
    }

    @Test
    fun `passe en majuscules les valeurs alphanumeriques`() {
        assertEquals("AB12CD34", BarcodeNormalizer.normalize("ab12cd34"))
    }

    @Test
    fun `conserve les zeros de tete`() {
        // Point critique : les traiter comme identiques ouvrirait l'accès au
        // badge d'un autre chauffeur.
        assertEquals("01455771", BarcodeNormalizer.normalize("01455771"))
        assertNotEquals(
            BarcodeNormalizer.normalize("01455771"),
            BarcodeNormalizer.normalize("1455771"),
        )
    }

    @Test
    fun `refuse une valeur trop courte ou trop longue`() {
        assertThrows(BarcodeNormalizer.InvalidBarcodeException::class.java) {
            BarcodeNormalizer.normalize("123")
        }
        assertThrows(BarcodeNormalizer.InvalidBarcodeException::class.java) {
            BarcodeNormalizer.normalize("1".repeat(33))
        }
    }

    @Test
    fun `refuse une valeur vide apres nettoyage`() {
        assertThrows(BarcodeNormalizer.InvalidBarcodeException::class.java) {
            BarcodeNormalizer.normalize("---")
        }
        // Dans le flux du scanner, un rejet est banal : pas d'exception.
        assertNull(BarcodeNormalizer.normalizeOrNull("---"))
    }

    @Test
    fun `le masque ne laisse apparaitre que les quatre derniers caracteres`() {
        assertEquals("****7719", BarcodeNormalizer.mask("14557719"))
        assertEquals("******6789", BarcodeNormalizer.mask("0123456789"))
        assertEquals("7719", BarcodeNormalizer.mask("7719"))
    }
}
