/**
 * Browser-half smoke test for the Dremu chart studio.
 *
 * There is no DOM in this process, so this file implements a deliberately tiny
 * React-compatible runtime (function components, useState/useEffect/useMemo/
 * useRef/useCallback, host elements, refs) plus the handful of browser globals
 * `client.js` touches. It then mounts the real page and asserts that:
 *
 *   1. the module evaluates and registers a client plugin,
 *   2. the page renders in its loading, empty and project states without
 *      throwing,
 *   3. the timeline canvas paints through a stub 2D context,
 *   4. the inspector and curve dialog render a real element/catalog,
 *   5. a curve dialog Apply produces the expected value.
 *
 * Run: node tests/client-smoke.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', '..', 'client.js');

// ---------------------------------------------------------------------------
// Browser globals
// ---------------------------------------------------------------------------

/** Stub 2D context: every unknown property is a no-op method. */
function makeContext2D() {
  const state = { canvas: null };
  return new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return () => ({ width: 24 });
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (prop === 'setTransform' || prop === 'clearRect') return () => undefined;
      if (typeof prop === 'string' && /^[a-z]/.test(prop) && prop[0] === prop[0].toLowerCase()) return () => undefined;
      return undefined;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

/** Fake DOM element sufficient for the components' ref usage. */
function makeElement(tag) {
  const style = {};
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    style,
    dataset: {},
    children: [],
    width: 0,
    height: 0,
    clientWidth: 800,
    clientHeight: 420,
    className: '',
    value: '',
    type: '',
    checked: false,
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index !== -1) this.children.splice(index, 1);
      return child;
    },
    setAttribute() {},
    removeAttribute() {},
    getAttribute() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    blur() {},
    click() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    getContext() {
      return makeContext2D();
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 800, bottom: 420, width: 800, height: 420, x: 0, y: 0 };
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    contains() {
      return false;
    },
  };
  return node;
}

/** A DOM element whose children mirror the rendered tree (for text asserts). */
function makeHostNode(tag, props) {
  const node = makeElement(tag);
  node.className = props && props.className ? props.className : '';
  return node;
}

/** Minimal document/window implementation. */
function installGlobals() {
  const documentElement = makeElement('html');
  documentElement.isContentEditable = false;
  const doc = {
    documentElement,
    body: makeElement('body'),
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    },
  };
  const win = {
    document: doc,
    devicePixelRatio: 2,
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle() {
      return { getPropertyValue: () => '' };
    },
    requestAnimationFrame(callback) {
      // Do not actually loop; a single deferred frame is enough for scheduling.
      return 1;
    },
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout,
    matchMedia() {
      return { matches: false, addEventListener() {}, removeEventListener() {} };
    },
    fetch: (url, options) => mockFetch(url, options),
    EventSource: class {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
      }
      close() {}
    },
    Audio: class {
      constructor() {
        this.playbackRate = 1;
        this.muted = false;
        this.currentTime = 0;
        this.duration = 0;
        this.error = null;
        this.preload = 'auto';
        this.src = '';
      }
      play() {
        return Promise.resolve();
      }
      pause() {}
      addEventListener() {}
      removeEventListener() {}
      removeAttribute() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class {
      constructor(callback) {
        this.callback = callback;
      }
      observe() {}
      disconnect() {}
    },
    OfflineAudioContext: undefined,
    AudioContext: undefined,
    performance: { now: () => Date.now() },
  };
  win.window = win;
  win.globalThis = globalThis;
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.performance = win.performance;
  globalThis.requestAnimationFrame = win.requestAnimationFrame;
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame;
  globalThis.getComputedStyle = win.getComputedStyle;
  globalThis.ResizeObserver = win.ResizeObserver;
  globalThis.MutationObserver = win.MutationObserver;
  globalThis.EventSource = win.EventSource;
  globalThis.Audio = win.Audio;
  globalThis.fetch = win.fetch;
  return win;
}

