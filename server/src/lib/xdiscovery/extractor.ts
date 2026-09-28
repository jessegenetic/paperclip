/**
 * Entity extractor: pull candidate entities (tool/school/curriculum name + URL)
 * from matched X/Twitter posts.
 * 
 * Uses heuristic regex patterns and domain extraction — no AI dependency for Stage A.
 */

import type { Tweet, CatalogEntry } from "./types.js";

// ── URL patterns we care about ──────────────────────────────────────────

const KNOWN_EDU_DOMAINS = new Set([
  // Major edtech platforms
  "khanacademy.org", "classroom.google.com", "canvas.instructure.com",
  "moodle.org", "edpuzzle.com", "nearpod.com", "blooket.com",
  "ixl.com", "prodigygame.com", "dreambox.com", "epic.com",
  "abcmouse.com", "scratch.mit.edu", "codeworks.com", "code.org",
  "tynker.com", "lightbot.com", "quickmath.com", "photomath.com",
  "brilliant.org", "desmos.com", "geogebra.org", "nctm.org",
  "readworks.org", "achieve3000.com", "commonlit.org",
  "amplify.com", "pearson.com", "hmhco.com", "scholastic.com",
  "freedomhomeschool.com", "ambahomeschool.com", "hslearningfamily.com",
  "time4learning.com", "k12.com", "athenaeducation.com",
  "beastacademy.com", "artofproblemsolving.com", "gimkit.com",
  "quizlet.com", "ankiweb.net", "brainly.com", "coursehero.com",
  "outschool.com", "curiousworld.com", "teacherspayteachers.com",
]);

// Domain-to-category mapping for auto-categorization
const DOMAIN_CATEGORIES = new Map<string, string[]>([
  ["khanacademy.org", ["online_program", "math"]],
  ["code.org", ["coding", "computer_science"]],
  ["scratch.mit.edu", ["coding", "creative"]],
  ["prodigygame.com", ["math", "gamification"]],
  ["epic.com", ["reading", "early_grade"]],
  ["outschool.com", ["marketplace_model", "classes"]],
  ["brilliant.org", ["math", "science"]],
  ["desmos.com", ["math", "tools"]],
  ["geogebra.org", ["math", "geometry"]],
  ["commonlit.org", ["reading", "language_arts"]],
  ["achieve3000.com", ["reading", "language_arts"]],
  ["photomath.com", ["math", "tools"]],
  ["quizlet.com", ["tools", "flashcards"]],
  ["amplify.com", ["curriculum", "assessment"]],
  ["scholastic.com", ["reading", "books"]],
]);

// ── Heuristic patterns ─────────────────────────────────────────────────

