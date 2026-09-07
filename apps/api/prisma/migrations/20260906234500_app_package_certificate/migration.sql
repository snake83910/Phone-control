-- Sujet et validite du certificat de signature, conserves au depot.
--
-- Relire le bloc de signature a chaque affichage supposerait de lire le fichier
-- entier : cent lignes de catalogue chargeraient plusieurs giga-octets pour
-- afficher un tableau. Ces deux colonnes evitent ce cout, et permettent surtout
-- que l'operateur VOIE qui a signe une application avant de la deployer.

ALTER TABLE "app_packages"
  ADD COLUMN "signing_cert_subject" TEXT,
  ADD COLUMN "signing_cert_valid_to" TIMESTAMPTZ(3);
