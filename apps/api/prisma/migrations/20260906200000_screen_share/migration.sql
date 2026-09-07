-- Partage d'ecran avec accord du chauffeur.
--
-- Ce que cette table conserve, et ce qu'elle ne conserve pas, est le coeur du
-- dispositif : elle garde QUI a demande, POURQUOI, QUI a repondu, QUAND, et
-- COMBIEN d'images ont transite. Elle ne garde AUCUNE image. Les captures
-- passent par le canal temps reel et disparaissent.
--
-- Conserver l'ecran d'un chauffeur transformerait un outil d'assistance en
-- outil de surveillance. La distinction n'est pas rhetorique : elle change la
-- qualification juridique du traitement.

ALTER TYPE "CommandType" ADD VALUE IF NOT EXISTS 'REQUEST_SCREEN_SHARE';

CREATE TYPE "ScreenShareState" AS ENUM (
  'REQUESTED',
  'ACCEPTED',
  'REFUSED',
  'ENDED_BY_DRIVER',
  'ENDED_BY_ADMIN',
  'EXPIRED',
  'FAILED'
);

CREATE TABLE "screen_share_sessions" (
  "id"           UUID PRIMARY KEY,
  "company_id"   UUID NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "device_id"    UUID NOT NULL REFERENCES "devices"("id") ON DELETE CASCADE,
  "user_id"      UUID REFERENCES "users"("id") ON DELETE SET NULL,
  -- ON DELETE RESTRICT : on ne supprime pas un administrateur qui a demande a
  -- voir l'ecran de quelqu'un. La trace doit rester attribuable.
  "requested_by" UUID NOT NULL REFERENCES "admins"("id") ON DELETE RESTRICT,

  "reason"       TEXT NOT NULL,
  "state"        "ScreenShareState" NOT NULL DEFAULT 'REQUESTED',

  "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "responded_at" TIMESTAMPTZ(3),
  "started_at"   TIMESTAMPTZ(3),
  "ended_at"     TIMESTAMPTZ(3),
  "expires_at"   TIMESTAMPTZ(3) NOT NULL,

  "frame_count"  INTEGER NOT NULL DEFAULT 0,
  "detail"       TEXT,

  "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX "screen_share_sessions_company_requested_idx"
  ON "screen_share_sessions" ("company_id", "requested_at" DESC);

-- Sert a repondre en une requete a « ce telephone a-t-il un partage en cours ? »,
-- verification faite a chaque image recue.
CREATE INDEX "screen_share_sessions_device_state_idx"
  ON "screen_share_sessions" ("device_id", "state");
