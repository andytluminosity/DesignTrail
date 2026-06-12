/* global miro */

// The app iframe is served by the DesignTrail service, so /view-change is
// same-origin with this page.
const API_BASE = window.location.origin;

const VIEW_CHANGE_EVENT = "view-change";
const ABOUT_EVENT = "about-designtrail";

async function handleViewChange(event) {
  const item = event.items && event.items[0];
  if (!item) {
    await miro.board.notifications.showError(
      "Select a captured screenshot first."
    );
    return;
  }

  try {
    const info = await miro.board.getInfo();
    const response = await fetch(`${API_BASE}/view-change`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boardId: info.id, itemId: item.id }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }

    const shortHash = String(data.commitHash || "").slice(0, 7);
    await miro.board.notifications.showInfo(
      `Opening ${shortHash} at ${data.navPath} in your browser...`
    );
  } catch (error) {
    const message =
      error && error.message ? error.message : "Unknown error";
    await miro.board.notifications.showError(`View this change failed: ${message}`);
  }
}

async function handleAbout() {
  await miro.board.notifications.showInfo(
    "DesignTrail is running. Use View This Change on a captured screenshot to open its preview."
  );
}

async function init() {
  // Handlers fire when the user clicks a custom context-menu entry.
  await miro.board.ui.on(`custom:${VIEW_CHANGE_EVENT}`, handleViewChange);
  await miro.board.ui.on(`custom:${ABOUT_EVENT}`, handleAbout);

  // Miro shows a labeled App Actions dropdown when at least two custom actions
  // are registered. Keep both image-scoped so they appear only on screenshots.
  await miro.board.experimental.action.register({
    event: VIEW_CHANGE_EVENT,
    ui: {
      label: { en: "View This Change" },
      icon: "chat-two",
      description: "Check out this commit and open the app at the captured route",
      position: 1,
    },
    scope: "local",
    predicate: { type: "image" },
    selection: "single",
    contexts: { item: {} },
  });

  await miro.board.experimental.action.register({
    event: ABOUT_EVENT,
    ui: {
      label: { en: "About DesignTrail" },
      icon: "chat-two",
      description: "Confirm the DesignTrail Miro app is active on this board",
      position: 2,
    },
    scope: "local",
    predicate: { type: "image" },
    selection: "single",
    contexts: { item: {} },
  });
}

init().catch((error) => {
  console.error("DesignTrail Miro app failed to initialize:", error);
});
