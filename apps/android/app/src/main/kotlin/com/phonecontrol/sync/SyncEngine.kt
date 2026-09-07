package com.phonecontrol.sync

import android.util.Log
import com.phonecontrol.apps.AppInstaller
import com.phonecontrol.core.rules.AppPolicy
import com.phonecontrol.core.rules.ExpectedApk
import com.phonecontrol.core.rules.isAnomaly
import com.phonecontrol.core.rules.LockReason
import com.phonecontrol.data.local.CommandDao
import com.phonecontrol.data.local.CommandStatus
import com.phonecontrol.data.local.ConfigurationDao
import com.phonecontrol.data.local.DepotEntity
import com.phonecontrol.data.local.OfflineBadgeDao
import com.phonecontrol.data.local.OfflineBadgeEntity
import com.phonecontrol.data.local.PendingCommandEntity
import com.phonecontrol.data.local.PendingEventDao
import com.phonecontrol.data.local.PendingEventEntity
import com.phonecontrol.data.local.SettingsEntity
import com.phonecontrol.data.local.SyncState
import com.phonecontrol.data.remote.AppPolicyReportRequest
import com.phonecontrol.data.remote.AppRefusalDto
import com.phonecontrol.data.remote.CommandResultRequest
import com.phonecontrol.data.remote.PhoneControlApi
import com.phonecontrol.data.remote.SettingsDto
import com.phonecontrol.data.remote.SyncEventDto
import com.phonecontrol.data.remote.SyncEventsRequest
import com.phonecontrol.kiosk.AppPolicyController
import com.phonecontrol.screenshare.ScreenShareCoordinator
import com.phonecontrol.security.SecureStore
import com.phonecontrol.session.SessionManager
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.serialization.json.Json
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Moteur de synchronisation.
 *
 * Trois garanties, dans cet ordre d'importance :
 *
 *  1. **IDEMPOTENCE** — chaque événement porte un `eventId` généré localement.
 *     Un lot renvoyé après une réponse perdue ne crée aucun doublon.
 *  2. **ACQUITTEMENT EXPLICITE** — rien n'est purgé localement avant l'accusé
 *     de réception. Une réponse HTTP perdue coûte une répétition, jamais une
 *     donnée.
 *  3. **AUTORITÉ SERVEUR** — la configuration et l'état de session descendent
 *     du serveur et écrasent la vue locale.
 */
