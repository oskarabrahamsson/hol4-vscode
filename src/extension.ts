import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { HOLIDE, HOLSymbolInformation } from './ide';
import { HolTerminal } from './terminal';
import * as holcommands from './holcommands';
import { HOLExtensionContext, log, error, isInactive } from './commons';

let holExtensionContext: HOLExtensionContext = {
    holPath: undefined,
    holTerminal: undefined,
    holIDE: undefined,
    terminal: undefined,
    active: false,
    config: undefined
};

function loadUnicodeCompletions(context: vscode.ExtensionContext) {
    let unicodeCompletionsFilepath = context.asAbsolutePath('unicode-completions.json');
    let completions: { [key: string] : string } = {};

    log('Loading unicode completions.');
    fs.readFile(unicodeCompletionsFilepath, (err, data) => {
        if (err) {
            error(`Unable to read unicode completions file: ${err}`);
            vscode.window.showErrorMessage('Unable to load unicode completions.');
        }

        completions = JSON.parse(data.toString());
    });

    return completions;
}

let hol4selector: vscode.DocumentSelector = {
    scheme: 'file',
    language: 'hol4'
};

function initHOLDIR(context: vscode.ExtensionContext) {
    log('Attempting to determine $HOLDIR.');
    if ((holExtensionContext.holPath = process.env['HOLDIR'])) {
        log(`$HOLDIR is set to ${holExtensionContext.holPath}`);
    } else {
        vscode.window.showErrorMessage('HOL4 mode: $HOLDIR environment variable not set');
        error('Unable to read $HOLDIR environment variable, exiting');
        return;
    }

    holExtensionContext.config = vscode.workspace.getConfiguration('hol4-mode');
    if (holExtensionContext.config.get('experimental', false)) {
        holExtensionContext.holIDE = new HOLIDE();
        holExtensionContext.holIDE.initIDE();
    } else {
        vscode.window.showWarningMessage('HOL4 mode: experimental features disabled. In order to enable them, set hol4-mode.experimental to true in your settings.');
    }

    log('Done with initialization');
}

