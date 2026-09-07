package com.phonecontrol.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.phonecontrol.core.rules.DeviceContext
import com.phonecontrol.core.rules.DeviceEffect
import com.phonecontrol.core.rules.DeviceEvent
import com.phonecontrol.core.rules.DeviceState
import com.phonecontrol.BuildConfig
import com.phonecontrol.data.local.SessionDao
import com.phonecontrol.data.repository.EnrollmentManager
import com.phonecontrol.kiosk.KioskController
import com.phonecontrol.location.LocationTrackingService
import com.phonecontrol.schedule.LockScheduler
import com.phonecontrol.security.SecureStore
import com.phonecontrol.session.SessionManager
import com.phonecontrol.sync.SyncWorker
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class UiState(
    val deviceState: DeviceState = DeviceState.LOCKED,
    val driverName: String? = null,
    val notice: String? = null,
    val busy: Boolean = false,
    val offlineSession: Boolean = false,
    val alertPending: Boolean = false,
    val enrolled: Boolean = false,
    /**
     * Faux tant que le privilège Device Owner n'est pas réellement accordé.
     * L'écran l'affiche : un kiosque non garanti doit se voir.
     */
    val kioskEnforced: Boolean = false,
    val enrollmentError: String? = null,
    val serverUrl: String = "",
)

@HiltViewModel
class MainViewModel @Inject constructor(
    application: Application,
    private val sessionManager: SessionManager,
    private val secureStore: SecureStore,
    private val sessions: SessionDao,
    private val kiosk: KioskController,
    private val lockScheduler: LockScheduler,
    private val enrollmentManager: EnrollmentManager,
) : AndroidViewModel(application) {

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    /** Effets à exécuter par l'activité (caméra, kiosque). */
    val effects = sessionManager.effects

    init {
        viewModelScope.launch {
            sessionManager.restore()
            lockScheduler.schedule()
        }

        viewModelScope.launch {
            sessionManager.context.collect { context -> render(context) }
        }

        viewModelScope.launch {
            sessionManager.effects.collect { effect -> handle(effect) }
        }
    }

    private suspend fun render(context: DeviceContext) {
        val session = context.session
        val stored = if (session != null) sessions.current() else null

        _state.value = UiState(
            deviceState = context.state,
            driverName = stored?.let { "${it.firstName} ${it.lastName}" },
            notice = context.notice,
            busy = context.state == DeviceState.AUTHENTICATING,
            offlineSession = session?.openedOffline == true,
            alertPending = context.alertPending,
            enrolled = secureStore.isEnrolled,
            kioskEnforced = kiosk.isDeviceOwner,
            enrollmentError = _state.value.enrollmentError,
            serverUrl = secureStore.serverUrl ?: BuildConfig.DEFAULT_SERVER_URL,
        )
    }

    /**
     * Enrôlement manuel (Phase 4). En production, il est effectué sans saisie à
     * partir du jeton transporté par le QR code de provisioning.
     */
    fun enroll(token: String, serverUrl: String) {
        if (_state.value.busy) return
        _state.value = _state.value.copy(busy = true, enrollmentError = null)

        viewModelScope.launch {
            when (val result = enrollmentManager.enroll(token, serverUrl)) {
                is EnrollmentManager.Result.Success -> {
                    _state.value = _state.value.copy(
                        busy = false,
                        enrolled = true,
                        enrollmentError = null,
                        notice = "Téléphone ${result.assetTag} enrôlé" +
                            (result.depotName?.let { " — dépôt $it" } ?: ""),
                    )
                    sessionManager.restore()
                    lockScheduler.schedule()
                }

                is EnrollmentManager.Result.Failure ->
                    _state.value = _state.value.copy(
                        busy = false,
                        enrollmentError = result.message,
                    )
            }
        }
    }

    private fun handle(effect: DeviceEffect) {
        val context = getApplication<Application>()
        when (effect) {
            is DeviceEffect.StartLocationTracking -> LocationTrackingService.start(context)
            is DeviceEffect.StopLocationTracking -> LocationTrackingService.stop(context)
            is DeviceEffect.ExitKiosk -> {
                // Une session vient de s'ouvrir : on synchronise sans attendre
                // le cycle périodique, pour que le dashboard voie le chauffeur
                // apparaître tout de suite.
                SyncWorker.syncNow(context)
                viewModelScope.launch { lockScheduler.schedule() }
            }
            is DeviceEffect.EnterKiosk -> SyncWorker.syncNow(context)
            else -> Unit
        }
    }

    fun requestScan() {
        viewModelScope.launch { sessionManager.dispatch(DeviceEvent.ScanRequested) }
    }

    fun cancelScan() {
        viewModelScope.launch { sessionManager.dispatch(DeviceEvent.ScanCancelled) }
    }

    fun onBarcode(rawValue: String, latitude: Double?, longitude: Double?) {
        if (_state.value.busy) return
        viewModelScope.launch {
            sessionManager.submitBarcode(rawValue, latitude, longitude)
        }
    }

    fun dismissNotice() {
        _state.value = _state.value.copy(notice = null)
    }
}
