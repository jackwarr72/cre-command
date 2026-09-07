'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Download, Filter, Search } from 'lucide-react';
import { useListings } from '@/lib/swr';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { Spinner } from '@/components/ui/spinner';
import { formatCurrency, formatDate, formatNumber, capitalize } from '@/lib/utils';
import type { ListingFilter, PropertyType, ListingType, ListingStatus } from '@cre/shared';

const PROPERTY_OPTIONS: { value: string; label: string }[] = [
  { value: 'office', label: 'Office' },
  { value: 'retail', label: 'Retail' },
  { value: 'industrial', label: 'Industrial' },
  { value: 'multifamily', label: 'Multifamily' },
  { value: 'land', label: 'Land' },
  { value: 'mixed-use', label: 'Mixed Use' },
  { value: 'special-purpose', label: 'Special Purpose' },
];

const LISTING_OPTIONS: { value: string; label: string }[] = [
  { value: 'sale', label: 'Sale' },
  { value: 'lease', label: 'Lease' },
  { value: 'sale-or-lease', label: 'Sale or Lease' },
];

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'pending', label: 'Pending' },
  { value: 'sold', label: 'Sold' },
  { value: 'leased', label: 'Leased' },
  { value: 'off-market', label: 'Off Market' },
  { value: 'removed', label: 'Removed' },
];

export default function ListingsPage() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [propertyType, setPropertyType] = useState('');
  const [listingType, setListingType] = useState('');
  const [status, setStatus] = useState('');
  const [city, setCity] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const filter: ListingFilter = {
    ...(q ? { q } : {}),
    ...(propertyType ? { propertyTypes: [propertyType as PropertyType] } : {}),
    ...(listingType ? { listingTypes: [listingType as ListingType] } : {}),
    ...(status ? { statuses: [status as ListingStatus] } : {}),
    ...(city ? { cities: [city] } : {}),
    ...(minPrice ? { minPrice: Number(minPrice) } : {}),
    ...(maxPrice ? { maxPrice: Number(maxPrice) } : {}),
  };

  const { data, isLoading } = useListings({ filter, page, pageSize: 25 });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-noir-50">Listings</h1>
          <p className="text-sm text-noir-400">
            {data ? `${formatNumber(data.total)} listings tracked` : 'Browse discovered properties.'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowFilters(!showFilters)}>
            <Filter className="h-3.5 w-3.5" />
            Filters
          </Button>
          <Button variant="outline" size="sm">
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
      </div>

      <div className="card flex items-center gap-3 p-3">
        <Search className="h-4 w-4 text-noir-400" />
        <input
          type="text"
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
          placeholder="Search by title, description, address..."
          className="flex-1 bg-transparent text-sm text-noir-100 placeholder:text-noir-500 focus:outline-none"
        />
      </div>

      {showFilters && (
        <div className="card grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Select label="Property Type" options={PROPERTY_OPTIONS} onValueChange={(v) => { setPropertyType(v); setPage(1); }} placeholder="Any" />
          <Select label="Operation" options={LISTING_OPTIONS} onValueChange={(v) => { setListingType(v); setPage(1); }} placeholder="Any" />
          <Select label="Status" options={STATUS_OPTIONS} onValueChange={(v) => { setStatus(v); setPage(1); }} placeholder="Any" />
          <Input label="City" value={city} onChange={(e) => { setCity(e.target.value); setPage(1); }} placeholder="Mexico City" />
          <Input label="Min Price" value={minPrice} onChange={(e) => { setMinPrice(e.target.value); setPage(1); }} placeholder="0" />
          <Input label="Max Price" value={maxPrice} onChange={(e) => { setMaxPrice(e.target.value); setPage(1); }} placeholder="1000000" />
        </div>
      )}
<div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-noir-700 text-[11px] uppercase tracking-wider text-noir-400">
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Property</th>
              <th className="px-4 py-3 font-medium">Source</th>
              <th className="px-4 py-3 font-medium">Location</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Price</th>
              <th className="px-4 py-3 font-medium">Size</th>
              <th className="px-4 py-3 font-medium">Seller</th>
              <th className="px-4 py-3 font-medium">Discovered</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-noir-750">
            {isLoading ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-noir-400">
                  <Spinner className="mx-auto size-4" />
                </td>
              </tr>
            ) : (
              (data?.items ?? []).map((listing) => (
                <tr key={listing.id} className="transition-colors hover:bg-noir-850">
                  <td className="px-4 py-3">
                    <Badge variant={listing.status === 'active' ? 'success' : listing.status === 'pending' ? 'warning' : listing.status === 'removed' ? 'danger' : 'neutral'}>
                      {listing.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/listings/${listing.id}`} className="font-medium text-noir-100 hover:text-gold">
                      {listing.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-xs text-noir-300">{listing.sourceKey}</td>
                  <td className="px-4 py-3 text-xs text-noir-300">{listing.address?.city ?? '—'}</td>
                  <td className="px-4 py-3 text-xs text-noir-300">{capitalize(listing.propertyType)}</td>
                  <td className="px-4 py-3 text-xs text-noir-100">
                    {listing.price ? formatCurrency(listing.price.amount, listing.price.currency) : '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-noir-300">
                    {listing.size ? `${listing.size.value} ${listing.size.unit}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-noir-300">
                    {listing.contacts?.[0]?.name ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-noir-400">{listing.updatedAt ? formatDate(listing.updatedAt) : '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {data && data.items.length === 0 && (
          <p className="py-12 text-center text-sm text-noir-500">No listings match your criteria.</p>
        )}
        <div className="border-t border-noir-700 px-4 py-3">
          <Pagination page={page} pageSize={25} total={data?.total ?? 0} onPageChange={setPage} />
        </div>
      </div>
    </div>
  );
}
