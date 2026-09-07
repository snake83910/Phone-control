package com.phonecontrol.screenshare

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.phonecontrol.MainActivity
import com.phonecontrol.R
import java.io.ByteArrayOutputStream
import javax.inject.Inject
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Capture d'ecran pendant un partage accepte.
 *
 * Ce service n'existe **que** le temps d'une seance acceptee. Il est demarre
 * apres l'accord du chauffeur et apres la boite de dialogue systeme d'Android,
 * et il s'arrete de lui-meme a l'echeance — sans attendre d'ordre du serveur.
 * Un telephone qui perd le reseau juste apres l'accord doit cesser tout seul.
 *
 * **Il transmet des images, pas de la video.** Une capture toutes les quelques
 * centaines de millisecondes suffit largement a accompagner quelqu'un a l'ecran,
 * et divise la consommation de donnees mobiles par un ordre de grandeur par
 * rapport a un flux video. Le choix est assume : c'est un outil d'assistance,
 * pas un outil d'observation.
 *
 * Deux choses qu'Android impose et qu'on ne cherche pas a contourner :
 *
 * - une notification permanente, plus l'indicateur systeme de capture. Le
 *   chauffeur ne peut pas etre filme sans le voir ;
 * - la boite de dialogue de consentement systeme, a chaque seance. Elle
 *   s'ajoute a notre propre demande, elle ne la remplace pas : la notre dit qui
 *   demande et pourquoi, celle d'Android dit ce qui va etre capture.
 */
@AndroidEntryPoint
class ScreenCaptureService : LifecycleService() {

    @Inject lateinit var coordinator: ScreenShareCoordinator

    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var readerThread: HandlerThread? = null

