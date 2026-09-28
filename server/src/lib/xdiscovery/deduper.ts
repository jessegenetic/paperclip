/**
 * Deduplication against existing catalog for X discovery (LOL-36).
 * 
 * Strategy: match candidates by domain first, then normalized name.
 * The pipeline should report hit rates — a pipeline that re-proposes what
 * we already have is noise.
 */

import type { CatalogEntry } from "./types.js";
import type { CandidateEntity } from "./extractor.js";

// ── In-memory catalog for Stage A fixtures ─────────────────────────────

export interface DedupResult {
  /** Entity already in catalog (dedupe hit). */
  isDuplicate: boolean;
  /** If duplicate, the existing catalog entry it matches. */
  matched?: CatalogEntry | null;
  /** Normalized keys compared for audit trail. */
  candidateKey: string;
  matchedKey?: string;
}

/**
 * Load catalog entries from a JSON file or return fixture data if not available.
 * 
 * Primary source: `data/marketplace/import-report.json` (Lolo repo)
 * Fallback: `apps/web/src/marketplace-research.generated.json` 
 * Fixture: hardcoded sample for testing when no real catalog is available.
 */
export async function loadCatalog(): Promise<CatalogEntry[]> {
  // Try known paths (Stage B will use Lolo repo paths)
  const possiblePaths = [
    "/Users/hudbotstudio1/paperclip/server/src/lib/xdiscovery/fixtures/catalog-sample.json",
    // These would be the real paths in the Lolo repo:
    // "data/marketplace/import-report.json",
    // "apps/web/src/marketplace-research.generated.json",
  ];

  for (const path of possiblePaths) {
    try {
      const fs = await import("node:fs");
      const raw = fs.readFileSync(path, "utf-8");
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        console.log(`[dedup] Loaded ${data.length} catalog entries from ${path}`);
        return data as CatalogEntry[];
      }
    } catch {
      // Not found yet — try next path
    }
  }

  // Return fixture sample for Stage A dry-run validation
  console.log("[dedup] Using fixture catalog sample for Stage A");
  return FIXTURE_CATALOG;
}

// ── Fixtures ───────────────────────────────────────────────────────────

/** Sample catalog entries for Stage A testing. Matches ~40% of expected X-discovered domains. */
const FIXTURE_CATALOG: CatalogEntry[] = [
  { name: "Khan Academy", url: "https://www.khanacademy.org", domain: "khanacademy.org", categories: ["online_program", "math"], grade_bands: ["K-12"] },
  { name: "Code.org", url: "https://code.org", domain: "code.org", categories: ["coding", "computer_science"], grade_bands: ["K-5", "6-12"] },
  { name: "Scratch", url: "https://scratch.mit.edu", domain: "scratch.mit.edu", categories: ["coding", "creative"], grade_bands: ["K-5", "6-8"] },
  { name: "Prodigy Math Game", url: "https://www.prodigygame.com", domain: "prodigygame.com", categories: ["math", "gamification"], grade_bands: ["1-8"] },
  { name: "Epic!", url: "https://epic.com", domain: "epic.com", categories: ["reading", "early_grade"], grade_bands: ["Pre-K-6"] },
  { name: "Brilliant.org", url: "https://brilliant.org", domain: "brilliant.org", categories: ["math", "science"], grade_bands: ["6-12", "college"] },
  { name: "Desmos", url: "https://desmos.com", domain: "desmos.com", categories: ["math", "tools"], grade_bands: ["6-12"] },
  { name: "GeoGebra", url: "https://geogebra.org", domain: "geogebra.org", categories: ["math", "geometry"], grade_bands: ["6-12", "college"] },
  { name: "CommonLit", url: "https://commonlit.org", domain: "commonlit.org", categories: ["reading", "language_arts"], grade_bands: ["3-12"] },
  { name: "Photomath", url: "https://photomath.com", domain: "photomath.com", categories: ["math", "tools"], grade_bands: ["4-10"] },
  { name: "Quizlet", url: "https://quizlet.com", domain: "quizlet.com", categories: ["tools", "flashcards"], grade_bands: ["6-college"] },
  { name: "IXL", url: "https://ixl.com", domain: "ixl.com", categories: ["curriculum", "practice"], grade_bands: ["K-college"] },
  { name: "Outschool", url: "https://outschool.com", domain: "outschool.com", categories: ["marketplace_model", "classes"], grade_bands: ["K-12"] },
  { name: "Beast Academy", url: "https://beastacademy.com", domain: "beastacademy.com", categories: ["math", "enrichment"], grade_bands: ["2-8"] },
  { name: "Art of Problem Solving", url: "https://artofproblemsolving.com", domain: "artofproblemsolving.com", categories: ["math", "gifted"], grade_bands: ["6-12"] },
  { name: "Khan Academy Kids", url: "https://learn.khanacademy.org/khan-kids/", domain: "learn.khanacademy.org", categories: ["early_grade", "foundations"], grade_bands: ["Pre-K-K"] },
  { name: "ABCmouse", url: "https://abcmouse.com", domain: "abcmouse.com", categories: ["early_grade", "foundations"], grade_bands: ["Pre-K-3"] },
  { name: "Dreambox Learning", url: "https://www.dreambox.com", domain: "dreambox.com", categories: ["math", "personalised"], grade_bands: ["K-8"] },
  { name: "Nearpod", url: "https://nearpod.com", domain: "nearpod.com", categories: ["presentation", "engagement"], grade_bands: ["K-12"] },
  { name: "Edpuzzle", url: "https://edpuzzle.com", domain: "edpuzzle.com", categories: ["video", "assessment"], grade_bands: ["3-12"] },
  { name: "Blooket", url: "https://blooket.com", domain: "blooket.com", categories: ["gamification", "review"], grade_bands: ["3-8"] },
  { name: "Teachers Pay Teachers", url: "https://teacherspayteachers.com", domain: "teacherspayteachers.com", categories: ["marketplace_model", "materials"], grade_bands: ["K-12"] },
  { name: "Scholastic", url: "https://scholastic.com", domain: "scholastic.com", categories: ["books", "reading"], grade_bands: ["Pre-K-5"] },
  { name: "Time4Learning", url: "https://time4learning.com", domain: "time4learning.com", categories: ["online_program", "homeschool"], grade_bands: ["K-12"] },
];

