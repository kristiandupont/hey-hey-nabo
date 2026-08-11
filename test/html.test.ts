import assert from "node:assert/strict";
import { test } from "node:test";

import { htmlToText } from "../src/html.ts";

test("paragraphs become blank-line separated text", () => {
  const html = "<p>Fastelavn for børn og voksne.</p><p></p><p>Program:</p>";
  assert.equal(htmlToText(html), "Fastelavn for børn og voksne.\n\nProgram:");
});

test("entities are decoded", () => {
  assert.equal(htmlToText("<p>Kaffe&nbsp;&amp;&nbsp;kage</p>"), "Kaffe & kage");
  assert.equal(htmlToText("<p>&#248;l og &#xe6;bler</p>"), "øl og æbler");
});

test("line breaks and list items are preserved", () => {
  assert.equal(htmlToText("<p>A<br>B</p>"), "A\nB");
  assert.equal(htmlToText("<ul><li>Tønde 0-3 år</li><li>Tønde 4+ år</li></ul>"), "• Tønde 0-3 år\n• Tønde 4+ år");
});

test("inline formatting is stripped but content kept", () => {
  assert.equal(htmlToText("<p><strong>Vigtigt:</strong> <span>tilmeld jer</span></p>"), "Vigtigt: tilmeld jer");
});

test("links keep both label and target", () => {
  assert.equal(
    htmlToText('<p>Se <a href="https://example.com/x">programmet</a></p>'),
    "Se programmet (https://example.com/x)",
  );
});

test("a link whose label is already the url is not duplicated", () => {
  assert.equal(
    htmlToText('<a href="https://example.com/x">https://example.com/x</a>'),
    "https://example.com/x",
  );
});

test("table cells are separated rather than run together", () => {
  const html = "<table><tbody><tr><td>Mad</td><td>50 kr</td></tr></tbody></table>";
  assert.equal(htmlToText(html), "Mad\t50 kr");
});

test("empty and missing input is handled", () => {
  assert.equal(htmlToText(null), "");
  assert.equal(htmlToText(undefined), "");
  assert.equal(htmlToText(""), "");
  assert.equal(htmlToText("<p></p>"), "");
});

test("runs of blank lines are capped", () => {
  assert.equal(htmlToText("<p>A</p><p></p><p></p><p></p><p>B</p>"), "A\n\nB");
});
