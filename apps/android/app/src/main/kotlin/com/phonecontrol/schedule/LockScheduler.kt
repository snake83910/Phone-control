package com.phonecontrol.schedule

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.phonecontrol.core.rules.DepotSchedule
import com.phonecontrol.core.rules.LockReason
import com.phonecontrol.core.rules.ScheduleOverridesJson
import com.phonecontrol.core.rules.nextLockInstant
import com.phonecontrol.data.local.ConfigurationDao
import com.phonecontrol.data.local.DepotEntity
import com.phonecontrol.session.SessionManager
import com.phonecontrol.sync.EventRecorder
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import dagger.hilt.android.AndroidEntryPoint
import dagger.hilt.android.qualifiers.ApplicationContext
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json

/**
 * Verrouillage local à l'heure du dépôt.
 *
 * **C'est la garantie, pas la commande serveur.** Le serveur planifie et envoie
 * un ordre : c'est le chemin nominal. Mais un téléphone hors réseau à 22 h doit
 * se verrouiller quand même, et c'est cette alarme qui le fait.
 *
 * Deux protections complémentaires :
 *  - une **alarme exacte** posée sur le prochain verrouillage calculé dans le
 *    fuseau du dépôt ;
 *  - un **contrôle périodique** (WorkManager) qui rattrape une alarme perdue —
 *    redémarrage, mise à jour de l'application, gestionnaire de batterie
 *    agressif.
 *
 * L'heure système est supposée fiable parce que le Device Owner la verrouille
 * (`DISALLOW_CONFIG_DATE_TIME`, heure réseau forcée). Sans ce privilège, elle ne
 * l'est pas — et l'application le signale plutôt que de le taire.
 */
@Singleton
class LockScheduler @Inject constructor(
    @ApplicationContext private val context: Context,
    private val configuration: ConfigurationDao,
    private val json: Json,
) {

    private val alarmManager: AlarmManager? =
        context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager

    /** Replanifie l'alarme sur le prochain verrouillage. Idempotent. */
    suspend fun schedule() {
        val depot = configuration.depot()
        if (depot == null) {
            Log.i(TAG, "Aucun dépôt connu : pas de verrouillage planifié.")
            return
        }

        val next = depot.toSchedule().nextLockInstant(Instant.now())
        if (next == null) {
            // Un dimanche neutralisé, par exemple : aucune règle ce jour-là.
            Log.i(TAG, "Aucun verrouillage prévu dans les prochains jours.")
            cancel()
            return
        }

        val pending = pendingIntent()
        val manager = alarmManager ?: return

        val canScheduleExact = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            manager.canScheduleExactAlarms()
        } else {
            true
        }

        if (canScheduleExact) {
            // `setExactAndAllowWhileIdle` traverse le mode Doze. C'est le seul
            // mode qui tienne la promesse « verrouillé à 22 h ».
            manager.setExactAndAllowWhileIdle(
                AlarmManager.RTC_WAKEUP,
                next.toEpochMilli(),
                pending,
            )
            Log.i(TAG, "Verrouillage planifié pour $next")
        } else {
            // Sans alarme exacte, le verrouillage peut glisser de plusieurs
            // minutes. On le fait quand même, et on le dit.
            manager.setAndAllowWhileIdle(
                AlarmManager.RTC_WAKEUP,
                next.toEpochMilli(),
                pending,
            )
            Log.w(
                TAG,
                "Alarmes exactes indisponibles : le verrouillage de $next peut être différé.",
            )
        }
    }

    fun cancel() {
        alarmManager?.cancel(pendingIntent())
    }

    private fun pendingIntent(): PendingIntent = PendingIntent.getBroadcast(
        context,
        REQUEST_CODE,
        Intent(context, LockAlarmReceiver::class.java).setAction(ACTION_LOCK),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun DepotEntity.toSchedule(): DepotSchedule = DepotSchedule(
        timezone = timezone,
        returnTime = returnTime,
        lockTime = lockTime,
        operationalDayStart = operationalDayStart,
        overrides = scheduleOverridesJson?.let {
            ScheduleOverridesJson.parse(json.parseToJsonElement(it))
        },
    )

    companion object {
        private const val TAG = "LockScheduler"
        private const val REQUEST_CODE = 7301
        const val ACTION_LOCK = "com.phonecontrol.action.SCHEDULED_LOCK"
    }
}

