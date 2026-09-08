/**
 * Component tests for the /metrics page (jsdom + Testing Library).
 * SWR hooks are module-mocked; rendering covers the aggregate cards,
 * windowing behavior, and the loading/error/empty states.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { CrawlRunWithMetrics } from '@cre/shared';

import MetricsPage from '../app/(app)/metrics/page';
import { useCrawlRuns, useSources } from '@/lib/swr';

vi.mock('@/lib/swr', () => ({ useSources: vi.fn(), useCrawlRuns: vi.fn() }));

const mockedSources = useSources as unknown as ReturnType<typeof vi.fn>;
const mockedRuns = useCrawlRuns as unknown as ReturnType<typeof vi.fn>;

function run(
  id: string,
  metrics: Partial<NonNullable<CrawlRunWithMetrics['metrics']>>,
): CrawlRunWithMetrics {
  return { id, sourceKey: 'vivanuncios', status: 'completed', metrics } as CrawlRunWithMetrics;
}

const RUNS: CrawlRunWithMetrics[] = [
  run('r1', {
    listingsCreated: 10,
    listingsUpdated: 1,
    pagesAttempted: 10,
    pagesSucceeded: 10,
    cardsSeen: 10,
    cardsParsed: 9,
    httpErrors: 1,
    parseErrors: 0,
    latencySamplesMs: [100],
    requestCount: 10,
    maxLatencyMs: 100,
  }),
  run('r2', {
    listingsCreated: 5,
    listingsUpdated: 0,
    pagesAttempted: 8,
    pagesSucceeded: 6,
    cardsSeen: 8,
    cardsParsed: 8,
    httpErrors: 0,
    parseErrors: 2,
    latencySamplesMs: [500],
    requestCount: 8,
    maxLatencyMs: 500,
  }),
  run('r3', {
    listingsCreated: 2,
    listingsUpdated: 3,
    pagesAttempted: 2,
    pagesSucceeded: 2,
    cardsSeen: 5,
    cardsParsed: 0,
    httpErrors: 0,
    parseErrors: 5,
    latencySamplesMs: [1500, 3000],
    requestCount: 2,
    maxLatencyMs: 3000,
  }),
];

function paged(items: CrawlRunWithMetrics[]) {
  return { items, page: 1, pageSize: 100, total: items.length };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSources.mockReturnValue({
    data: [{ key: 'vivanuncios', name: 'Vivanuncios' }],
    isLoading: false,
    error: undefined,
  });
});

describe('MetricsPage', () => {
  it('renders aggregate cards over the default 25-run window', () => {
    mockedRuns.mockReturnValue({ data: paged(RUNS), isLoading: false, error: undefined });
    render(<MetricsPage />);

    // 10 + 5 + 2 created; 1 + 0 + 3 updated; pooled fetch = 18/20 = 90.0%.
    expect(screen.getByText('17')).toBeInTheDocument();
    expect(screen.getByText('4 updated · 3 runs')).toBeInTheDocument();
    expect(screen.getByText('90.0%')).toBeInTheDocument();
  });

  it('limits the aggregation to the newest N runs via the window selector', () => {
    mockedRuns.mockReturnValue({ data: paged(RUNS), isLoading: false, error: undefined });
    render(<MetricsPage />);

    fireEvent.change(screen.getByLabelText('Window'), { target: { value: '2' } });

    // Window of 2 → only r1 + r2: 15 created, 1 updated, fetch 16/18 ≈ 88.9%.
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.getByText('1 updated · 2 runs')).toBeInTheDocument();
    expect(screen.getByText('88.9%')).toBeInTheDocument();
    expect(screen.queryByText('17')).not.toBeInTheDocument();
  });

  it('shows the empty state when no runs match the filters', () => {
    mockedRuns.mockReturnValue({ data: paged([]), isLoading: false, error: undefined });
    render(<MetricsPage />);
    expect(screen.getByText(/No crawl runs match these filters/i)).toBeInTheDocument();
  });

  it('shows the error state with the failure message', () => {
    mockedRuns.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
    });
    render(<MetricsPage />);
    expect(screen.getByText(/Error: boom/)).toBeInTheDocument();
  });

  it('shows the loading state while runs are being fetched', () => {
    mockedRuns.mockReturnValue({ data: undefined, isLoading: true, error: undefined });
    render(<MetricsPage />);
    expect(screen.getByText(/Loading metrics/i)).toBeInTheDocument();
  });
});