    /**
     * Android exige qu'un rappel soit enregistre avant toute capture (API 34+),
     * et l'arret peut venir du systeme lui-meme — l'utilisateur peut couper le
     * partage depuis le panneau de notifications, et c'est tres bien ainsi.
     */
    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            Log.i(TAG, "Capture interrompue par le système ou par l'utilisateur.")
            lifecycleScope.launch { coordinator.stoppedByDriver("Arrêt depuis le système.") }
            stopSelf()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)

        if (intent?.action == ACTION_STOP) {
            lifecycleScope.launch { coordinator.stoppedByDriver("Arrêt demandé par le chauffeur.") }
            stopSelf()
            return START_NOT_STICKY
        }

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        val data: Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent?.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent?.getParcelableExtra(EXTRA_RESULT_DATA)
        }

        if (data == null) {
            Log.e(TAG, "Aucune autorisation de capture reçue : service arrêté.")
            lifecycleScope.launch { coordinator.captureFailed("Autorisation système absente.") }
            stopSelf()
            return START_NOT_STICKY
        }

        createChannel()
        // L'ordre compte : depuis Android 14, le service doit deja etre au
        // premier plan, type `mediaProjection`, AVANT d'obtenir la projection.
        // L'inverse leve une SecurityException.
        startForegroundCompat()

        val started = runCatching { start(resultCode, data) }
        if (started.isFailure) {
            val message = started.exceptionOrNull()?.message ?: "cause inconnue"
            Log.e(TAG, "Capture impossible : $message")
            // Remonte comme un ECHEC, pas comme un ecran vide : l'administrateur
            // doit savoir que rien ne viendra (§67).
            lifecycleScope.launch { coordinator.captureFailed(message) }
            stopSelf()
            return START_NOT_STICKY
        }

        return START_NOT_STICKY
    }

    private fun start(resultCode: Int, data: Intent) {
        val manager = getSystemService(MediaProjectionManager::class.java)
        val media = manager.getMediaProjection(resultCode, data)
            ?: error("MediaProjection refusée par le système.")

        projection = media
        media.registerCallback(projectionCallback, Handler(mainLooper))

        val metrics = displayMetrics()
        // Capture reduite : la lisibilite d'un ecran de telephone survit tres
        // bien a une division par deux, et le volume de donnees suit.
        val width = (metrics.widthPixels / SCALE).toInt().coerceAtLeast(1)
        val height = (metrics.heightPixels / SCALE).toInt().coerceAtLeast(1)

        val thread = HandlerThread("screen-capture").also { it.start() }
        readerThread = thread

        val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, MAX_IMAGES)
        imageReader = reader

        virtualDisplay = media.createVirtualDisplay(
            "phone-control-share",
            width,
            height,
            metrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface,
            null,
            Handler(thread.looper),
        )

        lifecycleScope.launch { captureLoop(reader, width, height) }
    }

    /**
     * Boucle de capture.
     *
     * Elle interroge le coordinateur a chaque tour : c'est lui qui detient
     * l'echeance et l'etat de la seance. Si la seance n'est plus ouverte — fin,
     * expiration, refus tardif — la boucle s'arrete d'elle-meme, sans qu'aucun
     * ordre n'ait eu besoin d'arriver par le reseau.
     */
    private suspend fun captureLoop(reader: ImageReader, width: Int, height: Int) {
        while (lifecycleScope.isActive && coordinator.shouldCaptureNow()) {
            val jpeg = withContext(Dispatchers.Default) { grab(reader, width, height) }
            if (jpeg != null) {
                coordinator.sendFrame(
                    image = Base64.encodeToString(jpeg, Base64.NO_WRAP),
                    width = width,
                    height = height,
                )
            }
            delay(coordinator.frameIntervalMs)
        }

        Log.i(TAG, "Fin de la boucle de capture : la séance n'est plus ouverte.")
        stopSelf()
    }

    /**
     * Recupere la derniere image disponible et la compresse en JPEG.
     *
     * Le remplissage de ligne (`rowPadding`) n'est pas un detail : ImageReader
     * aligne chaque ligne sur une largeur materielle qui depasse souvent celle
     * demandee. L'ignorer produit une image oblique — defaut classique, et
     * spectaculaire.
     */
    private fun grab(reader: ImageReader, width: Int, height: Int): ByteArray? {
        val image = reader.acquireLatestImage() ?: return null
        return try {
            val plane = image.planes[0]
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val rowPadding = rowStride - pixelStride * width

            val bitmap = Bitmap.createBitmap(
                width + rowPadding / pixelStride,
                height,
                Bitmap.Config.ARGB_8888,
            )
            bitmap.copyPixelsFromBuffer(plane.buffer)

            val cropped = if (rowPadding == 0) {
                bitmap
            } else {
                Bitmap.createBitmap(bitmap, 0, 0, width, height)
            }

            ByteArrayOutputStream().use { out ->
                cropped.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
                out.toByteArray()
            }.also {
                if (cropped !== bitmap) cropped.recycle()
                bitmap.recycle()
            }
        } catch (error: Exception) {
            Log.w(TAG, "Image illisible : ${error.message}")
            null
        } finally {
            image.close()
        }
    }

    override fun onDestroy() {
        // L'ordre de liberation compte : la surface d'abord, la projection
        // ensuite. L'inverse laisse un VirtualDisplay orphelin qui continue de
        // consommer.
        virtualDisplay?.release()
        virtualDisplay = null
        imageReader?.close()
        imageReader = null
        projection?.unregisterCallback(projectionCallback)
        projection?.stop()
        projection = null
        readerThread?.quitSafely()
        readerThread = null
        super.onDestroy()
    }

    @Suppress("DEPRECATION")
    private fun displayMetrics(): DisplayMetrics {
        val metrics = DisplayMetrics()
        val window = getSystemService(WindowManager::class.java)
        window.defaultDisplay.getRealMetrics(metrics)
        return metrics
    }

    private fun startForegroundCompat() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.screen_share_channel_name),
                // HIGH, contrairement au suivi de position : un partage d'ecran
                // doit se remarquer. Une notification discrete irait a l'encontre
                // de ce que le dispositif garantit.
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = getString(R.string.screen_share_channel_description)
                setShowBadge(true)
            },
        )
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )

        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, ScreenCaptureService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.screen_share_notification_title))
            .setContentText(getString(R.string.screen_share_notification_text))
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentIntent(open)
            // L'arret est a une touche, depuis la notification : un accord qu'on
            // ne peut pas retirer facilement n'en est pas vraiment un.
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                getString(R.string.screen_share_stop),
                stop,
            )
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
    }

    companion object {
        private const val TAG = "ScreenCaptureService"
        private const val CHANNEL_ID = "screen-share"
        private const val NOTIFICATION_ID = 4711
        private const val EXTRA_RESULT_CODE = "resultCode"
        private const val EXTRA_RESULT_DATA = "resultData"
        private const val ACTION_STOP = "com.phonecontrol.SCREEN_SHARE_STOP"

        /** Division de la resolution capturee. Lisible, et cinq fois plus leger. */
        private const val SCALE = 2.0

        private const val JPEG_QUALITY = 55

        /**
         * Deux images en attente au plus. Au-dela, `acquireLatestImage` finit
         * par renvoyer null faute de tampon libre — panne discrete qui se
         * manifeste par un ecran fige.
         */
        private const val MAX_IMAGES = 2

        fun start(context: Context, resultCode: Int, data: Intent) {
            context.startForegroundService(
                Intent(context, ScreenCaptureService::class.java)
                    .putExtra(EXTRA_RESULT_CODE, resultCode)
                    .putExtra(EXTRA_RESULT_DATA, data),
            )
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ScreenCaptureService::class.java))
        }
    }
}