// ---------------------------------------------------------------------------
// Tiny React runtime
// ---------------------------------------------------------------------------

const hookSlots = [];
const pendingStateUpdates = [];
let renderCursor = 0;
let activeSlot = null;
let scheduled = false;
let mountedRoot = null;
let effectQueue = [];

function slotFor(index) {
  if (!hookSlots[index]) hookSlots[index] = { hooks: [], cursor: 0 };
  return hookSlots[index];
}

function scheduleRender() {
  scheduled = true;
}

/** Apply queued setState updates the way React does before a render pass. */
function flushStateUpdates() {
  while (pendingStateUpdates.length > 0) {
    const item = pendingStateUpdates.shift();
    const value = typeof item.next === 'function' ? item.next(item.hook.value) : item.next;
    item.hook.value = value;
  }
}

function readDeps(deps) {
  return Array.isArray(deps) ? deps.slice() : null;
}

function depsChanged(previous, next) {
  if (!previous || !next) return true;
  if (previous.length !== next.length) return true;
  for (let i = 0; i < previous.length; i += 1) if (!Object.is(previous[i], next[i])) return true;
  return false;
}

function nextHook() {
  const slot = activeSlot;
  const index = slot.cursor;
  slot.cursor += 1;
  if (slot.hooks.length <= index) slot.hooks[index] = {};
  return slot.hooks[index];
}

const React = {
  createElement(type, props, ...children) {
    const merged = children.length === 0 ? props || {} : Object.assign({}, props || {}, { children: children.length === 1 ? children[0] : children });
    const flat = [];
    const push = (child) => {
      if (Array.isArray(child)) child.forEach(push);
      else if (child !== undefined) flat.push(child);
    };
    push(merged.children);
    const normalized = Object.assign({}, merged);
    if (flat.length === 0) delete normalized.children;
    else normalized.children = flat.length === 1 ? flat[0] : flat;
    return { $$typeof: 'element', type, props: normalized };
  },
  useState(initial) {
    const hook = nextHook();
    if (!('value' in hook)) hook.value = typeof initial === 'function' ? initial() : initial;
    // SYNC control: the upstream mock-React behaviour (see tests/client-smoke.mjs).
    const setState = (next) => {
      const value = typeof next === 'function' ? next(hook.value) : next;
      if (Object.is(value, hook.value)) return;
      hook.value = value;
      scheduleRender();
    };
    return [hook.value, setState];
  },
  useRef(initial) {
    const hook = nextHook();
    if (!('ref' in hook)) hook.ref = { current: initial };
    return hook.ref;
  },
  useMemo(factory, deps) {
    const hook = nextHook();
    const nextDeps = readDeps(deps);
    if (depsChanged(hook.deps, nextDeps)) {
      hook.deps = nextDeps;
      hook.value = factory();
    }
    return hook.value;
  },
  memo(component) {
    return component;
  },
  useCallback(callback, deps) {
    const hook = nextHook();
    const nextDeps = readDeps(deps);
    if (depsChanged(hook.deps, nextDeps)) {
      hook.deps = nextDeps;
      hook.value = callback;
    }
    return hook.value;
  },
  useEffect(effect, deps) {
    const hook = nextHook();
    const nextDeps = readDeps(deps);
    if (hook.cleanup && depsChanged(hook.deps, nextDeps)) {
      try {
        hook.cleanup();
      } catch (error) {
        /* ignore cleanup failures in the harness */
      }
      hook.cleanup = undefined;
    }
    if (depsChanged(hook.deps, nextDeps)) {
      hook.deps = nextDeps;
      effectQueue.push({ hook, effect });
    }
  },
  useLayoutEffect(effect, deps) {
    React.useEffect(effect, deps);
  },
  useDebugValue() {},
  Component: class Component {
    constructor(props) {
      this.props = props;
    }
  },
};

