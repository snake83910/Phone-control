-- Extensions requises. Repetees ici (et pas seulement dans l'init Docker) afin
-- que la base fantome utilisee par `prisma migrate dev` les possede aussi.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;

-- CreateEnum
CREATE TYPE "CompanyStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'COMPANY_ADMIN', 'DEPOT_ADMIN', 'VIEWER');

-- CreateEnum
CREATE TYPE "AdminStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "DepotStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "BadgeStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'REVOKED', 'LOST');

-- CreateEnum
CREATE TYPE "BarcodeType" AS ENUM ('CODE_128', 'CODE_39', 'QR_CODE', 'NFC');

-- CreateEnum
CREATE TYPE "DeviceEnrollmentStatus" AS ENUM ('PENDING', 'ENROLLED', 'REVOKED', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "KioskMode" AS ENUM ('KIOSK', 'RESTRICTED', 'STANDARD');

-- CreateEnum
CREATE TYPE "DeviceState" AS ENUM ('UNKNOWN', 'LOCKED', 'ACTIVE', 'RETURNED', 'LOCKING');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'ENDED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SessionState" AS ENUM ('ACTIVE', 'RETURNED');

-- CreateEnum
CREATE TYPE "SessionEndReason" AS ENUM ('NEW_SESSION', 'ADMIN_LOGOUT', 'SCHEDULED_LOCK', 'EXPIRED', 'REVOKED', 'OFFLINE_REVALIDATION_FAILED');

-- CreateEnum
CREATE TYPE "GeofenceType" AS ENUM ('DEPOT', 'ZONE', 'FORBIDDEN');

-- CreateEnum
CREATE TYPE "GeofenceEventType" AS ENUM ('ENTER_DEPOT', 'EXIT_DEPOT', 'ENTER_DEPOT_AFTER_RETURN_TIME', 'AFTER_RETURN_EXIT');

-- CreateEnum
CREATE TYPE "BarcodeScanResult" AS ENUM ('SUCCESS', 'UNKNOWN_BADGE', 'BADGE_INACTIVE', 'BADGE_REVOKED', 'USER_INACTIVE', 'DEVICE_UNKNOWN', 'DEVICE_NOT_ENROLLED', 'DEVICE_REVOKED', 'DEVICE_NOT_AUTHORIZED', 'COMPANY_MISMATCH', 'RATE_LIMITED', 'OFFLINE_GRANTED', 'OFFLINE_DENIED');

-- CreateEnum
CREATE TYPE "SecuritySeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "SecurityEventType" AS ENUM ('LOGIN_SUCCESS', 'LOGIN_FAILED', 'UNKNOWN_BADGE', 'UNAUTHORIZED_USER', 'ENTER_DEPOT', 'EXIT_DEPOT', 'AFTER_RETURN_EXIT', 'LOCK_DEVICE', 'UNLOCK_DEVICE', 'DEVICE_OFFLINE', 'LOCATION_DISABLED', 'COMMAND_FAILED', 'ROOT_DETECTED', 'DEBUGGER_ATTACHED', 'ADB_ENABLED', 'CLOCK_TAMPERING', 'MOCK_LOCATION', 'KIOSK_EXIT_ATTEMPT', 'DEVICE_OWNER_LOST', 'APP_INTEGRITY_FAILED', 'SESSION_STARTED', 'SESSION_ENDED');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('AFTER_RETURN_EXIT', 'UNKNOWN_BADGE', 'UNAUTHORIZED_USER', 'DEVICE_OFFLINE', 'LOCATION_DISABLED', 'SECURITY_EVENT', 'DEVICE_TAMPERING', 'BATTERY_LOW', 'NOT_RETURNED', 'LOCK_FAILED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'AUTO_CLOSED');

-- CreateEnum
CREATE TYPE "CommandType" AS ENUM ('LOCK_DEVICE', 'UNLOCK_DEVICE', 'FORCE_LOGOUT', 'SYNC_SETTINGS', 'REVOKE_SESSION', 'REFRESH_CONFIGURATION', 'REBOOT', 'WIPE_DEVICE', 'LOCATE_NOW', 'COLLECT_DIAGNOSTICS', 'DECOMMISSION_DEVICE');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'EXECUTED', 'FAILED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" CITEXT NOT NULL,
    "status" "CompanyStatus" NOT NULL DEFAULT 'ACTIVE',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admins" (
    "id" UUID NOT NULL,
    "company_id" UUID,
    "email" CITEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL,
    "depot_scope" UUID[],
    "mfa_secret" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" "AdminStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMPTZ(3),
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_refresh_tokens" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "admin_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "depots" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "radius_meters" INTEGER NOT NULL DEFAULT 250,
    "exit_hysteresis_meters" INTEGER NOT NULL DEFAULT 75,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Paris',
    "return_time" TEXT NOT NULL DEFAULT '18:00',
    "lock_time" TEXT NOT NULL DEFAULT '22:00',
    "operational_day_start" TEXT NOT NULL DEFAULT '04:00',
    "schedule_overrides" JSONB NOT NULL DEFAULT '{}',
    "wifi_hints" JSONB NOT NULL DEFAULT '[]',
    "status" "DepotStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "depots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "depot_id" UUID,
    "employee_number" TEXT,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "anonymized_at" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "badges" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "barcode_hash" BYTEA NOT NULL,
    "hash_version" INTEGER NOT NULL DEFAULT 1,
    "barcode_last4" TEXT NOT NULL,
    "barcode_length" INTEGER NOT NULL,
    "barcode_ciphertext" BYTEA,
    "barcode_type" "BarcodeType" NOT NULL DEFAULT 'CODE_128',
    "status" "BadgeStatus" NOT NULL DEFAULT 'ACTIVE',
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" UUID,
    "revoke_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "depot_id" UUID,
    "asset_tag" TEXT NOT NULL,
    "serial_number" TEXT,
    "imei" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "android_version" TEXT,
    "app_version" TEXT,
    "enrollment_status" "DeviceEnrollmentStatus" NOT NULL DEFAULT 'PENDING',
    "device_owner_active" BOOLEAN NOT NULL DEFAULT false,
    "kiosk_mode" "KioskMode" NOT NULL DEFAULT 'KIOSK',
    "state" "DeviceState" NOT NULL DEFAULT 'UNKNOWN',
    "last_seen_at" TIMESTAMPTZ(3),
    "last_sync_at" TIMESTAMPTZ(3),
    "battery_level" SMALLINT,
    "is_charging" BOOLEAN,
    "gps_enabled" BOOLEAN,
    "network_type" TEXT,
    "storage_free_mb" INTEGER,
    "last_latitude" DOUBLE PRECISION,
    "last_longitude" DOUBLE PRECISION,
    "last_accuracy" DOUBLE PRECISION,
    "last_location_at" TIMESTAMPTZ(3),
    "fcm_token" TEXT,
    "public_key" BYTEA,
    "offline_key" BYTEA,
    "enrolled_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_credentials" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "device_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollment_tokens" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "depot_id" UUID,
    "device_id" UUID,
    "token_hash" TEXT NOT NULL,
    "asset_tag" TEXT,
    "kiosk_mode" "KioskMode" NOT NULL DEFAULT 'KIOSK',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrollment_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_assignments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "valid_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "device_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "depot_id" UUID,
    "badge_id" UUID,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" "SessionEndReason",
    "status" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "state" "SessionState" NOT NULL DEFAULT 'ACTIVE',
    "returned_at" TIMESTAMPTZ(3),
    "returned_latitude" DOUBLE PRECISION,
    "returned_longitude" DOUBLE PRECISION,
    "returned_accuracy" DOUBLE PRECISION,
    "opened_offline" BOOLEAN NOT NULL DEFAULT false,
    "offline_validated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "geofences" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "depot_id" UUID,
    "name" TEXT NOT NULL,
    "type" "GeofenceType" NOT NULL DEFAULT 'DEPOT',
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "radius_meters" INTEGER NOT NULL DEFAULT 250,
    "hysteresis_meters" INTEGER NOT NULL DEFAULT 75,
    "min_dwell_seconds" INTEGER NOT NULL DEFAULT 60,
    "polygon" JSONB,
    "status" "DepotStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "geofences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_events" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "session_id" UUID,
    "user_id" UUID,
    "depot_id" UUID,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy_meters" DOUBLE PRECISION,
    "altitude" DOUBLE PRECISION,
    "speed_mps" DOUBLE PRECISION,
    "bearing" DOUBLE PRECISION,
    "provider" TEXT,
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "battery_level" SMALLINT,
    "inside_geofence" BOOLEAN,

    CONSTRAINT "location_events_pkey" PRIMARY KEY ("recorded_at","id")
) PARTITION BY RANGE ("recorded_at");

-- CreateTable
CREATE TABLE "geofence_events" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "user_id" UUID,
    "session_id" UUID,
    "depot_id" UUID,
    "geofence_id" UUID,
    "event_type" "GeofenceEventType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy_meters" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "evaluation" JSONB NOT NULL DEFAULT '{}',
    "created_alert_id" UUID,

    CONSTRAINT "geofence_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "barcode_scan_events" (
    "id" UUID NOT NULL,
    "event_id" UUID,
    "company_id" UUID NOT NULL,
    "device_id" UUID,
    "badge_id" UUID,
    "user_id" UUID,
    "barcode_hash" BYTEA,
    "barcode_last4" TEXT,
    "result" "BarcodeScanResult" NOT NULL,
    "scanned_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "offline" BOOLEAN NOT NULL DEFAULT false,
    "session_id" UUID,
    "ip" TEXT,

    CONSTRAINT "barcode_scan_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" UUID NOT NULL,
    "event_id" UUID,
    "company_id" UUID NOT NULL,
    "device_id" UUID,
    "user_id" UUID,
    "session_id" UUID,
    "type" "SecurityEventType" NOT NULL,
    "severity" "SecuritySeverity" NOT NULL DEFAULT 'LOW',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "device_id" UUID,
    "user_id" UUID,
    "depot_id" UUID,
    "session_id" UUID,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'MEDIUM',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "context" JSONB NOT NULL DEFAULT '{}',
    "dedupe_key" TEXT,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMPTZ(3),
    "acknowledged_by" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by" UUID,
    "resolution_note" TEXT,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_commands" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "command" "CommandType" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "CommandStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "sent_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "executed_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "device_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_settings" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "device_id" UUID,
    "depot_id" UUID,
    "location_interval_active_seconds" INTEGER NOT NULL DEFAULT 60,
    "location_interval_idle_seconds" INTEGER NOT NULL DEFAULT 300,
    "location_min_distance_meters" INTEGER NOT NULL DEFAULT 50,
    "heartbeat_interval_seconds" INTEGER NOT NULL DEFAULT 300,
    "sync_interval_seconds" INTEGER NOT NULL DEFAULT 900,
    "offline_auth_enabled" BOOLEAN NOT NULL DEFAULT true,
    "offline_auth_max_duration_minutes" INTEGER NOT NULL DEFAULT 480,
    "offline_cache_max_age_minutes" INTEGER NOT NULL DEFAULT 1440,
    "session_max_duration_minutes" INTEGER NOT NULL DEFAULT 960,
    "battery_alert_threshold" INTEGER NOT NULL DEFAULT 15,
    "offline_alert_delay_minutes" INTEGER NOT NULL DEFAULT 30,
    "gps_accuracy_threshold_meters" INTEGER NOT NULL DEFAULT 100,
    "geofence_confirmation_seconds" INTEGER NOT NULL DEFAULT 120,
    "geofence_confirmation_samples" INTEGER NOT NULL DEFAULT 3,
    "allowed_apps" JSONB NOT NULL DEFAULT '[]',
    "kiosk_features" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "device_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_policies" (
    "company_id" UUID NOT NULL,
    "location_events_days" INTEGER NOT NULL DEFAULT 90,
    "geofence_events_days" INTEGER NOT NULL DEFAULT 365,
    "security_events_days" INTEGER NOT NULL DEFAULT 365,
    "sessions_days" INTEGER NOT NULL DEFAULT 1095,
    "audit_logs_days" INTEGER NOT NULL DEFAULT 1825,
    "anonymize_after_days" INTEGER,
    "allow_locate_when_locked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "retention_policies_pkey" PRIMARY KEY ("company_id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "company_id" UUID,
    "admin_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "correlation_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_slug_key" ON "companies"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "admins_email_key" ON "admins"("email");

-- CreateIndex
CREATE INDEX "admins_company_id_status_idx" ON "admins"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "admin_refresh_tokens_token_hash_key" ON "admin_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "admin_refresh_tokens_admin_id_family_id_idx" ON "admin_refresh_tokens"("admin_id", "family_id");

-- CreateIndex
CREATE INDEX "admin_refresh_tokens_expires_at_idx" ON "admin_refresh_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "depots_company_id_status_idx" ON "depots"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "depots_company_id_code_key" ON "depots"("company_id", "code");

-- CreateIndex
CREATE INDEX "users_company_id_status_idx" ON "users"("company_id", "status");

-- CreateIndex
CREATE INDEX "users_company_id_last_name_first_name_idx" ON "users"("company_id", "last_name", "first_name");

-- CreateIndex
CREATE UNIQUE INDEX "users_company_id_employee_number_key" ON "users"("company_id", "employee_number");

-- CreateIndex
CREATE INDEX "badges_company_id_barcode_hash_idx" ON "badges"("company_id", "barcode_hash");

-- CreateIndex
CREATE INDEX "badges_user_id_status_idx" ON "badges"("user_id", "status");

-- CreateIndex
CREATE INDEX "devices_company_id_enrollment_status_idx" ON "devices"("company_id", "enrollment_status");

-- CreateIndex
CREATE INDEX "devices_company_id_state_idx" ON "devices"("company_id", "state");

-- CreateIndex
CREATE INDEX "devices_company_id_last_seen_at_idx" ON "devices"("company_id", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "devices_company_id_asset_tag_key" ON "devices"("company_id", "asset_tag");

-- CreateIndex
CREATE UNIQUE INDEX "device_credentials_refresh_token_hash_key" ON "device_credentials"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "device_credentials_device_id_family_id_idx" ON "device_credentials"("device_id", "family_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrollment_tokens_token_hash_key" ON "enrollment_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "enrollment_tokens_company_id_expires_at_idx" ON "enrollment_tokens"("company_id", "expires_at");

-- CreateIndex
CREATE INDEX "device_assignments_user_id_revoked_at_idx" ON "device_assignments"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "device_assignments_device_id_revoked_at_idx" ON "device_assignments"("device_id", "revoked_at");

-- CreateIndex
CREATE INDEX "device_assignments_company_id_idx" ON "device_assignments"("company_id");

-- CreateIndex
CREATE INDEX "sessions_company_id_status_idx" ON "sessions"("company_id", "status");

-- CreateIndex
CREATE INDEX "sessions_device_id_started_at_idx" ON "sessions"("device_id", "started_at");

-- CreateIndex
CREATE INDEX "sessions_user_id_started_at_idx" ON "sessions"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "geofences_company_id_status_idx" ON "geofences"("company_id", "status");

-- CreateIndex
CREATE INDEX "geofences_depot_id_idx" ON "geofences"("depot_id");

-- CreateIndex
CREATE INDEX "location_events_company_id_device_id_recorded_at_idx" ON "location_events"("company_id", "device_id", "recorded_at");

-- CreateIndex
CREATE INDEX "location_events_session_id_recorded_at_idx" ON "location_events"("session_id", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "geofence_events_event_id_key" ON "geofence_events"("event_id");

-- CreateIndex
CREATE INDEX "geofence_events_company_id_occurred_at_idx" ON "geofence_events"("company_id", "occurred_at");

-- CreateIndex
CREATE INDEX "geofence_events_device_id_occurred_at_idx" ON "geofence_events"("device_id", "occurred_at");

-- CreateIndex
CREATE INDEX "geofence_events_session_id_occurred_at_idx" ON "geofence_events"("session_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "barcode_scan_events_event_id_key" ON "barcode_scan_events"("event_id");

-- CreateIndex
CREATE INDEX "barcode_scan_events_company_id_scanned_at_idx" ON "barcode_scan_events"("company_id", "scanned_at");

-- CreateIndex
CREATE INDEX "barcode_scan_events_device_id_scanned_at_idx" ON "barcode_scan_events"("device_id", "scanned_at");

-- CreateIndex
CREATE INDEX "barcode_scan_events_barcode_hash_idx" ON "barcode_scan_events"("barcode_hash");

-- CreateIndex
CREATE UNIQUE INDEX "security_events_event_id_key" ON "security_events"("event_id");

-- CreateIndex
CREATE INDEX "security_events_company_id_occurred_at_idx" ON "security_events"("company_id", "occurred_at");

-- CreateIndex
CREATE INDEX "security_events_device_id_occurred_at_idx" ON "security_events"("device_id", "occurred_at");

-- CreateIndex
CREATE INDEX "security_events_company_id_type_occurred_at_idx" ON "security_events"("company_id", "type", "occurred_at");

-- CreateIndex
CREATE INDEX "alerts_company_id_status_created_at_idx" ON "alerts"("company_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "alerts_device_id_created_at_idx" ON "alerts"("device_id", "created_at");

-- CreateIndex
CREATE INDEX "alerts_company_id_type_created_at_idx" ON "alerts"("company_id", "type", "created_at");

-- CreateIndex
CREATE INDEX "device_commands_device_id_status_priority_created_at_idx" ON "device_commands"("device_id", "status", "priority", "created_at");

-- CreateIndex
CREATE INDEX "device_commands_company_id_created_at_idx" ON "device_commands"("company_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "device_settings_device_id_key" ON "device_settings"("device_id");

-- CreateIndex
CREATE INDEX "device_settings_company_id_idx" ON "device_settings"("company_id");

-- CreateIndex
CREATE INDEX "audit_logs_company_id_created_at_idx" ON "audit_logs"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_admin_id_created_at_idx" ON "audit_logs"("admin_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_idx" ON "audit_logs"("resource_type", "resource_id");

-- AddForeignKey
ALTER TABLE "admins" ADD CONSTRAINT "admins_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_refresh_tokens" ADD CONSTRAINT "admin_refresh_tokens_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "depots" ADD CONSTRAINT "depots_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_depot_id_fkey" FOREIGN KEY ("depot_id") REFERENCES "depots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "badges" ADD CONSTRAINT "badges_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "badges" ADD CONSTRAINT "badges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_depot_id_fkey" FOREIGN KEY ("depot_id") REFERENCES "depots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_depot_id_fkey" FOREIGN KEY ("depot_id") REFERENCES "depots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_assignments" ADD CONSTRAINT "device_assignments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_assignments" ADD CONSTRAINT "device_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_assignments" ADD CONSTRAINT "device_assignments_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_depot_id_fkey" FOREIGN KEY ("depot_id") REFERENCES "depots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geofences" ADD CONSTRAINT "geofences_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geofences" ADD CONSTRAINT "geofences_depot_id_fkey" FOREIGN KEY ("depot_id") REFERENCES "depots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geofence_events" ADD CONSTRAINT "geofence_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geofence_events" ADD CONSTRAINT "geofence_events_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geofence_events" ADD CONSTRAINT "geofence_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geofence_events" ADD CONSTRAINT "geofence_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geofence_events" ADD CONSTRAINT "geofence_events_depot_id_fkey" FOREIGN KEY ("depot_id") REFERENCES "depots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geofence_events" ADD CONSTRAINT "geofence_events_geofence_id_fkey" FOREIGN KEY ("geofence_id") REFERENCES "geofences"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barcode_scan_events" ADD CONSTRAINT "barcode_scan_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barcode_scan_events" ADD CONSTRAINT "barcode_scan_events_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barcode_scan_events" ADD CONSTRAINT "barcode_scan_events_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barcode_scan_events" ADD CONSTRAINT "barcode_scan_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_depot_id_fkey" FOREIGN KEY ("depot_id") REFERENCES "depots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_settings" ADD CONSTRAINT "device_settings_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_settings" ADD CONSTRAINT "device_settings_depot_id_fkey" FOREIGN KEY ("depot_id") REFERENCES "depots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
