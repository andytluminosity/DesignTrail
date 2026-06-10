// Deterministic mapping from an LLM-identified component to a branch id.
// Branches ARE components; there is no commit-message keyword logic.

const MAIN_BRANCH = "main";

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
 * Derives a stable branch id from a climbed DOM container's identity: its `id`
 * (preferred) else its first class name. Returns null for anonymous containers
 * (no id/class) — those can't get a stable, reusable branch id across commits,
 * so the climb skips noding them but keeps climbing through them.
 */
export function deriveDomBranchId(identity: {
  id?: string;
  firstClass?: string;
}): string | null {
  const raw = identity.id?.trim() || identity.firstClass?.trim() || "";
  if (!raw) return null;
  const id = slug(raw);
  return id || null;
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