/**
 * Déclenchement de l'alarme.
 *
 * Le verrouillage est appliqué même si l'application n'était pas au premier
 * plan : c'est tout l'intérêt d'une alarme plutôt que d'une minuterie interne.
 */
@AndroidEntryPoint
class LockAlarmReceiver : BroadcastReceiver() {

    @Inject lateinit var sessionManager: SessionManager
    @Inject lateinit var scheduler: LockScheduler
    @Inject lateinit var recorder: EventRecorder

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != LockScheduler.ACTION_LOCK) return

        val pendingResult = goAsync()
        runBlocking {
            runCatching {
                recorder.recordSecurity(
                    type = "LOCK_DEVICE",
                    metadata = mapOf("source" to "LOCAL_ALARM"),
                )
                sessionManager.lock(LockReason.SCHEDULED_LOCAL)
                // Immédiatement replanifié : sans cela, le verrouillage
                // n'aurait lieu qu'une seule fois.
                scheduler.schedule()
            }.onFailure { Log.e("LockAlarm", "Verrouillage planifié : ${it.message}") }
            pendingResult.finish()
        }
    }
}

/**
 * Redémarrage et mise à jour de l'application.
 *
 * Une alarme exacte ne survit ni à l'un ni à l'autre : sans ce récepteur, un
 * téléphone redémarré à 21 h 50 ne se verrouillerait jamais.
 */
@AndroidEntryPoint
class BootReceiver : BroadcastReceiver() {

    @Inject lateinit var scheduler: LockScheduler
    @Inject lateinit var sessionManager: SessionManager

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            return
        }

        val pendingResult = goAsync()
        runBlocking {
            runCatching {
                sessionManager.restore()
                scheduler.schedule()
            }.onFailure { Log.e("BootReceiver", "Restauration : ${it.message}") }
            pendingResult.finish()
        }
    }
}

/**
 * Filet de sécurité : contrôle périodique de l'heure de verrouillage.
 *
 * Il rattrape une alarme perdue. Sur les terminaux dont le constructeur limite
 * agressivement les tâches de fond, c'est parfois ce contrôle — et non l'alarme
 * — qui déclenche réellement le verrouillage.
 */
@HiltWorker
class LockCheckWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val configuration: ConfigurationDao,
    private val sessionManager: SessionManager,
    private val scheduler: LockScheduler,
    private val json: Json,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val depot = configuration.depot() ?: return Result.success()
        val session = sessionManager.context.value.session ?: return Result.success()

        val schedule = DepotSchedule(
            timezone = depot.timezone,
            returnTime = depot.returnTime,
            lockTime = depot.lockTime,
            operationalDayStart = depot.operationalDayStart,
            overrides = depot.scheduleOverridesJson?.let {
                ScheduleOverridesJson.parse(json.parseToJsonElement(it))
            },
        )

        // Fenêtre de rattrapage : le verrouillage a-t-il été manqué depuis la
        // dernière vérification ?
        val now = Instant.now()
        val windowStart = now.minusSeconds(CHECK_WINDOW_SECONDS)
        val due = schedule.nextLockInstant(windowStart)

        if (due != null && !due.isAfter(now)) {
            Log.w(TAG, "Verrouillage manqué détecté ($due) : application immédiate.")
            sessionManager.lock(LockReason.SCHEDULED_LOCAL)
        }

        if (session.expiresAt.isBefore(now)) {
            sessionManager.lock(LockReason.EXPIRED)
        }

        scheduler.schedule()
        return Result.success()
    }

    private companion object {
        const val TAG = "LockCheckWorker"

        /** Doit couvrir largement l'intervalle du worker (15 min minimum). */
        const val CHECK_WINDOW_SECONDS = 30L * 60
    }
}
