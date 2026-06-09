export type CommitData = {
  hash: string;
  message: string;
  diff: string;
  timestamp: number;
  repoName?: string;
};

export type LocatorSpec = {
  mode: "selector" | "text" | "role";
  value: string;
};

// On-screen geometry of a located element, in page (document) pixels. pageW/pageH
// are the full scrollable document dimensions, so the spatial board can lay every
// component out in one shared coordinate system.
export type NodeGeometry = {
  x: number;
  y: number;
  w: number;
  h: number;
  pageW: number;
  pageH: number;
};

export type ScreenshotTarget = {
  // How to locate the changed element (or full page).
  mode: "full" | "selector" | "text" | "role";
  value?: string;
  // Container to climb to and screenshot/measure: the smallest meaningful frame
  // around the located element. It defines this component's branch and drives
  // both the screenshot and the recorded geometry. Absent for "full" captures.
  capture?: LocatorSpec;
};

export type CommitType = "UI_CHANGE" | "FEATURE" | "REFACTOR" | "UNKNOWN";

// One changed component detected by the LLM within a single commit. A commit can
// change several components, so analysis returns a list of these.
export type ComponentChange = {
  component: string; // stable id; "" or "main" => the main branch (broad/global change)
  parentBranch?: string; // NEW component only: existing branch to nest under ("" => main)
  summary: string;
  type: CommitType;
  path?: string; // route to navigate to before this component's capture; defaults to "/"
  screenshotTarget: ScreenshotTarget;
};

export type CommitAnalysis = {
  components: ComponentChange[];
};

// A single component change for one commit — the node of the design graph.
export type IterationNode = {
  id: string; // `${commitHash}:${branchId}`
  commitHash: string;
  branchId: string;
  parentId: string | null; // previous node on the SAME component branch, null if first
  summary: string;
  type: CommitType;
  screenshotPath: string; // relative, e.g. captures/<repo>/<hash>/<branchId>.png
  timestamp: number;
  // On-screen rect of the captured container at capture time (the climbed
  // `capture` element, or the located element when no container was chosen).
  // Undefined for nodes captured before geometry tracking existed, or whose
  // capture fell back to full page.
  geometry?: NodeGeometry;
};

// A component branch — the node of the component tree.
export type BranchRecord = {
  id: string; // "main" | "<component>"
  parentBranchId: string | null; // null for main; component nesting (LLM-driven)
  forkNodeId: string | null; // parent-branch tip node this split from (fork point)
  createdAt: number;
  // How to re-screenshot this branch's component on demand (e.g. for cascading
  // ancestor updates). navPath is the route to navigate to; target is the
  // component locator. Undefined for legacy branches created before this existed.
  navPath?: string;
  target?: ScreenshotTarget;
};

// Result of capturing one screenshot job: the file it wrote and, when a concrete
// element was located, that element's on-screen geometry.
export type ScreenshotResult = {
  outputPath: string;
  geometry?: NodeGeometry;
};

export type PageContext = {
  path: string;
  elements: UiElement[];
};

export type UiElement = {
  tag: string;
  id?: string;
  classes: string[];
  role?: string;
  testid?: string;
  text?: string;
  // Best-effort selector for the nearest identifiable ancestor (id/class), useful
  // as context when assigning component nesting.
  parent?: string;
};
