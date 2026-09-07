-- =============================================================================
--  Objets PostgreSQL non exprimables dans le schéma Prisma.
--  CE FICHIER EST MAINTENU À LA MAIN — voir prisma/README.md
--
--  1. Partitionnement mensuel de location_events
--  2. Index uniques partiels (unicité conditionnelle)
--  3. Immuabilité du journal d'audit
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. PARTITIONNEMENT DE location_events
--
-- La table est déclarée PARTITION BY RANGE (recorded_at) dans la migration
-- précédente. Les partitions mensuelles sont créées à l'avance par le worker ;
-- la partition DEFAULT garantit qu'aucun événement n'est jamais rejeté, même si
-- la création anticipée a échoué.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_location_events_partition(p_month date)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := 'location_events_' || to_char(v_start, 'YYYY_MM');
BEGIN
  IF to_regclass(v_name) IS NOT NULL THEN
    RETURN v_name || ' (déjà présente)';
  END IF;

  EXECUTE format(
    'CREATE TABLE %I PARTITION OF location_events FOR VALUES FROM (%L) TO (%L)',
    v_name, v_start, v_end
  );

  RETURN v_name || ' (créée)';
END;
$$;

COMMENT ON FUNCTION create_location_events_partition(date) IS
  'Crée la partition mensuelle de location_events contenant la date fournie. Idempotente.';

-- Partition de repli : rien ne doit jamais être perdu faute de partition.
-- Note d''exploitation : attacher une nouvelle partition impose un scan de la
-- partition DEFAULT. Le worker doit donc créer les partitions à l''avance, en
-- pratique trois mois d''avance, pour que ce scan porte sur une table vide.
CREATE TABLE IF NOT EXISTS location_events_default
  PARTITION OF location_events DEFAULT;

-- Partitions du mois courant et des deux mois suivants.
SELECT create_location_events_partition(CURRENT_DATE);
SELECT create_location_events_partition((CURRENT_DATE + interval '1 month')::date);
SELECT create_location_events_partition((CURRENT_DATE + interval '2 months')::date);

-- Idempotence du rejeu des événements de position.
-- Sur une table partitionnée, tout index unique doit inclure la clé de
-- partitionnement : la cible de conflit applicative est donc
-- (recorded_at, event_id), que l'appareil fournit toujours.
CREATE UNIQUE INDEX IF NOT EXISTS location_events_recorded_at_event_id_uidx
  ON location_events ("recorded_at", "event_id");

-- -----------------------------------------------------------------------------
-- 2. INDEX UNIQUES PARTIELS
-- -----------------------------------------------------------------------------

-- Un même numéro de badge ne peut être actif qu'une fois par entreprise, mais
-- il peut être réémis après révocation.
CREATE UNIQUE INDEX IF NOT EXISTS badges_company_hash_active_uidx
  ON badges ("company_id", "barcode_hash")
  WHERE status <> 'REVOKED';

-- Une seule session active par téléphone, garanti par la base et non par le
-- code applicatif.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_active_per_device_uidx
  ON sessions ("device_id")
  WHERE status = 'ACTIVE';

-- Un chauffeur n'a qu'une session active à la fois, quel que soit le téléphone.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_active_per_user_uidx
  ON sessions ("user_id")
  WHERE status = 'ACTIVE';

-- Une seule affectation active par couple (utilisateur, téléphone).
CREATE UNIQUE INDEX IF NOT EXISTS device_assignments_active_uidx
  ON device_assignments ("user_id", "device_id")
  WHERE revoked_at IS NULL;

-- Déduplication des alertes : un téléphone hors ligne depuis trois heures
-- produit UNE alerte, pas cent quatre-vingts.
CREATE UNIQUE INDEX IF NOT EXISTS alerts_dedupe_open_uidx
  ON alerts ("company_id", "dedupe_key")
  WHERE status = 'OPEN' AND dedupe_key IS NOT NULL;

-- Une commande donnée n'est créée qu'une fois pour une clé d'idempotence.
CREATE UNIQUE INDEX IF NOT EXISTS device_commands_idempotency_uidx
  ON device_commands ("device_id", "idempotency_key")
  WHERE idempotency_key IS NOT NULL;

-- Index de récupération des commandes en attente (file par appareil).
CREATE INDEX IF NOT EXISTS device_commands_pending_idx
  ON device_commands ("device_id", "priority" DESC, "created_at")
  WHERE status IN ('PENDING', 'SENT');

-- -----------------------------------------------------------------------------
-- 3. IMMUABILITÉ DU JOURNAL D'AUDIT
--
-- Un trigger, et non une révocation de privilège : l'application se connecte
-- avec le propriétaire de la base, sur lequel un REVOKE serait sans effet.
-- -----------------------------------------------------------------------------

-- Le UPDATE est interdit sans exception. Le DELETE l'est aussi, sauf pour la
-- tâche de purge RGPD, qui doit positionner explicitement app.audit_purge = 'on'
-- dans sa transaction. Une purge est ainsi toujours un acte délibéré, jamais un
-- effet de bord d'une requête applicative.
CREATE OR REPLACE FUNCTION audit_logs_deny_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'audit_logs est une table en insertion seule (tentative de %)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_deny_mutation();

DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_deny_mutation();
