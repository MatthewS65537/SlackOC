import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import { canonicalDir } from "../src/paths.js";

const root = join(import.meta.dirname, ".fixtures", "paths");
afterAll(() => rmSync(root, { recursive: true, force: true }));

it("collapses real symlinks, trailing slashes and dot segments without merging same basenames", () => {
  const a = join(root, "a", "project");
  const b = join(root, "b", "project");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  symlinkSync(a, join(root, "alias"));
  expect(canonicalDir(join(root, "alias") + "/./")).toBe(canonicalDir(a));
  expect(canonicalDir(a + "/../project/")).toBe(canonicalDir(a));
  expect(canonicalDir(b)).not.toBe(canonicalDir(a));
});

it("uses an absolute lexical fallback for missing paths, preserving spelling/case", () => {
  expect(canonicalDir("test/.fixtures/paths/missing/../CaseSensitive/"))
    .toBe(resolve("test/.fixtures/paths/CaseSensitive"));
  expect(canonicalDir(join(root, "missing", "X"))).not.toBe(canonicalDir(join(root, "missing", "x")));
});
