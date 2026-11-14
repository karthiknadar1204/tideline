import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportMarkdown } from "../app/workspace/[id]/reports/saved/[reportId]/report-markdown";

test("saved reports render Markdown without active content or remote embeds", () => {
  const markdown = [
    "# Findings",
    "A **finding** and [reference](https://example.com).",
    "[script URL](javascript:alert%281%29) and [protocol-relative URL](//example.com).",
    "![tracking pixel](https://example.com/track)",
    '<iframe src="https://example.com/frame"></iframe>',
    "<script>window.untrusted = true</script>",
  ].join("\n\n");
  const html = renderToStaticMarkup(createElement(ReportMarkdown, { markdown }));

  assert.match(html, /<h2>Findings<\/h2>/);
  assert.match(html, /<strong>finding<\/strong>/);
  assert.match(html, /<a href="https:\/\/example\.com" rel="noopener noreferrer" target="_blank">reference<\/a>/);
  assert.match(html, /<span>script URL<\/span>/);
  assert.match(html, /<span>protocol-relative URL<\/span>/);
  assert.doesNotMatch(html, /<(?:iframe|img|script)\b|javascript:|example\.com\/(?:track|frame)/);
});
