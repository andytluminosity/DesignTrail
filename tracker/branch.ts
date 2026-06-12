// Deterministic mapping from an LLM-identified component to a branch id.
// Branches ARE components; there is no commit-message keyword logic.

const MAIN_BRANCH = "main";

// Hard ceiling on how many DOM ancestors the capture may climb above the
// located changed element. The analyzer (LLM) decides how far to climb per
// change so the captured container frames a coherent component; this cap is the
// authoritative backstop so a bad suggestion can never drag the capture up
// toward the page root.
export const MAX_CLIMB_LEVELS = 4;
// Climb used when the analyzer omits/garbles a value: the located element's
// immediate parent, matching DesignTrail's long-standing default container.
const DEFAULT_CLIMB_LEVELS = 1;

/**
 * Clamps an analyzer-provided climb count to a whole number of DOM levels within
 * [0, MAX_CLIMB_LEVELS]. A missing or non-numeric value falls back to the
 * default single-level climb so a targeted capture still rises off the precise
 * changed leaf to its container. Shared by the analyzer (when recording the
 * suggested climb) and the capture layer (which enforces it authoritatively).
 */
export function clampClimbLevels(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CLIMB_LEVELS;
  return Math.max(0, Math.min(MAX_CLIMB_LEVELS, Math.round(n)));
}

/**
 * Normalizes a component/branch name into a stable, filesystem-safe slug.
 * Lowercase, non-alphanumerics collapse to single hyphens, trimmed.
 */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolves the branch a component change belongs to. An empty/blank component
 * (broad, non-visual, or global change) maps to "main".
 */
export function resolveBranch(component?: string): string {
  const trimmed = component?.trim();
  if (!trimmed) return MAIN_BRANCH;
  return slug(trimmed) || MAIN_BRANCH;
}

/**
 * Resolves the parent branch a NEW branch nests under. Only honored when it
 * names a branch that actually exists; otherwise falls back to "main". This is
 * the deterministic backstop if the LLM picks a parent not in the tree.
 */
export function resolveParentBranch(
  parentBranch: string | undefined,
  existingBranches: Set<string>
): string {
  const trimmed = parentBranch?.trim();
  if (!trimmed) return MAIN_BRANCH;
  const candidate = slug(trimmed);
  return existingBranches.has(candidate) ? candidate : MAIN_BRANCH;
}

export { MAIN_BRANCH };
