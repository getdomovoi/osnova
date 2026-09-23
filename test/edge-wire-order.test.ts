import { expect, it } from "vitest";
import { edgeKinds } from "../src/index/edgeStore.js";

it("keeps the stored encoding of edge kinds fixed", () => {
  // The index in this list is what the edge section stores for each edge. Renumbering it would make
  // every stored edge read back as a different kind while both section hashes still verify, so a
  // change here must come with an edge section format version bump.
  expect(edgeKinds).toEqual(["calls", "references", "imports", "extends", "routes"]);
});
