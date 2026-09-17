-- Rétention des positions GPS : 90 jours -> 60.
--
-- La CNIL pose deux mois en base active pour la géolocalisation de salariés.
-- Les 90 jours d'origine dépassaient ce plafond ; l'année supplémentaire
-- qu'elle admet parfois relève de l'archivage intermédiaire et suppose que la
-- preuve ne puisse être apportée autrement, ce qui n'est pas le cas ici.
--
-- Les lignes existantes sont ramenées sous le plafond en même temps que le
-- défaut : laisser une entreprise déjà créée à 90 jours reviendrait à corriger
-- la valeur par défaut sans corriger les installations. Aucune valeur
-- inférieure n'est touchée — un client plus strict que la règle le reste.
ALTER TABLE "retention_policies"
  ALTER COLUMN "location_events_days" SET DEFAULT 60;

UPDATE "retention_policies"
   SET "location_events_days" = 60,
       "updated_at" = now()
 WHERE "location_events_days" > 60;
