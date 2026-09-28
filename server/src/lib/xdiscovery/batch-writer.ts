/**
 * Batch issue writer for X discovery (LOL-36).
 * 
 * Writes an editorial queue issue per batch in Paperclip, linking all
 * candidate records from a single pipeline run. In Stage A this produces
 * dry-run output; Stage B will use the actual Paperclip API to create issues.
 */

import type { CandidateRecord } from "./types.js";

export interface EditorialBatchIssue {
  /** Title of the generated issue. */
  title: string;
  /** Body containing all candidates formatted as a markdown table + detail list. */
  body: string;
  /** Count of new (non-duplicate) entities. */
  newEntityCount: number;
  /** Total candidates including duplicates. */
  totalCount: number;
}

const EDITORIAL_STATUS = "not_reviewed";

/**
 * Write an editorial queue issue body from a batch of candidate records.
 */
export function writeBatchIssue(
  candidates: CandidateRecord[],
  runBatchId: string,
  activeFamilies: string[]
): EditorialBatchIssue {
  const newCandidates = candidates.filter(c => c.editorial_status === EDITORIAL_STATUS);
  
  // Build title
  const title = "[Editorial Queue] X Discovery — " + newCandidates.length + " new entities found (" + candidates.length + " total)";

  const lines: string[] = [];
  
  lines.push("# Editorial Queue: X Discovery Batch");
  lines.push("");
  lines.push("Run ID: `" + runBatchId + "`");
  lines.push("Timestamp: " + new Date().toISOString());
  lines.push("Query families used: " + activeFamilies.join(", "));
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("- **New entities:** " + newCandidates.length);
  lines.push("- **Duplicates (already in catalog):** " + (candidates.length - newCandidates.length));
  lines.push("- All marked with editorial status " + EDITORIAL_STATUS + " — see source post before any endorsement implication.");
  lines.push("");
  lines.push("## Candidates Table");
  lines.push("");

  if (candidates.length > 0) {
    // Markdown table header
    lines.push("| # | Name | URL | Domain | Confidence Note | Source Post |");
    lines.push("|---|------|-----|--------|----------------|-------------|");

    candidates.forEach((c, i) => {
      const isNew = !candidates.slice(0, i).some(prev => prev.candidate_id === c.candidate_id);
      const flag = isNew ? "NEW" : "[dup]";
      const url = shortUrl(c.url);
      const domain = c.domain || "?";
      const note = truncateNote(c.confidence_note, 40);
      const post = truncatePost(c.source_posts[0]);
      lines.push("| " + (i + 1) + " | " + flag + " " + c.name + " | " + url + " | " + domain + " | " + note + " | " + post + " |");
    });
  } else {
    lines.push("*No candidates in this batch.*");
  }

  // Detail section for each candidate
  if (newCandidates.length > 0) {
    lines.push("");
    lines.push("## New Entities — Full Details");
    lines.push("");

    for (const c of newCandidates) {
      lines.push("### " + c.name);
      lines.push("");
      lines.push("- **URL:** " + c.url);
      lines.push("- **Domain:** " + (c.domain || "(unknown)"));
      lines.push("- **Categories:** " + c.categories.join(", "));
      lines.push("- **Source tweets:**");
      
      for (const sp of c.source_posts) {
        lines.push("  - [" + sp.tweet_id + "](" + sp.url + ") — \"" + truncatePost(sp) + "\"");
      }

      lines.push("- **Confidence note:** " + c.confidence_note);
      lines.push("- **Provenance:** discovered via X search on " + new Date(c.discovered_at).toLocaleString());
      lines.push("");
    }
  }

  // Footer warning
  lines.push("---");
  lines.push("");
  lines.push("Truthfulness reminder: These candidates come from X discussion threads.");
  lines.push("They have NOT been reviewed, verified, or endorsed by Lolo. Any marketplace listing");
  lines.push("must go through editorial review first. Popularity on X is not quality.");

  return {
    title,
    body: lines.join("\n"),
    newEntityCount: newCandidates.length,
    totalCount: candidates.length,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const pathPart = u.pathname.length > 40 ? "/" + u.pathname.substring(0, 37) + "..." : u.pathname;
    return u.hostname + pathPart;
  } catch {
    return url.length > 60 ? url.substring(0, 57) + "..." : url;
  }
}

function truncatePost(post: { tweet_id?: string; text_snippet?: string; url?: string }, maxLen = 80): string {
  if (!post.text_snippet) return "";
  if (post.text_snippet.length <= maxLen) return post.text_snippet;
  return post.text_snippet.substring(0, maxLen) + "...";
}

function truncateNote(note: string, maxLen = 40): string {
  if (note.length <= maxLen) return note;
  return note.substring(0, maxLen) + "...";
}
