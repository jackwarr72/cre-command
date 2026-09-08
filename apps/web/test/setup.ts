// Extends Vitest's expect with Testing Library's DOM matchers
// (toBeInTheDocument, toHaveTextContent, toBeDisabled, …).
import '@testing-library/jest-dom/vitest';

// @testing-library/react v16 doesn't auto-cleanup after each test (the
// auto-effect was removed in RTL 13+). Without this, `render` calls stack in
// the shared jsdom document across tests — stale nodes from one test leak into
// the next, which makes `queryByText(...)` see elements that *should* be gone.
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
afterEach(() => {
  cleanup();
});