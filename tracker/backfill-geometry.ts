// Deprecated. Geometry backfill targeted the old branch/iteration model, which
// has been replaced by the explicit three-tree model (page -> component ->
// version). Component geometry is now recorded at capture time and is no longer
// needed to derive the tree (the hierarchy is stored directly), so this command
// is a no-op kept only so existing tooling/scripts don't break.

async function main(): Promise<void> {
  console.log(
    "backfill-geometry is deprecated: the three-tree model records geometry at " +
      "capture time and derives no hierarchy from it. Nothing to do."
  );
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
