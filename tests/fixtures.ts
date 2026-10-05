import type { Snapshot } from "../src/schema.ts";

const TEST_DESCRIPTION = "A synthetic Link Card used to verify the persisted format and renderer.";

export function syntheticSnapshot(): Snapshot {
  return {
    card: {
      version: 1,
      type: "link-card",
      url: "https://example.com/articles/card",
      title: "Example article",
      description: TEST_DESCRIPTION,
      siteName: "Example",
    },
    unknown: {},
  };
}
