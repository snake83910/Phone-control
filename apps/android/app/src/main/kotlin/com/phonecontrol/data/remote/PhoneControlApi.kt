package com.phonecontrol.data.remote

import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query
import retrofit2.http.Streaming

/**
 * Points d'entrée de l'API utilisés par le téléphone.
 *
 * Ils sont peu nombreux, et c'est délibéré : tout ce que l'appareil a besoin de
 * savoir arrive par `sync/pull`, et tout ce qu'il a à dire part par
 * `sync/events`. Multiplier les appels spécialisés multiplierait les occasions
 * d'être à moitié synchronisé.
 */
interface PhoneControlApi {

    /** Enrôlement : route publique, protégée par le jeton du QR de provisioning. */
    @POST("v1/devices/enroll")
    suspend fun enroll(@Body body: EnrollRequest): Response<EnrollResponse>

    @POST("v1/devices/token/refresh")
    suspend fun refreshToken(@Body body: RefreshRequest): Response<TokenResponse>

    /**
     * Scan de badge. Un refus renvoie HTTP 200 avec `success = false` : la
     * requête a abouti, c'est le scan qui est refusé. Distinguer les deux évite
     * de confondre « badge inconnu » et « serveur en panne » — deux situations
     * qui n'appellent pas du tout la même réaction côté téléphone.
     */
    @POST("v1/auth/barcode")
    suspend fun authenticateBarcode(
        @Body body: BarcodeAuthRequest,
    ): Response<BarcodeAuthResponse>

    @POST("v1/devices/heartbeat")
    suspend fun heartbeat(@Body body: HeartbeatRequest): Response<HeartbeatResponse>

    @POST("v1/devices/app-policy/report")
    suspend fun reportAppPolicy(@Body body: AppPolicyReportRequest): Response<Unit>

    // --- Deploiement d'applications ------------------------------------------

    /**
     * Telechargement d'un APK.
     *
     * `@Streaming` est indispensable : sans lui, Retrofit charge la reponse
     * entiere en memoire avant de la rendre. Un APK de quarante mega-octets
     * ferait tomber l'application sur un telephone d'entree de gamme.
     */
    @Streaming
    @GET("v1/app-packages/{id}/download")
    suspend fun downloadAppPackage(@Path("id") id: String): Response<ResponseBody>

    @POST("v1/app-packages/installed")
    suspend fun reportInstalledApp(@Body body: InstalledAppRequest): Response<Unit>

    // --- Partage d'ecran ----------------------------------------------------

    @GET("v1/devices/screen-share/current")
    suspend fun currentScreenShare(): Response<ScreenShareDto?>

    @POST("v1/devices/screen-share/{id}/consent")
    suspend fun respondToScreenShare(
        @Path("id") id: String,
        @Body body: ScreenShareConsentRequest,
    ): Response<ScreenShareDto>

    @POST("v1/devices/screen-share/{id}/frame")
    suspend fun sendScreenShareFrame(
        @Path("id") id: String,
        @Body body: ScreenShareFrameRequest,
    ): Response<Unit>

    @POST("v1/devices/screen-share/{id}/stop")
    suspend fun stopScreenShare(
        @Path("id") id: String,
        @Body body: ScreenShareStopRequest,
    ): Response<ScreenShareDto>

    @POST("v1/devices/screen-share/{id}/failed")
    suspend fun reportScreenShareFailure(
        @Path("id") id: String,
        @Body body: ScreenShareStopRequest,
    ): Response<ScreenShareDto>

    @POST("v1/sync/events")
    suspend fun pushEvents(@Body body: SyncEventsRequest): Response<SyncEventsResponse>

    @GET("v1/sync/pull")
    suspend fun pull(
        @Query("configVersion") configVersion: Int?,
    ): Response<SyncPullResponse>

    @POST("v1/devices/commands/{id}/result")
    suspend fun reportCommandResult(
        @Path("id") commandId: String,
        @Body body: CommandResultRequest,
    ): Response<Unit>
}
