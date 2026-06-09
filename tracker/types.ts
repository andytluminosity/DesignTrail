export type CommitData = {
  hash: string;
  message: string;
  diff: string;
  timestamp: number;
};

export type LocatorSpec = {
  mode: "selector" | "text" | "role";
  value: string;
};

export type ScreenshotTarget = {
  // how to LOCATE the changed element (or full page)
  mode: "full" | "selector" | "text" | "role";
  value?: string;
  // explicit element to SCREENSHOT (the part of the page to capture).
  // omit to screenshot the located element itself.
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
};

// A component branch — the node of the component tree.
export type BranchRecord = {
  id: string; // "main" | "<component>"
  parentBranchId: string | null; // null for main; component nesting (LLM-driven)
  forkNodeId: string | null; // parent-branch tip node this split from (fork point)
  createdAt: number;
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
};
