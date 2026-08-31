import type { ListingCandidate } from '@cre/shared';

/** A per-card parse problem. Adapters never throw on malformed input; they report. */
export interface AdapterError {
  message: string;
  context?: Record<string, unknown>;
}

/** Result of parsing one page: validated candidates plus diagnostics. */
export interface SourceAdapterResult {
  candidates: ListingCandidate[];
  errors: AdapterError[];
}

/**
 * A source-specific adapter:
 *
 * - parses raw HTML captured from a source,
 * - normalizes it into the shared `ListingCandidate` shape,
 * - validates every candidate with `listingCandidateSchema`.
 *
 * Adapters are intentionally DB-independent: they never receive a database
 * client and never persist anything. They also never perform HTTP; fetching,
 * robots/rate-limit policy, and retries live in the crawler layer.
 */
export interface SourceAdapter {
  /** Uniquely identifies this source, e.g. `vivanuncios`. */
  readonly sourceKey: string;
  /** True when this adapter can handle the given source URL. */
  canHandle(url: string): boolean;
  /** Parse one page of HTML. Never throws; malformed input is reported. */
  parse(html: string): SourceAdapterResult;
}