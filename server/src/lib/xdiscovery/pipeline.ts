/**
 * X Discovery Pipeline — main orchestrator (LOL-36 Stage A).
 * 
 * Composes all modules into a single pipeline:
 * 1. Fetch tweets via configured query families
 * 2. Extract candidate entities from matched tweets
 * 3. Deduplicate against existing catalog
 * 4. Emit full candidate records
 * 5. Write editorial batch issue
 * 
 * Dry-run mode prints what it would do without making live API calls.
 */

import type { XDiscoveryConfig, PipelineResult } from "./types.js";
import { QUERY_FAMILIES, TOTAL_QUERY_COUNT } from "./queries.js";
import { XApiClient } from "./client.js";
import type { Tweet } from "./types.js";
import { extractCandidates } from "./extractor.js";
import { deduplicate, loadCatalog, dedupSummary } from "./deduper.js";
import { emitCandidates } from "./emitter.js";
import { writeBatchIssue } from "./batch-writer.js";

// ── Main pipeline function ─────────────────────────────────────────────

export async function runPipeline(config: Partial<XDiscoveryConfig>): Promise<PipelineResult> {
  const explicitDryRun = config.dryRun ?? true; // Default to dry-run for Stage A
  const maxResultsPerQuery = config.maxResultsPerQuery ?? 50;
  const maxQueries = config.maxQueries ?? TOTAL_QUERY_COUNT;
  
  // Determine effective mode: dryRun wins, or missing/bad token forces it
  const hasValidToken = typeof config.xBearerToken === "string" && config.xBearerToken.length >= 20;
  const isDryRun = explicitDryRun || !hasValidToken;
  if (!isDryRun) {
    console.log("[pipeline] Live mode detected — will attempt X API calls");
  } else {
    console.log("[pipeline] Dry-run mode — no live API calls will be made");
  }

  // Select queries to run
  const queriesToRun = QUERY_FAMILIES.slice(0, maxQueries);

  // DRY RUN REPORT
  if (isDryRun) {
    console.log("[pipeline] === DRY RUN MODE ===");
    console.log(`[pipeline] Would execute ${queriesToRun.length} query families`);
    
    for (const q of queriesToRun) {
      console.log(`[pipeline]   "${q.family}": "${q.query}" (max_results=${maxResultsPerQuery})`);
    }

    // Load catalog to estimate dedupe hit rate
    const catalog = await loadCatalog();
    console.log(`[pipeline] Catalog loaded with ${catalog.length} entries for dedup analysis`);

    return {
      candidates: [],
      dedupe_hits: 0,
      new_entities: 0,
      active_families: queriesToRun.map(q => q.family),
      batch_id: "dry-run-" + Date.now(),
      dry_run_report: {
        queries: queriesToRun.map(q => ({
          family: q.family,
          query: q.query,
          max_results: maxResultsPerQuery,
        })),
        total_queries: queriesToRun.length,
        max_total_results: queriesToRun.length * maxResultsPerQuery,
        estimated_dedupe_hit_rate: `~${((catalog.length / (queriesToRun.length * maxResultsPerQuery)) * 100).toFixed(0)}% of discovered entities likely match existing catalog entries`,
      },
    };
  }

  // LIVE MODE — fetch tweets
  const client = new XApiClient({
    xBearerToken: config.xBearerToken ?? "",
    dryRun: false,
  });

  const searchSpecs = queriesToRun.map(q => ({
    family: q.family,
    query: q.query,
    maxResults: maxResultsPerQuery,
  }));

  console.log("[pipeline] Running X search across", searchSpecs.length, "families...");
  const searchResults = await client.searchAll(searchSpecs);

  // Flatten tweets with family context
  interface TaggedTweet { family: string; tweet: Tweet; }
  const taggedTweets: TaggedTweet[] = [];
  for (const result of searchResults) {
    for (const tweet of result.tweets) {
      taggedTweets.push({ family: result.family, tweet });
    }
  }

  console.log("[pipeline] Found", taggedTweets.length, "total tweets across", searchResults.filter(r => r.tweets.length > 0).length, "families");

  // Extract candidates
  const allTweets = taggedTweets.map(t => t.tweet);
  const entities = extractCandidates(allTweets);
  console.log("[pipeline] Extracted", entities.length, "candidate entities");

  // Deduplicate
  const catalog = await loadCatalog();
  const dedupResults = deduplicate(entities, catalog);
  const summary = dedupSummary(dedupResults);
  console.log("[pipeline] Dedup results:", summary.hitRate, "hit rate");

  // Build candidate records from extraction + dedup
  const paired = entities.map((e, i) => ({
    entity: e,
    dedupResult: dedupResults[i],
  }));

  const activeFamilies = [...new Set(taggedTweets.map(t => t.family))];
  const batchId = "batch-" + Date.now();
  const emitters = emitCandidates(paired, batchId, activeFamilies);
  const records = emitters.map(e => e.record);

  // Write batch issue
  const issue = writeBatchIssue(records, batchId, activeFamilies);
  console.log("\n=== BATCH ISSUE OUTPUT ===\n");
  console.log(issue.body);
  console.log("\n=========================\n");

  return {
    candidates: records,
    dedupe_hits: summary.dedupeHits,
    new_entities: summary.newEntities,
    active_families: activeFamilies,
    batch_id: batchId,
  };
}

/** Quick CLI entry point — just parse args and run. */
export function main() {
  const dryRun = process.argv.includes("--live") ? false : true;
  const bearerToken = process.env.X_BEARER_TOKEN ?? "";

  runPipeline({
    dryRun: !process.argv.includes("--live"),
    xBearerToken: bearerToken,
  }).then(result => {
    console.log("\n[Pipeline complete]", JSON.stringify({
      candidates: result.candidates.length,
      dedupeHits: result.dedupe_hits,
      newEntities: result.new_entities,
      families: result.active_families.length,
    }, null, 2));
  }).catch(err => {
    console.error("[Pipeline failed]", err);
    process.exit(1);
  });
}
