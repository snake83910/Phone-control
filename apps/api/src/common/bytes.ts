/**
 * Conversions Buffer <-> Uint8Array.
 *
 * Prisma 6 expose les colonnes `bytea` en `Uint8Array<ArrayBuffer>`, tandis que
 * l'API crypto de Node produit des `Buffer<ArrayBufferLike>`. Les deux sont
 * identiques à l'exécution mais incompatibles pour TypeScript : ces deux
 * fonctions évitent d'éparpiller des `as never` dans le code métier.
 */
export function toBytes(value: Buffer | Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(value.byteLength));
  out.set(value);
  return out;
}

export function toBuffer(value: Uint8Array | Buffer | null): Buffer | null {
  return value === null ? null : Buffer.from(value);
}
