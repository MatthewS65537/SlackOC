import { describe, expect, it } from "vitest";
import { parseBackslash } from "../src/commands/parse.js";

describe("parseBackslash", () => {
  it("parses name + args", () => {
    expect(parseBackslash("\\model openai/gpt-5-high")).toEqual({ name: "model", args: "openai/gpt-5-high" });
  });
  it("parses bare command", () => {
    expect(parseBackslash("\\stop")).toEqual({ name: "stop", args: "" });
  });
  it("lowercases the command name", () => {
    expect(parseBackslash("\\VERBOSE on")).toEqual({ name: "verbose", args: "on" });
  });
  it("keeps multiline args", () => {
    expect(parseBackslash("\\cmd summarize --deep\nwith more")).toEqual({
      name: "cmd",
      args: "summarize --deep\nwith more",
    });
  });
  it("returns null for ordinary text", () => {
    expect(parseBackslash("fix the auth bug")).toBeNull();
  });
  it("returns null for a real Slack slash command", () => {
    expect(parseBackslash("/remind me tomorrow")).toBeNull();
  });
  it("returns null for empty-ish input", () => {
    expect(parseBackslash("\\")).toBeNull();
    expect(parseBackslash("   ")).toBeNull();
  });
  it("parses command with only spaces after it", () => {
    expect(parseBackslash("\\status  ")).toEqual({ name: "status", args: "" });
  });
});
