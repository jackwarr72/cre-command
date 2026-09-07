/**
 * Formatting helpers shared across the control panel UI.
 */

/** Formats a number as a currency string (e.g. "$1,250.00"). */
export function formatCurrency(amount: number, currency: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
  }).format(amount);
}

/** Formats a Size as "1,250 sqft" or "85 sqm". */
export function formatSize(value: number, unit: string): string {
  const formatted = new Intl.NumberFormat('en-US').format(value);
  return `${formatted} ${unit}`;
}

/** Formats an ISO datetime into a localized human-readable string. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** Formats a number with thousands separators. */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

/** Capitalises the first letter of a string. */
export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
