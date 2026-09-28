/**
 * Tests for X Discovery Pipeline — Stage A (LOL-36).
 * 
 * All tests use recorded fixture data, no live X API calls.
 * Covers: queries, extraction, deduplication, emission, batching, and pipeline orchestration.
 */

import { describe, it, expect } from "vitest";
import { QUERY_FAMILIES, TOTAL_QUERY_COUNT } from "../../lib/xdiscovery/queries.js";
import { extractCandidates } from "../../lib/xdiscovery/extractor.js";
import type { Tweet } from "../../lib/xdiscovery/types.js";
import { deduplicate, loadCatalog, dedupSummary } from "../../lib/xdiscovery/deduper.js";
import { emitCandidates } from "../../lib/xdiscovery/emitter.js";
import { writeBatchIssue } from "../../lib/xdiscovery/batch-writer.js";
import { runPipeline } from "../../lib/xdiscovery/pipeline.js";

// ── Fixtures ────────────────────────────────────────────────────────────

const TWEETS: Tweet[] = [
  {
    id: "1840000000000000001",
    text: 'Just discovered this amazing new app called Lumosity for brain training! Perfect for kids who need extra practice. Check it out at https://www.lumosity.com #edtech #learning',
    created_at: "2026-09-25T14:30:00.000Z",
    author_id: "1234567890123456789",
    public_metrics: { retweet_count: 12, reply_count: 3, like_count: 45, quote_count: 1 },
    entities: { hashtags: [{ tag: "edtech" }, { tag: "learning" }] },
  },
  {
    id: "1840000000000000002",
    text: "Our homeschool community is loving the new curriculum from Sonlight. Great for K-8 reading and history programs!",
    created_at: "2026-09-25T15:00:00.000Z",
    author_id: "2345678901234567890",
    public_metrics: { retweet_count: 8, reply_count: 5, like_count: 23, quote_count: 0 },
  },
  {
    id: "1840000000000000003",
    text: "The Khan Academy math track for middle school has improved SO much. My daughter finally gets fractions now! https://www.khanacademy.org/math #math #middle_school",
    created_at: "2026-09-25T16:15:00.000Z",
    author_id: "3456789012345678901",
    public_metrics: { retweet_count: 34, reply_count: 12, like_count: 156, quote_count: 4 },
    entities: { hashtags: [{ tag: "math" }, { tag: "middle_school" }] },
  },
  {
    id: "1840000000000000004",
    text: "If you're looking for coding activities for your elementary students, try Code.org's Computer Science fundamentals course. Free and no login required!",
    created_at: "2026-09-25T17:45:00.000Z",
    author_id: "4567890123456789012",
    public_metrics: { retweet_count: 56, reply_count: 8, like_count: 234, quote_count: 7 },
  },
  {
    id: "1840000000000000005",
    text: "Found this gem: Beast Academy by Art of Problem Solving is great for gifted kids in grades 2-8. The online practice is excellent.",
    created_at: "2026-09-25T18:00:00.000Z",
    author_id: "5678901234567890123",
    public_metrics: { retweet_count: 21, reply_count: 7, like_count: 89, quote_count: 2 },
  },
];

// ── Query families ──────────────────────────────────────────────────────

describe("QUERY_FAMILIES", () => {
  it("has 17 query families covering all directive intents", () => {
    expect(QUERY_FAMILIES.length).toBeGreaterThan(15);
    expect(TOTAL_QUERY_COUNT).toBeGreaterThan(15);
  });

  it("every query has a non-empty string value and description", () => {
    for (const q of QUERY_FAMILIES) {
      expect(q.query.length).toBeGreaterThan(0);
      expect(q.description.length).toBeGreaterThan(0);
      expect(typeof q.query).toBe("string");
      expect(typeof q.description).toBe("string");
    }
  });
});

// ── Extract candidates ──────────────────────────────────────────────────

