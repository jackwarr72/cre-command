/**
 * @cre/crawler — adapter registry.
 *
 * Maps source keys to `SourceAdapter`s. Deliberately minimal; the second
 * source will tell us what genuinely needs generalizing.
 */

import type { SourceAdapter } from '@cre/adapters';

export class AdapterRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): this {
    if (this.adapters.has(adapter.sourceKey)) {
      throw new Error(`adapter already registered: ${adapter.sourceKey}`);
    }
    this.adapters.set(adapter.sourceKey, adapter);
    return this;
  }

  get(sourceKey: string): SourceAdapter | undefined {
    return this.adapters.get(sourceKey);
  }

  require(sourceKey: string): SourceAdapter {
    const adapter = this.adapters.get(sourceKey);
    if (!adapter) throw new Error(`no adapter registered for source: ${sourceKey}`);
    return adapter;
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }
}