@Singleton
class SyncEngine @Inject constructor(
    private val api: PhoneControlApi,
    private val events: PendingEventDao,
    private val commands: CommandDao,
    private val configuration: ConfigurationDao,
    private val offlineBadges: OfflineBadgeDao,
    private val secureStore: SecureStore,
    private val sessionManager: SessionManager,
    private val appPolicy: AppPolicyController,
    private val screenShare: ScreenShareCoordinator,
    private val appInstaller: AppInstaller,
    private val json: Json,
) {

    data class Outcome(
        val pushed: Int,
        val acked: Int,
        val commandsReceived: Int,
        val configurationUpdated: Boolean,
        val success: Boolean,
    )

    suspend fun synchronize(): Outcome {
        val deviceId = secureStore.deviceId ?: return Outcome(0, 0, 0, false, false)

        val pushed = runCatching { push(deviceId) }.getOrElse { error ->
            Log.w(TAG, "Envoi impossible : ${error.message}")
            PushResult(0, 0, false)
        }

        val pulled = runCatching { pull() }.getOrElse { error ->
            Log.w(TAG, "Réception impossible : ${error.message}")
            PullResult(0, false, false)
        }

        return Outcome(
            pushed = pushed.sent,
            acked = pushed.acked,
            commandsReceived = pulled.commands,
            configurationUpdated = pulled.configurationUpdated,
            success = pushed.success && pulled.success,
        )
    }

    // -----------------------------------------------------------------------

    private data class PushResult(val sent: Int, val acked: Int, val success: Boolean)

    private suspend fun push(deviceId: String): PushResult {
        var totalSent = 0
        var totalAcked = 0

        // Envoi par lots : un téléphone revenu de trois jours hors réseau peut
        // avoir des dizaines de milliers d'événements en attente.
        repeat(MAX_BATCHES_PER_RUN) {
            val batch = events.nextBatch(BATCH_SIZE)
            if (batch.isEmpty()) return PushResult(totalSent, totalAcked, true)

            events.markState(batch.map { it.eventId }, SyncState.SENDING)

            val response = api.pushEvents(
                SyncEventsRequest(deviceId = deviceId, events = batch.map { it.toDto() }),
            )

            if (!response.isSuccessful) {
                // Retour en file : ne jamais purger sur un envoi non confirmé.
                events.markState(batch.map { it.eventId }, SyncState.PENDING)
                Log.w(TAG, "Envoi refusé (${response.code()}) : lot remis en file.")
                return PushResult(totalSent, totalAcked, false)
            }

            val body = response.body()
            if (body == null) {
                events.markState(batch.map { it.eventId }, SyncState.PENDING)
                return PushResult(totalSent, totalAcked, false)
            }

            adjustClock(body.serverTime)

            // Seuls les événements ACQUITTÉS sont supprimés. Les autres
            // repassent en attente et seront retentés.
            events.deleteAcked(body.ackedEventIds)
            val notAcked = batch.map { it.eventId } - body.ackedEventIds.toSet()
            if (notAcked.isNotEmpty()) {
                events.markState(notAcked, SyncState.PENDING)
                Log.w(TAG, "${notAcked.size} événement(s) non acquitté(s) : conservés.")
            }

            totalSent += batch.size
            totalAcked += body.ackedEventIds.size

            if (batch.size < BATCH_SIZE) return PushResult(totalSent, totalAcked, true)
        }

        return PushResult(totalSent, totalAcked, true)
    }

    private data class PullResult(
        val commands: Int,
        val configurationUpdated: Boolean,
        val success: Boolean,
    )

    private suspend fun pull(): PullResult {
        val knownVersion = secureStore.configVersion.takeIf { it >= 0 }
        val response = api.pull(knownVersion)
        if (!response.isSuccessful) return PullResult(0, false, false)
        val body = response.body() ?: return PullResult(0, false, false)

        adjustClock(body.serverTime)

        var configurationUpdated = false

        body.settings?.let { settings ->
            configuration.upsertSettings(settings.toEntity(json))
            secureStore.configVersion = body.configVersion
            configurationUpdated = true
        }

        // La politique d'applications se rejoue quand la configuration change,
        // et tant qu'elle n'a pas pu s'appliquer. Ce second cas n'est pas une
        // precaution theorique : entre l'installation et l'attribution du Device
        // Owner, tous les passages echouent, et sans nouvelle tentative le
        // telephone resterait indefiniment sans politique.
        if (configurationUpdated || !appPolicy.lastApplyEnforced) {
            applyAppPolicy(body.settings, body.configVersion)
        }

        body.depot?.let { depot ->
            configuration.upsertDepot(
                DepotEntity(
                    id = depot.id,
                    name = depot.name,
                    latitude = depot.latitude,
                    longitude = depot.longitude,
                    radiusMeters = depot.radiusMeters,
                    exitHysteresisMeters = depot.exitHysteresisMeters,
                    timezone = depot.timezone,
                    returnTime = depot.returnTime,
                    lockTime = depot.lockTime,
                    operationalDayStart = depot.operationalDayStart,
                    scheduleOverridesJson = depot.scheduleOverrides?.let { encode(it) },
                    wifiHintsJson = depot.wifiHints?.let { encode(it) },
                ),
            )
            configurationUpdated = true
        }

        if (body.offlineBadges.isNotEmpty() || configurationUpdated) {
            val now = System.currentTimeMillis()
            // Remplacement en bloc : un badge révoqué doit DISPARAÎTRE, pas
            // survivre à une fusion.
            offlineBadges.replaceAll(
                body.offlineBadges.map { badge ->
                    OfflineBadgeEntity(
                        badgeHmac = badge.badgeHmac,
                        userId = badge.userId,
                        firstName = badge.firstName,
                        lastName = badge.lastName,
                        badgeLast4 = badge.badgeLast4,
                        validUntil = Instant.parse(badge.validUntil).toEpochMilli(),
                        refreshedAt = now,
                    )
                },
            )
        }

        commands.insertAll(
            body.commands.map { command ->
                PendingCommandEntity(
                    id = command.id,
                    command = command.command,
                    payloadJson = command.payload?.let { encode(it) },
                    receivedAt = System.currentTimeMillis(),
                    expiresAt = Instant.parse(command.expiresAt).toEpochMilli(),
                )
            },
        )

        sessionManager.reconcile(
            serverSessionId = body.session?.id,
            serverState = body.session?.state,
            returnedAt = body.session?.returnedAt?.let { Instant.parse(it).toEpochMilli() },
        )

        return PullResult(body.commands.size, configurationUpdated, true)
    }

    /**
     * Installation d'une application demandee par le serveur.
     *
     * Le resultat est renvoye en exception quand il constitue un echec : la
     * boucle d'execution des commandes acquitte alors la commande en FAILED, et
     * le message remonte tel quel au serveur. Un refus qui n'est PAS une
     * anomalie — telephone deja a jour — n'est pas un echec : la commande est
     * acquittee comme executee, parce qu'elle l'est.
     */
    private suspend fun installApp(payloadJson: String?) {
        val payload = payloadJson?.let {
            runCatching { json.parseToJsonElement(it).jsonObject }.getOrNull()
        } ?: error("Commande d'installation sans paramètres.")

        val expected = ExpectedApk(
            packageId = payload["packageId"]?.jsonPrimitive?.content
                ?: error("Commande d'installation sans identifiant d'application."),
            sha256 = payload["sha256"]?.jsonPrimitive?.content
                ?: error("Commande d'installation sans empreinte : refusée."),
            signingCertSha256 = payload["signingCertSha256"]?.jsonPrimitive?.content
                ?: error("Commande d'installation sans empreinte de signature : refusée."),
            packageName = payload["packageName"]?.jsonPrimitive?.contentOrNull,
        )

        when (val outcome = appInstaller.install(expected)) {
            is AppInstaller.Outcome.Installed ->
                Log.i(TAG, "Installé : ${outcome.packageName} ${outcome.versionName}")

            is AppInstaller.Outcome.Refused ->
                if (isAnomaly(outcome.reason)) {
                    error("Installation refusée : ${outcome.reason}")
                } else {
                    Log.i(TAG, "Rien à faire : ${outcome.reason}")
                }

            is AppInstaller.Outcome.Failed -> error(outcome.message)
        }
    }

    private suspend fun uninstallApp(payloadJson: String?) {
        val payload = payloadJson?.let {
            runCatching { json.parseToJsonElement(it).jsonObject }.getOrNull()
        } ?: error("Commande de désinstallation sans paramètres.")

        val packageName = payload["packageName"]?.jsonPrimitive?.content
            ?: error("Commande de désinstallation sans nom de paquet.")

        val outcome = appInstaller.uninstall(packageName)
        if (outcome is AppInstaller.Outcome.Failed) error(outcome.message)
    }

    /**
     * Applique la politique d'applications, puis dit au serveur ce qui s'est
     * reellement passe.
     *
     * La remontee compte autant que l'application elle-meme : sans elle, le
     * tableau de bord afficherait la politique DEMANDEE et laisserait croire a
     * un verrouillage qui n'a peut-etre pas eu lieu (§67).
     *
     * Les listes viennent de la base locale et non de la reponse : le telephone
     * doit reappliquer la meme politique apres un redemarrage, alors que le
     * serveur, lui, n'enverra plus rien tant que la version n'a pas change.
     */
    private suspend fun applyAppPolicy(settings: SettingsDto?, configVersion: Int) {
        val stored = settings?.let {
            AppPolicy(allowedApps = it.allowedApps, blockedApps = it.blockedApps)
        } ?: configuration.settings()?.let { entity ->
            AppPolicy(
                allowedApps = decodeStringList(entity.allowedAppsJson),
                blockedApps = decodeStringList(entity.blockedAppsJson),
            )
        } ?: return

        val report = runCatching { appPolicy.apply(stored, configVersion) }
            .getOrElse { error ->
                Log.e(TAG, "Politique d'applications non appliquee : ${error.message}")
                return
            }

        val deviceId = secureStore.deviceId ?: return

        // Un constat perdu n'est pas rejoue : il sera renvoye au prochain cycle,
        // et une remontee de politique n'a pas la valeur probante d'un evenement
        // metier — elle n'a donc pas sa place dans la file persistante.
        runCatching {
            api.reportAppPolicy(
                AppPolicyReportRequest(
                    deviceId = deviceId,
                    enforced = report.enforced,
                    configVersion = report.configVersion,
                    hidden = report.hidden,
                    refusals = report.refusals.map {
                        AppRefusalDto(it.packageName, it.reason.name)
                    },
                ),
            )
        }.onFailure { Log.w(TAG, "Constat de politique non remonte : ${it.message}") }
    }

    private fun decodeStringList(raw: String): List<String> =
        runCatching {
            json.decodeFromString(ListSerializer(String.serializer()), raw)
        }.getOrDefault(emptyList())

    /**
     * Exécution des commandes reçues.
     *
     * Idempotente : une commande déjà exécutée est simplement réacquittée.
     * Le rejeu après une réponse perdue est donc sans conséquence.
     */
    suspend fun executeCommands(onLock: suspend (LockReason) -> Unit): Int {
        commands.expireOverdue(System.currentTimeMillis())

        val pending = commands.pending()
        var executed = 0

        for (command in pending) {
            val result = runCatching {
                when (command.command) {
                    "LOCK_DEVICE" -> onLock(LockReason.SERVER_COMMAND)
                    "FORCE_LOGOUT", "REVOKE_SESSION" -> onLock(LockReason.REVOKED)
                    "REFRESH_CONFIGURATION", "SYNC_SETTINGS" -> synchronize()
                    "UNLOCK_DEVICE" -> Unit // Phase 5 : dépend du mode kiosque.
                    // La commande ne fait qu'avertir : elle n'ouvre aucun
                    // partage. Le téléphone relit la séance auprès du serveur,
                    // puis pose la question au chauffeur.
                    "REQUEST_SCREEN_SHARE" -> screenShare.refresh()
                    "INSTALL_APP" -> installApp(command.payloadJson)
                    "UNINSTALL_APP" -> uninstallApp(command.payloadJson)
                    else -> Log.i(TAG, "Commande ignorée : ${command.command}")
                }
            }

            val status = if (result.isSuccess) CommandStatus.EXECUTED else CommandStatus.FAILED
            commands.updateStatus(command.id, status, result.exceptionOrNull()?.message)

            val ack = runCatching {
                api.reportCommandResult(
                    command.id,
                    CommandResultRequest(
                        status = if (result.isSuccess) "EXECUTED" else "FAILED",
                        error = result.exceptionOrNull()?.message,
                    ),
                )
            }

            // L'acquittement n'a pas abouti : la commande reste marquée
            // exécutée localement, et sera réacquittée au cycle suivant. Le
            // serveur, lui, sait ignorer un acquittement en double.
            if (ack.getOrNull()?.isSuccessful == true) {
                commands.updateStatus(command.id, CommandStatus.ACKED)
            }

            if (result.isSuccess) executed++
        }

        commands.purgeAcked()
        return executed
    }

    /**
     * Décalage d'horloge.
     *
     * Le téléphone date ses événements avec l'heure serveur corrigée. Un écart
     * important n'est pas seulement gênant : il peut trahir une manipulation de
     * l'horloge pour échapper au verrouillage (docs/01 §2.4).
     */
    private suspend fun adjustClock(serverTime: String) {
        val server = runCatching { Instant.parse(serverTime).toEpochMilli() }.getOrNull() ?: return
        val offset = server - System.currentTimeMillis()
        val previous = secureStore.serverTimeOffsetMs
        secureStore.serverTimeOffsetMs = offset

        if (kotlin.math.abs(offset) > CLOCK_DRIFT_ALERT_MS &&
            kotlin.math.abs(offset - previous) > CLOCK_DRIFT_ALERT_MS
        ) {
            Log.w(TAG, "Dérive d'horloge de ${offset / 1000} s détectée.")
        }
    }

    private fun encode(element: JsonElement): String =
        json.encodeToString(JsonElement.serializer(), element)

    private fun PendingEventEntity.toDto(): SyncEventDto = SyncEventDto(
        eventId = eventId,
        seq = seq,
        kind = kind,
        occurredAt = Instant.ofEpochMilli(occurredAt).toString(),
        latitude = latitude,
        longitude = longitude,
        accuracyMeters = accuracyMeters,
        altitude = altitude,
        speedMps = speedMps,
        bearing = bearing,
        provider = provider,
        isMock = isMock,
        batteryLevel = batteryLevel,
        insideGeofence = insideGeofence,
        geofenceEventType = geofenceEventType,
        depotId = depotId,
        confidence = confidence,
        evaluation = evaluationJson?.let { json.parseToJsonElement(it) },
        securityType = securityType,
        severity = severity,
        metadata = metadataJson?.let { json.parseToJsonElement(it) },
        sessionId = sessionId,
    )

    private companion object {
        const val TAG = "SyncEngine"
        const val BATCH_SIZE = 500
        const val MAX_BATCHES_PER_RUN = 20
        const val CLOCK_DRIFT_ALERT_MS = 5 * 60 * 1000L
    }
}

