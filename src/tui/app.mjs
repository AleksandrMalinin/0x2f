// The TUI controller — the only place the terminal touches Work.
//
// It owns three things and nothing else: the current snapshot, the current
// TUI state, and the translation of an INTENT (produced by the pure keymap
// in state.mjs) into a call on src/core/actions.mjs. Every gesture in the
// design resolves to shared actions:
//
//   ALLOW / REJECT        resumeWork(id, grant)      — same run, same session
//   ANSWER & CONTINUE     answerWork + rerunWork     — answer, then next run
//   SAVE ONLY             answerWork                 — answer, stay NEEDS YOU
//   SEND BACK             noteWork + rerunWork       — correction, next run
//   ACCEPT / DROP         closeWork
//   RETRY / REOPEN        rerunWork({ provider })
//   NOTE                  noteWork
//   NEW TASK              createWork({ brief, provider })
//   ⌥↵ brief              refine.refineTaskPrompt    — text only, no task
//
// There is no TUI-side rule about when any of those are legal. A task can
// advance between the keypress and the call (a worker finishes, another
// surface acts), and the shared action re-reads the task and refuses with a
// precise message — which this surfaces verbatim in the message line. That
// is deliberately NOT re-implemented here: a second copy of the guard would
// be a second opinion about Work state.

import { initialState, apply, selected } from "./state.mjs";
import { snapshot } from "./model.mjs";
import { frame } from "./view.mjs";
import { palette } from "./theme.mjs";

const FLASH_MS = 3400;

export function createApp(runtime, opts = {}) {
  const clock = opts.now ?? (() => Date.now());
  const theme = palette(opts.theme ?? "dark");
  const providerOrder = (runtime.providers.listProviders?.() ?? []).map(p => p.id);
  let state = initialState({
    provider: runtime.router?.defaultRequestedProvider?.() ?? providerOrder[0] ?? null
  });
  // "auto" is a routing request, not a provider — the composer shows a
  // provider chip, so an auto default starts the chip on the resolved
  // default and leaves AUTO to `2f new`.
  if (state.composer.provider === "auto") {
    state.composer.provider = runtime.providers.defaultProviderId ?? providerOrder[0] ?? null;
  }
  let model = null;
  let flashTimer = null;

  function setFlash(text, tone = "ok") {
    state = { ...state, flash: { text, tone } };
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      state = { ...state, flash: null };
      opts.onChange?.();
    }, FLASH_MS);
    // A timer must never hold the process open on its own.
    flashTimer.unref?.();
  }

  async function refresh() {
    model = await snapshot(runtime, { now: clock() });
    // A task can disappear from the filtered list under the cursor; keep the
    // selection inside the list rather than pointing at nothing.
    const list = model.tasks.length;
    if (state.sel >= list && list > 0) state = { ...state, sel: list - 1 };
    return model;
  }

  // The label a message uses for a task, matching the ledger's own.
  const ref = id => "#" + String(id).padStart(3, "0");

  async function run(intent) {
    if (!intent) return;
    const actions = runtime.actions;
    state = { ...state, busy: true };
    try {
      switch (intent.type) {
        case "allow": {
          const task = await actions.allowWork(intent.id);
          setFlash(
            task.live
              ? "allowed · " + ref(intent.id) + " continues in the same run"
              : "allowed · " + ref(intent.id) + " resumes the same provider session"
          );
          break;
        }
        case "reject": {
          await actions.rejectWork(intent.id);
          setFlash(
            "declined · " + ref(intent.id) + " continues with the request withdrawn",
            "warn"
          );
          break;
        }
        case "answer": {
          await actions.answerWork(intent.id, { answer: intent.text });
          if (!intent.continue) {
            setFlash("answer recorded on " + ref(intent.id) + " · it stays NEEDS YOU");
            break;
          }
          // Never continue past a failed save: a run started without the
          // recorded answer is a run spent on the wrong question.
          const task = await actions.rerunWork(intent.id);
          const run = task.runs?.at(-1)?.run ?? 1;
          setFlash(
            "answer recorded · run " + run + " of " + ref(intent.id) + " continues with it"
          );
          break;
        }
        case "note": {
          await actions.noteWork(intent.id, { note: intent.text });
          setFlash("note kept on " + ref(intent.id) + " · every later run carries it");
          break;
        }
        case "sendback": {
          await actions.noteWork(intent.id, { note: intent.text });
          const task = await actions.rerunWork(intent.id);
          const run = task.runs?.at(-1)?.run ?? 1;
          setFlash(
            "sent back · run " + run + " of " + ref(intent.id) + " is rebuilt with your correction",
            "warn"
          );
          break;
        }
        case "accept": {
          await actions.closeWork(intent.id);
          setFlash("accepted " + ref(intent.id) + " · the changes stay in the working tree");
          break;
        }
        case "drop": {
          await actions.closeWork(intent.id);
          setFlash("dropped " + ref(intent.id) + " · kept in closed with its whole run history", "warn");
          break;
        }
        case "rerun": {
          const task = await actions.rerunWork(intent.id, { provider: intent.provider });
          const run = task.runs?.at(-1)?.run ?? 1;
          const name = model.lookup(task.execution?.provider).name;
          setFlash(
            "run " + run + " of " + ref(intent.id) + " started on " + name +
            " · notes and answers carried over"
          );
          state = { ...state, rerunProvider: null };
          break;
        }
        case "create": {
          const task = await actions.createWork({
            brief: intent.brief,
            provider: intent.provider ?? undefined
          });
          const name = model.lookup(task.execution?.provider).name;
          state = {
            ...state,
            mode: "work",
            sel: 0,
            filter: 0,
            search: "",
            composer: { text: "", original: null, provider: intent.provider }
          };
          setFlash(ref(task.id) + " opened · run 1 on " + name + " — " + task.title);
          break;
        }
        case "refine": {
          setFlash("expanding your note into a brief…");
          const refined = await runtime.refine.refineTaskPrompt(intent.text);
          state = {
            ...state,
            composer: { ...state.composer, original: intent.text, text: refined }
          };
          setFlash("briefed · review it, then ↵ starts the run");
          break;
        }
        default:
          break;
      }
      await refresh();
    } catch (error) {
      // WorkError carries the shared refusal message — the same words the
      // CLI and the Web show. Anything else is surfaced as-is rather than
      // swallowed; a TUI that hides a failure is worse than one that is ugly.
      setFlash(String(error?.message ?? error).split("\n")[0], "warn");
    } finally {
      state = { ...state, busy: false };
    }
  }

  return {
    get state() {
      return state;
    },
    get model() {
      return model;
    },
    refresh,
    run,
    flash: setFlash,
    // One key press: fold it through the pure keymap, then execute whatever
    // intent it produced.
    async key(key) {
      if (!model) return null;
      const result = apply(state, key, {
        tasks: model.tasks,
        providerOrder,
        lookup: model.lookup
      });
      state = result.state;
      if (result.intent) await run(result.intent);
      return result.intent;
    },
    selected() {
      return model ? selected(model.tasks, state) : null;
    },
    frame(size) {
      return frame({ ...model, at: clock() }, state, { ...size, palette: theme });
    },
    dispose() {
      if (flashTimer) clearTimeout(flashTimer);
    }
  };
}
