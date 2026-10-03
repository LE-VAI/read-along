/**
 * natural-voice.test.mjs — the opt-in natural voice, decision by decision.
 *
 * The component renders a button; this controller decides everything the
 * button means: when the ~80–90 MB download starts, what a screen reader
 * hears while it runs, what is remembered, and what happens when it fails.
 * Every one of those is a promise to a reader who may not be able to see
 * the page, so every one is pinned here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NaturalVoice,
  NATURAL_VOICE_STORAGE_KEY,
  DEFAULT_DOWNLOAD_SIZE,
  safeStorage,
  readOptIn,
  writeOptIn,
} from "../src/natural-voice.js";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

const throwingStorage = {
  getItem() { throw new Error("SecurityError"); },
  setItem() { throw new Error("QuotaExceededError"); },
  removeItem() { throw new Error("SecurityError"); },
};

function fakeEngine({ steps = [], fail = null } = {}) {
  return {
    onProgress: null,
    speak() {}, pause() {}, resume() {}, stop() {},
    async load() {
      for (const p of steps) this.onProgress?.(p, "Downloading voice model");
      if (fail) throw fail;
    },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A controller wired to recorders instead of a DOM. */
function harness({ loader, storage = memoryStorage(), where = "" } = {}) {
  const log = { announced: [], renders: [], swaps: [], loads: 0 };
  const nv = new NaturalVoice({
    loader: async () => { log.loads++; return loader(); },
    announce: (m) => log.announced.push(m),
    render: (state, info) => log.renders.push({ state, ...info }),
    swap: (engine) => { log.swaps.push(engine); return typeof where === "function" ? where(engine) : where; },
    storage: () => storage,
  });
  return { nv, log, storage };
}

async function quietly(fn) {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try { await fn(); } finally { console.warn = warn; }
  return warnings;
}

// -- storage ----------------------------------------------------------------

test("opt-in round-trips through storage", () => {
  const s = memoryStorage();
  assert.equal(readOptIn(s), false);
  writeOptIn(s, true);
  assert.equal(s.getItem(NATURAL_VOICE_STORAGE_KEY), "on");
  assert.equal(readOptIn(s), true);
  writeOptIn(s, false);
  assert.equal(readOptIn(s), false);
});

test("storage that throws on every call never throws out of the helpers", () => {
  assert.doesNotThrow(() => writeOptIn(throwingStorage, true));
  assert.doesNotThrow(() => writeOptIn(throwingStorage, false));
  assert.equal(readOptIn(throwingStorage), false);
  assert.equal(readOptIn(null), false);
  assert.doesNotThrow(() => writeOptIn(null, true));
});

test("safeStorage returns null when merely reading localStorage throws", () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("SecurityError: sandboxed"); },
  });
  try {
    assert.equal(safeStorage(), null);
  } finally {
    if (before) Object.defineProperty(globalThis, "localStorage", before);
    else delete globalThis.localStorage;
  }
});

// -- the reader presses the button ------------------------------------------

test("pressing it discloses the download, narrates in quarters, swaps, remembers", async () => {
  const engine = fakeEngine({ steps: [0.1, 0.2, 0.3, 0.55, 0.6, 0.8, 0.99, 1] });
  const { nv, log, storage } = harness({ loader: () => engine, where: "Continuing from word 5." });
  await nv.enable();
  assert.equal(nv.state, "on");
  assert.equal(log.swaps.length, 1);
  assert.equal(log.swaps[0], engine);
  assert.equal(readOptIn(storage), true, "the choice is remembered");
  assert.deepEqual(log.announced, [
    `Downloading the natural voice, ${DEFAULT_DOWNLOAD_SIZE}, once. The standard voice keeps reading meanwhile.`,
    "Natural voice 25 percent downloaded.",
    "Natural voice 50 percent downloaded.",
    "Natural voice 75 percent downloaded.",
    "Natural voice on. Continuing from word 5.",
  ]);
  assert.equal(log.renders[0].state, "loading");
  assert.ok(log.renders.some((r) => r.state === "loading" && r.pct === 0.55), "the visible note gets every step");
  assert.equal(log.renders.at(-1).state, "on");
});

test("the engine's own onProgress is preserved, not replaced", async () => {
  const engine = fakeEngine({ steps: [0.5] });
  const hostSaw = [];
  engine.onProgress = (p) => hostSaw.push(p);
  const { nv } = harness({ loader: () => engine });
  await nv.enable();
  assert.deepEqual(hostSaw, [0.5]);
});

test("an engine without load() is ready as soon as the loader returns it", async () => {
  const engine = { speak() {}, pause() {}, resume() {}, stop() {} };
  const { nv, log } = harness({ loader: () => engine });
  await nv.enable();
  assert.equal(nv.state, "on");
  assert.equal(log.swaps[0], engine);
});

// -- failure ----------------------------------------------------------------

for (const [why, loader] of [
  ["the loader rejects", () => Promise.reject(new Error("offline"))],
  ["the loader returns something that is not an engine", () => ({ speak() {} })],
  ["engine.load() rejects", () => fakeEngine({ steps: [0.4], fail: new Error("wasm compile failed") })],
]) {
  test(`failure (${why}): standard voice stays, it is announced, and not remembered`, async () => {
    const { nv, log, storage } = harness({ loader });
    const warnings = await quietly(() => nv.enable());
    assert.equal(nv.state, "failed");
    assert.equal(log.swaps.length, 0, "the standard engine was never swapped out");
    assert.equal(readOptIn(storage), false, "a failed load is forgotten");
    assert.equal(log.announced.at(-1), "The natural voice could not be loaded. The standard voice is reading.");
    assert.equal(log.renders.at(-1).state, "failed");
    assert.equal(warnings.length, 1, "developers get the reason in the console");
  });
}