internal fun SettingsDto.toEntity(json: Json): SettingsEntity = SettingsEntity(
    locationIntervalActiveSeconds = locationIntervalActiveSeconds,
    locationIntervalIdleSeconds = locationIntervalIdleSeconds,
    locationMinDistanceMeters = locationMinDistanceMeters,
    heartbeatIntervalSeconds = heartbeatIntervalSeconds,
    syncIntervalSeconds = syncIntervalSeconds,
    offlineAuthEnabled = offlineAuthEnabled,
    offlineAuthMaxDurationMinutes = offlineAuthMaxDurationMinutes,
    offlineCacheMaxAgeMinutes = offlineCacheMaxAgeMinutes,
    sessionMaxDurationMinutes = sessionMaxDurationMinutes,
    batteryAlertThreshold = batteryAlertThreshold,
    offlineAlertDelayMinutes = offlineAlertDelayMinutes,
    gpsAccuracyThresholdMeters = gpsAccuracyThresholdMeters,
    geofenceConfirmationSeconds = geofenceConfirmationSeconds,
    geofenceConfirmationSamples = geofenceConfirmationSamples,
    allowedAppsJson = json.encodeToString(
        ListSerializer(String.serializer()),
        allowedApps,
    ),
    blockedAppsJson = json.encodeToString(
        ListSerializer(String.serializer()),
        blockedApps,
    ),
    version = version,
)
