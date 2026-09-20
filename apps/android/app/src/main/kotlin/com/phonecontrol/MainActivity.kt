package com.phonecontrol

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.view.Window
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import com.phonecontrol.core.rules.AppScreen
import com.phonecontrol.core.rules.DeviceEffect
import com.phonecontrol.core.rules.DeviceState
import com.phonecontrol.core.rules.shouldMaskScreen
import com.phonecontrol.kiosk.KioskController
import com.phonecontrol.kiosk.PermissionGranter
import com.phonecontrol.screenshare.ScreenCaptureService
import com.phonecontrol.ui.MainViewModel
import com.phonecontrol.ui.ScreenShareViewModel
import com.phonecontrol.ui.screens.ActiveScreen
import com.phonecontrol.ui.screens.EnrollmentScreen
import com.phonecontrol.ui.screens.LockScreen
import com.phonecontrol.ui.screens.ScannerScreen
import com.phonecontrol.ui.screens.ScreenShareBanner
import com.phonecontrol.ui.screens.ScreenShareRequestScreen
import com.phonecontrol.ui.theme.PhoneControlTheme
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject
import kotlinx.coroutines.flow.collectLatest

/**
 * Activité unique.
 *
 * Elle est déclarée comme écran d'accueil dans le manifeste, mais **cela ne
 * suffit pas** : tant que le Device Owner n'a pas été attribué (Phase 5), un
 * appui sur « Accueil » propose le choix du lanceur et le kiosque est
 * contournable. L'écran de verrouillage l'affiche explicitement plutôt que de
 * laisser croire à une protection acquise.
 */
@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject lateinit var kiosk: KioskController

    @Inject lateinit var permissions: PermissionGranter

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Écran maintenu allumé : le téléphone verrouillé sert d'affichage
        // permanent dans la cabine. La luminosité, elle, reste gérée par le
        // système.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Masquage par défaut, dès la première image affichée.
        //
        // Le contenu de l'écran n'apparaît ni dans les captures, ni dans la
        // vignette du sélecteur d'applications. C'est l'écran de scan qui le
        // justifie : un badge photographié se rejoue.
        //
        // Ce drapeau est ensuite RECALCULÉ à chaque changement d'état, par
        // `shouldMaskScreen` — fonction pure et testée. Il se lève pendant un
        // partage d'écran accepté, et jamais sur l'écran de scan. Le calculer
        // en un seul endroit est ce qui évite l'oubli au retrait, qui ne se
        // verrait pas à l'œil nu.
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)

        // Avant tout le reste, et à CHAQUE démarrage.
        //
        // À chaque démarrage parce que l'opération est idempotente et
        // silencieuse, et parce que la placer au seul enrôlement laisserait
        // sans rien les téléphones déjà en service — dont celui sur lequel
        // cette panne a été trouvée.
        //
        // Avant tout le reste parce que sans la localisation, le suivi de
        // position ne peut pas entrer au premier plan sur Android 14+, et le
        // système tue l'application entière quelques secondes après
        // l'ouverture de session.
        // Retire un réglage posé par une version précédente. Le bouton
        // Accueil est désormais neutralisé pendant le verrouillage seulement,
        // par l'absence de LOCK_TASK_FEATURE_HOME — donc hors verrouillage le
        // téléphone doit redevenir un téléphone.
        kiosk.libererLanceur()

        val refusees = permissions.accorderLeNecessaire()
        if (refusees.isNotEmpty()) {
            // Signalé, jamais masqué : une application qui se croit autorisée
            // et ne l'est pas est pire qu'une application qui l'annonce.
            android.util.Log.e(
                "MainActivity",
                "Permissions refusées par le système : ${refusees.joinToString()}",
            )
        }

        setContent {
            PhoneControlTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    AppRoot(
                        onEnterKiosk = { kiosk.enterKiosk(this) },
                        onExitKiosk = { kiosk.exitKiosk(this) },
                        onMaskChanged = { mask -> applyScreenMask(window, mask) },
                    )
                }
            }
        }
    }

    /**
     * Applique ou lève le masquage aux captures.
     *
     * Un seul appelant, une seule décision : celle de `shouldMaskScreen`. Toute
     * autre écriture de ce drapeau ailleurs dans l'application ferait
     * réapparaître exactement le risque que la fonction pure existe pour
     * écarter.
     */
    private fun applyScreenMask(window: Window, mask: Boolean) {
        if (mask) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
    }

    /**
     * Sans Device Owner, `onBackPressed` est le moyen le plus simple de sortir
     * de l'écran verrouillé. On le neutralise : c'est un garde-fou, pas une
     * sécurité — la vraie protection est le Lock Task de la Phase 5.
     */
    @Deprecated("Neutralisé volontairement", ReplaceWith(""))
    @Suppress("DEPRECATION", "MissingSuperCall")
    override fun onBackPressed() {
        // Aucun appel à super : l'écran de verrouillage ne se referme pas.
    }
}

