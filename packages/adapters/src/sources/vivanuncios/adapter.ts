import * as cheerio from 'cheerio';
import {
  listingCandidateSchema,
  type ListingCandidate,
  type ListingType,
  type PropertyType,
} from '@cre/shared';

import {
  canonicalizeUrl,
  normalizeText,
  parseDate,
  parsePrice,
  parseSize,
} from '../../normalize';
import type { SourceAdapter, SourceAdapterResult } from '../../types';
import {
  listingTypeByPath,
  propertyTypeByPath,
  selectors,
} from './selectors';

/** Infer property/listing type from a Vivanuncios URL path. */
function inferKind(pathname: string): { propertyType: PropertyType; listingType: ListingType } {
  const segments = pathname.toLowerCase().split(/[/-]+/).filter(Boolean);

  let propertyType: PropertyType = 'other';
  for (const seg of segments) {
    const mapped = propertyTypeByPath[seg];
    if (mapped) {
      propertyType = mapped;
      break;
    }
  }

  let listingType: ListingType = 'sale';
  for (const seg of segments) {
    const mapped = listingTypeByPath[seg];
    if (mapped) {
      listingType = mapped;
      break;
    }
  }

  return { propertyType, listingType };
}

/** Last non-empty path segment, used as a fallback source identifier. */
function pathLastSegment(srcUrl: string): string | undefined {
  try {
    const path = new URL(srcUrl, selectors.baseUrl).pathname.replace(/\/+$/, '');
    const segments = path.split('/').filter(Boolean);
    return segments[segments.length - 1] || undefined;
  } catch {
    return undefined;
  }
}

/** Vivanuncios listing ids are numeric; category words are not ids. */
function isLikelyListingId(value: string | undefined): boolean {
  return !!value && /^\d+$/.test(value);
}

export const vivanunciosAdapter: SourceAdapter = {
  sourceKey: 'vivanuncios',

  canHandle(value: string): boolean {
    try {
      const host = new URL(value).hostname.replace(/^www\./, '');
      return host === 'vivanuncios.com.mx';
    } catch {
      return false;
    }
  },

  parse(html: string): SourceAdapterResult {
    const candidates: ListingCandidate[] = [];
    const errors: SourceAdapterResult['errors'] = [];

    const $ = cheerio.load(html);
    const cards = $(selectors.card).toArray();

    if (cards.length === 0) {
      errors.push({ message: 'no listing cards found on page' });
      return { candidates, errors };
    }

    for (const card of cards) {
      const $card = $(card);
      const href = $card.find(selectors.link).first().attr('href');
      const urlFallback = href ? pathLastSegment(href) : undefined;
      const externalId =
        $card.attr(selectors.externalIdAttr)?.trim() ||
        (isLikelyListingId(urlFallback) ? urlFallback : undefined);

      const sourceUrl = canonicalizeUrl(
        $card.find(selectors.link).first().attr('href'),
        selectors.baseUrl,
      );

      // Every card needs a stable identifier and a URL to be traceable.
      if (!externalId || !sourceUrl) {
        errors.push({ message: 'card is missing a usable identifier or URL' });
        continue;
      }

      const kind = inferKind(new URL(sourceUrl).pathname);

      const city = normalizeText($card.find(selectors.locationCity).first().text());
      const state = normalizeText($card.find(selectors.locationState).first().text());
      const parsedPrice = parsePrice(
        normalizeText($card.find(selectors.price).first().text()),
      );
      const parsedSize = parseSize(normalizeText($card.find(selectors.size).first().text()));
      const images = $card
        .find(selectors.image)
        .toArray()
        .map((img) => canonicalizeUrl($(img).attr(selectors.imageAttr), selectors.baseUrl))
        .filter((url): url is string => Boolean(url));

      const candidate = {
        sourceKey: 'vivanuncios' as const,
        externalId,
        sourceUrl,
        title: normalizeText($card.find(selectors.title).first().text()),
        description: normalizeText($card.find(selectors.description).first().text()),
        propertyType: kind.propertyType,
        listingType: kind.listingType,
        address: {
          city,
          state,
          country: 'MX',
          formatted: [city, state].filter(Boolean).join(', ') || undefined,
        },
        price: parsedPrice ? { amount: parsedPrice.amount, currency: parsedPrice.currency } : undefined,
        priceUnit: parsedPrice?.unit,
        size: parsedSize ?? undefined,
        listedAt: parseDate($card.find(selectors.date).first().attr(selectors.dateAttr)),
        images,
      };

      const parsed = listingCandidateSchema.safeParse(candidate);
      if (parsed.success) {
        candidates.push(parsed.data);
      } else {
        errors.push({
          message: 'invalid listing candidate',
          context: {
            externalId,
            issues: parsed.error.issues.map((issue) => issue.message),
          },
        });
      }
    }

    return { candidates, errors };
  },
};