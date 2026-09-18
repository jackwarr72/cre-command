import { createVivanunciosAdapter } from '../vivanuncios/adapter';

/**
 * Vivanuncios Metepec (Toluca metro area) — registered under the source key
 * `vivanuncios_metepec`.
 *
 * Same site and HTML vocabulary as the base Vivanuncios source; a distinct
 * identity keeps its listings, crawl runs, and source health separate while
 * reusing the single Vivanuncios capture implementation.
 */
export const vivanunciosMetepecAdapter = createVivanunciosAdapter('vivanuncios_metepec');