@Composable
private fun AppRoot(
    onEnterKiosk: () -> Boolean,
    onExitKiosk: () -> Unit,
    onMaskChanged: (Boolean) -> Unit,
) {
    val viewModel: MainViewModel = hiltViewModel()
    val screenShareViewModel: ScreenShareViewModel = hiltViewModel()
    val state by viewModel.state.collectAsState()
    val share by screenShareViewModel.state.collectAsState()
    val shareBusy by screenShareViewModel.busy.collectAsState()
    val context = LocalContext.current

    var cameraGranted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> cameraGranted = granted }

    // Le Device Owner accorde les permissions silencieusement au provisioning.
    // Cette demande n'existe que pour le développement, avant la Phase 5.
    LaunchedEffect(Unit) {
        if (!cameraGranted) permissionLauncher.launch(Manifest.permission.CAMERA)
    }

    LaunchedEffect(Unit) {
        viewModel.effects.collectLatest { effect ->
            when (effect) {
                is DeviceEffect.EnterKiosk -> onEnterKiosk()
                is DeviceEffect.ExitKiosk -> onExitKiosk()
                else -> Unit
            }
        }
    }

    // Une demande de partage peut avoir été émise pendant que le téléphone était
    // hors réseau : la commande expire, la demande, elle, peut encore attendre.
    LaunchedEffect(Unit) { screenShareViewModel.refresh() }

    // Boîte de dialogue système d'Android. Elle s'ajoute à notre écran de
    // demande, elle ne le remplace pas : la nôtre dit qui demande et pourquoi,
    // celle d'Android dit ce qui va être capturé. On ne cherche pas à la
    // supprimer — c'est elle qui rend la capture visible du chauffeur.
    val projectionLauncher = rememberLauncherForActivityResult(
        StartActivityForResult(),
    ) { result ->
        val data = result.data
        if (result.resultCode == Activity.RESULT_OK && data != null) {
            ScreenCaptureService.start(context, result.resultCode, data)
        } else {
            screenShareViewModel.systemConsentDeclined()
        }
    }

    val currentScreen = when {
        !state.enrolled -> AppScreen.ENROLLMENT
        state.deviceState == DeviceState.SCANNING ||
            state.deviceState == DeviceState.AUTHENTICATING -> AppScreen.SCANNER
        state.deviceState == DeviceState.ACTIVE ||
            state.deviceState == DeviceState.RETURNED -> AppScreen.ACTIVE
        else -> AppScreen.LOCK
    }

    // Le masquage aux captures se recalcule à chaque changement d'écran comme à
    // chaque changement d'état du partage. La décision vit dans une fonction
    // pure et testée ; il n'y a ici qu'une application.
    LaunchedEffect(currentScreen, share.sharing) {
        onMaskChanged(shouldMaskScreen(currentScreen, share.sharing))
    }

    /**
     * Le kiosque suit l'ÉTAT, pas l'événement.
     *
     * ── Pourquoi le déclencher sur un effet ne pouvait pas marcher ────────
     * `startLockTask()` n'a d'effet que sur une activité au premier plan.
     * L'ordre de verrouillage arrive par notification pendant que le chauffeur
     * est dans une autre application — c'est même le seul moment où il sert.
     * Notre activité est alors en arrière-plan, l'appel ne prend pas, et
     * `mLockTaskModeState` reste à `NONE`. Mesuré sur le téléphone.
     *
     * Un effet est de surcroît consommé une seule fois : après une
     * recomposition ou une recréation d'activité, plus rien ne le rejoue, et
     * le kiosque resterait ouvert sans que personne ne s'en aperçoive.
     *
     * Dérivé de l'écran courant, il se réimpose à chaque retour au premier
     * plan, et l'opération est idempotente.
     */
    LaunchedEffect(currentScreen) {
        if (currentScreen == AppScreen.LOCK) onEnterKiosk() else onExitKiosk()
    }

    // La question passe avant tout le reste, y compris l'écran de verrouillage :
    // elle est brève, elle attend une réponse, et elle expire seule.
    if (share.awaitingDecision) {
        ScreenShareRequestScreen(
            reason = share.reason,
            requestedBy = share.requestedBy,
            busy = shareBusy,
            onAccept = {
                screenShareViewModel.accept {
                    val manager = context.getSystemService(MediaProjectionManager::class.java)
                    projectionLauncher.launch(manager.createScreenCaptureIntent())
                }
            },
            onRefuse = screenShareViewModel::refuse,
        )
        return
    }

    Column(modifier = Modifier.fillMaxSize()) {
        // Bandeau permanent pendant un partage, en plus de la notification et de
        // l'indicateur système : visible sans dérouler quoi que ce soit, et
        // l'arrêt à portée de pouce.
        if (share.sharing) {
            ScreenShareBanner(
                requestedBy = share.requestedBy,
                onStop = {
                    ScreenCaptureService.stop(context)
                    screenShareViewModel.stop()
                },
            )
        }

        Column(modifier = Modifier.weight(1f)) {
            // Tant que le téléphone n'est rattaché à aucune entreprise, il n'y a
            // rien à verrouiller ni personne à identifier : la mise en service
            // passe d'abord.
            if (!state.enrolled) {
                EnrollmentScreen(
                    defaultServerUrl = state.serverUrl,
                    busy = state.busy,
                    error = state.enrollmentError,
                    onEnroll = viewModel::enroll,
                )
                return@Column
            }

            when (state.deviceState) {
                DeviceState.SCANNING, DeviceState.AUTHENTICATING ->
                    ScannerScreen(
                        busy = state.busy,
                        onBarcode = { value -> viewModel.onBarcode(value, null, null) },
                        onCancel = viewModel::cancelScan,
                    )

                DeviceState.ACTIVE, DeviceState.RETURNED ->
                    ActiveScreen(
                        driverName = state.driverName,
                        returned = state.deviceState == DeviceState.RETURNED,
                        offlineSession = state.offlineSession,
                        alertPending = state.alertPending,
                    )

                DeviceState.LOCKED, DeviceState.LOCKING ->
                    LockScreen(
                        notice = state.notice,
                        kioskEnforced = state.kioskEnforced,
                        enrolled = state.enrolled,
                        onScan = viewModel::requestScan,
                    )
            }
        }
    }
}
