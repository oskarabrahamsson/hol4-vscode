import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';

/**
 * This class wraps the Pseudoterminal interface with some functionality to
 * toggle terminal echo. We need to toggle echoing of input as text is sent to
 * the HOL process via its `stdin`, and the plugin would become unbearable to
 * use otherwise.
 */
class HolTerminal implements vscode.Pseudoterminal {

    private cwd: string;
    private child: child_process.ChildProcess | undefined;
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<void>();

    private buffer: string[] = [];

    // Fixes linebreaks and backspaces when printing back to terminal stdout.
    private fixLineBreak(text: string) {
        return text.replace(/\r\n/gi,'\r')
                   .replace(/\r/gi, '\n')
                   .replace(/\n/gi, '\r\n')
                   .replace(/\x7f/gi,'\b \b');
    }

    userInput: boolean = true;
    sendRaw(text: string) {
        this.userInput = false;
        this.handleInput(text);
        this.userInput = true;
    }

    constructor(cwd: string) {
        this.cwd = cwd;
    }

    onDidWrite = this.writeEmitter.event;
    onDidClose = this.closeEmitter.event;

    open(initialDimensions: vscode.TerminalDimensions | undefined) {
        this.child = child_process.exec(
            path.join(holPath!, 'bin', 'hol'),
            {cwd: this.cwd});
        this.child.stdout?.on('data', (data) => {
            this.writeEmitter.fire(this.fixLineBreak(data));
        });
        this.child.stderr?.on('data', (data) => {
            const isLineBreak = /(\r[^\n]|\n[^\r])/gi;
            this.writeEmitter.fire(this.fixLineBreak(data));
        });
    }

    close() {
        this.child?.kill();
    }

    setDimensions(dimensions: vscode.TerminalDimensions) {}

    handleInput(data: string) {
        if (this.userInput) {
            this.writeEmitter.fire(this.fixLineBreak(data));

            if (data[0] === '\b' || data[0] === '\x7f') {
                this.buffer.pop();
                return;
            }

            if (data[0] === '\r') {
                this.child?.stdin?.write(this.buffer.join(''));
                this.child?.stdin?.write('\r\n');
                this.buffer = [];
            } else {
                this.buffer.push(data[0]);
            }
            return;
        }

        this.child!.stdin?.write(data);
    };
}

/** Path to the HOL installation to use. */
let holPath: string | undefined;

/** Currently active pseudoterminal (if any). */
let holTerminal: HolTerminal | undefined;

/** Currently active terminal (if any). */
let terminal: vscode.Terminal | undefined;

/** Whether the HOL session is active. */
let active = false;

/** Log a message with the 'hol-mode' prefix. */
function log(message: string) {
    console.log(`--- hol-mode: ${message}`);
}

/** Log an error with the 'hol-mode' prefix. */
function error(message: string) {
    console.error(`!!! hol-mode: Error: ${message}`);
}

/** Returns whether the current session is inactive. If it is inactive, then an
 * error message is printed.
 */
function isInactive() {
    if (!active) {
        vscode.window.showErrorMessage('No active HOL session; doing nothing.');
        error('No active session; doing nothing');
    }

    return !active;
}

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
function searchForward(text: string,  offset: number, init: RegExp, stop: RegExp) {
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
};


/**
 * Get the editors current selection if any, or the contents of the editors
 * current line otherwise.
 */
