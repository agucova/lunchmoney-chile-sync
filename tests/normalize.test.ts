import { describe, expect, test } from "bun:test";
import {
  SIMILARITY_THRESHOLD,
  descriptionSimilarity,
  normalizeDescription,
} from "../src/core/normalize.ts";

describe("normalizeDescription", () => {
  test("collapses whitespace, uppercases, strips accents", () => {
    expect(normalizeDescription("PAYU   *UBER TRIP")).toBe("PAYU *UBER TRIP");
    expect(normalizeDescription("Traspaso A:Agustín covarrubias")).toBe(
      "TRASPASO A:AGUSTIN COVARRUBIAS",
    );
    expect(normalizeDescription("  COM.MANTENCION  PLAN ")).toBe("COM.MANTENCION PLAN");
  });
});

describe("descriptionSimilarity (truncation variants from real Santander data)", () => {
  const observedPairs: Array<[string, string]> = [
    ["PAYU *UBER EA", "PAYU *UBER EATS"],
    ["PAYU *UBER TR", "PAYU *UBER TRIP"],
    ["DP *IKEA CO", "DP *IKEA COM"],
    ["UBER RIDES", "UBER RIDES UBER"],
  ];

  test("real truncation variants score above the match threshold", () => {
    for (const [a, b] of observedPairs) {
      const score = descriptionSimilarity(normalizeDescription(a), normalizeDescription(b));
      expect(score).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
    }
  });

  test("distinct merchants score below the threshold", () => {
    const distinct: Array<[string, string]> = [
      ["PAYU *UBER EATS", "DL*GOOGLE YOUTUBE"],
      ["40515-SBX COLON", "UBER RIDES UBER"],
      ["COM.MANTENCION PLAN", "PAYU *UBER TRIP"],
    ];
    for (const [a, b] of distinct) {
      const score = descriptionSimilarity(normalizeDescription(a), normalizeDescription(b));
      expect(score).toBeLessThan(SIMILARITY_THRESHOLD);
    }
  });

  test("identical strings score 1, symmetry holds", () => {
    expect(descriptionSimilarity("A B C", "A B C")).toBe(1);
    expect(descriptionSimilarity("PAYU *UBER EA", "PAYU *UBER EATS")).toBe(
      descriptionSimilarity("PAYU *UBER EATS", "PAYU *UBER EA"),
    );
  });
});
