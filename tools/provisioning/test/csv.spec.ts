import { detectDelimiter, parseFleetCsv } from '../src/lib/csv';

const BOM = '\ufeff';

/**
 * Le fichier de parc arrive d'un tableur, pas d'un programme. Ces tests
 * couvrent ce qu'on reçoit réellement : point-virgule, accents, BOM, guillemets,
 * colonnes en trop, et les fautes qu'il vaut mieux refuser tout de suite —
 * une étiquette en double finirait sur deux téléphones différents.
 */
describe('lecture du parc', () => {
  it('reconnaît le point-virgule des tableurs français', () => {
    expect(detectDelimiter('asset_tag;serial;depot')).toBe(';');
    expect(detectDelimiter('asset_tag,serial,depot')).toBe(',');
    expect(detectDelimiter('asset_tag\tserial\tdepot')).toBe('\t');
  });

  it('lit un fichier avec BOM, accents et retours Windows', () => {
    const fleet = parseFleetCsv(`${BOM}Étiquette;Dépôt;Mode\r\nTEL-001;Lyon Est;KIOSK\r\n`);

    expect(fleet.delimiter).toBe(';');
    expect(fleet.rows[0]).toMatchObject({
      assetTag: 'TEL-001',
      depot: 'Lyon Est',
      kioskMode: 'KIOSK',
    });
  });

  it('accepte les en-têtes usuels, quelle que soit leur casse ou leurs accents', () => {
    const fleet = parseFleetCsv(
      `${BOM}Asset Tag;DÉPÔT;Numéro de série\nTEL-001;Lyon Est;R58N70ABCDE\n`,
    );

    expect(fleet.rows[0]).toMatchObject({
      assetTag: 'TEL-001',
      depot: 'Lyon Est',
      serialNumber: 'R58N70ABCDE',
    });
  });

  it("refuse un fichier sans colonne d'étiquette", () => {
    expect(() => parseFleetCsv('couleur;depot\nnoir;Lyon\n')).toThrow(
      /étiquette d'inventaire/,
    );
  });

  it('respecte les guillemets et les séparateurs qu’ils protègent', () => {
    const text = 'asset_tag;depot\nTEL-001;"Lyon Est; bâtiment C"\n';

    expect(parseFleetCsv(text).rows[0].depot).toBe('Lyon Est; bâtiment C');
  });

  it('lit un guillemet échappé par doublement', () => {
    const text = 'asset_tag;depot\nTEL-001;"Dépôt ""Nord"""\n';

    expect(parseFleetCsv(text).rows[0].depot).toBe('Dépôt "Nord"');
  });

  it('normalise les étiquettes en majuscules', () => {
    expect(parseFleetCsv('asset_tag\ntel-001\n').rows[0].assetTag).toBe('TEL-001');
  });

  it('signale les colonnes inconnues sans bloquer', () => {
    const fleet = parseFleetCsv('asset_tag;couleur\nTEL-001;noir\n');

    expect(fleet.ignoredColumns).toEqual(['couleur']);
    expect(fleet.rows).toHaveLength(1);
  });

  it('refuse deux fois la même étiquette, en nommant les deux lignes', () => {
    const text = 'asset_tag\nTEL-001\nTEL-002\nTEL-001\n';

    expect(() => parseFleetCsv(text)).toThrow(/déjà présente ligne 2/);
  });

  it('refuse une étiquette au format invalide', () => {
    expect(() => parseFleetCsv('asset_tag\ntel 001\n')).toThrow(/refusée/);
    expect(() => parseFleetCsv('asset_tag\n-TEL\n')).toThrow(/refusée/);
  });

  it('refuse un mode kiosque inconnu', () => {
    expect(() => parseFleetCsv('asset_tag;mode\nTEL-001;VITRINE\n')).toThrow(
      /mode kiosque .* inconnu/,
    );
  });

  it('accepte les modes en minuscules et les remonte en majuscules', () => {
    expect(parseFleetCsv('asset_tag;mode\nTEL-001;restricted\n').rows[0].kioskMode).toBe(
      'RESTRICTED',
    );
  });

  it('ignore les lignes vides laissées en fin de fichier', () => {
    expect(parseFleetCsv('asset_tag\nTEL-001\n\n;\n\n').rows).toHaveLength(1);
  });

  it('refuse un fichier vide ou sans aucune ligne', () => {
    expect(() => parseFleetCsv('   ')).toThrow(/vide/);
    expect(() => parseFleetCsv('asset_tag\n')).toThrow(/aucune ligne/);
  });

  it('numérote les lignes comme le tableur, en-tête comprise', () => {
    const fleet = parseFleetCsv('asset_tag\nTEL-001\nTEL-002\n');

    expect(fleet.rows.map((row) => row.line)).toEqual([2, 3]);
  });
});
