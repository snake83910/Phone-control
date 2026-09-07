/**
 * Erreur attendue de l'outil : une situation que l'opérateur d'atelier peut
 * corriger lui-même. Elle est affichée telle quelle, sans pile d'appels, avec
 * une indication de la marche à suivre.
 *
 * Toute autre exception est un défaut de l'outil et sort avec sa pile complète.
 */
export class ProvisioningError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ProvisioningError';
  }
}
