// The proof tally, checked without VS Code.
//
// `npm test` drives a real extension host through @vscode/test-electron,
// which needs to download one; this needs nothing but node.  It stubs
// the `vscode` module, patches LanguageClient.start to record rather
// than spawn, and drives the real compiled out/lspClient.js.
//
// What it guards: the tally is keyed by proof *name*.  Keyed by name
// and line, as it once was, a proof that an edit moved was announced
// under two identities and counted twice -- "61 proofs checked" became
// 62, then 68, and adding a line at the top of a 61-theorem file gave
// 122 entries.  Run with `npm run test:offline`.
const Module = require('module');
const path = require('path');
const REPO = path.join(__dirname, '..', '..');

let statusText = null;
const listeners = {};
function evt(name) {
  return (fn) => { (listeners[name] = listeners[name] || []).push(fn);
                   return { dispose() {} }; };
}
class EventEmitter {
  constructor() { this.handlers = []; this.event = (fn) => { this.handlers.push(fn); return {dispose(){}}; }; }
  fire(x) { for (const h of this.handlers) h(x); }
  dispose() {}
}
const infoMessages = [];
const vscodeStub = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Beside: -2 },
  EventEmitter,
  Uri: { file: (p) => ({ scheme: 'file', fsPath: p, toString: () => 'file://' + p }) },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createStatusBarItem: () => ({
      show() {}, hide() {}, dispose() {},
      set text(t) { statusText = t; }, get text() { return statusText; },
      tooltip: '', command: '',
    }),
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    showInformationMessage: (m) => { infoMessages.push(m); },
    showErrorMessage: (m) => { infoMessages.push(m); },
    createWebviewPanel: () => ({
      webview: { set html(_) {}, },
      onDidDispose: evt('panelDispose'), dispose() {},
    }),
    onDidChangeVisibleTextEditors: evt('visible'),
    onDidChangeActiveTextEditor: evt('active'),
    onDidChangeTextEditorSelection: evt('selection'),
  },
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    asRelativePath: (u) => String(u.fsPath || u),
    onDidCloseTextDocument: evt('close'),
    textDocuments: [],
  },
  languages: { createDiagnosticCollection: () => ({ set() {}, dispose() {} }) },
  commands: { registerCommand: () => ({ dispose() {} }) },
};

// The client registers a pile of built-in features, each subscribing to
// `onDid…` hooks we don't model.  Hand out a no-op registrar for any of
// them rather than enumerating them.
function lenient(obj) {
  return new Proxy(obj, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && /^onDid|^onWill/.test(prop)) {
        return () => ({ dispose() {} });
      }
      if (typeof prop === 'string' && /^[A-Z]/.test(prop)) return class {};
      return undefined;
    },
    has() { return true; },
  });
}
vscodeStub.window = lenient(vscodeStub.window);
vscodeStub.workspace = lenient(vscodeStub.workspace);
vscodeStub.languages = lenient(vscodeStub.languages);
vscodeStub.version = '1.90.0';

// vscode-languageclient subclasses API classes it expects the real
// module to export (CompletionItem, CodeAction, …).  Hand out an empty
// class for anything unmodelled rather than enumerating them.
const vscodeProxy = new Proxy(vscodeStub, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop === 'string' && /^[A-Z]/.test(prop)) {
      const cls = class {};
      target[prop] = cls;
      return cls;
    }
    return undefined;
  },
  has() { return true; },
});

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeProxy };

// Record start() instead of spawning bin/hol, and report Running.
const lcNode = require(path.join(REPO, 'node_modules/vscode-languageclient/node'));
const notified = [];
lcNode.LanguageClient.prototype.start = async function () { this._fakeRunning = true; };
Object.defineProperty(lcNode.LanguageClient.prototype, 'state', {
  get() { return this._fakeRunning ? 2 : 1; },   // State.Running = 2
  configurable: true,
});
lcNode.LanguageClient.prototype.sendNotification = async function (m, p) {
  notified.push([m, p]);
};

const { LspClients, isHolScript } = require(path.join(REPO, 'out/lspClient.js'));

const doc = { uri: vscodeStub.Uri.file('/tmp/fooScript.sml'), languageId: 'hol4' };
let failed = 0;
function check(label, cond, got) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label +
              (cond ? '' : '   got: ' + JSON.stringify(got)));
  if (!cond) failed++;
}

// `bin/hol` has to exist for a client to be created; nothing is
// spawned, since `start` is patched above.
const os = require('os');
const fs = require('fs');
const fakeHol = fs.mkdtempSync(path.join(os.tmpdir(), 'holstub-'));
fs.mkdirSync(path.join(fakeHol, 'bin'));
fs.writeFileSync(path.join(fakeHol, 'bin', 'hol'), '', { mode: 0o755 });
const clients = new LspClients(fakeHol);
vscodeStub.window.visibleTextEditors = [{ document: doc }];
vscodeStub.window.activeTextEditor = {
  document: doc, selection: { active: { line: 1, character: 0 } } };