export function activate(context: vscode.ExtensionContext) {

    initHOLDIR(context);

    let completions = loadUnicodeCompletions(context);

    let commands = [
        // Start a new HOL4 session.
        // Opens up a terminal and starts HOL4.
        vscode.commands.registerTextEditorCommand('hol4-mode.startSession', (editor) => {
            holcommands.startSession(editor, holExtensionContext);
        }),

        // Stop the current session, if any.
        vscode.commands.registerCommand('hol4-mode.stopSession', () => {
            holcommands.stopSession(holExtensionContext);
        }),

        // Interrupt the current session, if any.
        vscode.commands.registerCommand('hol4-mode.interrupt', () => {
            holcommands.interrupt(holExtensionContext);
        }),

        // Send selection to the terminal; preprocess to find `open` and `load`
        // calls.
        vscode.commands.registerTextEditorCommand('hol4-mode.sendSelection', (editor) => {
            holcommands.sendSelection(editor, holExtensionContext);
        }),

        // Send all text up to and including the current line in the current editor
        // to the terminal.
        vscode.commands.registerTextEditorCommand('hol4-mode.sendUntilCursor', (editor) => {
            holcommands.sendUntilCursor(editor, holExtensionContext);
        }),

        // Send a goal selection to the terminal.
        vscode.commands.registerTextEditorCommand('hol4-mode.sendGoal', (editor) => {
            holcommands.sendGoal(editor, holExtensionContext);
        }),

        // Select a term quotation and set it up as a subgoal.
        vscode.commands.registerTextEditorCommand('hol4-mode.sendSubgoal', (editor) => {
            holcommands.sendSubgoal(editor, holExtensionContext);
        }),

        // Send a tactic selection to the terminal.
        vscode.commands.registerTextEditorCommand('hol4-mode.sendTactic', (editor) => {
            holcommands.sendTactic(editor, holExtensionContext);
        }),

        // Send a tactic line to the terminal.
        vscode.commands.registerTextEditorCommand('hol4-mode.sendTacticLine', (editor) => {
            holcommands.sendTacticLine(editor, holExtensionContext);
        }),

        // Show goal.
        vscode.commands.registerCommand('hol4-mode.proofmanShow', () => {
            holcommands.showCurrentGoal(holExtensionContext);
        }),

        // Rotate goal.
        vscode.commands.registerCommand('hol4-mode.proofmanRotate', () => {
            holcommands.rotateGoal(holExtensionContext);
        }),

        // Backstep in goal.
        vscode.commands.registerCommand('hol4-mode.proofmanBack', () => {
            holcommands.backstepGoal(holExtensionContext);
        }),

        // Restart goal.
        vscode.commands.registerCommand('hol4-mode.proofmanRestart', () => {
            holcommands.restartGoal(holExtensionContext);
        }),

        // Drop goal.
        vscode.commands.registerCommand('hol4-mode.proofmanDrop', () => {
            holcommands.dropGoal(holExtensionContext);
        }),

        // Toggle printing of terms with or without types
        vscode.commands.registerCommand('hol4-mode.toggleShowTypes', () => {
            holcommands.toggleShowTypes(holExtensionContext);
        }),

        // Toggle printing of theorem assumptions
        vscode.commands.registerCommand('hol4-mode.toggleShowAssums', () => {
            holcommands.toggleShowAssums(holExtensionContext);
        }),

        // Run Holmake in current directory
        vscode.commands.registerTextEditorCommand('hol4-mode.holmake', (editor) => {
            const docPath = path.dirname(editor.document.uri.fsPath);
            const terminal = vscode.window.createTerminal({
                cwd: docPath,
                name: 'Holmake',
                shellPath: 'Holmake',
                message: `Running Holmake in directory: ${docPath} ...`
            });
            terminal.show(true);
        }),

        // HOL IDE commands START

        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                holExtensionContext.holIDE?.updateImports(editor.document);
            }
        }),

        vscode.workspace.onDidSaveTextDocument((document) => {
            holExtensionContext.holIDE?.indexWorkspace(document);
        }),

        vscode.commands.registerCommand('hol4-mode.indexWorkspace', () => {
            holExtensionContext.holIDE?.indexWorkspace();
        }),

        vscode.commands.registerCommand('hol4-mode.reindexAllDependencies', () => {
            holExtensionContext.holIDE?.reindexAllDependencies();
        }),

        vscode.languages.registerHoverProvider(hol4selector, {
            provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) {
                const wordRange = document.getWordRangeAtPosition(position);
                const word = document.getText(wordRange);
                const entry = holExtensionContext.holIDE?.allEntries().find((entry) => entry.name === word && holExtensionContext.holIDE?.isAccessibleEntry(entry, holExtensionContext.holIDE?.imports, document));
                if (entry) {
                    const markdownString = new vscode.MarkdownString();
                    markdownString.appendMarkdown(`**${entry.type}:** ${entry.name}\n\n`);
                    markdownString.appendCodeblock(entry.statement);
                    return new vscode.Hover(markdownString, wordRange);
                }
            }
        }),

        vscode.languages.registerDefinitionProvider(hol4selector, {
            provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) {
                const wordRange = document.getWordRangeAtPosition(position);
                const word = document.getText(wordRange);
                const entry = holExtensionContext.holIDE?.allEntries().find((entry) => entry.name === word && holExtensionContext.holIDE?.isAccessibleEntry(entry, holExtensionContext.holIDE?.imports, document));
                if (entry) {
                    const position = new vscode.Position(entry.line! - 1, 0);
                    return new vscode.Location(vscode.Uri.file(entry.file!), position);
                }
            }
        }),

        vscode.languages.registerDocumentSymbolProvider(hol4selector, {
            provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<HOLSymbolInformation[]> {
                const symbols: HOLSymbolInformation[] = [];
                holExtensionContext.holIDE?.cachedEntries.filter((entry) => entry.file === document.uri.path).forEach((entry) => {
                    const symbol = holExtensionContext.holIDE?.holEntryToSymbol(entry);
                    if (symbol) {
                        symbols.push(symbol);
                    }
                });
                return symbols;
            }
        }),

        vscode.languages.registerWorkspaceSymbolProvider({
            provideWorkspaceSymbols(query: string, token: vscode.CancellationToken): vscode.ProviderResult<HOLSymbolInformation[]> {
                const symbols: HOLSymbolInformation[] = [];
                const matcher = new RegExp(query, 'i');
                holExtensionContext.holIDE?.allEntries().forEach((entry) => {
                    if (matcher.test(entry.name)) {
                        const symbol = holExtensionContext.holIDE?.holEntryToSymbol(entry);
                        if (symbol) {
                            symbols.push(symbol);
                        }
                    }
                });
                return symbols;
            }
        }),

        // HOL IDE commands END

        vscode.languages.registerCompletionItemProvider(hol4selector, {
                async provideCompletionItems(_document, position, _token, context) {
                    let items = [];
                    let range = new vscode.Range(position.translate(0, -1), position);
                    for (const matchKey in completions) {
                        let matchVal = completions[matchKey];
                        let item = new vscode.CompletionItem(context.triggerCharacter + matchKey);
                        item.kind = vscode.CompletionItemKind.Text;
                        item.range = range;
                        item.detail = matchVal;
                        item.insertText = matchVal;
                        items.push(item);
                    }
                    return items;
                }
            },
            ...['\\']
        ),

        vscode.languages.registerCompletionItemProvider(hol4selector, {
            provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[]> {
                const wordRange = document.getWordRangeAtPosition(position);
                if (!wordRange) {
                    return [];
                }
                const word = document.getText(wordRange);
                const completions: vscode.CompletionItem[] = [];
                const matcher = new RegExp(word, 'i');
                holExtensionContext.holIDE?.allEntries().forEach((entry) => {
                    if (matcher.test(entry.name) && holExtensionContext.holIDE?.isAccessibleEntry(entry, holExtensionContext.holIDE?.imports, document)) {
                        const item = holExtensionContext.holIDE?.createCompletionItem(entry, vscode.CompletionItemKind.Function);
                        completions.push(item);
                    }
                });
                return completions;
            }
        })
    ];

    commands.forEach((cmd) => context.subscriptions.push(cmd));

}

// this method is called when your extension is deactivated
export function deactivate() {}
