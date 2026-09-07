package com.phonecontrol.data.local

import androidx.room.Database
import androidx.room.RoomDatabase

@Database(
    entities = [
        PendingEventEntity::class,
        OfflineBadgeEntity::class,
        DepotEntity::class,
        SettingsEntity::class,
        SessionEntity::class,
        PendingCommandEntity::class,
    ],
    version = 2,
    exportSchema = true,
)
abstract class PhoneControlDatabase : RoomDatabase() {
    abstract fun pendingEvents(): PendingEventDao
    abstract fun offlineBadges(): OfflineBadgeDao
    abstract fun configuration(): ConfigurationDao
    abstract fun sessions(): SessionDao
    abstract fun commands(): CommandDao

    companion object {
        const val NAME = "phone-control.db"
    }
}
