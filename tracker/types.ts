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

export type ScreenshotTarget = {
  // how to LOCATE the changed element (or full page)
  mode: "full" | "selector" | "text" | "role";
  value?: string;
  // explicit element to SCREENSHOT (the part of the page to capture).
  // omit to screenshot the located element itself.
  capture?: LocatorSpec;
};

export type CommitType = "UI_CHANGE" | "FEATURE" | "REFACTOR" | "UNKNOWN";

export type CommitAnalysis = {
  summary: string;
  type: CommitType;
  path?: string; // route to navigate to before capture, e.g. "/settings"; defaults to "/"
  screenshotTarget: ScreenshotTarget;
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