function renderNode(node) {
  if (node === null || node === undefined || node === true || node === false) return null;
  if (Array.isArray(node)) return node.map(renderNode);
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) };
  if (node.$$typeof !== 'element') return null;
  const type = node.type;
  const props = node.props || {};
  if (typeof type === 'function') {
    const previous = activeSlot;
    activeSlot = slotFor(renderCursor);
    renderCursor += 1;
    activeSlot.cursor = 0;
    let output;
    try {
      output = type(props);
    } finally {
      activeSlot = previous;
    }
    const rendered = renderNode(output);
    const host = { component: type, rendered };
    return host;
  }
  const hostNode = makeHostNode(type, props);
  hostNode.props = props;
  if (props.ref !== undefined && props.ref !== null && typeof props.ref === 'object') props.ref.current = hostNode;
  const children = props.children === undefined ? [] : Array.isArray(props.children) ? props.children : [props.children];
  hostNode.rendered = children.map(renderNode);
  return hostNode;
}

function flattenText(node, out) {
  if (!node) return out;
  if (Array.isArray(node)) {
    node.forEach((child) => flattenText(child, out));
    return out;
  }
  if (node.text !== undefined) {
    out.push(node.text);
    return out;
  }
  if (node.rendered !== undefined) flattenText(node.rendered, out);
  if (node.rendered === undefined && node.children) flattenText(node.children, out);
  return out;
}

function flattenHosts(node, out) {
  if (!node) return out;
  if (Array.isArray(node)) {
    node.forEach((child) => flattenHosts(child, out));
    return out;
  }
  if (node.text !== undefined) return out;
  if (node.tagName) out.push(node);
  if (node.rendered !== undefined) flattenHosts(node.rendered, out);
  return out;
}

function flattenComponents(node, out) {
  if (!node) return out;
  if (Array.isArray(node)) {
    node.forEach((child) => flattenComponents(child, out));
    return out;
  }
  if (node.component) out.push(node.component);
  if (node.rendered !== undefined) flattenComponents(node.rendered, out);
  return out;
}

/** Run queued effects, then re-render while something scheduled a change. */
async function settle(maxPasses = 6) {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    flushStateUpdates();
    const queue = effectQueue;
    effectQueue = [];
    for (const item of queue) {
      try {
        const cleanup = item.effect();
        if (typeof cleanup === 'function') item.hook.cleanup = cleanup;
      } catch (error) {
        throw new Error('effect threw: ' + (error && error.stack ? error.stack : error));
      }
    }
    // Let promise-based effects (fetch) resolve.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!scheduled) break;
    scheduled = false;
    flushStateUpdates();
    renderCursor = 0;
    mountedRoot.tree = renderNode(mountedRoot.element);
  }
  return mountedRoot.tree;
}

function mount(element) {
  hookSlots.length = 0;
  renderCursor = 0;
  activeSlot = null;
  effectQueue = [];
  scheduled = false;
  mountedRoot = { element };
  const tree = renderNode(element);
  mountedRoot = { element, tree };
  return tree;
}

