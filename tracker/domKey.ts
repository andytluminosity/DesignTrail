// Stable, instance-unique identity for a DOM container.
//
// Grouping screenshots by "the same container" requires an identity that (a)
// distinguishes sibling elements that share a CSS class (e.g. the repeated
// `.card` stat cards) and (b) stays stable when the code changes in ways that
// don't move the container (editing a value from "318" to "319", restyling,
// etc.). A single class name (the old `firstClass` identity) fails (a): every
// `.card` collapses into one branch.
//
// We build a shortest anchored DOM path from the element up to the nearest
// strong anchor (an `id`), preferring stable anchors at each level:
//   1. `id`                      -> globally unique, stops the climb
//   2. `data-testid`/`data-*`    -> author-provided stable hook
//   3. ARIA role + accessible name (e.g. a card's heading text)
//   4. tag + sorted class list + `:nth-of-type` index (structural fallback)
// Volatile text content (the stat value) is never part of the key, so editing
// it reuses the same container; renaming a card's heading (a real semantic
// change) yields a new container, which is acceptable.

import { createHash } from "crypto";
import type { ElementHandle } from "playwright";
import { slug, MAIN_BRANCH } from "./branch.js";

export type ContainerIdentity = {
  // Stable identity string (path of anchored segments), scoped by nav path.
  key: string;
  // Best-effort VALID CSS selector that re-locates the element (never uses the
  // `[name=...]` identity pseudo, which is not real CSS).
  selector: string;
  // Human-readable name for the container (used for the branch id + folders).
  label: string;
  // Whether this element is a distinct, identifiable container (has an id,
  // class, data hook, role, or accessible name) versus an anonymous wrapper.
  meaningful: boolean;
};

/**
 * Computes the stable container identity for a live DOM element. Runs in the
 * browser via `el.evaluate`, then scopes the key by `navPath` so the same
 * structural path on two different routes never collides.
 */
export async function computeContainerIdentity(
  el: ElementHandle,
  navPath: string
): Promise<ContainerIdentity> {
  // NOTE: this callback runs in the browser via Playwright. It must contain NO
  // named inner functions (declarations or `const` arrows): the tsx/esbuild
  // `keepNames` transform wraps named functions with a `__name` helper that does
  // not exist in Playwright's evaluate context, throwing `__name is not defined`.
  // Everything is therefore inlined.
  const raw = (await el.evaluate((node: Element) => {
    const MAX = 60;
    const cssLib = (window as unknown as { CSS?: { escape?: (v: string) => string } }).CSS;
    const canEscape = !!(cssLib && cssLib.escape);

    const keyParts: string[] = [];
    const selParts: string[] = [];
    let labelName = "";
    let selfMeaningful = false;

    let cur: Element | null = node;
    let guard = 0;
    while (cur && guard < 64) {
      guard += 1;
      const tag = cur.tagName.toLowerCase();
      if (tag === "html" || tag === "body") break;

      // classes, sorted for stability
      let classes: string[] =
        typeof cur.className === "string" && cur.className.trim()
          ? cur.className.trim().split(/\s+/)
          : Array.from(cur.classList || []);
      classes = classes.filter(Boolean).slice().sort();

      // nth-of-type among same-tag siblings
      let idx = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) idx += 1;
        sib = sib.previousElementSibling;
      }

      // data-* anchor
      let dName = "";
      if (cur.getAttribute("data-testid")) dName = "data-testid";
      else if (cur.getAttribute("data-test-id")) dName = "data-test-id";
      else if (cur.getAttribute("data-component")) dName = "data-component";

      // accessible name (aria-label, else a single heading descendant). Repeated
      // containers like a stats grid contain many card headings; using the first
      // one would mislabel the grid as "Total Commits". Only a single heading is
      // treated as the container's semantic name.
      let name = "";
      const aria = cur.getAttribute("aria-label");
      if (aria && aria.trim()) {
        name = aria.replace(/\s+/g, " ").trim();
      } else {
        const headings = cur.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']");
        if (headings.length === 1) {
          const heading = headings[0];
          if (heading && heading.textContent && heading.textContent.trim()) {
            name = heading.textContent.replace(/\s+/g, " ").trim();
          }
        }
      }
      if (name.length > MAX) name = name.slice(0, MAX);

      const id = cur.id ? String(cur.id).trim() : "";

      if (guard === 1) {
        labelName = name || (classes.length ? classes[0] : "") || tag;
        selfMeaningful = Boolean(
          id || classes.length || dName || cur.getAttribute("role") || name
        );
      }

      let keyPart = "";
      let selPart = "";
      let stop = false;

      if (id) {
        keyPart = "#" + id;
        selPart = "#" + (canEscape ? cssLib!.escape!(id) : id.replace(/[^a-zA-Z0-9_-]/g, "\\$&"));
        stop = true;
      } else if (dName) {
        const dv = cur.getAttribute(dName) || "";
        keyPart = tag + "[" + dName + "=" + dv + "]";
        selPart = tag + "[" + dName + '="' + dv + '"]';
      } else {
        const classKey = classes.length ? "." + classes.join(".") : "";
        let classSel = "";
        if (classes.length) {
          const escaped: string[] = [];
          for (let i = 0; i < classes.length; i += 1) {
            const c = classes[i];
            escaped.push(canEscape ? cssLib!.escape!(c) : c.replace(/[^a-zA-Z0-9_-]/g, "\\$&"));
          }
          classSel = "." + escaped.join(".");
        }
        // The selector must be valid CSS, so it never uses the [name=] pseudo.
        keyPart = name
          ? tag + classKey + "[name=" + name + "]"
          : tag + classKey + ":nth-of-type(" + idx + ")";
        selPart = tag + classSel + ":nth-of-type(" + idx + ")";
      }

      keyParts.push(keyPart);
      selParts.push(selPart);
      if (stop) break;
      cur = cur.parentElement;
    }

    keyParts.reverse();
    selParts.reverse();

    return {
      key: keyParts.join(">"),
      selector: selParts.join(">"),
      label: labelName,
      meaningful: selfMeaningful,
    };
  })) as { key: string; selector: string; label: string; meaningful: boolean };

  return {
    key: `${navPath}|${raw.key}`,
    selector: raw.selector,
    label: raw.label,
    meaningful: raw.meaningful,
  };
}

/**
 * Maps a container identity to a stable, readable, filesystem-safe branch id.
 * The readable label keeps Miro/folders legible; a short hash of the full key
 * guarantees uniqueness (so two unnamed `.card`s never collide) while staying
 * deterministic, so the same container reuses the same branch id across commits.
 */
export function keyToBranchId(identity: { key: string; label: string }): string {
  const base = slug(identity.label) || "node";
  const hash = createHash("sha1").update(identity.key).digest("hex").slice(0, 6);
  return `${base}-${hash}`;
}

export { MAIN_BRANCH };
