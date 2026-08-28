import { describe, expect, it } from "@effect/vitest";
import { GrokSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { buildInitialGrokProviderSnapshot } from "./GrokProvider.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

describe("Grok model switching", () => {
  it.effect("does not require a new thread when changing models", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: true }),
      );

      expect(snapshot.requiresNewThreadForModelChange).toBeUndefined();
    }),
  );
});
