import { Logger } from '@nestjs/common';
import { createPushTransport } from './fcm';

/**
 * Lecture de la clé de service FCM.
 *
 * ── Ce qui est en jeu ───────────────────────────────────────────────────
 * Une clé mal lue ne provoque aucune panne visible : le transport se
 * désactive, l'API démarre, et les téléphones retombent sur le sondage de
 * quinze minutes. On s'en aperçoit le jour où un verrouillage urgent n'arrive
 * pas — c'est-à-dire au pire moment.
 */

const COMPTE = {
  project_id: 'trajelys',
  client_email: 'fcm@trajelys.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
};

function transport(valeur: string | undefined) {
  const logger = new Logger('test');
  jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  return { t: createPushTransport(valeur, logger), logger };
}

describe('clé de service FCM', () => {
  it('accepte le JSON brut', () => {
    const { logger } = transport(JSON.stringify(COMPTE));
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('trajelys'));
  });

  it('accepte le même contenu encodé en base64', () => {
    // La forme à privilégier : une clé de service traverse le fichier .env,
    // Docker Compose et le shell, et il suffit qu'un seul des trois
    // interprète un guillemet pour tout casser.
    const b64 = Buffer.from(JSON.stringify(COMPTE), 'utf8').toString('base64');
    const { logger } = transport(b64);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('trajelys'));
  });

  it('se désactive sans clé, sans bruit', () => {
    // Une installation qui ne veut pas de Google doit démarrer normalement.
    const { logger } = transport('');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('se désactive sur une clé illisible, et le DIT', () => {
    // Le silence serait pire que la panne : l'exploitant croirait le réveil
    // actif.
    const { logger } = transport('ceci-nest-pas-une-clef');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('inutilisable'));
  });

  it('ne démarre pas sur une clé privée absente', () => {
    const sansClef = { ...COMPTE, private_key: 'rien du tout' };
    const { logger } = transport(JSON.stringify(sansClef));
    expect(logger.error).toHaveBeenCalled();
  });
});
