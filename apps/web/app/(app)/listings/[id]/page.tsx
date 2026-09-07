'use client';

/**
 * Listing detail page.
 */
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { MapPin, ExternalLink } from 'lucide-react';
import type { ListingStatus } from '@cre/shared';

import { useListing } from '@/lib/swr';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { formatCurrency, formatDate, formatSize, capitalize } from '@/lib/utils';

const STATUS_BADGE: Record<ListingStatus, string> = {
  active: 'success',
  pending: 'warning',
  sold: 'primary',
  leased: 'primary',
  'off-market': 'neutral',
  removed: 'danger',
};

function DetailRow({ label, value }: { label: string; value?: string | number }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-noir-400">{label}</span>
      <span className="text-sm text-noir-100">{value}</span>
    </div>
  );
}

export default function ListingDetailPage() {
  const { id } = useParams() as { id: string };
  const { data: listing, isLoading, error } = useListing(id);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-noir-400">
        <Spinner className="size-4" />
        <span>Loading listing…</span>
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-accent-danger">Error: {error.message}</p>;
  }

  if (!listing) {
    return <p className="text-sm text-noir-400">Listing not found.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-noir-50">{listing.title}</h1>
          <div className="mt-2 flex gap-2">
            <Badge variant={STATUS_BADGE[listing.status] as 'success'}>
              {capitalize(listing.status)}
            </Badge>
            <Badge variant="neutral">{capitalize(listing.propertyType)}</Badge>
            <Badge variant="neutral">{capitalize(listing.listingType)}</Badge>
          </div>
        </div>
        <Link href="/listings">
          <Button variant="outline" size="sm">← Back</Button>
        </Link>
      </div>

      {listing.price && (
        <p className="text-2xl font-bold text-gold">
          {formatCurrency(listing.price.amount, listing.price.currency)}
          {listing.priceUnit && (
            <span className="text-sm font-normal text-noir-400">
              {' '}/ {capitalize(listing.priceUnit)}
            </span>
          )}
        </p>
      )}

      {listing.images.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {listing.images.slice(0, 6).map((img, i) => (
            <img
              key={i}
              src={img}
              alt={`${listing.title} — image ${i + 1}`}
              className="aspect-video w-full rounded-lg border border-noir-700 object-cover"
            />
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-noir-700 bg-noir-850 p-4">
          <h3 className="mb-3 text-sm font-semibold text-noir-100">Property Details</h3>
          <div className="grid grid-cols-2 gap-4">
            <DetailRow label="Property Type" value={capitalize(listing.propertyType)} />
            <DetailRow label="Listing Type" value={capitalize(listing.listingType)} />
            {listing.size && <DetailRow label="Size" value={formatSize(listing.size.value, listing.size.unit)} />}
            {listing.lotSize && <DetailRow label="Lot Size" value={formatSize(listing.lotSize.value, listing.lotSize.unit)} />}
            {listing.yearBuilt && <DetailRow label="Year Built" value={listing.yearBuilt} />}
            {listing.unitCount && <DetailRow label="Units" value={listing.unitCount} />}
          </div>
        </div>

        <div className="rounded-lg border border-noir-700 bg-noir-850 p-4">
          <h3 className="mb-3 text-sm font-semibold text-noir-100">Location</h3>
          <div className="space-y-2">
            {listing.address?.formatted && (
              <p className="text-sm text-noir-100">{listing.address.formatted}</p>
            )}
            {listing.address && (
              <p className="text-sm text-noir-100">
                {[listing.address.city, listing.address.state]
                  .filter(Boolean)
                  .join(', ')}
              </p>
            )}
            {listing.address?.country && (
              <p className="text-sm text-noir-400">{listing.address.country}</p>
            )}
            {listing.geo && (
              <a
                href={`https://maps.google.com/?q=${listing.geo.lat},${listing.geo.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 flex items-center gap-1 text-sm text-gold hover:text-gold-400"
              >
                <MapPin className="size-3" />
                View on Google Maps
              </a>
            )}
          </div>
        </div>
      </div>

      {listing.description && (
        <div className="rounded-lg border border-noir-700 bg-noir-850 p-4">
          <p className="text-sm text-noir-200">{listing.description}</p>
        </div>
      )}

      <div className="rounded-lg border border-noir-700 bg-noir-850 p-4">
        <h3 className="mb-3 text-sm font-semibold text-noir-100">Source Provenance</h3>
        <div className="grid grid-cols-2 gap-4">
          <DetailRow label="Source" value={listing.sourceKey} />
          <DetailRow label="External ID" value={listing.externalId} />
          <DetailRow label="Last Crawled" value={formatDate(listing.scrapedAt)} />
          <DetailRow label="Last Changed" value={listing.updatedAt ? formatDate(listing.updatedAt) : undefined} />
          {listing.listedAt && <DetailRow label="Listed At" value={formatDate(listing.listedAt)} />}
        </div>
        {listing.sourceUrl && (
          <a
            href={listing.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-sm text-gold hover:text-gold-400"
          >
            <ExternalLink className="size-3" />
            View Original Listing
          </a>
        )}
      </div>
    </div>
  );
}
