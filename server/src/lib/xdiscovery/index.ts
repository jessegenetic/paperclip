/**
 * Barrel export for X Discovery Pipeline (LOL-36).
 * 
 * All public API surface for Stage A:
 * - Query families (17 families, 0 dependencies)
 * - X API client with fixture support  
 * - Entity extractor (heuristic name/URL extraction)
 * - Deduplication against catalog
 * - Candidate record emitter
 * - Batch issue writer
 * - Main pipeline orchestrator with dry-run mode
 */

// Public types
export type {
  Tweet, SearchResponse, UserProfile,
  CatalogEntry, CandidateRecord,
  XDiscoveryConfig, FeedQuery,
  DryRunReport, PipelineResult,
} from "./types.js";

// Query families — always available, no secrets needed
export { QUERY_FAMILIES, TOTAL_QUERY_COUNT } from "./queries.js";

// Pipeline modules
export { runPipeline, main as mainCLI } from "./pipeline.js";
export { deduplicate, loadCatalog, dedupSummary } from "./deduper.js";
export { extractCandidates, isNoiseTerm } from "./extractor.js";
export { emitCandidates } from "./emitter.js";
export { writeBatchIssue } from "./batch-writer.js";
export { XApiClient } from "./client.js";
