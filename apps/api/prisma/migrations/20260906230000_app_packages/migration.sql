-- Deploiement d'applications sur la flotte.
--
-- Cette fonction est la plus puissante du systeme : « installe l'APK qui se
-- trouve ici » est une execution de code arbitraire sur deux mille telephones.
-- D'ou la forme de cette table.
--
-- Les deux empreintes sont calculees PAR LE SERVEUR a la reception du fichier,
-- jamais saisies par l'operateur. Une empreinte declaree par celui qui depose
-- le fichier ne verifierait rien : elle decrirait le fichier depose, quel qu'il
-- soit.
--
-- Ce qu'elles protegent reellement, et ce qu'elles ne protegent pas, est
-- documente en docs/19.

ALTER TYPE "CommandType" ADD VALUE IF NOT EXISTS 'INSTALL_APP';
ALTER TYPE "CommandType" ADD VALUE IF NOT EXISTS 'UNINSTALL_APP';

CREATE TABLE "app_packages" (
  "id"         UUID PRIMARY KEY,
  "company_id" UUID NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,

  "label"  TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "signing_cert_sha256" TEXT NOT NULL,
  "size_bytes"   INTEGER NOT NULL,
  "storage_path" TEXT NOT NULL,

  -- Renseignes par le PREMIER telephone qui installe : le serveur ne sait pas
  -- lire le manifeste binaire d'un APK, et prefere l'ignorer plutot que de
  -- l'inventer a partir d'une saisie.
  "package_name" TEXT,
  "version_name" TEXT,
  "version_code" INTEGER,

  -- ON DELETE RESTRICT : on ne supprime pas l'administrateur qui a pousse une
  -- application sur la flotte. La trace doit rester attribuable.
  "created_by" UUID NOT NULL REFERENCES "admins"("id") ON DELETE RESTRICT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  -- Retire du catalogue : le fichier est supprime, la ligne reste. Elle
  -- explique les installations deja faites.
  "retired_at" TIMESTAMPTZ(3)
);

CREATE INDEX "app_packages_company_created_idx"
  ON "app_packages" ("company_id", "created_at" DESC);