// Pattern: "Check out [NAME] at [URL]" or similar promotional language
const NAME_URL_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // Direct URL references in context of recommendations
  { pattern: /(?:check out|visit|try|download|sign up|get started with)\s+(?:the\s+)?([A-Za-z][\w\s\.&\-]{1,60})\s*(?:at\s*(https?:\/\/\S+)|\bon\s+(https?:\/\/\S+))/i, description: "Recommendation with name + URL" },
  // Name followed by website-like mention
  { pattern: /\b([A-Z][\w]*[\s\-]?[\w]*)\s+(?:\.com|\.org|\.edu|\.io)\b/, description: "Name with TLD suffix" },
  // App store mentions: "Search '[App Name]' on..."
  { pattern: /(?:search?)['"]([\w\s]+)['"]\s+(?:on|in)\s+(?:app\s+store|play\s+store)/i, description: "App store search recommendation" },
];

// ── Extractor output ───────────────────────────────────────────────────

export interface CandidateEntity {
  /** Extracted/display name of the tool, school, or curriculum. */
  name: string;
  /** Primary URL from tweet text or entities. */
  url: string;
  /** Domain extracted from URL for dedup scoring. */
  domain?: string;
  /** The tweet this was extracted from. */
  sourceTweet: Tweet;
}

/**
 * Extract candidate entities from a set of tweets.
 * 
 * Strategy:
 * 1. First pass: extract URLs from tweet text/entities and normalize into catalog entries.
 * 2. Second pass: try to pair nearby text fragments with known EDU domains as names.
 * 3. Return deduplicated list sorted by signal strength.
 */
export function extractCandidates(tweets: Tweet[]): CandidateEntity[] {
  const seen = new Map<string, CandidateEntity>(); // keyed by normalized URL
  const results: CandidateEntity[] = [];

  for (const tweet of tweets) {
    // Extract all URLs from tweet text
    const urls = extractAllUrls(tweet);
    
    for (const rawUrl of urls) {
      const entry = tryCreateCandidate(tweet, rawUrl);
      if (!entry) continue;

      const key = normalizeKey(entry.url);
      if (seen.has(key)) continue; // dedupe within same batch
      
      seen.set(key, entry);
      results.push(entry);
    }

    // Also check tweet entity-embedded URLs
    if (tweet.entities?.urls) {
      for (const e of tweet.entities.urls) {
        const target = e.expanded_url ?? e.url;
        const key = normalizeKey(target);
        if (!seen.has(key)) {
          const entry = tryCreateCandidate(tweet, target);
          if (entry) {
            seen.set(key, entry);
            results.push(entry);
          }
        }
      }
    }
  }

  // Sort by signal strength: known domains first
  results.sort((a, b) => {
    const aKnown = KNOWN_EDU_DOMAINS.has(a.domain || "") ? 1 : 0;
    const bKnown = KNOWN_EDU_DOMAINS.has(b.domain || "") ? 1 : 0;
    return bKnown - aKnown;
  });

  return results;
}

/** Extract all potential URLs from a tweet's text content. */
function extractAllUrls(tweet: Tweet): string[] {
  const urls: string[] = [];
  
  // Standard http(s) URLs in text
  const httpPattern = /(https?:\/\/[^'"\s<>]+)/g;
  let match;
  while ((match = httpPattern.exec(tweet.text)) !== null) {
    let url = match[1];
    // Strip only TRAILING punctuation chars that are likely sentence-ending, not URL components
    url = url.replace(/[)\.,;:]+$/, ''); 
    url = url.trim();
    if (url.length > 5 && url.length < 256) {
      urls.push(url);
    }
  }

  // x.co short URLs (from the entities array — those are already handled separately)
  return urls;
}

/** Try to build a catalog entry from a tweet + URL. */
function tryCreateCandidate(tweet: Tweet, rawUrl: string): CandidateEntity | null {
  const url = normaliseUrl(rawUrl);
  if (!isValidEduUrl(url)) return null;

  const domain = extractDomain(url);

  let name = inferNameFromContext(tweet, domain);
  if (!name) return null;

  return {
    name: name.trim(),
    url: url,
    domain,
    sourceTweet: tweet,
  };
}

/** Normalize a URL for comparison. */
function normaliseUrl(input: string): string {
  try {
    const u = new URL(input);
    return `${u.protocol}//${u.hostname}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    // If URL is unparseable, return as-is
    return input.replace(/\/+$/, "").trim().toLowerCase();
  }
}

/** Check if a URL looks like it points to an educational entity. */
function isValidEduUrl(url: string): boolean {
  try {
    const u = new URL(normaliseUrl(url));
    const host = u.hostname.replace(/^www\./, "");
    // If we know it's a known edu domain, always allow
    if (KNOWN_EDU_DOMAINS.has(host)) return true;
    // Otherwise heuristically check common edu-y signals
    return /\.(org|edu|ac\.uk|ac\.ca|gov|blogspot\.com|wordpress\.com)$/i.test(host)
      || /^(khan|code|scratch|prodigy|dreambox|epic|xil|amplif[iy]|brighter|outschool|curiousworld|teachers[p-]|fawn|genius|gimkit)\.com$/i.test(host)
      || !/^(facebook|twitter|x\.com|instagram|tiktok|reddit|youtube|linkedin)\.com$/.test(host);
  } catch {
    return false;
  }
}

/** Extract hostname from URL, stripping www prefix. */
function extractDomain(url: string): string | undefined {
  try {
    return new URL(normaliseUrl(url)).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** Infer entity name from the tweet context around the discovered URL. */
function inferNameFromContext(tweet: Tweet, domain?: string): string | null {
  if (!domain) return null;

  // Look up predefined name-domain mapping
  const knownDomains: Record<string, string[]> = {
    "khanacademy.org": ["Khan Academy"],
    "code.org": ["Code.org"],
    "scratch.mit.edu": ["Scratch"],
    "prodigygame.com": ["Prodigy Math Game"],
    "epic.com": ["Epic!"],
    "brilliant.org": ["Brilliant.org"],
    "desmos.com": ["Desmos"],
    "geogebra.org": ["GeoGebra"],
    "commonlit.org": ["CommonLit"],
    "photomath.com": ["Photomath"],
    "quizlet.com": ["Quizlet"],
    "outschool.com": ["Outschool"],
    "beastacademy.com": ["Beast Academy"],
    "artofproblemsolving.com": ["Art of Problem Solving"],
    "gimkit.com": ["Gimkit"],
    "ixl.com": ["IXL"],
    "blooket.com": ["Blooket"],
    "nearpod.com": ["Nearpod"],
    "edpuzzle.com": ["Edpuzzle"],
  };

  if (knownDomains[domain]) {
    return knownDomains[domain][0];
  }

  // Fallback: try to extract name from surrounding text patterns
  for (const pat of NAME_URL_PATTERNS) {
    const m = pat.pattern.exec(tweet.text);
    if (m) {
      const nameGroup = m[1] || m[2] || m[3];
      if (nameGroup && nameGroup.length > 2 && nameGroup.length < 80) {
        // Clean up and capitalize
        return cleanEntityName(nameGroup.trim());
      }
    }
  }

  // Last resort: use author's display name from profile (if available)
  // Not implemented yet — requires user lookup which is Stage B complexity
  
  return null;
}

/** Clean up a raw entity name into proper display form. */
function cleanEntityName(raw: string): string {
  return raw
    .replace(/\s+/g, " ")           // collapse whitespace
    .replace(/['"`]/g, "")          // strip quote chars
    .trim()
    .replace(/^the\s+/i, "");       // strip leading "The "
}

/** Build a dedup-friendly key from a URL. */
function normalizeKey(url: string): string {
  try {
    const u = new URL(normaliseUrl(url));
    // Normalize to just domain + path for domain-level matching
    return `domain:${u.hostname.toLowerCase()}|path:${u.pathname.toLowerCase().replace(/\/+$/, "")}`;
  } catch {
    return `fallback:${normaliseUrl(url).toLowerCase()}`;
  }
}
