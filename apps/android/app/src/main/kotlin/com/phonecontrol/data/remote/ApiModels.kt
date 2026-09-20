package com.phonecontrol.data.remote

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Contrat d'échange avec l'API.
 *
 * Ces classes reproduisent exactement les DTO du serveur
 * (`apps/api/src/**/dto`). Elles sont volontairement séparées des entités Room :
 * confondre le format de transport et le format de stockage, c'est s'interdire
 * de faire évoluer l'un sans casser l'autre.
 */

// --- Enrôlement -------------------------------------------------------------

@Serializable
data class EnrollRequest(
    val enrollmentToken: String,
    val serialNumber: String? = null,
    val imei: String? = null,
    val manufacturer: String? = null,
    val model: String? = null,
    val androidVersion: String? = null,
    val appVersion: String? = null,
    val publicKey: String? = null,
    /**
     * Déclaratif, et le serveur le traite comme tel : tant que l'application
     * n'est pas réellement Device Owner, elle le dit plutôt que de le supposer.
     */
    val deviceOwnerActive: Boolean,
)

@Serializable
data class EnrollResponse(
    val deviceId: String,
    val assetTag: String,
    val accessToken: String,
    val refreshToken: String,
    val expiresIn: Int,
    /** Clé HMAC propre à cet appareil, à ranger dans le Keystore. */
    val offlineKey: String,
    val settings: SettingsDto? = null,
    val depot: DepotDto? = null,
)

// --- Jetons -----------------------------------------------------------------

@Serializable
data class RefreshRequest(val refreshToken: String)

@Serializable
data class TokenResponse(
    val accessToken: String,
    val refreshToken: String,
    val expiresIn: Int,
)

// --- Authentification par badge ---------------------------------------------

@Serializable
data class BarcodeAuthRequest(
    val barcode: String,
    val deviceId: String,
    val scannedAt: String? = null,
    val latitude: Double? = null,
    val longitude: Double? = null,
)

@Serializable
data class BarcodeUserDto(
    val id: String,
    val firstName: String,
    val lastName: String,
)

@Serializable
data class BarcodeSessionDto(
    val id: String,
    val startedAt: String,
    val expiresAt: String,
)

@Serializable
data class BarcodeAuthResponse(
    val success: Boolean,
    val user: BarcodeUserDto? = null,
    val session: BarcodeSessionDto? = null,
    val reason: String? = null,
    val message: String? = null,
    val retryAfterSeconds: Int? = null,
)

// --- Heartbeat --------------------------------------------------------------

@Serializable
data class HeartbeatRequest(
    val deviceId: String,
    val battery: Int? = null,
    val charging: Boolean? = null,
    val network: String? = null,
    val gps: Boolean? = null,
    val appVersion: String? = null,
    val androidVersion: String? = null,
    val storageFreeMb: Int? = null,
    val deviceOwnerActive: Boolean? = null,
    /**
     * Jeton de réveil FCM. Envoyé à CHAQUE heartbeat, sans se demander s'il a
     * bougé : Android le renouvelle tout seul, et un jeton périmé côté serveur
     * est un téléphone qu'on croit joignable et qui ne l'est pas.
     */
    val fcmToken: String? = null,
)

@Serializable
data class HeartbeatResponse(
    val ok: Boolean,
    /** Référence d'horloge : sert à dater les événements et à détecter une dérive. */
    val serverTime: String,
)

// --- Synchronisation --------------------------------------------------------

@Serializable
data class SyncEventDto(
    val eventId: String,
    val seq: Long,
    val kind: String,
    val occurredAt: String,
    val latitude: Double? = null,
    val longitude: Double? = null,
    val accuracyMeters: Double? = null,
    val altitude: Double? = null,
    val speedMps: Double? = null,
    val bearing: Double? = null,
    val provider: String? = null,
    val isMock: Boolean? = null,
    val batteryLevel: Int? = null,
    val insideGeofence: Boolean? = null,
    val geofenceEventType: String? = null,
    val depotId: String? = null,
    val confidence: Double? = null,
    val evaluation: JsonElement? = null,
    val securityType: String? = null,
    val severity: String? = null,
    val metadata: JsonElement? = null,
    val sessionId: String? = null,
)

@Serializable
data class SyncEventsRequest(
    val deviceId: String,
    val events: List<SyncEventDto>,
)

@Serializable
data class RejectedEventDto(val eventId: String, val reason: String)

@Serializable
data class SyncEventsResponse(
    /** Seuls ces événements peuvent être purgés localement. */
    val ackedEventIds: List<String>,
    val rejected: List<RejectedEventDto> = emptyList(),
    val serverTime: String,
    val nextBackoffMs: Long = 0,
)

