package com.phonecontrol.session

import android.util.Log
import com.phonecontrol.core.rules.BarcodeNormalizer
import com.phonecontrol.core.rules.DeviceContext
import com.phonecontrol.core.rules.DeviceEffect
import com.phonecontrol.core.rules.DeviceEvent
import com.phonecontrol.core.rules.DeviceState
import com.phonecontrol.core.rules.DeviceStateMachine
import com.phonecontrol.core.rules.LockReason
import com.phonecontrol.data.local.ConfigurationDao
import com.phonecontrol.data.local.OfflineBadgeDao
import com.phonecontrol.data.local.SessionDao
import com.phonecontrol.data.local.SessionEntity
import com.phonecontrol.data.remote.BarcodeAuthRequest
import com.phonecontrol.data.remote.PhoneControlApi
import com.phonecontrol.security.SecureStore
import com.phonecontrol.sync.EventRecorder
import java.time.Instant
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Ouverture et fermeture des sessions chauffeur.
 *
 * **Le serveur est l'autorité, le téléphone est autonome.** Ces deux
 * affirmations ne s'opposent que si l'on confond « décider » et « décider
 * provisoirement » :
 *
 *  - serveur joignable → il décide, le téléphone exécute ;
 *  - serveur injoignable → le téléphone applique une décision **bornée dans le
 *    temps**, à partir d'une liste signée par le serveur, et cette décision est
 *    **revalidée** dès le retour du réseau.
 *
 * Aucune autorisation hors ligne n'est permanente.
 */
