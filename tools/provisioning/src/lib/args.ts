import { ProvisioningError } from '@phone-control/provisioning-payload';

/**
 * Analyse des arguments de la ligne de commande.
 *
 * Écrit à la main, pour une raison simple : cet outil manipule des jetons
 * d'enrôlement, et chaque dépendance ajoutée est une dépendance à surveiller.
 * Trois formes suffisent : `--clé valeur`, `--clé=valeur`, `--drapeau`.
 */

export interface ParsedArgs {
  command?: string;
  flags: Record<string, string | boolean>;
  positional: string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    if (argument.startsWith('--')) {
      const body = argument.slice(2);
      const equals = body.indexOf('=');

      if (equals >= 0) {
        flags[body.slice(0, equals)] = body.slice(equals + 1);
        continue;
      }

      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
        index++;
      } else {
        flags[body] = true;
      }
      continue;
    }

    if (argument === '-h') {
      flags.help = true;
      continue;
    }

    if (command === undefined) command = argument;
    else positional.push(argument);
  }

  return { command, flags, positional };
}

export function requireString(
  flags: Record<string, string | boolean>,
  name: string,
  hint?: string,
): string {
  const value = flags[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProvisioningError(`L'option --${name} est obligatoire.`, hint);
  }
  return value;
}

export function optionalString(
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function boolean(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}
