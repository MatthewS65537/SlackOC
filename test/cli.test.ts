import { describe, expect, it } from "vitest";
import { parseFlags } from "../src/args.js";

describe("parseFlags", () => {
  it("parses --flag value pairs", () => {
    expect(parseFlags(["--bot-token", "xoxb-1", "--owner", "U123"], ["bot-token", "owner"])).toEqual({
      "bot-token": "xoxb-1",
      owner: "U123",
    });
  });
  it("parses --flag=value", () => {
    expect(parseFlags(["--dir=/x/y"], ["dir"])).toEqual({ dir: "/x/y" });
  });
  it("ignores non-flag positionals", () => {
    expect(parseFlags(["--bot-token", "t", "junk"], ["bot-token"])).toEqual({ "bot-token": "t" });
  });
  it("rejects unknown flags", () => {
    expect(() => parseFlags(["--nope", "x"], ["bot-token"])).toThrow(/unknown flag/);
  });
  it("rejects flag without a value", () => {
    expect(() => parseFlags(["--dir"], ["dir"])).toThrow(/needs a value/);
  });
});