clients.start();
const entry = clients.clients.get(doc.uri.toString());
const handlers = entry.client._pendingNotificationHandlers
                 || entry.client._notificationHandlers;
const send = (states) =>
  handlers.get('$/proofStates')({ uri: doc.uri.toString(), states });
const st = (name, status, line) => ({ name, status, pos: { line } });

// Two proofs settle.
send([st('one', 'proved', 3), st('two', 'proved', 9)]);
check('two proofs read as two', /2 proofs checked/.test(String(statusText)),
      statusText);

// An edit at the top: both are dropped and re-announced one line down.
send([st('one', 'cheated', 4), st('two', 'cheated', 10)]);
check('both outstanding while the pool has let go',
      /proofs 0\/2 \(2 not checked\)/.test(String(statusText)), statusText);
send([st('one', 'proved', 4), st('two', 'checking', 10)]);
check('still two, not four', /proofs 1\/2/.test(String(statusText)),
      statusText);
send([st('two', 'proved', 10)]);
check('and back to two checked', /2 proofs checked/.test(String(statusText)),
      statusText);

// The line follows the proof, so navigation goes to the right place.
send([st('two', 'failed', 10)]);
const out = clients.outstandingProofs();
check('the outstanding proof is reported at the line it moved to',
      out.length === 1 && out[0].name === 'two' && out[0].line === 10, out);

// A rebound name is two proofs, not one: `two' is failed at this
// point, so four entries with two proved and one to look at.
send([st('foo', 'proved', 20), st('foo#2', 'checking', 30)]);
check('a rebound name counts twice, not once',
      /proofs 2\/4 \(1 to look at\)/.test(String(statusText)), statusText);
check('and both occurrences are reachable',
      clients.outstandingProofs().map((p) => p.name).join(',')
        === 'two,foo#2',
      clients.outstandingProofs());

// An unnamed proof is not the user's and is not counted.
send([st('', 'proved', 40)]);
check('an unnamed proof is not counted',
      /proofs 2\/4 \(1 to look at\)/.test(String(statusText)), statusText);

// ---- theorem search ----------------------------------------------
// The quick pick is what makes a search usable: it gets the hits as
// items, and picking one opens where the theorem was proved.
let quickPickItems = null;
let opened = null;
vscodeStub.window.showInputBox = async () => '"ASSOC" \'arithmetic\'';
vscodeStub.window.showQuickPick = async (items) => {
  quickPickItems = items;
  return items[0];
};
vscodeStub.workspace.openTextDocument = async (u) => { opened = u; return {}; };
vscodeStub.window.showTextDocument = async () => ({
  selection: null, revealRange() {},
});
vscodeStub.Position = class {
  constructor(l, c) { this.line = l; this.character = c; }
};
vscodeStub.Selection = class {};
vscodeStub.Range = class {};
vscodeStub.TextEditorRevealType = { InCenterIfOutsideViewport: 2 };
vscodeStub.Uri.parse = (u) => ({ scheme: 'file', toString: () => u });

const hits = [
  { name: 'ADD_ASSOC', theory: 'arithmetic', class: 'Thm',
    statement: '\u22a2 !m n p.\n  m + (n + p) = m + n + p',
    uri: 'file:///tmp/arithmeticScript.sml', line: 312 },
  { name: 'NOWHERE', theory: 'local', class: 'Def',
    statement: '\u22a2 T', line: 0 },
];
let asked = null;
clients.sendRequest = async (_doc, method, params) => {
  asked = { method, params };
  return hits;
};

(async () => {
  await clients.searchTheorems();
  check('search asks the server', asked && asked.method === '$/hol/search',
        asked);
  check('as one box, for the server to split',
        asked && asked.params.query === '"ASSOC" \'arithmetic\'', asked);
  check('every hit is offered',
        quickPickItems && quickPickItems.length === hits.length,
        quickPickItems);
  check('labelled theory$name, with its class and where it was proved',
        quickPickItems &&
        quickPickItems[0].label === 'arithmetic$ADD_ASSOC' &&
        quickPickItems[0].description === 'Thm  arithmeticScript.sml:312',
        quickPickItems);
  // The fixture's second hit has no location, which HOL does not
  // always record; it must show the class alone rather than a stray
  // separator.
  check('a hit with no location shows just its class',
        quickPickItems && quickPickItems[1].description === 'Def',
        quickPickItems);
  check('and its statement flattened to one line',
        quickPickItems &&
        quickPickItems[0].detail === '\u22a2 !m n p. m + (n + p) = m + n + p',
        quickPickItems && quickPickItems[0].detail);
  check('picking one opens where it was proved',
        opened && String(opened) === 'file:///tmp/arithmeticScript.sml',
        opened);

  console.log(failed === 0 ? '\nall checks passed'
                           : `\n${failed} check(s) failed`);
  fs.rmSync(fakeHol, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
})();
