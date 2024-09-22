import * as vscode from 'vscode';
import * as path from 'path';
import { log, error } from './common';
import { HolTerminal } from './hol_terminal';
import { HOLIDE, entryToCompletionItem, entryToSymbol, isAccessibleEntry } from './hol_ide';

/**
 * Generate a HOL lexer location pragma from a vscode Position value.
 */
function positionToLocationPragma(pos: vscode.Position): string {
    return `(*#loc ${pos.line + 1} ${pos.character} *)`;
}

type SearchForwardResult = {
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
function searchForward(text: string, offset: number, init: RegExp, stop: RegExp): SearchForwardResult | undefined {
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
 * Adds a location pragma to the text at the given position.
 */
function addLocationPragma(text: string, position: vscode.Position) {
    const locPragma = positionToLocationPragma(position);
    const trace = '"show_typecheck_errors"';
    const data = [
        'let val old = Feedback.current_trace ', trace,
        '    val _ = Feedback.set_trace ', trace, ' 0 in (',
        locPragma, ') before Feedback.set_trace ', trace, ' old end;',
        `${text};`
    ].join('');
    return data;
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

export class HOLExtensionContext {

    /**
     * Path to the HOL installation to use.
     */
    public holPath: string;

    /**
     * Currently active pseudoterminal (if any).
     */
    public holTerminal?: HolTerminal;

    /**
     * Current IDE class instance.
     */
    public holIDE?: HOLIDE;

    /**
     * Currently active terminal (if any).
     */
    public terminal?: vscode.Terminal;

    constructor(holPath: string, holIDE?: HOLIDE) {
        this.holPath = holPath;
        this.holIDE = holIDE;
    }

    /** Returns whether the current session is active. If it is not active, then
     * an error message is printed.
     */
    isActive(): boolean {
        if (!this.holTerminal) {
            vscode.window.showErrorMessage('No active HOL session; doing nothing.');
            error('No active session; doing nothing');
        }

        return this.holTerminal !== undefined;
    }

    /**
     * Start HOL terminal session.
     */
    async startSession(editor: vscode.TextEditor) {
        if (this.holTerminal !== undefined) {
            vscode.window.showErrorMessage('HOL session already active; doing nothing.');
            error('Session already active; doing nothing');
            return;
        }

        let docPath = path.dirname(editor.document.uri.fsPath);
        this.holTerminal = new HolTerminal(docPath, this.holPath);
        this.terminal = vscode.window.createTerminal({
            name: 'HOL4',
            pty: this.holTerminal
        });

        vscode.window.onDidCloseTerminal((e: vscode.Terminal) => {
            if (e === this.terminal) {
                this.terminal = undefined;
                this.holTerminal = undefined;
                log('Closed terminal; deactivating');
            }
        });

        log('Started session');
        this.terminal.show(true);
    }

    /**
     * Stop the HOL terminal session.
     */
    stopSession() {
        if (!this.isActive()) {
            return;
        }

        log('Stopped session');
        this.terminal?.dispose();
        this.holTerminal = undefined;
    }

    /**
     * Send interrupt signal to the HolTerminal.
     */
    interrupt() {
        if (!this.isActive()) {
            return;
        }

        log('Interrupted session');
        this.holTerminal?.interrupt();
    }

    /**
     * Send selection to the terminal; preprocess to find `open` and `load`
     * calls.
     */
    sendSelection(editor: vscode.TextEditor) {
        if (!this.isActive()) {
            return;
        }

        let text = getSelection(editor);
        text = processOpens(text);
        text = addLocationPragma(text, editor.selection.start);

        this.holTerminal!.sendRaw(`${text};\n`);
    }


    /**
     * Send all text up to and including the current line in the current editor to
     * the terminal.
     */
    sendUntilCursor(editor: vscode.TextEditor) {
        if (!this.isActive()) {
            return;
        }

        const currentLine = editor.selection.active.line;

        const selection = new vscode.Selection(0, 0, currentLine, 0);
        let text = editor.document.getText(selection);
        text = processOpens(text);
        text = addLocationPragma(text, selection.start);

        this.holTerminal!.sendRaw(`${text};\n`);
    }

    /**
     * Send a goal selection to the terminal.
     */
    sendGoal(editor: vscode.TextEditor) {
        if (!this.isActive()) {
            return;
        }

        let text = extractGoal(editor);
        if (!text) {
            vscode.window.showErrorMessage('Unable to select a goal term');
            error('Unable to select goal term');
            return;
        }

        this.holTerminal!.sendRaw(`proofManagerLib.g(\`${text}\`);\n`);
        this.holTerminal!.sendRaw('proofManagerLib.set_backup 100;\n');
    }

    /**
     * Select a term quotation and set it up as a subgoal.
     */
    sendSubgoal(editor: vscode.TextEditor) {
        if (!this.isActive()) {
            return;
        }

        let text = extractSubgoal(editor);
        if (!text) {
            vscode.window.showErrorMessage('Unable to select a subgoal term');
            error('Unable to select subgoal term');
            return;
        }

        this.holTerminal!.sendRaw(`proofManagerLib.e(sg\`${text}\`);\n`);
    }

    /**
     * Send a tactic to the terminal.
     */
    sendTactic(editor: vscode.TextEditor) {
        if (!this.isActive()) {
            return;
        }

        let tacticText = getSelection(editor);
        tacticText = processTactics(tacticText);
        const text = addLocationPragma(`proofManagerLib.e(${tacticText})`, editor.selection.start);

        this.holTerminal!.sendRaw(`${text};\n`);
    }


    /**
     * Send a tactic line to the terminal.
     */
    sendTacticLine(editor: vscode.TextEditor) {
        if (!this.isActive()) {
            return;
        }

        let tacticText = editor.document.lineAt(editor.selection.active.line).text;
        tacticText = processTactics(tacticText);
        const text = addLocationPragma(`proofManagerLib.e(${tacticText})`, editor.selection.start);

        this.holTerminal!.sendRaw(`${text};\n`);
    }

    /**
     * Show current goal.
     */
    showCurrentGoal() {
        if (!this.isActive()) {
            return;
        }

        this.holTerminal!.sendRaw('proofManagerLib.p ();\n');
    }


    /**
     * Rotate goal.
     */
    rotateGoal() {
        if (!this.isActive()) {
            return;
        }

        this.holTerminal!.sendRaw('proofManagerLib.rotate 1;\n');
    }

    /**
     * Step backwards goal.
     */
    stepbackGoal() {
        if (!this.isActive()) {
            return;
        }

        this.holTerminal!.sendRaw('proofManagerLib.backup ();\n');
    }

    /**
     * Restart goal.
     */
    restartGoal() {
        if (!this.isActive()) {
            return;
        }

        this.holTerminal!.sendRaw('proofManagerLib.restart ();\n');
    }

    /**
     * Drop goal.
     */
    dropGoal() {
        if (!this.isActive()) {
            return;
        }

        this.holTerminal!.sendRaw('proofManagerLib.drop();\n');
    }

    /**
     * Toggle printing of terms with or without types.
     */
    toggleShowTypes() {
        if (!this.isActive()) {
            return;
        }

        this.holTerminal!.sendRaw('Globals.show_types:=not(!Globals.show_types);\n');
    }

    /**
     * Toggle printing of theorem hypotheses.
     */
    toggleShowAssums() {
        if (!this.isActive()) {
            return;
        }
        this.holTerminal!.sendRaw('Globals.show_assums:=not(!Globals.show_assums);\n');
    }

    /**
     * See {@link vscode.HoverProvider}.
     */
    provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) {
        const wordRange = document.getWordRangeAtPosition(position);
        const word = document.getText(wordRange);
        const entry = this.holIDE?.allEntries().find((entry) =>
            entry.name === word &&
            isAccessibleEntry(entry, this.holIDE!.imports, document));
        if (entry) {
            const markdownString = new vscode.MarkdownString();
            markdownString.appendMarkdown(`**${entry.type}:** ${entry.name}\n\n`);
            markdownString.appendCodeblock(entry.statement);
            return new vscode.Hover(markdownString, wordRange);
        }
    }

    /**
     * See {@link vscode.DefinitionProvider}.
     */
    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
    ) {
        const wordRange = document.getWordRangeAtPosition(position);
        const word = document.getText(wordRange);
        const entry = this.holIDE?.allEntries().find((entry) =>
            entry.name === word &&
            isAccessibleEntry(entry, this.holIDE!.imports, document));
        if (entry) {
            const position = new vscode.Position(entry.line! - 1, 0);
            return new vscode.Location(vscode.Uri.file(entry.file!), position);
        }
    }

    /**
     * See {@link vscode.DocumentSymbolProvider}.
     */
    provideDocumentSymbols(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken,
    ) {
        return this.holIDE?.documentEntries(document)
            .map((entry) => entryToSymbol(entry));
    }

    /**
     * See {@link vscode.WorkspaceSymbolProvider<T>}.
     */
    provideWorkspaceSymbols(
        query: string,
        _token: vscode.CancellationToken,
    ) {
        const symbols: vscode.SymbolInformation[] = [];
        const matcher = new RegExp(query, "i" /* ignoreCase */);
        this.holIDE?.allEntries().forEach((entry) => {
            if (matcher.test(entry.name)) {
                symbols.push(entryToSymbol(entry));
            }
        });
        return symbols;
    }

    /**
     * See {@link vscode.CompletionItemProvider}.
     */
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext,
    ) {
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {
            return [];
        }

        const word = document.getText(wordRange);
        const completions: vscode.CompletionItem[] = [];
        const matcher = new RegExp(word, "i" /* ignoreCase */);
        this.holIDE?.allEntries().forEach((entry) => {
            if (matcher.test(entry.name) &&
                isAccessibleEntry(entry, this.holIDE!.imports, document)) {
                completions.push(entryToCompletionItem(entry));
            }
        });
        return completions;
    }
};

