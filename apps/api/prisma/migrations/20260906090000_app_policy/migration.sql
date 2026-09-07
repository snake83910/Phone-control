-- Politique d'applications : ce que le telephone doit masquer, et ce qu'il a
-- reellement masque.
--
-- Deux colonnes distinctes, et c'est delibere :
--   * `device_settings.blocked_apps` est la DEMANDE de l'administrateur ;
--   * `devices.app_policy_report` est le CONSTAT rapporte par le telephone.
--
-- Le tableau de bord affiche le constat. Sans cette separation, il afficherait
-- une liste d'applications bloquees alors que le telephone n'a peut-etre rien
-- pu bloquer -- faute de Device Owner, par exemple (specification §67).

ALTER TABLE "device_settings"
  ADD COLUMN "blocked_apps" JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "devices"
  ADD COLUMN "app_policy_report" JSONB,
  ADD COLUMN "app_policy_applied_at" TIMESTAMPTZ(3);