test("after a failure, pressing again retries", async () => {
  let attempt = 0;
  const { nv, log } = harness({
    loader: () => (++attempt === 1 ? Promise.reject(new Error("offline")) : fakeEngine()),
  });
  await quietly(() => nv.enable());
  assert.equal(nv.state, "failed");
  nv.toggle();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(nv.state, "on");
  assert.equal(log.loads, 2);
});

// -- cancel, disable, re-enable ---------------------------------------------

test("pressing again while loading cancels: no swap when the load lands later", async () => {
  const gate = deferred();
  const engine = fakeEngine();
  const { nv, log, storage } = harness({ loader: () => gate.promise });
  const pending = nv.enable();
  assert.equal(nv.state, "loading");
  nv.toggle(); // cancel
  assert.equal(nv.state, "off");
  assert.equal(readOptIn(storage), false);
  assert.equal(log.announced.at(-1), "Natural voice cancelled. The standard voice stays.");
  gate.resolve(engine);
  await pending;
  assert.equal(log.swaps.length, 0, "a cancelled load never takes the voice");
  assert.equal(nv.state, "off");
  // The engine that finished loading is kept: choosing it now is instant.
  await nv.enable();
  assert.equal(nv.state, "on");
  assert.equal(log.loads, 1, "no second download");
  assert.equal(log.swaps[0], engine);
});

test("disable swaps back to the standard voice and forgets the choice", async () => {
  const { nv, log, storage } = harness({
    loader: () => fakeEngine(),
    where: (e) => (e ? "" : "Continuing from word 9."),
  });
  await nv.enable();
  nv.toggle();
  assert.equal(nv.state, "off");
  assert.equal(log.swaps.at(-1), null, "null means: back to the standard engine");
  assert.equal(readOptIn(storage), false);
  assert.equal(log.announced.at(-1), "Standard voice on. Continuing from word 9.");
  assert.equal(log.renders.at(-1).loaded, true, "the note can say it is downloaded");
});

// -- a later visit ----------------------------------------------------------

test("a remembered opt-in auto-upgrades quietly, once", async () => {
  const storage = memoryStorage({ [NATURAL_VOICE_STORAGE_KEY]: "on" });
  const { nv, log } = harness({ loader: () => fakeEngine({ steps: [0.3, 0.6, 0.9] }), storage });
  nv.autoUpgrade();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(nv.state, "on");
  assert.equal(log.swaps.length, 1);
  assert.deepEqual(log.announced, [], "no page-load chatter when nothing was playing");
  nv.disable();
  nv.autoUpgrade(); // a reconnect must not undo the reader's choice
  assert.equal(nv.state, "off");
});

test("a remembered upgrade that lands mid-reading says where it continues", async () => {
  const storage = memoryStorage({ [NATURAL_VOICE_STORAGE_KEY]: "on" });
  const { nv, log } = harness({ loader: () => fakeEngine(), storage, where: "Continuing from word 3." });
  nv.autoUpgrade();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(log.announced, ["Natural voice on. Continuing from word 3."]);
});

test("no remembered opt-in: autoUpgrade does nothing", () => {
  const { nv, log } = harness({ loader: () => fakeEngine() });
  nv.autoUpgrade();
  assert.equal(nv.state, "off");
  assert.equal(log.loads, 0);
});

test("a remembered upgrade that fails is announced, then forgotten", async () => {
  const storage = memoryStorage({ [NATURAL_VOICE_STORAGE_KEY]: "on" });
  const { nv, log } = harness({ loader: () => Promise.reject(new Error("offline")), storage });
  await quietly(async () => {
    nv.autoUpgrade();
    await new Promise((r) => setTimeout(r, 0));
  });
  assert.equal(nv.state, "failed");
  assert.equal(readOptIn(storage), false, "the next visit will not retry into the same failure");
  assert.deepEqual(log.announced, ["The natural voice could not be loaded. The standard voice is reading."]);
});

// -- the host changes its mind ------------------------------------------------

test("detach (host assigned its own engine) shows off without swapping or forgetting", async () => {
  const { nv, log, storage } = harness({ loader: () => fakeEngine() });
  await nv.enable();
  nv.detach();
  assert.equal(nv.state, "off");
  assert.equal(log.swaps.length, 1, "no swap back");
  assert.equal(readOptIn(storage), true, "the reader's saved choice is theirs");
});

test("destroy mid-load: nothing calls back afterwards", async () => {
  const gate = deferred();
  const { nv, log } = harness({ loader: () => gate.promise });
  const pending = nv.enable();
  const rendersBefore = log.renders.length;
  const announcedBefore = log.announced.length;
  nv.destroy();
  gate.resolve(fakeEngine({ steps: [0.5] }));
  await pending;
  assert.equal(log.swaps.length, 0);
  assert.equal(log.renders.length, rendersBefore);
  assert.equal(log.announced.length, announcedBefore);
});

test("everything still works when storage throws on every call", async () => {
  const { nv, log } = harness({ loader: () => fakeEngine(), storage: throwingStorage });
  await nv.enable();
  assert.equal(nv.state, "on");
  assert.equal(log.swaps.length, 1);
  assert.equal(nv.remembered, false);
});

test("a custom download size reaches the disclosure", async () => {
  const log = [];
  const nv = new NaturalVoice({
    loader: () => fakeEngine(),
    announce: (m) => log.push(m),
    render: () => {},
    swap: () => "",
    storage: () => null,
    downloadSize: "about 60 MB",
  });
  await nv.enable();
  assert.match(log[0], /about 60 MB/);
});