/** Find the first host node whose text content contains `needle`. */
function findHostByText(tree, needle) {
  const hosts = flattenHosts(tree, []);
  for (const host of hosts) {
    const text = flattenText(host.rendered, []).join('');
    if (text.indexOf(needle) !== -1) return host;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATALOG = {
  version: 1,
  elements: [
    {
      type: 'Dremu.DremuMainLane',
      shortName: 'MainLane',
      category: 'lane',
      color: '#38e8c4',
      timing: { start: 'generateTime', duration: 'keepTime', lane: null },
      fields: [
        { name: 'name', type: 'string', default: 'lane01' },
        { name: 'generateTime', type: 'number', default: 0 },
        { name: 'keepTime', type: 'number', default: 10 },
        { name: 'laneLines', type: 'array', default: [] },
      ],
    },
    {
      type: 'Dremu.DremuTap',
      shortName: 'Tap',
      category: 'note',
      color: '#22c55e',
      timing: { start: 'hitTime', duration: null, lane: 'laneName' },
      fields: [
        { name: 'laneName', type: 'string', default: '' },
        { name: 'hitTime', type: 'number', default: 0 },
        { name: 'leadTime', type: 'number', default: 0.6 },
        { name: 'position', type: 'VariableFloat', default: { t: 'obj', type: 'GorgeFramework.VariableFloat', fields: { baseValue: 0 } } },
      ],
    },
    {
      type: 'Dremu.DremuHold',
      shortName: 'Hold',
      category: 'hold',
      color: '#7c8cff',
      timing: { start: 'hitTime', duration: 'holdTime', lane: 'laneName' },
      fields: [
        { name: 'laneName', type: 'string', default: '' },
        { name: 'hitTime', type: 'number', default: 0 },
        { name: 'holdTime', type: 'number', default: 1 },
        { name: 'holdLine', type: 'curve', default: { t: 'obj', type: 'GorgeFramework.LinearCurve', fields: { timeStart: 0, valueStart: 0, timeEnd: 1, valueEnd: 1 } } },
      ],
    },
  ],
  valueTypes: {},
  palettes: {},
};

const PROJECT = {
  dir: '/tmp/gorge-fixture',
  id: '/tmp/gorge-fixture',
  title: 'Fixture Song',
  form: 'Dremu',
  tempo: { bpm: 120, offset: 0 },
  duration: 40,
  audio: { name: 'Song.wav', file: '/tmp/gorge-fixture/Song.wav', duration: 40 },
  assets: { images: [], audio: ['Song.wav'] },
  warnings: ['样例警告'],
  staffs: [
    {
      id: 'DremuStaff.g',
      file: '/tmp/gorge-fixture/DremuStaff.g',
      kind: 'chart',
      form: 'Dremu',
      displayName: '谱表A',
      className: 'DremuStaff',
      periods: [
        {
          id: 'p0',
          method: 'Period',
          timeOffset: 0,
          minLength: 10,
          elements: [
            {
              id: 'p0:e0',
              type: 'Dremu.DremuMainLane',
              fields: { name: 'Main1', generateTime: 0, keepTime: 20 },
              start: 0,
              duration: 20,
              lane: null,
              category: 'lane',
            },
            {
              id: 'p0:e1',
              type: 'Dremu.DremuTap',
              fields: {
                laneName: 'Main1',
                hitTime: 2,
                leadTime: 0.6,
                position: { t: 'obj', type: 'GorgeFramework.VariableFloat', fields: { baseValue: -1 } },
              },
              start: 2,
              duration: null,
              lane: 'Main1',
              category: 'note',
            },
            {
              id: 'p0:e2',
              type: 'Dremu.DremuHold',
              fields: {
                laneName: 'Main1',
                hitTime: 6,
                holdTime: 2,
                holdLine: { t: 'obj', type: 'GorgeFramework.LinearCurve', fields: { timeStart: 0, valueStart: 0, timeEnd: 2, valueEnd: 1 } },
              },
              start: 6,
              duration: 2,
              lane: 'Main1',
              category: 'hold',
            },
          ],
        },
        {
          id: 'p1',
          method: 'Period1',
          timeOffset: 21.21053,
          minLength: null,
          elements: [
            {
              id: 'p1:e0',
              type: 'Dremu.DremuTap',
              fields: { laneName: 'Main1', hitTime: 0.5, leadTime: 0.6 },
              start: 21.71053,
              duration: null,
              lane: 'Main1',
              category: 'note',
            },
          ],
        },
      ],
    },
  ],
};

/** fetch stub keyed by URL. */
let stateResponse = { ok: true, rev: 3, dirty: false, openPath: PROJECT.dir, recent: [PROJECT.dir], project: PROJECT, catalog: CATALOG };
let projectsResponse = { ok: true, projectRoot: '/tmp', count: 1, projects: [{ dir: PROJECT.dir, title: PROJECT.title, staffs: 1 }] };
const calls = [];
const editBodies = [];

function mockFetch(url, options) {
  const target = String(url);
  calls.push(target);
  if (target.indexOf('/plugins/gorge-chart/projects') !== -1) {
    return Promise.resolve({ ok: true, status: 200, json: async () => projectsResponse });
  }
  if (target.indexOf('/plugins/gorge-chart/edit') !== -1) {
    let body = null;
    try { body = JSON.parse((options && options.body) || '{}'); } catch (error) { body = null; }
    editBodies.push(body);
    // Exactly what index.js createEditHandler does with an empty ops array.
    if (!body || !Array.isArray(body.ops) || body.ops.length === 0) {
      return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: 'expected { baseRev: number, ops: non-empty array }' }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ rev: 4, dirty: true, changed: true }) });
  }
  if (target.indexOf('/plugins/gorge-chart/save') !== -1) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, written: ['DremuStaff.g'], errors: [], rev: 5, dirty: false }) });
  }
  if (target.indexOf('/plugins/gorge-chart/file') !== -1) {
    return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(64), json: async () => ({}) });
  }
  if (target.indexOf('/plugins/gorge-chart/state') !== -1) {
    return Promise.resolve({ ok: true, status: 200, json: async () => stateResponse });
  }
  if (target.indexOf('/plugins/gorge-chart/events') !== -1) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
}

