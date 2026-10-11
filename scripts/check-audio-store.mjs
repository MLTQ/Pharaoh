import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = ts.transpileModule(
  readFileSync(new URL('../src/store/audioStore.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function playback() {
  const instances = [];
  const errors = [];
  const timers = new Map();
  let nextTimer = 0;
  class Audio {
    duration = 1;
    currentTime = 0;
    constructor() { instances.push(this); }
    play() { return this.start ?? Promise.resolve(); }
    pause() {}
    removeAttribute() {}
    load() {}
  }
  const exports = {};
  runInNewContext(source, {
    exports, Audio,
    require(name) {
      if (name === '../lib/transport') return { fileSrc: path => path };
      if (name === '../lib/errors') return { reportError: (...args) => errors.push(args) };
      return require(name);
    },
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  return {
    store: exports.useAudioStore,
    instances, errors,
    expire() { for (const callback of [...timers.values()]) callback(); },
  };
}

test('a clip with no metadata stops and reports a timeout', async () => {
  const p = playback();
  const pending = p.store.getState().play('silent.wav');
  p.expire();
  await pending;
  assert.equal(p.store.getState().playing, null);
  assert.match(p.errors[0][1].message, /loading timed out/);
});

test('a stalled play promise stops and reports a timeout', async () => {
  const p = playback();
  const pending = p.store.getState().play('silent.wav');
  p.instances[0].start = new Promise(() => {});
  p.instances[0].onloadedmetadata();
  await new Promise(resolve => setImmediate(resolve));
  p.expire();
  await pending;
  assert.equal(p.store.getState().playing, null);
  assert.match(p.errors[0][1].message, /startup timed out/);
});

test('a replaced clip timing out does not stop the new clip', async () => {
  const p = playback();
  const old = p.store.getState().play('old.wav');
  const current = p.store.getState().play('new.wav');
  p.instances[1].onloadedmetadata();
  await current;
  p.expire();
  await old;
  assert.equal(p.store.getState().playing, 'new.wav');
  assert.equal(p.errors.length, 0);
});

test('a decoder error after metadata resets playback', async () => {
  const p = playback();
  const pending = p.store.getState().play('bad.wav');
  p.instances[0].onloadedmetadata();
  await pending;
  p.instances[0].error = { message: 'Decoder failed' };
  p.instances[0].onerror();
  assert.equal(p.store.getState().playing, null);
  assert.match(p.errors[0][1].message, /Decoder failed/);
});
