import test from "node:test";
import assert from "node:assert/strict";
import { renderTasks } from "../src/render.mjs";

const task = (id, title, status, blockedOn) => ({
  id,
  title,
  status,
  ...(blockedOn ? { blockedOn } : {}),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

test("render groups needs_you tasks under NEEDS YOU with the reason", () => {
  const out = renderTasks([
    task(2, "Long text overflow", "needs_you", { type: "permission" }),
    task(3, "Attention regression", "working"),
    task(1, "Return replay", "ready")
  ]);

  assert.match(out, /TODAY/);
  assert.match(out, /NEEDS YOU/);
  assert.match(out, /#002  Long text overflow/);
  assert.match(out, /Permission required/);
  assert.match(out, /WORKING/);
  assert.match(out, /#003  Attention regression/);
  assert.match(out, /READY/);
  assert.match(out, /#001  Return replay/);
});

test("decision reason renders its own label", () => {
  const out = renderTasks([task(4, "Pick a backend", "needs_you", { type: "decision" })]);
  assert.match(out, /Decision needed/);
});

test("empty render", () => {
  assert.match(renderTasks([]), /No tasks yet/);
});