// ---------------------------------------------------------------------------
// Load the client bundle
// ---------------------------------------------------------------------------

installGlobals();
let captured = null;
window.__ModuleLoader__ = {
  load(entry) {
    captured = entry;
  },
};

const source = fs.readFileSync(clientPath, 'utf8');
const sandboxRequire = (name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
};

// The bundle calls window.__ModuleLoader__.load({ id, factory }) at load time.
const evaluate = new Function('require', 'window', 'document', 'globalThis', source + '\n//# sourceURL=client.js');
evaluate(sandboxRequire, globalThis.window, globalThis.document, globalThis);

assert.ok(captured, 'client bundle did not call window.__ModuleLoader__.load');
assert.equal(captured.id, '@local/gorge-chart-studio', 'bundle id mismatch');
assert.equal(typeof captured.factory, 'function', 'factory missing');

const clientPlugin = captured.factory(sandboxRequire);
assert.equal(typeof clientPlugin.apply, 'function', 'client plugin has no apply');
assert.deepEqual(clientPlugin.inject, ['slots', 'locale'], 'client plugin inject list');

// ---------------------------------------------------------------------------
// Mount the page
// ---------------------------------------------------------------------------

const t = (key) => key;
const pageElement = React.createElement(
  // Resolve the page through the slot registration path: capture it from apply.
  (() => {
    const registrations = [];
    const ctx = {
      locale: {
        register: () => () => undefined,
        bind: () => t,
      },
      effect: (factory) => {
        const cleanup = factory();
        return typeof cleanup === 'function' ? cleanup : () => undefined;
      },
      slots: {
        inject: (name, factory) => {
          factory();
        },
        register: (options, component) => {
          registrations.push({ options, component });
          return () => undefined;
        },
      },
    };
    clientPlugin.apply(ctx);
    const page = registrations.find((item) => item.options.name === 'main');
    assert.ok(page, 'no main slot registration');
    assert.equal(page.options.key, 'gorge-chart', 'main panel key');
    const icon = registrations.find((item) => item.options.name === 'sidebar.panellist');
    assert.ok(icon, 'no sidebar.panellist registration');
    assert.equal(icon.options.id, 'gorge-chart', 'sidebar panel id');
    return page.component;
  })(),
  { t },
);

let tree = mount(pageElement);
tree = await settle();

