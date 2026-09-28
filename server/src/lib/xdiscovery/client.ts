/**
 * Twitter/X API v2 client for recent tweet search (LOL-36).
 * 
 * Abstracted behind an interface so it can be driven by recorded fixture
 * responses in tests and dry-run mode, without requiring live credentials.
 * 
 * Required env var: X_BEARER_TOKEN (injected from Lolo company secrets at runtime).
 */

import type { SearchResponse, Tweet, XDiscoveryConfig } from "./types.js";

export const X_SEARCH_ENDPOINT = "https://api.twitter.com/2/tweets/search/recent";

// ── Interface for testability / fixture-driven testing ──────────────────

export interface IXClient {
  /** Run a single query family and return results. */
  search(query: string, maxResults?: number): Promise<Tweet[]>;
}

// ── Live implementation ─────────────────────────────────────────────────

export class XApiClient implements IXClient {
  private readonly bearerToken: string;
  private readonly dryRun: boolean;
  private readonly fixtureLoader?: FixtureLoader;

  constructor(config: Pick<XDiscoveryConfig, "xBearerToken" | "dryRun">) {
    this.bearerToken = config.xBearerToken;
    this.dryRun = config.dryRun;

    // If a fixture loader is provided, use it even in non-dry-run mode for retestability
    if ("fixtureLoader" in globalThis) {
      this.fixtureLoader = (globalThis as any).fixtureLoader;
    }
  }

  async search(query: string, maxResults = 50): Promise<Tweet[]> {
    if (this.dryRun) {
      console.log(`[DRY RUN] Would search with: "${query}" (max=${maxResults})`);
      return [];
    }

    if (!this.bearerToken || this.bearerToken === "<X_BEARER_TOKEN>") {
      throw new Error(
        `X_BEARER_TOKEN not set or still at placeholder. ` +
        `Set it via Lolo company secrets before running Stage B.`
      );
    }

    const params = new URLSearchParams({
      query,
      max_results: String(Math.min(maxResults, 100)),
      "tweet.fields": "public_metrics,entities",
      "expansions": "author_id",
    });

    const url = `${X_SEARCH_ENDPOINT}?${params}`;
    console.log(`[X API] GET ${url}`);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`X API error ${response.status}: ${body}`);
    }

    const data: SearchResponse = await response.json();
    return data.data ?? [];
  }

  /** Batch-search across multiple query families. Returns all tweets found. */
  async searchAll(queries: Array<{ family: string; query: string; maxResults: number }>): Promise<
    Array<{ family: string; tweets: Tweet[] }>
  > {
    const results: Array<{ family: string; tweets: Tweet[] }> = [];

    for (const q of queries) {
      try {
        const tweets = await this.search(q.query, q.maxResults);
        results.push({ family: q.family, tweets });
      } catch (err) {
        console.error(`[X API] Failed on "${q.family}": ${err instanceof Error ? err.message : err}`);
        // Don't bail — partial results are still useful
        results.push({ family: q.family, tweets: [] });
      }
    }

    return results;
  }
}

// ── Fixture Loader (for tests and dry-run analysis) ─────────────────────

/**
 * Load fixture responses from JSON files in __tests__/xdiscovery/fixtures/.
 * Files follow naming convention: <family-name>.json containing SearchResponse objects.
 */
export interface FixtureLoader {
  load(familyName: string): Promise<Tweet[]>;
  listFamilies(): Promise<string[]>;
}