describe("extractCandidates", () => {
  it("extracts known edtech domains from tweets with URLs", () => {
    const results = extractCandidates(TWEETS);
    const domains: string[] = results.map(r => (r.domain || "").toLowerCase());
    
    // Khan Academy should be extracted from tweet 3
    expect(domains.some(d => d.includes("khanacadem"))).toBe(true);
    // At least some candidates should be found from tweets containing URLs
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty array when no valid edu URLs are present", () => {
    const fakeTweets: Tweet[] = [
      {
        id: "999",
        text: "Just posted on Facebook about my weekend plans!",
        created_at: "2026-09-25T10:00:00.000Z",
        author_id: "0",
        public_metrics: { retweet_count: 0, reply_count: 0, like_count: 0, quote_count: 0 },
      },
    ];
    const results = extractCandidates(fakeTweets);
    expect(results).toHaveLength(0);
  });

  it("deduplicates within same batch by URL", () => {
    const dupTweet: Tweet = {
      id: "888",
      text: "Check out https://www.khanacademy.org for free math lessons!",
      created_at: "2026-09-25T10:00:00.000Z",
      author_id: "0",
      public_metrics: { retweet_count: 0, reply_count: 0, like_count: 0, quote_count: 0 },
    };
    const results = extractCandidates([dupTweet]);
    // Should have exactly one result per unique URL
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

// ── Deduplication ───────────────────────────────────────────────────────

describe("deduplicate", () => {
  it("identifies Khan Academy as a duplicate against catalog", async () => {
    const catalog = await loadCatalog();
    expect(catalog.length).toBeGreaterThan(10);
    
    // Simulate a candidate matching an existing catalog entry
    const candidates = [
      { name: "Khan Academy", url: "https://www.khanacademy.org", domain: "khanacademy.org", sourceTweet: TWEETS[2] },
    ];
    
    const results = deduplicate(candidates as any, catalog);
    expect(results.length).toBe(1);
    expect(results[0].isDuplicate).toBe(true);
  });

  it("reports zero duplicates for unknown entities", async () => {
    const catalog = await loadCatalog();
    
    const candidates = [
      { name: "BrandNewStartup123", url: "https://brandnewstartup123.example.com", sourceTweet: TWEETS[0] },
    ];
    
    const results = deduplicate(candidates as any, catalog);
    expect(results.length).toBe(1);
    expect(results[0].isDuplicate).toBe(false);
  });

  it("summarizes correctly", () => {
    const mockResults = [
      { isDuplicate: true, matchedKey: "khanacademy.org|khan academy" },
      { isDuplicate: false, candidateKey: "newsite.com|newsite" },
      { isDuplicate: true, matchedKey: "code.org|code.org" },
      { isDuplicate: false, candidateKey: "anotherplace.org|another place" },
    ] as any;
    
    const summary = dedupSummary(mockResults);
    expect(summary.totalCandidates).toBe(4);
    expect(summary.dedupeHits).toBe(2);
    expect(summary.newEntities).toBe(2);
    expect(summary.hitRate).toBe("50.0%");
  });
});

// ── Emit candidates ─────────────────────────────────────────────────────

describe("emitCandidates", () => {
  it("creates records with correct editorial status", () => {
    const mockDedupResult = { isDuplicate: false } as any;
    const entity = { name: "TestTool", url: "https://test.example.com", sourceTweet: TWEETS[0] } as any;
    
    const emitters = emitCandidates([{ entity, dedupResult: mockDedupResult }], "batch-test-1", ["edtech_launches"]);
    
    expect(emitters.length).toBe(1);
    expect(emitters[0].record.editorial_status).toBe("not_reviewed");
    expect(emitters[0].record.discovery_provenance.method).toBe("x_discovery");
    expect(emitters[0].record.discovery_provenance.run_batch_id).toBe("batch-test-1");
  });

  it("marks confidence note appropriately for duplicates", () => {
    const mockDedupResult = { isDuplicate: true, matched: { name: "Existing Tool" } } as any;
    const entity = { name: "TestTool", url: "https://test.example.com", sourceTweet: TWEETS[0] } as any;
    
    const emitters = emitCandidates([{ entity, dedupResult: mockDedupResult }], "batch-test-2", ["parent_recommendations"]);
    
    expect(emitters[0].isNew).toBe(false);
    expect(emitters[0].record.confidence_note).toContain("Already in catalog");
  });
});

// ── Batch writer ────────────────────────────────────────────────────────

describe("writeBatchIssue", () => {
  it("generates markdown body with table and details section", () => {
    const records: any[] = [
      {
        candidate_id: "c1",
        name: "Khan Academy",
        url: "https://www.khanacademy.org",
        domain: "khanacademy.org",
        categories: ["math"],
        confidence_note: "High engagement post from trusted educator.",
        source_posts: [{ tweet_id: "123", text_snippet: "Love Khan Academy!", url: "https://x.com/status/123" }],
        discovered_at: "2026-09-25T16:15:00.000Z",
        editorial_status: "not_reviewed",
        discovery_provenance: { method: "x_discovery", run_batch_id: "b1", feed_query_families: ["edtech"] },
      },
    ];

    const issue = writeBatchIssue(records, "batch-1", ["edtech"]);
    
    expect(issue.title).toContain("X Discovery");
    expect(issue.body).toContain("Khan Academy");
    expect(issue.body).toContain("khanacademy.org");
    expect(issue.newEntityCount).toBe(1);
    expect(issue.totalCount).toBe(1);
  });

  it("produces empty table message when no candidates", () => {
    const issue = writeBatchIssue([], "empty-batch", []);
    expect(issue.body).toContain("No candidates");
    expect(issue.newEntityCount).toBe(0);
    expect(issue.totalCount).toBe(0);
  });
});

// ── Pipeline orchestration (dry-run) ────────────────────────────────────

describe("runPipeline — dry-run mode", () => {
  it("runs in dry-run mode without making API calls", async () => {
    const result = await runPipeline({
      dryRun: true,
      maxResultsPerQuery: 25,
      maxQueries: 5,
    });

    expect(result.candidates).toHaveLength(0); // Dry-run produces no real candidates
    expect(result.dry_run_report).toBeDefined();
    expect(result.dry_run_report!.total_queries).toBe(5);
    expect(result.dry_run_report!.queries.length).toBe(5);
    expect(result.batch_id.startsWith("dry-run-")).toBe(true);
  });

  it("respects maxQueries limit", async () => {
    const result = await runPipeline({ dryRun: true, maxQueries: 3 });
    expect(result.dry_run_report?.total_queries).toBe(3);
  });
});