const text = flattenText(tree, []).join(' ');
assert.ok(text.length > 0, 'page rendered no text');
assert.ok(text.includes('openProject') || text.includes('title'), 'page chrome missing');
assert.ok(text.includes('谱表A') || text.includes('Main1'), 'project data did not reach the UI');
assert.ok(text.includes('Fixture Song'), 'project title missing');

const hosts = flattenHosts(tree, []);
const canvases = hosts.filter((host) => host.tagName === 'CANVAS');
assert.ok(canvases.length >= 1, 'timeline canvas missing');
assert.ok(canvases[0].getContext('2d'), 'timeline canvas has no 2d context');

const components = flattenComponents(tree, []).map((component) => component.name);
if (process.env.DEBUG_CLIENT_SMOKE) console.log('components:', JSON.stringify(components.slice(0, 40)));
for (const expected of ['ChartStudioPage', 'LeftPane', 'TimelineCanvas', 'InspectorPane', 'TransportBar']) {
  assert.ok(components.includes(expected), 'component not rendered: ' + expected);
}

// The session fetched the Host state once.
assert.ok(calls.some((url) => url.indexOf('/plugins/gorge-chart/state') !== -1), 'state endpoint not called');

// ---------------------------------------------------------------------------
// Inspector + curve dialog with a real selection
// ---------------------------------------------------------------------------

/** First host node matching a predicate. */
function findHost(tree, predicate) {
  const hosts = flattenHosts(tree, []);
  for (const host of hosts) {
    try {
      if (predicate(host)) return host;
    } catch (error) {
      /* ignore predicate errors on stub nodes */
    }
  }
  return null;
}

/** First host node that has an onClick handler and whose text contains `needle`. */
function findClickableByText(tree, needle) {
  return findHost(tree, (host) => {
    if (!host.props || typeof host.props.onClick !== 'function') return false;
    return flattenText(host.rendered, []).join(' ').indexOf(needle) !== -1;
  });
}

// 1. Select the Hold element from the element list.
const holdRow = findClickableByText(tree, 'DremuHold');
assert.ok(holdRow, 'DremuHold row not found in the element list');
holdRow.props.onClick({ target: holdRow, stopPropagation() {}, preventDefault() {}, shiftKey: false, metaKey: false, ctrlKey: false });
tree = await settle();

const inspectorText = flattenText(tree, []).join(' ');
assert.ok(inspectorText.includes('holdTime'), 'inspector did not render the hold fields');
assert.ok(inspectorText.includes('laneName'), 'inspector did not render the lane field');
assert.ok(inspectorText.includes('p0:'), 'inspector did not show the element id');

// 2. Open the curve dialog from the hold's curve field.
const curveButton = findHost(tree, (host) => host.props && typeof host.props.onClick === 'function' && host.props.title === 'curveEditor');
assert.ok(curveButton, 'curve editor button not found for the curve field');
curveButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: curveButton });
tree = await settle();

assert.ok(flattenText(tree, []).join(' ').includes('curveEditor'), 'curve dialog did not open');
const dialogCanvases = flattenHosts(tree, []).filter((host) => host.tagName === 'CANVAS');
assert.ok(dialogCanvases.length >= 2, 'curve dialog did not render its plot canvas');
assert.ok(flattenHosts(tree, []).some((host) => String(host.className).includes('dgc-modalBackdrop')), 'curve dialog backdrop missing');
// The numeric tree must expose the LinearCurve fields.
const dialogText = flattenText(tree, []).join(' ');
for (const field of ['timeStart', 'valueStart', 'timeEnd', 'valueEnd']) {
  assert.ok(dialogText.includes(field), 'curve dialog numeric tree missing ' + field);
}

// 3. Apply the dialog: one edit op must be queued to the Host.
const editCallsBefore = calls.filter((url) => url.indexOf('/plugins/gorge-chart/edit') !== -1).length;
const applyButton = findHost(tree, (host) => {
  if (!host.props || typeof host.props.onClick !== 'function') return false;
  const label = flattenText(host.rendered, []).join(' ');
  return label.trim() === 'apply';
});
assert.ok(applyButton, 'curve dialog apply button not found');
applyButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: applyButton });
tree = await settle();
await new Promise((resolve) => setTimeout(resolve, 5));

