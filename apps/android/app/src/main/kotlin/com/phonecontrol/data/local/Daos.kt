package com.phonecontrol.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

@Dao
interface PendingEventDao {

    /**
     * `IGNORE` et non `REPLACE` : un événement déjà en file ne doit pas être
     * réécrit, sous peine de perdre son `syncState` et de le renvoyer deux fois.
     */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(event: PendingEventEntity): Long

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertAll(events: List<PendingEventEntity>)

    /**
     * Lot à transmettre.
     *
     * Les événements de sécurité et de geofence passent avant les positions :
     * une alerte ne doit jamais attendre derrière quatre mille points GPS
     * (docs/05 §4).
     */
    @Query(
        """
        SELECT * FROM pending_events
        WHERE syncState != :acked
        ORDER BY CASE kind
            WHEN 'SECURITY' THEN 0
            WHEN 'GEOFENCE' THEN 1
            WHEN 'BARCODE_SCAN' THEN 2
            ELSE 3
        END, seq ASC
        LIMIT :limit
        """,
    )
    suspend fun nextBatch(limit: Int, acked: String = SyncState.ACKED): List<PendingEventEntity>

    @Query("UPDATE pending_events SET syncState = :state WHERE eventId IN (:eventIds)")
    suspend fun markState(eventIds: List<String>, state: String)

    /** Purge après acquittement serveur : rien n'est supprimé avant. */
    @Query("DELETE FROM pending_events WHERE eventId IN (:eventIds)")
    suspend fun deleteAcked(eventIds: List<String>)

    @Query("SELECT COUNT(*) FROM pending_events WHERE syncState != :acked")
    fun pendingCount(acked: String = SyncState.ACKED): Flow<Int>

    @Query("SELECT COUNT(*) FROM pending_events")
    suspend fun totalCount(): Int

    @Query("SELECT COALESCE(MAX(seq), 0) FROM pending_events")
    suspend fun maxSeq(): Long

    /**
     * Débordement de stockage : les positions les plus anciennes partent en
     * premier. Les événements de sécurité ne sont jamais sacrifiés — ils sont
     * précisément ceux qu'on voudra relire après un incident.
     */
    @Query(
        """
        DELETE FROM pending_events
        WHERE kind = 'LOCATION' AND id IN (
            SELECT id FROM pending_events WHERE kind = 'LOCATION'
            ORDER BY seq ASC LIMIT :count
        )
        """,
    )
    suspend fun dropOldestLocations(count: Int)

    @Query("SELECT * FROM pending_events WHERE eventId = :eventId")
    suspend fun findByEventId(eventId: String): PendingEventEntity?
}

@Dao
interface OfflineBadgeDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(badges: List<OfflineBadgeEntity>)

    @Query("SELECT * FROM offline_badges WHERE badgeHmac = :hmac")
    suspend fun findByHmac(hmac: String): OfflineBadgeEntity?

    @Query("SELECT * FROM offline_badges")
    suspend fun all(): List<OfflineBadgeEntity>

    @Query("DELETE FROM offline_badges")
    suspend fun clear()

    @Query("SELECT COALESCE(MAX(refreshedAt), 0) FROM offline_badges")
    suspend fun lastRefreshedAt(): Long

    /**
     * La liste est remplacée en bloc, pas fusionnée : un badge révoqué
     * disparaît côté serveur, il doit disparaître ici aussi. Une fusion le
     * laisserait valide indéfiniment.
     */
    @Transaction
    suspend fun replaceAll(badges: List<OfflineBadgeEntity>) {
        clear()
        insertAll(badges)
    }
}

@Dao
interface ConfigurationDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertDepot(depot: DepotEntity)

    @Query("SELECT * FROM depot LIMIT 1")
    suspend fun depot(): DepotEntity?

    @Query("SELECT * FROM depot LIMIT 1")
    fun depotFlow(): Flow<DepotEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertSettings(settings: SettingsEntity)

    @Query("SELECT * FROM device_settings WHERE id = 1")
    suspend fun settings(): SettingsEntity?

    @Query("SELECT * FROM device_settings WHERE id = 1")
    fun settingsFlow(): Flow<SettingsEntity?>
}

@Dao
interface SessionDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(session: SessionEntity)

    @Query("SELECT * FROM session WHERE endedAt IS NULL ORDER BY startedAt DESC LIMIT 1")
    suspend fun current(): SessionEntity?

    @Query("SELECT * FROM session WHERE endedAt IS NULL ORDER BY startedAt DESC LIMIT 1")
    fun currentFlow(): Flow<SessionEntity?>

    @Query("UPDATE session SET endedAt = :endedAt, endReason = :reason WHERE endedAt IS NULL")
    suspend fun endAll(endedAt: Long, reason: String)

    @Query("UPDATE session SET state = :state, returnedAt = :returnedAt WHERE id = :id")
    suspend fun updateState(id: String, state: String, returnedAt: Long?)

    @Query("DELETE FROM session WHERE endedAt IS NOT NULL AND endedAt < :before")
    suspend fun purgeEndedBefore(before: Long)
}

@Dao
interface CommandDao {

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertAll(commands: List<PendingCommandEntity>)

    @Query("SELECT * FROM pending_commands WHERE status = :status ORDER BY receivedAt ASC")
    suspend fun pending(status: String = CommandStatus.PENDING): List<PendingCommandEntity>

    @Query("SELECT * FROM pending_commands WHERE status IN (:statuses)")
    suspend fun withStatuses(statuses: List<String>): List<PendingCommandEntity>

    @Query("UPDATE pending_commands SET status = :status, error = :error WHERE id = :id")
    suspend fun updateStatus(id: String, status: String, error: String? = null)

    @Query("DELETE FROM pending_commands WHERE status = :status")
    suspend fun purgeAcked(status: String = CommandStatus.ACKED)

    /** Une commande périmée n'est jamais exécutée : elle est marquée et oubliée. */
    @Query("UPDATE pending_commands SET status = :expired WHERE status = :pending AND expiresAt < :now")
    suspend fun expireOverdue(
        now: Long,
        pending: String = CommandStatus.PENDING,
        expired: String = CommandStatus.EXPIRED,
    )
}
