/**
 * Type definitions for the X Discovery Pipeline (LOL-36).
 * 
 * Hard truthfulness rule: X discovery is a lead source, never an endorsement.
 * Candidates carry `editorial.status: not_reviewed` and discovery provenance.
 */

// ── X API Response Types ────────────────────────────────────────────────

export interface Tweet {
  id: string;
  text: string;
  created_at: string;
  author_id: string;
  public_metrics?: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
  };
  entities?: {
    urls?: Array<{
      url: string;
      expanded_url?: string;
      display_url?: string;
    }>;
    hashtags?: Array<{ tag: string }>;
  };
}

export interface SearchResponse {
  data: Tweet[];
  meta?: {
    result_count: number;
    next_token?: string;
    newest_id?: string;
    oldest_id?: string;
  };
}

export interface UserProfile {
  id: string;
  username: string;
  name: string;
  description?: string;
  verified?: boolean;
}

// ── Catalog Types ───────────────────────────────────────────────────────

/** Minimal catalog record shape matching what Lolo's marketplace expects. */
export interface CatalogEntry {
  name: string;
  url: string;
  domain?: string;
  categories?: string[];
  grade_bands?: string[];
  subject_filters?: string[];
}

/** Candidate record produced by the pipeline for editorial review. */
export interface CandidateRecord {
  /** Unique internal ID for dedupe tracking. */
  candidate_id: string;
  /** Display name of the tool/school/curriculum. */
  name: string;
  /** Official URL — may be website, App Store, etc. */
  url: string;
  /** Domain extracted from URL for dedup scoring. */
  domain?: string;
  /** Categories mapped from entity type + inferred topic. */
  categories: string[];
  /** Confidence note describing how we know about this entity. Never a numeric score. */
  confidence_note: string;
  /** The tweet(s) that surfaced this entity. */
  source_posts: Array<{ tweet_id: string; text_snippet: string; url: string }>;
  /** When the candidate was first discovered. */
  discovered_at: string;
  /** Editorially untouched until manually reviewed. */
  editorial_status: "not_reviewed";
  /** Provenance metadata for audit trail. */
  discovery_provenance: {
    method: "x_discovery";
    run_batch_id: string;
    feed_query_families: string[];
  };
}

// ── Pipeline Config ─────────────────────────────────────────────────────

export interface XDiscoveryConfig {
  /** Twitter v2 recent search endpoint auth token. Injected at runtime. */
  xBearerToken: string;
  /** Max results per query family (rate-limited). Default: 50. */
  maxResultsPerQuery?: number;
  /** Maximum total queries before yielding. Default: 20. */
  maxQueries?: number;
  /** Whether to print dry-run output instead of making real calls. */
  dryRun: boolean;
  /** Path to existing catalog for dedup checking (optional; use fixture if absent). */
  catalogPath?: string;
}

// ── Feed Query Families ─────────────────────────────────────────────────

export interface FeedQuery {
  /** Query-family label for grouping/audit. */
  family: string;
  /** Actual Twitter search operator query. */
  query: string;
  /** Description of what this family targets. */
  description: string;
}

// ── Pipeline Results ────────────────────────────────────────────────────

export interface DryRunReport {
  /** Queries that would be executed (with count). */
  queries: Array<{ family: string; query: string; max_results: number }>;
  /** Total queries planned. */
  total_queries: number;
  /** Max total results across all queries. */
  max_total_results: number;
  /** Would-be dedupe hit rate estimate (from fixture analysis). */
  estimated_dedupe_hit_rate: string;
}

export interface PipelineResult {
  /** All candidates found in this batch run. */
  candidates: CandidateRecord[];
  /** How many unique URLs/entities were already in the catalog. */
  dedupe_hits: number;
  /** Total new entities discovered. */
  new_entities: number;
  /** Which query families contributed results. */
  active_families: string[];
  /** For audit/repro: batch run identifier. */
  batch_id: string;
  /** If dry-run mode, the report instead of live results. */
  dry_run_report?: DryRunReport;
}