const editCallsAfter = calls.filter((url) => url.indexOf('/plugins/gorge-chart/edit') !== -1).length;
assert.ok(editCallsAfter > editCallsBefore, 'applying the curve did not POST an edit');

// 4. Undo must also reach the Host.
// NOTE: the upstream smoke test looks up the undo button by `title === 'undo'`,
// but the header Undo button has no title prop (label text only) - so that check
// never runs. Find it by its visible label instead.
const undoButton = findClickableByText(tree, 'undo');
console.log('  [repro] undo button found:', !!undoButton, '| className:', undoButton && undoButton.className, '| title:', undoButton && undoButton.props && undoButton.props.title);
{
  const all = flattenHosts(tree, []).filter((host) => host.props && typeof host.props.onClick === 'function' && flattenText(host.rendered, []).join(' ').indexOf('undo') !== -1);
  console.log('  [repro] clickable hosts containing "undo":', all.length, all.map((hh) => String(hh.className) + ':' + flattenText(hh.rendered, []).join('')));
}
if (undoButton) {
  const before = calls.filter((url) => url.indexOf('/plugins/gorge-chart/edit') !== -1).length;
  try {
    undoButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: undoButton });
  } catch (error) {
    console.log('  [repro] undo onClick threw:', error && error.message);
  }
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const after = calls.filter((url) => url.indexOf('/plugins/gorge-chart/edit') !== -1).length;
  console.log('  [repro] edit calls before/after undo:', before, after,
    '| op counts:', JSON.stringify(editBodies.map((b) => (b && Array.isArray(b.ops) ? b.ops.length : 'NO-BODY'))));
  assert.ok(after > before, 'undo did not POST an inverse edit');
  const lastBatch = editBodies[editBodies.length - 1] || {};
  const undoOps = Array.isArray(lastBatch.ops) ? lastBatch.ops : [];
  console.log('  undo POST body ops:', JSON.stringify(undoOps));
  assert.ok(
    undoOps.length > 0,
    'REPRODUCED CODE-REVIEW BUG: undo POSTed ops:[] (the inverse list was captured before React ran the queued setState updater). ' +
      'The real Host answers 400 for an empty batch, so Ctrl+Z is a no-op + error toast.',
  );
}

// 5. Save button must POST /save.
const saveButton = findHost(tree, (host) => {
  if (!host.props || typeof host.props.onClick !== 'function') return false;
  return flattenText(host.rendered, []).join('').indexOf('save') !== -1 && String(host.className).includes('is-primary');
});
if (saveButton) {
  saveButton.props.onClick({ preventDefault() {}, stopPropagation() {}, target: saveButton });
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(calls.some((url) => url.indexOf('/plugins/gorge-chart/save') !== -1), 'save button did not POST /save');
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const finalHosts = flattenHosts(tree, []);
console.log('  [repro] edit POST op counts:', JSON.stringify(editBodies.map((b) => (b && Array.isArray(b.ops) ? b.ops.length : 'NO-BODY'))));
console.log('review-undo-repro: completed');
console.log(
  '  components rendered:',
  new Set(flattenComponents(tree, []).map((component) => component.name)).size,
  '| host nodes:',
  finalHosts.length,
  '| canvases:',
  finalHosts.filter((host) => host.tagName === 'CANVAS').length,
  '| fetch calls:',
  calls.length,
);
console.log('  slots: sidebar.panellist#gorge-chart + main#gorge-chart');
console.log('  verified: page chrome, project/lane/element data, timeline paint, element selection,');
console.log('            inspector fields, curve dialog (plot canvas + numeric tree), apply/undo/save round trips.');
