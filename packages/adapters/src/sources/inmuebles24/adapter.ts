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
import { selectors, listingTypeByPath, propertyTypeByPath } from './selectors';

function inferKind(pathname: string): { propertyType: PropertyType; listingType: ListingType } {
  const path = pathname.toLowerCase();
  // Look for patterns like /[operation]/[property-type]/ or /[property-type]-[operation]/
  const propertyType = Object.keys(propertyTypeByPath).find((key) => path.includes(key)) ?? 'other';
  const listingType = Object.keys(listingTypeByPath).find((key) => path.includes(key)) ?? 'sale';
  
  return {
    propertyType: propertyTypeByPath[propertyType] ?? 'other',
    listingType: listingTypeByPath[listingType] ?? 'sale',
  };
}

function pathLastSegment(srcUrl: string): string | undefined {
  try {
    const url = new URL(srcUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    return segments.pop();
  } catch {
    return undefined;
  }
}

function isLikelyListingId(value: string | undefined): boolean {
  return typeof value === 'string' && /^\d+$/.test(value);
}

export const inmuebles24Adapter: SourceAdapter = {
  sourceKey: 'inmuebles24',

  canHandle(value: string): boolean {
    try {
      const host = new URL(value).hostname.replace(/^www\./, '');
      return host === 'inmuebles24.com.mx';
    } catch {
      return false;
    }
  },

  parse(html: string): SourceAdapterResult {
    const candidates: ListingCandidate[] = [];
    const errors: SourceAdapterResult['errors'] = [];

    const $ = cheerio.load(html);
    // Try multiple selectors for card container
    const cards = $(selectors.card).toArray();

    if (cards.length === 0) {
      errors.push({ message: 'no listing cards found on page' });
      return { candidates, errors };
    }

    for (const card of cards) {
      const $card = $(card);
      // Try multiple selectors for link
      const linkEl = $card.find(selectors.link).first();
      const href = linkEl.attr('href');
      const urlFallback = href ? pathLastSegment(href) : undefined;
      const externalId =
        $card.attr(selectors.externalIdAttr)?.split(/\s+/)[0]?.trim() || // Take first value if multiple attrs
        (isLikelyListingId(urlFallback) ? urlFallback : undefined);

      const sourceUrl = canonicalizeUrl(
        href,
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
        sourceKey: 'inmuebles24' as const,
        externalId,
        sourceUrl,
        title: normalizeText($card.find(selectors.title).first().text()),
        description: normalizeText($card.find(selectors.description).first().text()) || undefined,
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