@Singleton
class SessionManager @Inject constructor(
    private val api: PhoneControlApi,
    private val secureStore: SecureStore,
    private val sessions: SessionDao,
    private val offlineBadges: OfflineBadgeDao,
    private val configuration: ConfigurationDao,
    private val recorder: EventRecorder,
) {

    private val _context = MutableStateFlow(DeviceContext())
    val context: StateFlow<DeviceContext> = _context.asStateFlow()

    private val _effects = MutableSharedFlow<DeviceEffect>(extraBufferCapacity = 32)
    val effects = _effects.asSharedFlow()

    private val mutex = Mutex()

    /** Restaure l'état après un redémarrage : le téléphone ne repart pas de zéro. */
    suspend fun restore() = mutex.withLock {
        val stored = sessions.current()
        if (stored == null) {
            _context.value = DeviceContext(state = DeviceState.LOCKED)
            return@withLock
        }

        if (stored.expiresAt <= System.currentTimeMillis()) {
            sessions.endAll(System.currentTimeMillis(), "EXPIRED")
            _context.value = DeviceContext(state = DeviceState.LOCKED)
            return@withLock
        }

        _context.value = DeviceContext(
            state = if (stored.state == "RETURNED") DeviceState.RETURNED else DeviceState.ACTIVE,
            session = com.phonecontrol.core.rules.SessionSnapshot(
                sessionId = stored.id,
                userId = stored.userId,
                expiresAt = Instant.ofEpochMilli(stored.expiresAt),
                openedOffline = stored.openedOffline,
                returnedAt = stored.returnedAt?.let(Instant::ofEpochMilli),
            ),
        )
        emit(DeviceEffect.StartLocationTracking)
    }

    suspend fun dispatch(event: DeviceEvent) = mutex.withLock { apply(event) }

    private suspend fun apply(event: DeviceEvent) {
        val reduction = DeviceStateMachine.reduce(_context.value, event)
        _context.value = reduction.context
        reduction.effects.forEach { emit(it) }
    }

    private suspend fun emit(effect: DeviceEffect) {
        _effects.emit(effect)
    }

    // -----------------------------------------------------------------------
    //  Scan de badge
    // -----------------------------------------------------------------------

    data class ScanResult(
        val granted: Boolean,
        val message: String,
        val offline: Boolean = false,
    )

    suspend fun submitBarcode(rawValue: String, latitude: Double?, longitude: Double?): ScanResult {
        val normalized = BarcodeNormalizer.normalizeOrNull(rawValue)
        if (normalized == null) {
            val message = "Code illisible. Représentez le badge."
            dispatch(DeviceEvent.AccessDenied("INVALID_BARCODE", message))
            return ScanResult(granted = false, message = message)
        }

        dispatch(DeviceEvent.BarcodeCaptured(normalized))

        val deviceId = secureStore.deviceId
        if (deviceId == null) {
            val message = "Téléphone non enrôlé. Contactez votre responsable."
            dispatch(DeviceEvent.AccessDenied("NOT_ENROLLED", message))
            return ScanResult(granted = false, message = message)
        }

        val online = runCatching {
            api.authenticateBarcode(
                BarcodeAuthRequest(
                    barcode = normalized,
                    deviceId = deviceId,
                    scannedAt = Instant.now().toString(),
                    latitude = latitude,
                    longitude = longitude,
                ),
            )
        }.getOrNull()

        // Le serveur a répondu : sa décision fait autorité, quelle qu'elle soit.
        if (online != null && online.isSuccessful) {
            val body = online.body()
            if (body == null) {
                return denyWith("Réponse invalide du serveur.")
            }

            if (!body.success) {
                val message = body.message ?: "Accès refusé."
                dispatch(DeviceEvent.AccessDenied(body.reason ?: "DENIED", message))
                return ScanResult(granted = false, message = message)
            }

            val session = body.session!!
            val user = body.user!!
            persistSession(
                SessionEntity(
                    id = session.id,
                    userId = user.id,
                    firstName = user.firstName,
                    lastName = user.lastName,
                    startedAt = Instant.parse(session.startedAt).toEpochMilli(),
                    expiresAt = Instant.parse(session.expiresAt).toEpochMilli(),
                    state = "ACTIVE",
                    openedOffline = false,
                ),
            )
            dispatch(
                DeviceEvent.AccessGranted(
                    sessionId = session.id,
                    userId = user.id,
                    expiresAt = Instant.parse(session.expiresAt),
                    offline = false,
                ),
            )
            return ScanResult(granted = true, message = "Bonjour ${user.firstName}")
        }

        // Réseau indisponible — et seulement dans ce cas.
        Log.i(TAG, "Serveur injoignable : bascule sur l'authentification hors ligne.")
        return authenticateOffline(normalized)
    }

    private suspend fun authenticateOffline(normalized: String): ScanResult {
        val settings = configuration.settings()
        if (settings == null || !settings.offlineAuthEnabled) {
            return denyWith("Connexion requise. Rapprochez-vous d'une zone couverte.")
        }

        if (!secureStore.hasOfflineKey) {
            return denyWith("Connexion requise. Ce téléphone n'a pas de liste hors ligne.")
        }

        val cacheAge = System.currentTimeMillis() - offlineBadges.lastRefreshedAt()
        val maxAge = settings.offlineCacheMaxAgeMinutes.toLong() * 60_000
        if (offlineBadges.lastRefreshedAt() == 0L || cacheAge > maxAge) {
            // Une liste périmée n'est pas une liste : refuser est le seul
            // comportement défendable, sinon un badge révoqué la semaine
            // dernière ouvrirait encore les téléphones.
            return denyWith("Connexion requise. Les autorisations locales sont périmées.")
        }

        val hmac = secureStore.deviceScopedHash(normalized, BarcodeNormalizer.HASH_VERSION)
            ?: return denyWith("Connexion requise.")

        val badge = offlineBadges.findByHmac(hmac)
            ?: return denyWith("Accès refusé. Badge non reconnu ou non autorisé.")

        if (badge.validUntil <= System.currentTimeMillis()) {
            return denyWith("Connexion requise. Autorisation locale expirée.")
        }

        val now = System.currentTimeMillis()
        val expiresAt = now + settings.offlineAuthMaxDurationMinutes.toLong() * 60_000
        val sessionId = UUID.randomUUID().toString()

        persistSession(
            SessionEntity(
                id = sessionId,
                userId = badge.userId,
                firstName = badge.firstName,
                lastName = badge.lastName,
                startedAt = now,
                expiresAt = expiresAt,
                state = "ACTIVE",
                openedOffline = true,
            ),
        )
        recorder.recordOfflineScan(sessionId, now)

        dispatch(
            DeviceEvent.AccessGranted(
                sessionId = sessionId,
                userId = badge.userId,
                expiresAt = Instant.ofEpochMilli(expiresAt),
                offline = true,
            ),
        )

        return ScanResult(
            granted = true,
            message = "Bonjour ${badge.firstName} (hors ligne)",
            offline = true,
        )
    }

    private suspend fun denyWith(message: String): ScanResult {
        dispatch(DeviceEvent.AccessDenied("OFFLINE_DENIED", message))
        return ScanResult(granted = false, message = message)
    }

    private suspend fun persistSession(session: SessionEntity) {
        sessions.endAll(System.currentTimeMillis(), "NEW_SESSION")
        sessions.upsert(session)
    }

    // -----------------------------------------------------------------------
    //  Fermeture
    // -----------------------------------------------------------------------

    suspend fun lock(reason: LockReason) {
        val current = _context.value
        if (current.state == DeviceState.LOCKED) return

        sessions.endAll(System.currentTimeMillis(), reason.name)
        recorder.recordSecurity(
            type = "LOCK_DEVICE",
            metadata = mapOf("reason" to reason.name),
            sessionId = current.session?.sessionId,
        )
        dispatch(DeviceEvent.LockRequested(reason))
        dispatch(DeviceEvent.LockApplied)
    }

    /**
     * Applique l'état de session vu par le serveur.
     * En cas de divergence, le serveur l'emporte — c'est lui qui détient
     * l'heure de référence et la configuration à jour du dépôt.
     */
    suspend fun reconcile(serverSessionId: String?, serverState: String?, returnedAt: Long?) {
        val local = _context.value.session ?: return

        if (serverSessionId == null) {
            Log.i(TAG, "Le serveur ne connaît plus de session active : verrouillage.")
            lock(LockReason.REVOKED)
            return
        }

        if (serverSessionId != local.sessionId) {
            Log.w(TAG, "Session divergente (locale ${local.sessionId}, serveur $serverSessionId).")
            lock(LockReason.REVOKED)
            return
        }

        if (serverState != null) {
            sessions.updateState(serverSessionId, serverState, returnedAt)
            _context.value = _context.value.copy(
                state = if (serverState == "RETURNED") DeviceState.RETURNED else DeviceState.ACTIVE,
                session = local.copy(returnedAt = returnedAt?.let(Instant::ofEpochMilli)),
            )
        }
    }

    private companion object {
        const val TAG = "SessionManager"
    }
}
