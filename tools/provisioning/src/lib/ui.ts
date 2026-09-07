/**
 * Sortie de la ligne de commande.
 *
 * Seul fichier autorisé à écrire sur la console (voir eslint.config.mjs) : tout
 * le reste de l'outil passe par ici. Cela garantit qu'aucun secret ne s'échappe
 * par un `console.log` oublié dans un module métier.
 */

const useColor =
  process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

/** Caractère d'échappement ANSI, écrit par son code pour rester lisible en clair. */
const ESC = String.fromCharCode(27);

const paint = (code: string, text: string): string =>
  useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text;

export const ui = {
  /** Ligne brute, sans décoration. */
  line(text = ''): void {
    console.log(text);
  },

  heading(text: string): void {
    console.log('');
    console.log(paint('1', text));
    console.log(paint('2', '─'.repeat(Math.min(text.length, 72))));
  },

  info(text: string): void {
    console.log(text);
  },

  detail(label: string, value: string): void {
    console.log(`  ${paint('2', label.padEnd(22))} ${value}`);
  },

  success(text: string): void {
    console.log(`${paint('32', '✓')} ${text}`);
  },

  /** Avertissement : l'opération continue, mais quelque chose mérite un regard. */
  warn(text: string): void {
    console.log(`${paint('33', '!')} ${text}`);
  },

  /** Erreur : sur stderr, pour rester séparable de la sortie utile. */
  fail(text: string): void {
    console.error(`${paint('31', '✗')} ${text}`);
  },

  step(text: string): void {
    console.log(`${paint('36', '→')} ${text}`);
  },

  /** Tableau simple, colonnes alignées sur le contenu le plus large. */
  table(headers: string[], rows: string[][]): void {
    const widths = headers.map((header, index) =>
      Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
    );
    const render = (cells: string[]): string =>
      cells.map((cell, index) => (cell ?? '').padEnd(widths[index])).join('  ');

    console.log(paint('1', render(headers)));
    console.log(paint('2', widths.map((width) => '─'.repeat(width)).join('  ')));
    for (const row of rows) console.log(render(row));
  },
};
