package com.phonecontrol.ui.screens

import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.phonecontrol.scanner.BarcodeAnalyzer
import java.util.concurrent.Executors

/**
 * Écrans de l'application embarquée.
 *
 * Contrainte de conception : ils sont lus par quelqu'un debout, un badge à la
 * main, parfois en plein soleil. D'où de très grands caractères, un seul bouton
 * par écran, et aucune information décorative.
 */

@Composable
fun LockScreen(
    notice: String?,
    kioskEnforced: Boolean,
    enrolled: Boolean,
    onScan: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = "🔒",
            fontSize = 56.sp,
        )

        Spacer(Modifier.height(20.dp))

        Text(
            text = "TÉLÉPHONE BLOQUÉ",
            style = MaterialTheme.typography.displaySmall,
            color = MaterialTheme.colorScheme.onBackground,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(12.dp))

        Text(
            text = "Présentez votre badge",
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(40.dp))

        Button(
            onClick = onScan,
            enabled = enrolled,
            modifier = Modifier
                .fillMaxWidth()
                .height(72.dp),
            shape = RoundedCornerShape(14.dp),
        ) {
            Text("SCANNER", fontSize = 22.sp, fontWeight = FontWeight.Bold)
        }

        if (!enrolled) {
            Spacer(Modifier.height(20.dp))
            Notice(
                text = "Téléphone non enrôlé. Il doit être provisionné avant utilisation.",
                tone = MaterialTheme.colorScheme.error,
            )
        }

        notice?.let {
            Spacer(Modifier.height(20.dp))
            Notice(text = it, tone = MaterialTheme.colorScheme.error)
        }

        if (enrolled && !kioskEnforced) {
            Spacer(Modifier.height(28.dp))
            // Honnêteté d'affichage : sans Device Owner, cet écran se referme
            // d'un appui sur « Accueil ». Le dire vaut mieux que de laisser
            // croire à une protection qui n'existe pas.
            Notice(
                text = "Mode kiosque non actif : ce téléphone n'est pas encore " +
                    "administré. Le verrouillage n'est pas garanti.",
                tone = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
fun ScannerScreen(
    busy: Boolean,
    onBarcode: (String) -> Unit,
    onCancel: () -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    val analyzer = remember { BarcodeAnalyzer(onBarcode = onBarcode) }

    DisposableEffect(Unit) {
        onDispose {
            analyzer.close()
            executor.shutdown()
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { viewContext ->
                val previewView = PreviewView(viewContext).apply {
                    scaleType = PreviewView.ScaleType.FILL_CENTER
                }

                val providerFuture = ProcessCameraProvider.getInstance(viewContext)
                providerFuture.addListener({
                    val provider = providerFuture.get()

                    val preview = Preview.Builder().build().also {
                        it.surfaceProvider = previewView.surfaceProvider
                    }

                    // Le Code 128 est LINÉAIRE : il exige une résolution
                    // suffisante et un cadrage horizontal. 1280x720 est le
                    // minimum utilisable sur un badge tenu à bout de bras.
                    val analysis = ImageAnalysis.Builder()
                        .setResolutionSelector(
                            ResolutionSelector.Builder()
                                .setResolutionStrategy(
                                    ResolutionStrategy(
                                        android.util.Size(1280, 720),
                                        ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
                                    ),
                                )
                                .build(),
                        )
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                        .also { it.setAnalyzer(executor, analyzer) }

                    runCatching {
                        provider.unbindAll()
                        provider.bindToLifecycle(
                            lifecycleOwner,
                            CameraSelector.DEFAULT_BACK_CAMERA,
                            preview,
                            analysis,
                        )
                    }
                }, ContextCompat.getMainExecutor(viewContext))

                previewView
            },
        )

        Column(
            modifier = Modifier.fillMaxSize().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = "SCANNEZ VOTRE BADGE",
                style = MaterialTheme.typography.headlineMedium,
                color = Color.White,
                modifier = Modifier.padding(top = 32.dp),
            )

            // Cadre de visée large et peu haut : c'est la forme d'un Code 128,
            // et il guide le cadrage bien mieux qu'un carré.
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(150.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(Color.White.copy(alpha = 0.08f)),
                contentAlignment = Alignment.Center,
            ) {
                if (busy) {
                    CircularProgressIndicator(color = Color.White, modifier = Modifier.size(48.dp))
                } else {
                    Text(
                        text = "CODE 128",
                        color = Color.White.copy(alpha = 0.6f),
                        fontSize = 18.sp,
                    )
                }
            }

            OutlinedButton(
                onClick = onCancel,
                modifier = Modifier.fillMaxWidth().height(56.dp).padding(bottom = 0.dp),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White),
            ) {
                Text("Annuler", fontSize = 18.sp)
            }
        }
    }
}

@Composable
fun ActiveScreen(
    driverName: String?,
    returned: Boolean,
    offlineSession: Boolean,
    alertPending: Boolean,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(text = if (returned) "🏠" else "✅", fontSize = 56.sp)

        Spacer(Modifier.height(20.dp))

        Text(
            text = if (returned) "RETOURNÉ AU DÉPÔT" else "SESSION ACTIVE",
            style = MaterialTheme.typography.displaySmall,
            color = MaterialTheme.colorScheme.onBackground,
            textAlign = TextAlign.Center,
        )

        driverName?.let {
            Spacer(Modifier.height(12.dp))
            Text(
                text = it,
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.primary,
            )
        }

        if (offlineSession) {
            Spacer(Modifier.height(24.dp))
            // Le chauffeur doit savoir que sa session sera revérifiée : elle
            // peut être révoquée au retour du réseau.
            Notice(
                text = "Session ouverte hors ligne. Elle sera vérifiée dès le " +
                    "retour du réseau.",
                tone = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        if (alertPending) {
            Spacer(Modifier.height(16.dp))
            Notice(
                text = "Une alerte a été transmise à l'exploitation.",
                tone = MaterialTheme.colorScheme.error,
            )
        }
    }
}

@Composable
private fun Notice(text: String, tone: Color) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(tone.copy(alpha = 0.12f))
            .padding(16.dp),
    ) {
        Text(text = text, color = tone, fontSize = 16.sp, textAlign = TextAlign.Center)
    }
}
