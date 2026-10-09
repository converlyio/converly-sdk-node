/**
 * The package version, sent as the `User-Agent` on every webhook request
 * (`@converly/sdk-node/<VERSION>`).
 *
 * Kept in lockstep with `package.json` — `test/version.test.ts` fails the
 * build if the two ever drift, which is the historical bug this constant
 * replaces (the old SDK hard-coded `0.1.0` in the User-Agent while the
 * package was `0.2.0`).
 *
 * @internal
 * @example
 * import { VERSION } from './version';
 * console.log(VERSION); // "1.0.0"
 */
export const VERSION = '1.0.2';
