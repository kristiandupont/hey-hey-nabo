import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCsv, parseTabList } from "../src/sheet.ts";

test("csv handles quoted commas, escaped quotes and embedded newlines", () => {
  const csv = 'a,"b, c","say ""hi"""\r\n"multi\nline",,x\n';
  assert.deepEqual(parseCsv(csv), [
    ["a", "b, c", 'say "hi"'],
    ["multi\nline", "", "x"],
  ]);
});

test("csv without a trailing newline keeps the last row", () => {
  assert.deepEqual(parseCsv("a,b\nc,d"), [
    ["a", "b"],
    ["c", "d"],
  ]);
});

test("tab list is read from the htmlview page source", () => {
  // Shape copied from the real page.
  const html =
    'items.push({name: "Uge 43", pageUrl: "https:\\/\\/docs.google.com\\/spreadsheets\\/d\\/x\\/htmlview\\/sheet?headers\\x3dtrue&gid=1879457789", gid: "1879457789",initialSheet: ("1879457789" == gid)});' +
    'items.push({name: "Fordeling \\u00e6\\u00f8\\u00e5", pageUrl: "x", gid: "1626995421",initialSheet: ("1626995421" == gid)});';
  assert.deepEqual(parseTabList(html), [
    { name: "Uge 43", gid: "1879457789" },
    { name: "Fordeling æøå", gid: "1626995421" },
  ]);
});
