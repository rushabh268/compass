import { readFile } from "node:fs/promises";

export async function loadSyntheticFixtures() {
  const fixture = JSON.parse(
    await readFile(new URL("./synthetic.json", import.meta.url), "utf8"),
  );
  // Construct deliberate fake credentials in test memory to avoid misleading
  // public secret alerts while exercising the original DLP inputs unchanged.
  fixture.detections = fixture.detections.map(({ textParts, ...example }) =>
    textParts === undefined ? example : { ...example, text: textParts.join("") },
  );
  return fixture;
}
