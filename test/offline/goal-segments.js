// The goals pane's type/identity tooltips, checked without VS Code.
//
// The goals pane is the one place hover cannot help: its text is in no
// file, so there is nothing to hover over.  The server sends `segments`
// beside `pretty` -- the same text, taken apart, each symbol carrying
// what it is.  These checks cover the two things that make that usable:
// what a tooltip says, and that the text still comes out intact.
//
// Nothing here needs an extension host; `vscode` is stubbed and the
// real compiled out/goalsView.js is driven.  Run via `npm run
// test:offline`.
const Module = require('module');
const path = require('path');
const REPO = path.join(__dirname, '..', '..');

// common.ts imports vscode but only reaches for it inside functions
// these tests never call, and `GoalSegment` is a type-only import, so
// nothing is required at load beyond this.
const vscodeStub = {
  ViewColumn: { Beside: -2 },
  window: { createWebviewPanel: () => ({}) },
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  commands: { registerCommand: () => ({ dispose() {} }) },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.call(this, request, ...rest);
};

const { segmentTitle, segmentsToHtml, hitLocation } =
  require(path.join(REPO, 'out', 'common.js'));

let failed = 0;
function check(what, ok, got) {
  if (ok) { console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + '  got: ' + JSON.stringify(got)); }
}

console.log('goal-state segment tooltips');

// --- what a tooltip says ---------------------------------------------
check('a constant is named by theory and typed',
      segmentTitle({ text: 'MAP', kind: 'const', name: 'listTheory$MAP',
                     ty: "('a -> 'b) -> 'a list -> 'b list" })
        === "listTheory$MAP : ('a -> 'b) -> 'a list -> 'b list",
      segmentTitle({ text: 'MAP', kind: 'const', name: 'listTheory$MAP',
                     ty: "('a -> 'b) -> 'a list -> 'b list" }));

check("a free variable shows HOL's own name :type",
      segmentTitle({ text: 'l', kind: 'fv', ty: "l :'a list" })
        === "l :'a list",
      segmentTitle({ text: 'l', kind: 'fv', ty: "l :'a list" }));

check('a bound variable says so',
      segmentTitle({ text: 'h', kind: 'bv', ty: "h :'a" })
        === "bound h :'a",
      segmentTitle({ text: 'h', kind: 'bv', ty: "h :'a" }));

check('plain text has no tooltip',
      segmentTitle({ text: ' = ' }) === undefined,
      segmentTitle({ text: ' = ' }));

// --- and the text survives -------------------------------------------
const segs = [
  { text: 'f' , kind: 'const', name: 'my$f', ty: 'num -> num' },
  { text: ' ' },
  { text: 'x' , kind: 'fv', ty: 'x :num' },
  { text: ' = y' },
];
const html = segmentsToHtml(segs);
check('every annotated segment gets a title',
      (html.match(/title=/g) || []).length === 2, html);
check('and a class naming its kind',
      html.includes('class="hol-const"') && html.includes('class="hol-fv"'),
      html);
check('plain runs are left as bare text',
      html.includes('</span> <span'), html);
check('the text reads exactly as the state did',
      html.replace(/<[^>]*>/g, '') === 'f x = y',
      html.replace(/<[^>]*>/g, ''));

// A goal is full of `/\`, `<`, `>` and `"`; a tooltip carries a type
// that is too.  Both go through escapeHtml, or the pane breaks.
const nasty = segmentsToHtml([
  { text: 'a < b', kind: 'const', name: 'x$"<"', ty: "'a -> 'a -> bool" },
]);
check('segment text is html-escaped',
      nasty.includes('a &lt; b'), nasty);
check('and so is the title',
      nasty.includes('&quot;') && !nasty.includes('title="x$"<"'), nasty);

// --- search hits say where they were proved -------------------------
check('a hit shows its script and line, not its path',
      hitLocation('file:///hol/src/finite_map/finite_mapScript.sml', 1234)
        === 'finite_mapScript.sml:1234',
      hitLocation('file:///hol/src/finite_map/finite_mapScript.sml', 1234));
check('a hit HOL records no location for shows nothing',
      hitLocation(undefined, 12) === undefined, hitLocation(undefined, 12));
check('and one with no line still names the script',
      hitLocation('file:///a/bScript.sml') === 'bScript.sml',
      hitLocation('file:///a/bScript.sml'));

console.log(failed === 0 ? '\nall checks passed'
                         : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
