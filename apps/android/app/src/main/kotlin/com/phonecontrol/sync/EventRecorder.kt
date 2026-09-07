package com.phonecontrol.sync

import android.util.Log
import com.phonecontrol.data.local.EventKind
import com.phonecontrol.data.local.PendingEventEntity
import com.phonecontrol.data.local.PendingEventDao
import com.phonecontrol.core.rules.ConfirmedTransition
import com.phonecontrol.core.rules.GeofenceDecision
import com.phonecontrol.core.rules.LocationFix
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * File d'événements locale.
 *
 * Tout ce que le téléphone observe passe par ici avant d'atteindre le réseau :
 * positions, transitions de geofence, événements de sécurité, scans hors ligne.
 * Rien n'est envoyé directement — c'est ce qui rend le fonctionnement hors
 * ligne identique au fonctionnement en ligne, à la latence près.
 *
 * Deux garanties :
 *  - chaque événement porte un `eventId` unique, généré ici : un lot rejoué
 *    après une réponse perdue ne crée aucun doublon côté serveur ;
 *  - le compteur `seq` est monotone et persistant, ce qui préserve l'ordre de
 *    rejeu même après un redémarrage.
 */
@Singleton
class EventRecorder @Inject constructor(
    private val dao: PendingEventDao,
    private val json: Json,
) {

    private val mutex = Mutex()
    private val seq = AtomicLong(-1)

    /** Plafond de stockage : au-delà, les positions les plus anciennes cèdent. */
    private val maxStoredEvents = 50_000
    private val dropBatch = 5_000

    private suspend fun nextSeq(): Long = mutex.withLock {
        if (seq.get() < 0) {
            seq.set(dao.maxSeq())
        }
        seq.incrementAndGet()
    }

    suspend fun recordLocation(fix: LocationFix, sessionId: String?, insideGeofence: Boolean?) {
        enqueue(
            PendingEventEntity(
                eventId = UUID.randomUUID().toString(),
                seq = nextSeq(),
                kind = EventKind.LOCATION,
                occurredAt = fix.recordedAt.toEpochMilli(),
                latitude = fix.latitude,
                longitude = fix.longitude,
                accuracyMeters = fix.accuracyMeters,
                speedMps = fix.speedMps,
                isMock = fix.isMock,
                insideGeofence = insideGeofence,
                sessionId = sessionId,
            ),
        )
    }

    suspend fun recordGeofence(
        transition: ConfirmedTransition,
        decision: GeofenceDecision,
        depotId: String?,
        sessionId: String?,
    ) {
        // Les mesures ayant conduit à la décision voyagent avec l'événement :
        // sans elles, une alerte contestée serait indéfendable.
        val evaluation = JsonObject(
            mapOf(
                "samples" to JsonPrimitive(transition.evaluation.size),
                "windowSeconds" to JsonPrimitive(
                    transition.evaluation.last().recordedAt.epochSecond -
                        transition.evaluation.first().recordedAt.epochSecond,
                ),
                "fixes" to JsonArray(
                    transition.evaluation.map { sample ->
                        JsonObject(
                            mapOf(
                                "t" to JsonPrimitive(sample.recordedAt.toString()),
                                "distanceMeters" to JsonPrimitive(sample.distanceMeters),
                                "accuracyMeters" to JsonPrimitive(sample.accuracyMeters),
                                "classification" to JsonPrimitive(sample.classification.name),
                            ),
                        )
                    },
                ),
            ),
        )

        enqueue(
            PendingEventEntity(
                eventId = UUID.randomUUID().toString(),
                seq = nextSeq(),
                kind = EventKind.GEOFENCE,
                occurredAt = transition.occurredAt.toEpochMilli(),
                latitude = transition.latitude,
                longitude = transition.longitude,
                accuracyMeters = transition.accuracyMeters,
                geofenceEventType = decision.eventType.name,
                depotId = depotId,
                confidence = transition.confidence,
                evaluationJson = json.encodeToString(JsonObject.serializer(), evaluation),
                sessionId = sessionId,
            ),
        )
    }

    suspend fun recordSecurity(
        type: String,
        severity: String = "LOW",
        metadata: Map<String, String> = emptyMap(),
        sessionId: String? = null,
        occurredAtMillis: Long = System.currentTimeMillis(),
    ) {
        val payload = JsonObject(metadata.mapValues { JsonPrimitive(it.value) })
        enqueue(
            PendingEventEntity(
                eventId = UUID.randomUUID().toString(),
                seq = nextSeq(),
                kind = EventKind.SECURITY,
                occurredAt = occurredAtMillis,
                securityType = type,
                severity = severity,
                metadataJson = json.encodeToString(JsonObject.serializer(), payload),
                sessionId = sessionId,
            ),
        )
    }

    /** Scan réalisé sans réseau : le serveur revalidera la session à la reconnexion. */
    suspend fun recordOfflineScan(sessionId: String, scannedAtMillis: Long) {
        enqueue(
            PendingEventEntity(
                eventId = UUID.randomUUID().toString(),
                seq = nextSeq(),
                kind = EventKind.BARCODE_SCAN,
                occurredAt = scannedAtMillis,
                sessionId = sessionId,
            ),
        )
    }

    private suspend fun enqueue(event: PendingEventEntity) {
        dao.insert(event)

        val total = dao.totalCount()
        if (total > maxStoredEvents) {
            // Les positions les plus anciennes sont sacrifiées, jamais les
            // événements de sécurité : ce sont précisément ceux qu'on voudra
            // relire après un incident.
            Log.w(TAG, "File locale saturée ($total) : purge des positions les plus anciennes.")
            dao.dropOldestLocations(dropBatch)
        }
    }

    private companion object {
        const val TAG = "EventRecorder"
    }
}
