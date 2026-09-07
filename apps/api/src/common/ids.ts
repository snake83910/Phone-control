import { v7 as uuidv7 } from 'uuid';

/**
 * Tous les identifiants applicatifs sont des UUID v7.
 *
 * L'UUID v7 est ordonné dans le temps : il préserve la localité d'insertion des
 * index B-tree, là où l'UUID v4 la détruit. Sur les tables d'événements
 * (des centaines de millions de lignes), l'écart de performance en écriture est
 * de l'ordre d'un facteur 3.
 */
export function newId(): string {
  return uuidv7();
}
