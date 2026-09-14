import test from "node:test";
import assert from "node:assert/strict";
import { createLabPaths } from "../app/lab_paths.mjs";
import { readConfig } from "../lab_config.mjs";

test("subdirectory applies to API, images, preloads, practice and storage", () => {
  for (const base of ["/inscription-system", "/research/repair-v2/"]) {
    const paths = createLabPaths(base);
    assert.equal(paths.url("/api/task/save"), paths.base + "api/task/save");
    const entry = { response: "/study-data/not-a-url", imageUrl: "/study-data/preserve-answer.jpg" };
    const input = { entry, tasks: [{ coverImageUrl: "/study-data/cover.jpg?v=123", preloadImageUrl: "/study-data/page.jpg" }],
      material: { pages: [{ imageUrl: "/study-data/page.jpg", thumbnailUrl: "/study-data/thumb.jpg" }],
        targets: [{ glyphUrl: "/study-data/glyph.png", maskUrl: "" }] }, message: "/study-data/free-text" };
    const result = paths.materials(input);
    assert.equal(result.tasks[0].coverImageUrl, paths.base + "study-data/cover.jpg?v=123");
    assert.equal(result.tasks[0].preloadImageUrl, paths.base + "study-data/page.jpg");
    assert.equal(result.material.pages[0].thumbnailUrl, paths.base + "study-data/thumb.jpg");
    assert.equal(result.material.targets[0].glyphUrl, paths.base + "study-data/glyph.png");
    assert.equal(result.material.targets[0].maskUrl, "");
    assert.equal(result.entry, entry);
    assert.equal(result.message, input.message);
    assert.equal(input.tasks[0].coverImageUrl, "/study-data/cover.jpg?v=123");
    assert.deepEqual(paths.materials(result), result);
  }
  assert.notEqual(createLabPaths("/a").storageKey("draft"), createLabPaths("/b").storageKey("draft"));
});

test("deployment config has one configurable path and a path-specific cookie", () => {
  const config = readConfig({});
  assert.equal(config.basePath, "/inscription-system");
  const next = readConfig({ LAB_PUBLIC_URL: "https://www.musicxlab.com/research/repair/" });
  assert.equal(next.basePath, "/research/repair");
  assert.notEqual(config.cookieName, next.cookieName);
  assert.throws(() => readConfig({ LAB_PUBLIC_URL: "https://www.musicxlab.com/" }));
  assert.throws(() => readConfig({ LAB_PUBLIC_URL: "https://www.musicxlab.com/foo?bar=1" }));
});
