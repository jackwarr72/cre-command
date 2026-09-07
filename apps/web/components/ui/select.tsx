'use client';

import { type SelectHTMLAttributes, forwardRef } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  label?: string;
  error?: string;
  options: SelectOption[];
  placeholder?: string;
  onValueChange?: (value: string) => void;
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, options, placeholder, onValueChange, className, id, ...props }, ref) => (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label className="text-xs font-medium uppercase tracking-wide text-noir-300" htmlFor={id}>
          {label}
        </label>
      )}
      <select
        ref={ref}
        id={id}
        className={
          'w-full rounded-lg border border-noir-600 bg-noir-800 px-3 py-2 text-sm text-noir-100 focus:border-gold/50 focus:outline-none focus:ring-1 focus:ring-gold/30 disabled:cursor-not-allowed disabled:opacity-50' +
          (error ? ' border-accent-danger/60' : '') +
          (className ? ` ${className}` : '')
        }
        onChange={(e) => {
          onValueChange?.(e.target.value);
        }}
        {...props}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((opt) => (
          <option
            key={opt.value}
            value={opt.value}
            disabled={opt.disabled}
          >
            {opt.label}
          </option>
        ))}
      </select>
      {error && <span className="text-xs text-accent-danger">{error}</span>}
    </div>
  ),
);
Select.displayName = 'Select';

export { Select };
