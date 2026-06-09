export type CommitData = {
  hash: string;
  message: string;
  diff: string;
  timestamp: number;
};

export type ScreenshotTarget = {
  mode: "full" | "selector" | "text" | "role";
  value?: string;
};

export type CommitType = "UI_CHANGE" | "FEATURE" | "REFACTOR" | "UNKNOWN";

export type CommitAnalysis = {
  summary: string;
  type: CommitType;
  screenshotTarget: ScreenshotTarget;
};
