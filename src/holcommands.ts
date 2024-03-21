import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { HOLExtensionContext, log, error, isInactive } from './commons';
import { HOLIDE, HOLSymbolInformation } from './ide';
import { HolTerminal } from './terminal';

/**
 * Generate a HOL lexer location pragma from a vscode Position value.
 */
function positionToLocationPragma(pos: vscode.Position): string {
    return `(*#loc ${pos.line + 1} ${pos.character} *)`;
}

export type SearchForwardResult = {
    matchStart: number;
    contentStart: number;
    matchEnd: number;
    contentEnd: number;
};

/**
 * Search forward in text and find the start- and end positions for the matched
 * text, and the content within the match (i.e. between the `start` and `stop`
 * match). If the `stop` regex is not matched, the end of the string counts as
 * the end of the match and the end of the contents.
 *
 * @param init Starting match
 * @param stop Ending match
 * @param offset Offset into `data` from where to start search
 */
function searchForward(text: string,  offset: number, init: RegExp, stop: RegExp): SearchForwardResult | undefined {
    text = text.slice(offset);

    const initMatch = init.exec(text);
    if (!initMatch) {
        return;
    }

    const matchStart = initMatch.index;
    const contentStart = matchStart + initMatch[0].length;

    const stopMatch = stop.exec(text.slice(contentStart));
    if (!stopMatch) {
        return {
            matchStart: matchStart,
            contentStart: contentStart,
            matchEnd: text.length - 1,
            contentEnd: text.length - 1
        };
    }

    const contentEnd = contentStart + stopMatch.index;
    const matchEnd = contentEnd + stopMatch[0].length;

    return {
        matchStart: matchStart,
        contentStart: contentStart,
        matchEnd: matchEnd,
        contentEnd: contentEnd
    };
}

/**
 * Get the editors current selection if any, or the contents of the editors
 * current line otherwise.
 */
function getSelection(editor: vscode.TextEditor): string {
    const document = editor.document;
    const selection = editor.selection;
    return selection.isEmpty ? document.lineAt(selection.active.line).text
                             : document.getText(selection);
}

/**
 * Preprocess any `open` declarations in a string. Any declarations are sorted,
 * and for each declaration a `load`-call is generated. If there are no `open`s
 * in the text, then this does nothing.
 */
function processOpens(text: string): string {

    const stoppers = [
        "val", "fun", "local", "open", "type", "datatype", "nonfix", "infix",
        "exception", "in", "end", "structure", "Theorem", "Definition",
        "Inductive", "CoInductive", "Triviality", "Datatype", "Type", "Overload"
    ];
    const openTerms = new RegExp(`;\|${stoppers.join('\\s\|\\s')}\\s`);
    const openBegin = /\s*open\s/;
    const comment = /\(\*(\*[^\)]|[^\*])*\*\)/g;

    let theories: string[] = [];
    let match;
    while ((match = searchForward(text, 0, openBegin, openTerms))) {
        text.slice(match.contentStart, match.contentEnd)
            .replace(comment, '')
            .split(/\s/)
            .filter((s) => s.length > 0)
            .sort()
            .forEach((s) => theories.push(s));
        text = text.substring(0, match.matchStart + 1) + text.substring(match.contentEnd);
    }

    text = text.replace(/\n\s*\n/g, '\n').replace(/\r/g, '');

    if (theories.length < 1) {
        return text;
    }

    const banner = `val _ = print "Loading: ${theories.join(' ')} ...\\n";`;
    const loads = theories.map((s) => `val _ = load "${s}";`).join('\n');
    const opens = [
        'val _ = HOL_Interactive.toggle_quietdec();',
        `open ${theories.join(' ')};`,
        'val _ = HOL_Interactive.toggle_quietdec();'
    ].join('\n');
    const bannerDone = 'val _ = print "Done loading theories.\\n"';

    return [banner, loads, opens, bannerDone, text].join('\n');
}

/**
 * Preprocess a tactic selection by removing leading tacticals and trailing
 * tacticals (plus possibly an opening parenthesis).
 */
