-- Horodatage suspect : événements datés dans le futur par l'appareil.
--
-- docs/05, résolution des conflits : « Événement daté dans le futur → accepté,
-- horodaté received_at, marqué clock_suspect ». Rien n'est rejeté — une preuve
-- horodatée de travers reste une preuve, et la refuser reviendrait à effacer ce
-- qu'on cherche justement à constater. Elle est seulement signalée, pour qu'une
-- alerte contestée puisse l'être en connaissance de cause.
--
-- Migration écrite à la main plutôt que générée : `prisma migrate dev` propose
-- de supprimer les partitions, index partiels et triggers que le schéma Prisma
-- ne sait pas décrire (voir prisma/README.md). Ici l'ajout est purement additif.

-- La table est partitionnée : PostgreSQL propage la colonne à toutes les
-- partitions existantes et futures.
ALTER TABLE "location_events"
  ADD COLUMN "clock_suspect" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "geofence_events"
  ADD COLUMN "clock_suspect" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "barcode_scan_events"
  ADD COLUMN "clock_suspect" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "security_events"
  ADD COLUMN "clock_suspect" BOOLEAN NOT NULL DEFAULT false;

-- Index partiel : les événements suspects sont rares par construction. Un index
-- complet coûterait autant qu'il rapporte ; celui-ci ne contient que les lignes
-- que l'exploitation ira réellement chercher.
CREATE INDEX "security_events_clock_suspect_idx"
  ON "security_events" ("company_id", "occurred_at")
  WHERE "clock_suspect";
