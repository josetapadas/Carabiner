/**
 * Core domain types for carabiner Annotator.
 *
 * The hierarchy is:
 *   Project     — an optional named grouping for flows and notes
 *   Annotation  — a marked range in a file + your comment
 *   FlowStep    — a reference to an annotation, positioned within a flow
 *   Flow        — an ordered sequence of steps tracing a code path
 *   CarabinerData — the top-level workspace store
 */

/** A named container that scopes a set of flows and notes */
export interface Project {
  id: string;
  name: string;
  createdAt: string;
}

/** Serialisable representation of a code range (VS Code Range isn't JSON-friendly) */
export interface SerializedRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

/** A single annotation pinned to a file range */
export interface Annotation {
  id: string;
  /** Workspace-relative file path (e.g. "src/auth/login.py") */
  filePath: string;
  range: SerializedRange;
  /** Human comment — your observation, concern, or explanation */
  comment: string;
  /** Optional project this note belongs to */
  projectId?: string;
  createdAt: string;
}

/** A step in a flow — wraps an annotation with ordering + optional extra note */
export interface FlowStep {
  annotationId: string;
  /** Optional per-step note that only applies in this flow's context */
  note?: string;
}

/** An ordered code path through the codebase */
export interface Flow {
  id: string;
  name: string;
  steps: FlowStep[];
  /** Optional high-level description shown at top of exported markdown */
  description?: string;
  /** Optional project this flow belongs to */
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Top-level workspace data — serialised to .carabiner/data.json */
export interface CarabinerData {
  version: 1;
  projects: Project[];
  annotations: Record<string, Annotation>;
  flows: Flow[];
}

export function createEmptyData(): CarabinerData {
  return { version: 1, projects: [], annotations: {}, flows: [] };
}