function getSelection(editor: vscode.TextEditor) {
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
function processOpens(text: string) {

    const stoppers = [
        "val", "fun", "local", "open", "type", "datatype", "nonfix", "infix",
        "exception", "in", "end", "structure", "Theorem", "Definition",
        "Inductive", "CoInductive", "Triviality", "Datatype", "Type", "Overload"
    ];
    const openTerms = new RegExp(`;\|${stoppers.join('\\s\|\\s')}\\s`);
    const openBegin = /\s*open\s/;

    let theories: string[] = [];
    let match;
    while ((match = searchForward(text, 0, openBegin, openTerms))) {
        text.slice(match.contentStart, match.contentEnd)
            .split(/\s/)
            .filter((s) => s.length > 0)
            .sort()
            .forEach((s) => theories.push(s));
        text = text.substring(0, match.matchStart + 1) + text.substring(match.contentEnd);
    }

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

    return [banner, loads, opens, text].join('\n');
}

/**
 * Preprocess a tactic selection by removing leading tacticals and trailing
 * tacticals (plus possibly an opening parenthesis).
 */
function processTactics(text: string) {
    const tacticalBegin = /^(\\\\|>>|>-|THEN[1]?\s)/;
    const tacticalEnd = /(\\\\|>>|>-|THEN[1]?\s&)\s*[\(]?$/;
    return text.trim().replace(tacticalBegin, '').replace(tacticalEnd, '');
}

/**
 * Attempt to extract a goal from the current editor. Start by searching
 * forwards and backwards for a matching `{Theorem,Triviality}:-Proof` pair.
 * If this does not work, search for the nearest pair of double term quotes. If
 * this does not work, search for the nearest pair of single term quotes.
 * Otherwise, return nothing.
 *
 * If you're between two goals or terms you will select a large chunk of
 * everything.
 */
function extractGoal(editor: vscode.TextEditor) {
    const selection = editor.selection;
    const document = editor.document;

    if (!selection.isEmpty) {
        return document.getText(selection);
    }

    const findSelectionBetween = (init: RegExp, stop: RegExp) => {
        const currentLine = selection.active.line;

        let matchBegin;
        let matchEnd;

        for (let i = currentLine; i >= 0; i--) {
            const text = document.lineAt(i).text;
            if (stop.test(text)) {
                return;
            }
            if (init.test(text)) {
                matchBegin = i;
                break;
            }
        }

        for (let i = currentLine; i < document.lineCount; i++) {
            const text = document.lineAt(i).text;
            if (init.test(text)) {
                return;
            }
            if (stop.test(text)) {
                matchEnd = i;
                break;
            }
        }

        if (!matchBegin || !matchEnd || matchEnd <= matchBegin) {
            return;
        }

        return new vscode.Selection(matchBegin + 1, 0, matchEnd, 0);
    };

    const spanBegin = /^(Theorem|Triviality)\s+[^\[\:]+(\[[^\]]*\])?\s*\:\s*$/;
    const spanEnd = /^Proof\s*$/;

    let sel;
    if ((sel = findSelectionBetween(spanBegin, spanEnd)) ||
        (sel = findSelectionBetween(/“/, /”/)) ||
        (sel = findSelectionBetween(/‘/, /’/)) ||
        (sel = findSelectionBetween(/``/, /``/)) ||
        (sel = findSelectionBetween(/`/, /`/))) {
        return document.getText(sel);
    }

    return;
}

export function activate(context: vscode.ExtensionContext) {

    log('Attempting to determine $HOLDIR.');
    if ((holPath = process.env['HOLDIR'])) {
        log(`$HOLDIR is set to ${holPath}`);
    } else {
        vscode.window.showErrorMessage('HOL4 mode: $HOLDIR environment variable not set');
        error('Unable to read $HOLDIR environment variable, exiting');
        return;
    }
    log('Done with initialization');

    // Start a new HOL4 session.
    // Opens up a terminal and starts HOL4.
    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand('hol4-mode.startSession', (editor) => {
            if (active) {
                vscode.window.showErrorMessage('HOL session already active; doing nothing.');
                error('Session already active; doing nothing');
                return;
            }

            let docPath = path.dirname(editor.document.uri.fsPath);
            holTerminal = new HolTerminal(docPath);
            terminal = vscode.window.createTerminal({
                name: 'HOL4',
                pty: holTerminal
            });

            vscode.window.onDidCloseTerminal((e: vscode.Terminal) => {
                if (e === terminal) {
                    active = false;
                    //terminal.dispose();
                    terminal = undefined;
                    log('Closed terminal; deactivating');
                }
            });

            log('Started session');
            terminal.show(true);
            active = true;
        })
    );

    // Stop the current session, if any.
    context.subscriptions.push(
        vscode.commands.registerCommand('hol4-mode.stopSession', () => {
            if (isInactive()) {
                return;
            }

            log('Stopped session');
            terminal?.dispose();
            active = false;

        })
    );

    // Send selection to the terminal; preprocess to find `open` and `load`
    // calls.
    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand('hol4-mode.sendSelection', (editor) => {
            if (isInactive()) {
                return;
            }

            let text = getSelection(editor);
            text = processOpens(text).replace('\n', ' ');

            holTerminal!.sendRaw(`${text};\n`);
        })
    );

    // Send all text up to and including the current line in the current editor
    // to the terminal.
    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand('hol4-mode.sendUntilCursor', (editor) => {
            if (isInactive()) {
                return;
            }

            const selection = editor.selection;
            const document = editor.document;
            const currentLine = selection.active.line;
            let text = document.getText(new vscode.Selection(0, 0, currentLine, 0));
            text = processOpens(text).replace('\n', ' ');

            holTerminal!.sendRaw(`${text};\n`);
        })
    );

    // Send a goal selection to the terminal.
    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand('hol4-mode.sendGoal', (editor) => {
            if (isInactive()) {
                return;
            }

            let text = extractGoal(editor)?.replace('\n', ' ');
            if (!text) {
                vscode.window.showErrorMessage('Unable to select a goal term');
                error('Unable to select goal term');
                return;
            }

            holTerminal!.sendRaw(`g(\`${text}\`);\n`);
        })
    );

    // Send a tactic selection to the terminal.
    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand('hol4-mode.sendTactic', (editor) => {
            if (isInactive()) {
                return;
            }

            let text = getSelection(editor);
            text = processTactics(text);

            holTerminal!.sendRaw(`e(${text});\n`);
        })
    );

    // Show goal.
    context.subscriptions.push(
        vscode.commands.registerCommand('hol4-mode.showGoal', () => {
            if (isInactive()) {
                return;
            }

            holTerminal!.sendRaw('p();\n');
        })
    );

    // Rotate goal.
    context.subscriptions.push(
        vscode.commands.registerCommand('hol4-mode.rotateGoal', () => {
            if (isInactive()) {
                return;
            }

            holTerminal!.sendRaw('r();\n');
        })
    );

    // Drop goal.
    context.subscriptions.push(
        vscode.commands.registerCommand('hol4-mode.dropGoal', () => {
            if (isInactive()) {
                return;
            }

            holTerminal!.sendRaw('d();\n');
        })
    );
}

// this method is called when your extension is deactivated
export function deactivate() {}
