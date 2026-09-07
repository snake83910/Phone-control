package com.phonecontrol.security

import android.content.Context
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.phonecontrol.core.rules.BadgeHmac
import com.phonecontrol.core.rules.BarcodeNormalizer
import java.security.KeyStore
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Empreinte de badge calculée par une clé **résidente du Keystore**.
 *
 * `BadgeHmacParityTest`, côté JVM, prouve déjà que le format Kotlin est
 * identique à celui du serveur. Ce qu'il ne pouvait pas prouver, faute
 * d'Android : que le calcul donne le même résultat lorsque la clé n'est plus
 * un tableau d'octets mais une clé importée dans le Keystore, dont on ne peut
 * plus extraire la valeur.
 *
 * C'est le point noté comme non vérifié en docs/11 §6. Il l'est ici.
 *
 * L'enjeu est concret : c'est cette empreinte qui décide, hors ligne, si un
 * badge ouvre une session. Une différence d'un octet, et aucun chauffeur
 * n'ouvre de session en zone blanche.
 */
@RunWith(AndroidJUnit4::class)
class KeystoreHmacTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private lateinit var store: SecureStore

    /** Badge de référence du projet. */
    private val badge = "14557719"

    @Before
    fun setUp() {
        store = SecureStore(context)
        store.wipe()
    }

    private fun randomKeyBytes(): ByteArray =
        SecureStore.generateLocalKey().encoded

    @Test
    fun le_keystore_donne_la_meme_empreinte_qu_un_calcul_direct() {
        val keyBytes = randomKeyBytes()
        store.storeOfflineKey(Base64.encodeToString(keyBytes, Base64.NO_WRAP))

        val normalized = BarcodeNormalizer.normalize(badge)
        val fromKeystore = store.deviceScopedHash(normalized)

        // Calcul de référence, avec la même clé, sans passer par le Keystore.
        val mac = Mac.getInstance("HmacSHA256").apply {
            init(SecretKeySpec(keyBytes, "HmacSHA256"))
        }
        val expected = BadgeHmac.encode(
            mac.doFinal(BadgeHmac.message(normalized, BarcodeNormalizer.HASH_VERSION)),
        )

        assertNotNull("Le Keystore doit répondre", fromKeystore)
        assertEquals(expected, fromKeystore)
    }

    @Test
    fun l_empreinte_est_stable_d_un_appel_a_l_autre() {
        store.storeOfflineKey(Base64.encodeToString(randomKeyBytes(), Base64.NO_WRAP))
        val normalized = BarcodeNormalizer.normalize(badge)

        assertEquals(store.deviceScopedHash(normalized), store.deviceScopedHash(normalized))
    }

    @Test
    fun deux_appareils_ne_produisent_pas_la_meme_empreinte() {
        val normalized = BarcodeNormalizer.normalize(badge)

        store.storeOfflineKey(Base64.encodeToString(randomKeyBytes(), Base64.NO_WRAP))
        val first = store.deviceScopedHash(normalized)

        store.storeOfflineKey(Base64.encodeToString(randomKeyBytes(), Base64.NO_WRAP))
        val second = store.deviceScopedHash(normalized)

        // C'est ce qui rend inexploitable, sur un autre téléphone, une liste de
        // badges extraite de celui-ci.
        assertTrue("Deux clés doivent produire deux empreintes", first != second)
    }

    @Test
    fun la_cle_importee_n_est_pas_extractible() {
        store.storeOfflineKey(Base64.encodeToString(randomKeyBytes(), Base64.NO_WRAP))

        val keystore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val entry = keystore.getEntry("phone_control_offline_hmac", null) as KeyStore.SecretKeyEntry

        // Une clé du Keystore répond `null` à `getEncoded()` : le matériel de
        // clé ne sort pas. C'est toute la différence avec une clé rangée dans un
        // fichier, qu'un accès root suffirait à recopier.
        assertNull("Le matériel de clé ne doit pas sortir du Keystore", entry.secretKey.encoded)
    }

    @Test
    fun sans_cle_importee_aucune_empreinte_n_est_produite() {
        // Le refus doit être franc : renvoyer une empreinte calculée avec une
        // clé par défaut ferait accepter des badges au hasard.
        assertNull(store.deviceScopedHash(BarcodeNormalizer.normalize(badge)))
    }
}