function processTactics(text: string): string {
    const tacticalBegin = /^(\\\\|>>|>-|\bTHEN[1]?\b)(\s)/;
    const tacticalEnd = /(\\\\|>>|>-|\bTHEN[1]?\b)(\s*)[\(]?$/;
    return text.trim().replace(tacticalBegin, '$2').replace(tacticalEnd, '$2');
}

/**
 * Select a chunk of text delimited by `init` and `stop` in the editor `editor`.
 */
function selectBetween(editor: vscode.TextEditor, init: RegExp, stop: RegExp): vscode.Selection | undefined {
    const selection = editor.selection;
    const document = editor.document;
    const currentLine = selection.active.line;

    let startLine, startCol;

    for (let i = currentLine; i >= 0; i--) {
        const text = document.lineAt(i).text;
        const match = init.exec(text);
        if (match) {
            startLine = i;
            startCol = match.index + match[0].length;
            break;
        }
    }

    if (startLine === undefined || startCol === undefined) {
        return;
    }

    let endLine, endCol;

    for (let i = currentLine; i < document.lineCount; i++) {
        let text = document.lineAt(i).text;
        let offset = 0;

        // If we're at the same line as the starting match, and if the `init`
        // and `stop` regexes both match the same token, then we need to skip
        // the init token, or we'll produce an empty range.
        if (i === startLine) {
            text = text.slice(startCol);
            offset += startCol;
        }

        const match = stop.exec(text);
        if (match) {
            endLine = i;
            endCol = match.index + offset;
            break;
        }
    }

    if (endLine === undefined || endCol === undefined) {
        return;
    }

    return new vscode.Selection(startLine, startCol, endLine, endCol);
};

/**
 * Attempt to extract a goal from the current editor. Start by searching
 * forwards and backwards for a matching `{Theorem,Triviality}:-Proof` pair.
 * If this does not work, search for the nearest pair of double term quotes. If
 * this does not work, search for the nearest pair of single term quotes.
 * Otherwise, return nothing.
 *
 * If you're between two goals or terms you will select a large chunk of
 * everything.
 *
 * @note this function embeds a location pragma in the string it returns.
 */
function extractGoal(editor: vscode.TextEditor): string | undefined {
    const selection = editor.selection;
    const document = editor.document;

    if (!selection.isEmpty) {
        const locPragma = positionToLocationPragma(selection.anchor);
        return [locPragma, document.getText(selection)].join('');
    }

    const spanBegin = /^(Theorem|Triviality)\s+[^\[\:]+(\[[^\]]*\])?\s*\:/;
    const spanEnd = /^Proof/;

    let sel;
    if ((sel = selectBetween(editor, spanBegin, spanEnd)) ||
        (sel = selectBetween(editor, /“/, /”/)) ||
        (sel = selectBetween(editor, /‘/, /’/)) ||
        (sel = selectBetween(editor, /``/, /``/)) ||
        (sel = selectBetween(editor, /`/, /`/))) {
        const locPragma = positionToLocationPragma(sel.anchor);
        return [locPragma, document.getText(sel)].join('');
    }

    return;
}

/**
 * Identical to {@link extractGoal} but only accepts term quotations.
 * @todo Merge with extractGoal.
 */
function extractSubgoal(editor: vscode.TextEditor): string | undefined {
    const selection = editor.selection;
    const document = editor.document;

    if (!selection.isEmpty) {
        const locPragma = positionToLocationPragma(selection.anchor);
        return [locPragma, document.getText(selection)].join('');
    }

    let sel;
    if ((sel = selectBetween(editor, /‘/, /’/)) ||
        (sel = selectBetween(editor, /`/, /`/))) {
        const locPragma = positionToLocationPragma(sel.anchor);
        return [locPragma, document.getText(sel)].join('');
    }

    return;
}

/** Start HOL terminal session */
export function startSession(editor: vscode.TextEditor, holExtensionContext: HOLExtensionContext): void {
    if (holExtensionContext.active) {
        vscode.window.showErrorMessage('HOL session already active; doing nothing.');
        error('Session already active; doing nothing');
        return;
    }

    let docPath = path.dirname(editor.document.uri.fsPath);
    holExtensionContext.holTerminal = new HolTerminal(docPath, holExtensionContext.holPath!);
    holExtensionContext.terminal = vscode.window.createTerminal({
        name: 'HOL4',
        pty: holExtensionContext.holTerminal
    });

    vscode.window.onDidCloseTerminal((e: vscode.Terminal) => {
        if (e === holExtensionContext.terminal) {
            holExtensionContext.active = false;
            //terminal.dispose();
            holExtensionContext.terminal = undefined;
            log('Closed terminal; deactivating');
        }
    });

    log('Started session');
    holExtensionContext.terminal.show(true);
    holExtensionContext.active = true;
}

/** Stop the HOL terminal session */
export function stopSession(holExtensionContext: HOLExtensionContext): void {
    if (isInactive(holExtensionContext)) {
        return;
    }

    log('Stopped session');
    holExtensionContext.terminal?.dispose();
    holExtensionContext.active = false;
}

/** Send interrupt signal to the hol terminal */
export function interrupt(holExtensionContext: HOLExtensionContext): void {
    if (isInactive(holExtensionContext)) {
        return;
    }

    log('Interrupted session');
    holExtensionContext.holTerminal?.interrupt();
}

/** Send selection to the terminal; preprocess to find `open` and `load`
  * calls.
  */
export function sendSelection(editor: vscode.TextEditor, holExtensionContext: HOLExtensionContext): void {
    if (isInactive(holExtensionContext)) {
        return;
    }

    let text = getSelection(editor);
    text = processOpens(text);

    holExtensionContext.holTerminal!.sendRaw(`${text};\n`);
}

/** Send all text up to and including the current line in the current editor
  * to the terminal.
  */
export function sendUntilCursor(editor: vscode.TextEditor, holExtensionContext: HOLExtensionContext): void {
    if (isInactive(holExtensionContext)) {
        return;
    }

    const selection = editor.selection;
    const document = editor.document;
    const currentLine = selection.active.line;
    let text = document.getText(new vscode.Selection(0, 0, currentLine, 0));
    text = processOpens(text);

    holExtensionContext.holTerminal!.sendRaw(`${text};\n`);
}

/** Send a goal selection to the terminal. */
export function sendGoal(editor: vscode.TextEditor, holExtensionContext: HOLExtensionContext): void {
    if (isInactive(holExtensionContext)) {
        return;
    }

    let text = extractGoal(editor);
    if (!text) {
        vscode.window.showErrorMessage('Unable to select a goal term');
        error('Unable to select goal term');
        return;
    }

    holExtensionContext.holTerminal!.sendRaw(`proofManagerLib.g(\`${text}\`);\n`);
    holExtensionContext.holTerminal!.sendRaw('proofManagerLib.set_backup 100;\n');
}

/** Select a term quotation and set it up as a subgoal. */
export function sendSubgoal(editor: vscode.TextEditor, holExtensionContext: HOLExtensionContext): void {
    if (isInactive(holExtensionContext)) {
        return;
    }

    let text = extractSubgoal(editor);
    if (!text) {
        vscode.window.showErrorMessage('Unable to select a subgoal term');
        error('Unable to select subgoal term');
        return;
    }

    holExtensionContext.holTerminal!.sendRaw(`proofManagerLib.e(sg\`${text}\`);\n`);
}

/** Send a tactic to the terminal. */
export function sendTactic(editor: vscode.TextEditor, holExtensionContext: HOLExtensionContext): void {
    if (isInactive(holExtensionContext)) {
        return;
    }

    let tacticText = getSelection(editor);
    tacticText = processTactics(tacticText);

    const locPragma = positionToLocationPragma(editor.selection.anchor);
    const trace = '"show_typecheck_errors"';
    const data = [
        'let val old = Feedback.current_trace ', trace,
        '    val _ = Feedback.set_trace ', trace, ' 0 in (',
        locPragma, ') before Feedback.set_trace ', trace, ' old end;',
        `proofManagerLib.e(${tacticText});`
    ].join('');
    holExtensionContext.holTerminal!.sendRaw(`${data};\n`);
}

/** Send a tactic line to the terminal. */
export function sendTacticLine(editor: vscode.TextEditor, holExtensionContext: HOLExtensionContext): void {
    if (isInactive(holExtensionContext)) {
        return;
    }

    let tacticText = editor.document.lineAt(editor.selection.active.line).text;
    tacticText = processTactics(tacticText);

    const locPragma = positionToLocationPragma(editor.selection.anchor);
    const trace = '"show_typecheck_errors"';
    const data = [
        'let val old = Feedback.current_trace ', trace,
        '    val _ = Feedback.set_trace ', trace, ' 0 in (',
        locPragma, ') before Feedback.set_trace ', trace, ' old end;',
        `proofManagerLib.e(${tacticText});`
    ].join('');
    holExtensionContext.holTerminal!.sendRaw(`${data};\n`);
}

/** Show current goal */
export function showCurrentGoal(holExtensionContext: HOLExtensionContext): void {
    if (isInactive(holExtensionContext)) {
        return;
    }

    holExtensionContext.holTerminal!.sendRaw('proofManagerLib.p ();\n');
}

/** Rotate goal */
export function rotateGoal(holExtensionContext: HOLExtensionContext): void {
    if (isInactive(holExtensionContext)) {
        return;
    }

    holExtensionContext.holTerminal!.sendRaw('proofManagerLib.rotate 1;\n');
}

/** Backstep in goal */
export function backstepGoal(holExtensionContext: HOLExtensionContext): void {
    if (isInactive(holExtensionContext)) {
        return;
    }

    holExtensionContext.holTerminal!.sendRaw('proofManagerLib.backup ();\n');
}

/** Restart goal */
export function restartGoal(holExtensionContext: HOLExtensionContext): void {
    if (isInactive(holExtensionContext)) {
        return;
    }

    holExtensionContext.holTerminal!.sendRaw('proofManagerLib.restart ();\n');
}

/** Drop goal */
export function dropGoal(holExtensionContext: HOLExtensionContext): void {
    if (isInactive(holExtensionContext)) {
        return;
    }

    holExtensionContext.holTerminal!.sendRaw('proofManagerLib.drop();\n');
}

/** Set show_types := ${show} */
export function setShowTypes(holExtensionContext: HOLExtensionContext, show: boolean): void {
    if (isInactive(holExtensionContext)) {
        return;
    }

    holExtensionContext.holTerminal?.sendRaw(`show_types := ${show};\n`);
}