@Serializable
data class SettingsDto(
    val locationIntervalActiveSeconds: Int = 60,
    val locationIntervalIdleSeconds: Int = 300,
    val locationMinDistanceMeters: Int = 50,
    val heartbeatIntervalSeconds: Int = 300,
    val syncIntervalSeconds: Int = 900,
    val offlineAuthEnabled: Boolean = true,
    val offlineAuthMaxDurationMinutes: Int = 480,
    val offlineCacheMaxAgeMinutes: Int = 1440,
    val sessionMaxDurationMinutes: Int = 960,
    val batteryAlertThreshold: Int = 15,
    val offlineAlertDelayMinutes: Int = 30,
    val gpsAccuracyThresholdMeters: Int = 100,
    val geofenceConfirmationSeconds: Int = 120,
    val geofenceConfirmationSamples: Int = 3,
    val allowedApps: List<String> = emptyList(),
    val blockedApps: List<String> = emptyList(),
    val version: Int = 0,
)

@Serializable
data class GeofenceDto(
    val id: String,
    val latitude: Double,
    val longitude: Double,
    val radiusMeters: Int,
    val hysteresisMeters: Int,
    val minDwellSeconds: Int,
)

@Serializable
data class DepotDto(
    val id: String,
    val name: String,
    val latitude: Double,
    val longitude: Double,
    val radiusMeters: Int,
    val exitHysteresisMeters: Int,
    val timezone: String,
    val returnTime: String,
    val lockTime: String,
    val operationalDayStart: String,
    val scheduleOverrides: JsonElement? = null,
    val wifiHints: JsonElement? = null,
    val geofences: List<GeofenceDto> = emptyList(),
)

@Serializable
data class OfflineBadgeDto(
    val userId: String,
    val firstName: String,
    val lastName: String,
    /** Empreinte que cet appareil, et lui seul, sait recalculer. */
    val badgeHmac: String,
    val badgeLast4: String,
    val validUntil: String,
)

@Serializable
data class PendingCommandDto(
    val id: String,
    val command: String,
    val payload: JsonElement? = null,
    val expiresAt: String,
)

@Serializable
data class SessionStateDto(
    val id: String,
    val userId: String,
    val state: String,
    val expiresAt: String,
    val returnedAt: String? = null,
    val user: BarcodeUserDto? = null,
)

@Serializable
data class SyncPullResponse(
    val serverTime: String,
    val configVersion: Int,
    val settings: SettingsDto? = null,
    val depot: DepotDto? = null,
    val offlineBadges: List<OfflineBadgeDto> = emptyList(),
    val commands: List<PendingCommandDto> = emptyList(),
    /** État de session vu par le serveur, qui fait autorité en cas de divergence. */
    val session: SessionStateDto? = null,
)

@Serializable
data class CommandResultRequest(
    val status: String,
    val error: String? = null,
)

@Serializable
data class ApiErrorBody(
    val statusCode: Int = 0,
    @SerialName("message") val messageRaw: JsonElement? = null,
    val error: String? = null,
    val correlationId: String? = null,
)

// --- Politique d'applications -----------------------------------------------

@Serializable
data class AppRefusalDto(
    val packageName: String,
    val reason: String,
)

/**
 * Constat envoye au serveur : ce que le telephone a REELLEMENT masque.
 *
 * [enforced] vaut `false` sans Device Owner. Le tableau de bord s'appuie
 * dessus pour distinguer « aucune application bloquee » de « le blocage n'a
 * pas pu s'appliquer », deux situations que rien ne distinguerait autrement.
 */
@Serializable
data class AppPolicyReportRequest(
    val deviceId: String,
    val enforced: Boolean,
    val configVersion: Int,
    val hidden: List<String>,
    val refusals: List<AppRefusalDto>,
)

// --- Partage d'ecran ---------------------------------------------------------

/**
 * Seance de partage, telle que le serveur la decrit.
 *
 * [reason] est affiche tel quel au chauffeur : c'est ce sur quoi il fonde sa
 * decision, et le reformuler serait lui faire repondre a autre chose.
 */
@Serializable
data class ScreenShareDto(
    val id: String,
    val deviceId: String,
    val state: String,
    val reason: String,
    val expiresAt: String,
    val frameCount: Int = 0,
    val requestedBy: AdminRefDto? = null,
)

@Serializable
data class AdminRefDto(
    val id: String,
    val firstName: String,
    val lastName: String,
)

@Serializable
data class ScreenShareConsentRequest(
    val accepted: Boolean,
    val detail: String? = null,
)

@Serializable
data class ScreenShareFrameRequest(
    val image: String,
    val width: Int,
    val height: Int,
    val capturedAt: String? = null,
)

@Serializable
data class ScreenShareStopRequest(
    val detail: String? = null,
)

// --- Deploiement d'applications ---------------------------------------------

/**
 * Identite reelle du paquet installe, rapportee au serveur.
 *
 * Le serveur ne sait pas lire le manifeste binaire d'un APK ; le telephone si.
 * C'est donc lui qui dit ce qui a ete installe, et le premier rapport fait foi.
 */
@Serializable
data class InstalledAppRequest(
    val packageId: String,
    val packageName: String,
    val versionName: String,
    val versionCode: Int,
)
