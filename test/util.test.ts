import { describe, expect, it } from "vitest";
import { chunkText, mdToMrkdwn, money, shortId, shortPath, slackToPlain, tok } from "../src/util.js";

describe("slackToPlain (Slack entities → model-friendly text)", () => {
  it("decodes entities (&amp; last, so &amp;lt; stays literal)", () => {
    expect(slackToPlain("a &amp;&amp; b &lt; c &gt; d &quot;q&quot;")).toBe('a && b < c > d "q"');
    expect(slackToPlain("&amp;lt;")).toBe("&lt;"); // user typed the literal text
  });

  it("unwraps labeled and bare link markup to GFM", () => {
    expect(slackToPlain("see <https://x.y/docs|the docs> here")).toBe("see [the docs](https://x.y/docs) here");
    expect(slackToPlain("open <https://x.y> now")).toBe("open https://x.y now");
  });

  it("converts channel refs", () => {
    expect(slackToPlain("ask in <#C0DE|general>")).toBe("ask in #general");
    expect(slackToPlain("ask in <#C0DE>")).toBe("ask in #channel");
  });

  it("leaves code spans and fenced blocks untouched", () => {
    expect(slackToPlain("`x &lt; y &amp;&amp; z`")).toBe("`x &lt; y &amp;&amp; z`");
    const fenced = "```\n<a href=\"x\">&amp;</a>\n```";
    expect(slackToPlain(fenced)).toBe(fenced);
  });

  it("passes plain text through", () => {
    expect(slackToPlain("just a normal prompt")).toBe("just a normal prompt");
  });
});

describe("chunkText", () => {
  it("no-ops short text", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
  });
  it("splits long text at newlines when possible", () => {
    const long = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
    const chunks = chunkText(long, 3800);
    expect(chunks.length).toBe(2);
    expect(chunks[1]).toMatch(/^b/);
    expect(chunks.every((c) => c.length <= 3800)).toBe(true);
  });
  it("hard-splits text without newline room", () => {
    const chunks = chunkText("a".repeat(9000), 3800);
    expect(chunks.length).toBe(3);
  });
});

describe("shortPath", () => {
  it("keeps short paths", () => {
    expect(shortPath("a/b.ts")).toBe("a/b.ts");
  });
  it("elides deep paths", () => {
    expect(shortPath("/x/y/z/q/file.ts")).toBe("…/q/file.ts");
  });
});

describe("money/tok", () => {
  it("formats cost", () => {
    expect(money(0.0032)).toBe("$0.0032");
    expect(money(0.52)).toBe("$0.520");
  });
  it("formats token counts", () => {
    expect(tok(950)).toBe("950");
    expect(tok(12_400)).toBe("12.4k");
    expect(tok(1_200_000)).toBe("1.2M");
  });
});

describe("shortId", () => {
  it("strips ses_ prefix", () => {
    expect(shortId("ses_abcdef0123456789")).toBe("abcdef0123");
  });
});

describe("mdToMrkdwn (GFM → Slack)", () => {
  it("converts bold, italics, and headings", () => {
    expect(mdToMrkdwn("**Fresh from 2026**")).toBe("*Fresh from 2026*");
    expect(mdToMrkdwn("# Title")).toBe("*Title*");
    expect(mdToMrkdwn("### Sub **b** line")).toBe("*Sub *b* line*");
    expect(mdToMrkdwn("some *emphasis* here")).toBe("some _emphasis_ here");
    expect(mdToMrkdwn("snake_case_id")).toBe("snake_case_id"); // underscore words untouched
  });

  it("converts bullets and links", () => {
    expect(mdToMrkdwn("- [[item]] — note")).toBe("• [[item]] — note");
    expect(mdToMrkdwn("* star bullet")).toBe("• star bullet");
    expect(mdToMrkdwn("see [docs](https://x.y) now")).toBe("see <https://x.y|docs> now");
    expect(mdToMrkdwn("![alt](https://x.y/a.png)")).toBe("alt https://x.y/a.png");
  });

  it("leaves fenced code blocks and inline code untouched", () => {
    const md = "text **bold**\n```js\nconst a = **1**;\n```\n`code **not** touched` end";
    const out = mdToMrkdwn(md);
    expect(out).toContain("```js\nconst a = **1**;\n```");
    expect(out).toContain("`code **not** touched`");
    expect(out).toContain("text *bold*");
  });

  it("passes plain text through", () => {
    expect(mdToMrkdwn("plain line 1\nplain line 2")).toBe("plain line 1\nplain line 2");
  });
});

describe("dur (run durations in the summary line)", () => {
  it("formats seconds, minutes, and hours tersely", async () => {
    const { dur } = await import("../src/util.js");
    expect(dur(0)).toBe("1s");
    expect(dur(41_000)).toBe("41s");
    expect(dur(60_000)).toBe("1m");
    expect(dur(134_000)).toBe("2m 14s");
    expect(dur(3_600_000)).toBe("1h");
    expect(dur(3_780_000)).toBe("1h 3m");
  });
});

describe("mdToMrkdwn GFM tables (RQ5)", () => {
  it("converts a table into an aligned fenced block", () => {
    const md = "| File | Change |\n| --- | --- |\n| a.ts | +12 |\n| long-name.ts | +3 |";
    const out = mdToMrkdwn(md);
    expect(out).toContain("```\n");
    expect(out).toContain("File          Change");
    expect(out).toContain("a.ts          +12");
    expect(out).toContain("long-name.ts  +3");
    expect(out).not.toContain("| --- |"); // separator rows dropped
  });

  it("leaves non-table pipe lines alone", () => {
    expect(mdToMrkdwn("a | b on one line")).toBe("a | b on one line");
    expect(mdToMrkdwn("| only one row |")).toBe("| only one row |");
  });
});
