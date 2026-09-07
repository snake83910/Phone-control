package com.phonecontrol.data.local

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Base locale du téléphone.
 *
 * **Écart assumé par rapport à docs/05 §2**, qui prévoyait une table par type
 * d'événement (positions, geofence, sécurité, scans). Ils sont ici réunis dans
 * une seule table [PendingEventEntity], avec une colonne `kind`.
 *
 * Raison : l'API les reçoit dans UN SEUL tableau, ordonné par `seq`, et les
 * acquitte en bloc. Avec quatre tables, chaque cycle de synchronisation devrait
 * fusionner quatre flux triés, puis répartir les acquittements — du code
 * délicat, pour un bénéfice nul. Les colonnes propres à chaque type sont
 * nullables ; c'est le prix, et il est faible.
 */

@Entity(
    tableName = "pending_events",
    indices = [Index(value = ["syncState", "seq"]), Index(value = ["eventId"], unique = true)],
)
data class PendingEventEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,

    /** UUID généré par le téléphone : c'est lui qui garantit l'idempotence. */
    val eventId: String,

    /** Compteur monotone par appareil, pour l'ordre de rejeu. */
    val seq: Long,

    /** LOCATION, GEOFENCE, SECURITY, BARCODE_SCAN. */
    val kind: String,

    val occurredAt: Long,
    val syncState: String = SyncState.PENDING,

    // Position
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

    // Geofence
    val geofenceEventType: String? = null,
    val depotId: String? = null,
    val confidence: Double? = null,
    /** Mesures ayant conduit à la décision, en JSON. */
    val evaluationJson: String? = null,

    // Sécurité
    val securityType: String? = null,
    val severity: String? = null,
    val metadataJson: String? = null,

    val sessionId: String? = null,
)

object SyncState {
    const val PENDING = "PENDING"
    const val SENDING = "SENDING"
    const val ACKED = "ACKED"
}

object EventKind {
    const val LOCATION = "LOCATION"
    const val GEOFENCE = "GEOFENCE"
    const val SECURITY = "SECURITY"
    const val BARCODE_SCAN = "BARCODE_SCAN"
}

/**
 * Liste d'authentification hors ligne.
 *
 * Ne contient JAMAIS un numéro de badge : uniquement une empreinte que seul cet
 * appareil sait recalculer, sa clé HMAC vivant dans le Keystore. Extraite d'un
 * téléphone volé, cette table est inexploitable ailleurs (docs/05 §3.1).
 */
@Entity(tableName = "offline_badges", indices = [Index(value = ["badgeHmac"])])
data class OfflineBadgeEntity(
    @PrimaryKey val badgeHmac: String,
    val userId: String,
    val firstName: String,
    val lastName: String,
    val badgeLast4: String,
    /** Au-delà, l'authentification hors ligne est refusée même sans redémarrage. */
    val validUntil: Long,
    val refreshedAt: Long,
)

@Entity(tableName = "depot")
data class DepotEntity(
    @PrimaryKey val id: String,
    val name: String,
    val latitude: Double,
    val longitude: Double,
    val radiusMeters: Int,
    val exitHysteresisMeters: Int,
    val timezone: String,
    val returnTime: String,
    val lockTime: String,
    val operationalDayStart: String,
    val scheduleOverridesJson: String?,
    val wifiHintsJson: String?,
)

@Entity(tableName = "device_settings")
data class SettingsEntity(
    @PrimaryKey val id: Int = 1,
    val locationIntervalActiveSeconds: Int,
    val locationIntervalIdleSeconds: Int,
    val locationMinDistanceMeters: Int,
    val heartbeatIntervalSeconds: Int,
    val syncIntervalSeconds: Int,
    val offlineAuthEnabled: Boolean,
    val offlineAuthMaxDurationMinutes: Int,
    val offlineCacheMaxAgeMinutes: Int,
    val sessionMaxDurationMinutes: Int,
    val batteryAlertThreshold: Int,
    val offlineAlertDelayMinutes: Int,
    val gpsAccuracyThresholdMeters: Int,
    val geofenceConfirmationSeconds: Int,
    val geofenceConfirmationSamples: Int,
    val allowedAppsJson: String,
    /**
     * Paquets a masquer. Colonne distincte de [allowedAppsJson] : les deux
     * listes ont des effets differents et se corrigent separement.
     *
     * Valeur par defaut a l'ouverture d'une base de version 1, pour qu'une mise
     * a jour de l'application ne bloque aucune application d'elle-meme.
     */
    val blockedAppsJson: String = "[]",
    val version: Int,
)

@Entity(tableName = "session")
data class SessionEntity(
    @PrimaryKey val id: String,
    val userId: String,
    val firstName: String,
    val lastName: String,
    val startedAt: Long,
    val expiresAt: Long,
    val state: String,
    val returnedAt: Long? = null,
    /** Ouverte sans le serveur : doit être revalidée à la reconnexion. */
    val openedOffline: Boolean = false,
    val endedAt: Long? = null,
    val endReason: String? = null,
)

@Entity(tableName = "pending_commands")
data class PendingCommandEntity(
    @PrimaryKey val id: String,
    val command: String,
    val payloadJson: String?,
    val receivedAt: Long,
    val expiresAt: Long,
    val status: String = CommandStatus.PENDING,
    val attempts: Int = 0,
    val error: String? = null,
)

object CommandStatus {
    const val PENDING = "PENDING"
    const val EXECUTED = "EXECUTED"
    const val FAILED = "FAILED"
    const val EXPIRED = "EXPIRED"
    /** Résultat transmis au serveur : la ligne peut être purgée. */
    const val ACKED = "ACKED"
}
