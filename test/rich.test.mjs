// The shared rich-text subset: provider-authored prose -> the token/block AST
// that the Web DOM layer renders (ledger.mjs is served verbatim to the
// browser, so these tests cover the production rendering path, not a copy).
//
// The subset is deliberately small — headings, paragraphs, lists, bold,
// inline code, fenced code blocks — and the parser is the security boundary:
// it may only ever emit text tokens, so the DOM side can build every node
// with textContent and never touch innerHTML.

import test from "node:test";
import assert from "node:assert/strict";
import { parseInline, parseRich } from "../src/web/ledger.mjs";

const BLOCK_TYPES = new Set(["heading", "paragraph", "list", "code"]);
const TOKEN_TYPES = new Set(["text", "code", "bold"]);

// Every leaf of the AST, in order, as type tags. Asserts the parser never
// emits a node type the DOM builder does not know how to render safely.
function leafTypes(ast) {
  const out = [];
  for (const block of ast) {
    assert.ok(BLOCK_TYPES.has(block.type), "unknown block type: " + block.type);
    if (block.type === "code") continue; // code text is a plain string
    const walk = tokens => {
      for (const token of tokens) {
        if (token.bold !== undefined) {
          out.push("bold");
          walk(token.bold);
        } else if (token.code !== undefined) {
          out.push("code");
        } else if (token.text !== undefined) {
          out.push("text");
        } else {
          assert.fail("unknown token: " + JSON.stringify(token));
        }
      }
    };
    walk(block.inline ?? (block.items ?? []).flat());
  }
  return out;
}

test("a realistic provider result parses into headings, prose, lists and code", () => {
  const result = [
    "## Summary",
    "",
    "Fixed the retry loop in `src/worker.mjs` so a **transient failure** no longer",
    "restarts the whole run.",
    "",
    "- reads the ledger once per attempt",
    "- reuses the session id across retries",
    "",
    "## Verification",
    "",
    "```bash",
    "2f open 12",
    "npm test",
    "```",
    "",
    "All 243 tests pass."
  ].join("\n");

  const ast = parseRich(result);
  assert.deepEqual(
    ast.map(b => b.type),
    ["heading", "paragraph", "list", "heading", "code", "paragraph"]
  );

  assert.deepEqual(ast[0], {
    type: "heading",
    level: 2,
    inline: [{ text: "Summary" }]
  });
  // inline code and bold survive inside paragraph prose
  assert.deepEqual(ast[1].inline, [
    { text: "Fixed the retry loop in " },
    { code: "src/worker.mjs" },
    { text: " so a " },
    { bold: [{ text: "transient failure" }] },
    { text: " no longer restarts the whole run." }
  ]);
  assert.deepEqual(ast[2].items, [
    [{ text: "reads the ledger once per attempt" }],
    [{ text: "reuses the session id across retries" }]
  ]);
  assert.deepEqual(ast[4], {
    type: "code",
    lang: "bash",
    text: "2f open 12\nnpm test"
  });
});

test("headings cap at three display levels and ordered lists parse", () => {
  const ast = parseRich("# one\n#### four\n\n1. first\n2. second");
  assert.deepEqual(
    ast.map(b => [b.type, b.level ?? b.ordered]),
    [
      ["heading", 1],
      ["heading", 3], // `####` folds into the smallest heading style
      ["list", true]
    ]
  );
  assert.deepEqual(ast[2].items, [[{ text: "first" }], [{ text: "second" }]]);
});

test("unbalanced markers stay literal text instead of becoming markup", () => {
  // A glob or a multiplication is not bold; a lone backtick is a backtick;
  // empty bold (`****`) never matches.
  assert.deepEqual(parseInline("src/**/*.ts"), [{ text: "src/**/*.ts" }]);
  assert.deepEqual(parseInline("2**3"), [{ text: "2**3" }]);
  assert.deepEqual(parseInline("a ` b"), [{ text: "a ` b" }]);
  assert.deepEqual(parseInline("****"), [{ text: "****" }]);
  // Balanced constructs still parse when they are actually there.
  assert.deepEqual(parseInline("`src/a.ts` and **a fix**"), [
    { code: "src/a.ts" },
    { text: " and " },
    { bold: [{ text: "a fix" }] }
  ]);
});

test("provider prose carrying HTML stays inert text tokens", () => {
  const ast = parseRich(
    "before\n\n```html\n<script>alert(1)</script>\n```\n\nafter <img src=x onerror=alert(1)> **bold**"
  );
  assert.deepEqual(leafTypes(ast), ["text", "text", "bold", "text"]);
  // No html/raw/link node can exist, and the hostile text is present verbatim
  // as plain text tokens — the DOM side renders it with textContent.
  const flat = JSON.stringify(ast);
  assert.ok(flat.includes("<script>alert(1)</script>"));
  assert.ok(flat.includes("<img src=x onerror=alert(1)>"));
  assert.ok(!flat.includes('"type":"html"'));
  assert.ok(!flat.includes('"type":"raw"'));
  assert.ok(!flat.includes('"type":"link"'));
});

test("code blocks keep newlines and long unbroken lines verbatim", () => {
  const long = "x".repeat(400);
  const ast = parseRich("```\n" + long + "\nline two\n```");
  assert.equal(ast.length, 1);
  assert.equal(ast[0].type, "code");
  // The block is one pre with overflow-x:auto in the UI — the parser must
  // not split it or insert spaces that would reflow the Ledger width.
  assert.equal(ast[0].text, long + "\nline two");
  // A long inline code token stays one token for the same reason.
  assert.deepEqual(parseInline("`" + long + "`"), [{ code: long }]);
});

test("empty, blank and plain input degrade gracefully", () => {
  assert.deepEqual(parseRich(""), []);
  assert.deepEqual(parseRich("   \n\n  "), []);
  assert.deepEqual(parseRich("just prose"), [
    { type: "paragraph", inline: [{ text: "just prose" }] }
  ]);
  // Unclosed fence: the rest of the input is still code, never dropped.
  const ast = parseRich("```js\nconst a = 1;");
  assert.equal(ast.length, 1);
  assert.equal(ast[0].type, "code");
  assert.equal(ast[0].lang, "js");
  assert.equal(ast[0].text, "const a = 1;");
});

test("a decision question parses inline for the NEEDS YOU card", () => {
  const question = "Should we ship **without** the `--force` flag?";
  assert.deepEqual(parseInline(question), [
    { text: "Should we ship " },
    { bold: [{ text: "without" }] },
    { text: " the " },
    { code: "--force" },
    { text: " flag?" }
  ]);
});
