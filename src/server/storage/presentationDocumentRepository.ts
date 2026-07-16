export type CommitPresentationDocumentInput = {
  userId: string;
  presentationId: string;
  expectedSourceRevision: number;
  baseSource: string;
  nextSource: string;
};

export type CommitPresentationDocumentResult = {
  sourceRevision: number;
  updatedAt: string;
};

/**
 * Owns conflict-safe writes to SlideX's canonical Presentation document.
 *
 * Implementations must scope every operation to the verified product user and
 * must never overwrite a source that changed after the agent run was accepted.
 */
export interface PresentationDocumentRepository {
  commitAgentResult(
    input: CommitPresentationDocumentInput
  ): Promise<CommitPresentationDocumentResult>;
}

export class PresentationDocumentConflictError extends Error {
  constructor() {
    super("Presentation changed while the agent was working");
    this.name = "PresentationDocumentConflictError";
  }
}

export class PresentationDocumentInaccessibleError extends Error {
  constructor() {
    super("Presentation not found or not accessible");
    this.name = "PresentationDocumentInaccessibleError";
  }
}
