-- Horodatage de notification des alertes.
--
-- Deux usages : savoir si une alerte a atteint un humain, et compter les envois
-- de l'heure écoulée pour la limite de débit. Un incident réseau peut produire
-- cinquante alertes en dix minutes ; au-delà du plafond, plus personne ne les
-- lit, et les suivantes noient les vraies.

ALTER TABLE "alerts" ADD COLUMN "notified_at" TIMESTAMPTZ(3);

-- Index partiel : seules les alertes déjà notifiées sont comptées, et elles
-- sont une minorité. Un index complet coûterait autant qu'il rapporte.
CREATE INDEX "alerts_notified_at_idx"
  ON "alerts" ("company_id", "notified_at")
  WHERE "notified_at" IS NOT NULL;
