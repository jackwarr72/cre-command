/**
 * @cre/adapters
 *
 * Source-specific capture & normalization. Adapters convert raw HTML into
 * validated `ListingCandidate`s — they never touch the database and never
 * perform HTTP. Fetching, policy enforcement, and deduplication live in the
 * crawler layer.
 */

export { vivanunciosAdapter } from './sources/vivanuncios/adapter';
export type { AdapterError, SourceAdapter, SourceAdapterResult } from './types';
export {
  canonicalizeUrl,
  collapseWhitespace,
  normalizeText,
  parseDate,
  parsePrice,
  parseSize,
} from './normalize';
export type { ParsedPrice, ParsedSize } from './normalize';