/**
 * Check whether a candidate entity already exists in the catalog.
 * Returns dedup results for each candidate.
 * 
 * Matching strategy:
 * 1. Domain exact match → high confidence duplicate
 * 2. Normalized name contains/contained by existing entry's name → medium
 * 3. Same domain, different URL → likely same entity with alternate URL
 */
export function deduplicate(
  candidates: CandidateEntity[],
  catalog: CatalogEntry[]
): DedupResult[] {
  return candidates.map(candidate => {
    const result: DedupResult = {
      isDuplicate: false,
      matched: null,
      candidateKey: `${candidate.domain || ""}|${normaliseName(candidate.name)}`,
    };

    // Strategy 1: domain match (highest confidence)
    const domainMatches = catalog.filter(entry =>
      entry.domain && candidate.domain &&
      entry.domain.toLowerCase() === candidate.domain.toLowerCase()
    );

    if (domainMatches.length > 0) {
      result.isDuplicate = true;
      result.matched = domainMatches[0];
      result.matchedKey = `${domainMatches[0].domain}|${normaliseName(domainMatches[0].name)}`;
      return result;
    }

    // Strategy 2: normalized name overlap
    const normalisedCandidate = normaliseName(candidate.name);
    for (const entry of catalog) {
      const normalisedEntry = normaliseName(entry.name);
      // Either contains the other (with tolerance for articles/prepositions)
      if (
        normalisedCandidate.includes(normalisedEntry) ||
        normalisedEntry.includes(normalisedCandidate) ||
        wordIntersection(normalisedCandidate, normalisedEntry) >= 0.7
      ) {
        // Double-check it's not the same entity with just a slightly different name
        // We allow some flexibility here since X mentions might abbreviate
        result.isDuplicate = true;
        result.matched = entry;
        result.matchedKey = `${entry.domain || "none"}|${normalisedEntry}`;
        break;
      }
    }

    return result;
  });
}

/** Report summary statistics on dedup performance. */
export function dedupSummary(results: DedupResult[]): {
  totalCandidates: number;
  dedupeHits: number;
  newEntities: number;
  hitRate: string;
} {
  const hits = results.filter(r => r.isDuplicate).length;
  const total = results.length;
  
  return {
    totalCandidates: total,
    dedupeHits: hits,
    newEntities: total - hits,
    hitRate: `${((hits / total) * 100).toFixed(1)}%`,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Word-overlap Jaccard-like similarity between two normalised names. */
function wordIntersection(a: string, b: string): number {
  if (!a || !b) return 0;
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  
  const unionSize = wordsA.size + wordsB.size - intersection;
  return unionSize === 0 ? 0 : intersection / unionSize;
}
