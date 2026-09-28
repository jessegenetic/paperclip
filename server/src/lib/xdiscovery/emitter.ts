/**
 * Candidate record emitter for X discovery (LOL-36).
 * 
 * Converts extracted candidate entities + dedup results into full
 * CandidateRecord objects ready for editorial queue submission.
 */

import { randomUUID } from "node:crypto";
import type { CandidateRecord } from "./types.js";
import type { CandidateEntity } from "./extractor.js";
import type { DedupResult } from "./deduper.js";

export interface EmittedCandidate {
  /** Full candidate record for editorial queue. */
  record: CandidateRecord;
  /** Whether this is a new entity or a duplicate. */
  isNew: boolean;
}

/**
 * Emit full candidate records from extracted entities + dedup analysis.
 * 
 * Records carry `editorial.status: not_reviewed` per the LOL-33 truthfulness rule:
 * "X discovery is a lead source, never an endorsement."
 */
export function emitCandidates(
  candidates: Array<{ entity: CandidateEntity; dedupResult: DedupResult }>,
  runBatchId: string,
  queryFamiliesUsed: string[]
): EmittedCandidate[] {
  const now = new Date().toISOString();

  return candidates.map(({ entity, dedupResult }) => {
    // Build source posts array from tweet data
    const sourcePosts = [
      {
        tweet_id: entity.sourceTweet.id,
        text_snippet: truncate(entity.sourceTweet.text, 280),
        url: `https://x.com/user/status/${entity.sourceTweet.id}`,
      },
    ];

    return {
      record: {
        candidate_id: `x-discovery-${runBatchId}-${hashNameUrl(entity.name, entity.url)}`,
        name: entity.name,
        url: entity.url,
        domain: entity.domain,
        categories: inferCategories(entity.name, entity.domain ?? ""),
        confidence_note: dedupResult.isDuplicate
          ? `Already in catalog — matched against existing entry. Not a new finding; included for audit transparency.`
          : `Discovered via X search query "${queryFamiliesUsed[0] ?? 'unknown'}" on ${now}. Author of post has ${countFavs(entity.sourceTweet)}+ engagement. No editorial review has been performed.`,
        source_posts: sourcePosts,
        discovered_at: now,
        editorial_status: "not_reviewed" as const,
        discovery_provenance: {
          method: "x_discovery",
          run_batch_id: runBatchId,
          feed_query_families: queryFamiliesUsed,
        },
      },
      isNew: !dedupResult.isDuplicate,
    };
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────

function hashNameUrl(name: string, url: string): string {
  // Simple hash for ID generation
  const input = `${name}|${url}`.toLowerCase();
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

function inferCategories(name: string, domain: string): string[] {
  const categories: string[] = [];
  
  // Domain-based mapping
  if (domain.includes("khan")) categories.push("math");
  if (domain.includes("code") || domain.includes("scratch")) categories.push("coding");
  if (domain.includes("prodigy")) categories.push("math");
  if (domain.includes("epic")) categories.push("reading");
  if (domain.includes("brilliant")) categories.push("math", "science");
  if (domain.includes("desmos") || domain.includes("geogebra")) categories.push("math");
  if (domain.includes("commonlit") || domain.includes("achieve")) categories.push("reading");
  if (domain.includes("photomath")) categories.push("math");
  if (domain.includes("quizlet")) categories.push("tools");
  if (domain.includes("outschool")) categories.push("classes");
  if (domain.includes("beastacademy") || domain.includes("artofproblemsolving")) categories.push("gifted");
  if (domain.includes("amplify") || domain.includes("hmhco")) categories.push("curriculum");
  
  return categories.length > 0 ? categories : ["general"];
}

function countFavs(tweet: { public_metrics?: { like_count?: number; retweet_count?: number } }): number {
  if (!tweet.public_metrics) return 0;
  return (tweet.public_metrics.like_count ?? 0) + (tweet.public_metrics.retweet_count ?? 0);
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}
