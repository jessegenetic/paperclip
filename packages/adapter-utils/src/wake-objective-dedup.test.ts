import { describe, expect, it } from "vitest";
import { renderPaperclipWakePrompt } from "./server-utils.js";

const brief = "Keep every approval gate. No deployment. ".repeat(300);
function wake(objectiveSource?: string) {
  return {
    version: 1, reason: "issue_assigned", issue: { id: "issue-1", title: "Reduce burn", description: brief },
    executionContinuation: {
      version: 1, companyId: "company-1", issueId: "issue-1",
      trigger: { reason: "issue_assigned", interactionId: null, sourceRunId: null },
      originCommentIds: [], objective: brief, objectiveSource, messages: [],
      humanResponses: [{ id: "approval-1", status: "rejected", result: "Do not deploy" }],
      interactionOutcomes: [], completedActions: [], completedWork: null,
      unresolvedInteractionIds: ["question-1"],
      coverage: { kind: "full_task_history", throughCommentId: "comment-9", summaryThroughCommentId: null },
    },
    unresolvedBlockerIssueIds: ["blocker-1"],
    dependencyBlockedInteraction: true,
  };
}

describe("wake objective deduplication", () => {
  it("removes only a second copy and retains directions, decisions, questions and coverage", () => {
    const input = wake("issue_description");
    const before = renderPaperclipWakePrompt(wake(), { suppressIssueDescription: true });
    const after = renderPaperclipWakePrompt(input, { suppressIssueDescription: true });
    expect(after).not.toContain(brief);
    expect(after).toContain("/api/issues/issue-1");
    for (const retained of ["approval-1", "Do not deploy", "question-1", "comment-9", "blocker-1"])
      expect(after).toContain(retained);
    // The full authoritative task section is still sent by the opted-in adapter.
    const task = `Paperclip task context:\n${brief}`;
    expect(task + after).toContain(brief);
    expect((task + before).length - (task + after).length).toBeGreaterThan(11_000);
    console.log(JSON.stringify({ beforeChars: (task + before).length, afterChars: (task + after).length,
      beforeBytes: Buffer.byteLength(task + before), afterBytes: Buffer.byteLength(task + after) }));
  });

  it.each([undefined, "human_comment", "issue_title"])("keeps %s objectives even when the task description is present", source => {
    expect(renderPaperclipWakePrompt(wake(source), { suppressIssueDescription: true })).toContain(brief);
  });

  it("keeps the objective when it is the only guaranteed copy", () => {
    expect(renderPaperclipWakePrompt(wake("issue_description"))).toContain(brief);
    expect(renderPaperclipWakePrompt(wake("issue_description"), { resumedSession: true })).toContain(brief);
  });
});
