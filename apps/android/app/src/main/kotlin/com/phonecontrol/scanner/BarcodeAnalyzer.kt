package com.phonecontrol.scanner

import android.annotation.SuppressLint
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.phonecontrol.core.rules.BarcodeNormalizer

/**
 * Lecture du Code 128 sur le badge existant.
 *
 * Trois choix qui comptent en usage réel :
 *
 *  1. **Un seul format déclaré** (`FORMAT_CODE_128`). ML Kit ne cherche alors
 *     rien d'autre : c'est plus rapide, et surtout cela évite qu'un QR code
 *     traînant sur un colis soit lu à la place du badge.
 *  2. **Anti-doublon temporel.** Le flux caméra produit trente images par
 *     seconde ; sans garde, un seul badge déclencherait trente authentifications.
 *  3. **Normalisation immédiate.** La valeur est nettoyée ici, avec la même
 *     règle que le serveur, avant même de quitter l'analyseur.
 *
 * Le Code 128 est un code LINÉAIRE : il tolère mal l'inclinaison et le flou.
 * D'où l'autofocus continu et la résolution imposée côté configuration caméra.
 */
class BarcodeAnalyzer(
    private val onBarcode: (String) -> Unit,
    private val onNoCode: () -> Unit = {},
) : ImageAnalysis.Analyzer {

    private val scanner: BarcodeScanner = BarcodeScanning.getClient(
        BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_CODE_128)
            .build(),
    )

    private var lastValue: String? = null
    private var lastAcceptedAt: Long = 0

    @SuppressLint("UnsafeOptInUsageError")
    override fun analyze(image: ImageProxy) {
        val mediaImage = image.image
        if (mediaImage == null) {
            image.close()
            return
        }

        val input = InputImage.fromMediaImage(mediaImage, image.imageInfo.rotationDegrees)

        scanner.process(input)
            .addOnSuccessListener { barcodes ->
                val raw = barcodes.firstNotNullOfOrNull { it.rawValue }
                if (raw == null) {
                    onNoCode()
                    return@addOnSuccessListener
                }

                val normalized = BarcodeNormalizer.normalizeOrNull(raw)
                if (normalized == null) {
                    // Code lu mais inexploitable : on ne le transmet pas, et on
                    // ne le mémorise pas non plus — le chauffeur doit pouvoir
                    // réessayer immédiatement.
                    onNoCode()
                    return@addOnSuccessListener
                }

                if (shouldAccept(normalized)) {
                    onBarcode(normalized)
                }
            }
            .addOnCompleteListener { image.close() }
    }

    private fun shouldAccept(value: String): Boolean {
        val now = System.currentTimeMillis()
        val isRepeat = value == lastValue && now - lastAcceptedAt < DEBOUNCE_MS
        if (isRepeat) return false

        lastValue = value
        lastAcceptedAt = now
        return true
    }

    /** À appeler quand l'écran de scan disparaît : libère le détecteur. */
    fun close() {
        scanner.close()
    }

    private companion object {
        /**
         * Deux secondes : assez pour couvrir la durée d'un aller-retour réseau,
         * assez court pour qu'un second chauffeur puisse enchaîner.
         */
        const val DEBOUNCE_MS = 2_000L
    }
}
