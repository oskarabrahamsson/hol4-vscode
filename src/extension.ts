import * as vscode from 'vscode';
import * as path from 'path';
import { HOLExtensionContext } from './extensionContext';
import { error, holdir } from './common';
import { AbbreviationFeature } from './abbreviations';
import { LspClients } from './lspClient';
import { GoalsView } from './goalsView';


/**
 * Initialize the HOL extension.
 *
 * @returns An extension context if successful, or `undefined` otherwise.
 */
function initialize(context: vscode.ExtensionContext): HOLExtensionContext | undefined {
    let holPath = holdir();
    if (!holPath) {
        holPath = process.env['HOLDIR'];
        if (holPath === undefined) {
            vscode.window.showErrorMessage('HOL4 mode: HOLDIR environment variable not set');
            error('Unable to read HOLDIR environment variable, exiting');
            return;
        }
    } else if (holPath.startsWith('$')) {
        holPath = process.env[holPath.slice(1)] ?? holPath;
    }

    // Cleanup orphaned tabs from previous session
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.label == 'HOL4 Session' &&
                !vscode.workspace.notebookDocuments.some(doc => doc.uri == (tab.input as { uri?: vscode.Uri }).uri)) {
                vscode.window.tabGroups.close(tab);
            }
        }
    }
    return new HOLExtensionContext(context, holPath);
}

let holExtensionContext: HOLExtensionContext | undefined;
let lspClients: LspClients | undefined;
let goalsView: GoalsView | undefined;
export function activate(context: vscode.ExtensionContext) {
    holExtensionContext = initialize(context);
    if (!holExtensionContext) {
        error("Unable to initialize extension.");
        return;
    }

    const lspEnabled = vscode.workspace.getConfiguration('hol4-mode')
        .get<boolean>('lsp.enabled', true);
    if (lspEnabled) {
        lspClients = new LspClients(holExtensionContext.holPath);
        lspClients.start();
        context.subscriptions.push(lspClients);
        goalsView = new GoalsView(lspClients);
        context.subscriptions.push(goalsView);
        // The extension activates on `onLanguage:hol4', so there is a
        // HOL buffer by now and the pane has something to be about.
        // `preserveFocus' is set where the panel is created, so this
        // does not take the cursor out of the editor.
        if (vscode.workspace.getConfiguration('hol4-mode')
                .get<boolean>('lsp.openGoalsOnStartup', true)) {
            goalsView.show();
        }
    }

    let commands = [
        // Start a new HOL4 session.
        // Opens up a terminal and starts HOL4.
        vscode.commands.registerTextEditorCommand('hol4-mode.startSession', (editor) => {
            holExtensionContext?.startSession(editor);
        }),

        // Stop the current session, if any.
        vscode.commands.registerCommand('hol4-mode.stopSession', () => {
            holExtensionContext?.stopSession();
        }),

        // Interrupt the current session, if any.
        vscode.commands.registerCommand('hol4-mode.interrupt', () => {
            holExtensionContext?.interrupt();
        }),

        // Send selection to the terminal; preprocess to find `open` and `load`
        // calls.
        vscode.commands.registerTextEditorCommand('hol4-mode.sendSelection', (editor) => {
            holExtensionContext?.sendSelection(editor);
        }),

        // Send all text up to and including the current line in the current editor
        // to the terminal.
        vscode.commands.registerTextEditorCommand('hol4-mode.sendUntilCursor', (editor) => {
            holExtensionContext?.sendUntilCursor(editor);
        }),

        // Send a goal selection to the terminal.
        vscode.commands.registerTextEditorCommand('hol4-mode.sendGoal', (editor) => {
            holExtensionContext?.sendGoal(editor);
        }),

        // Select a term quotation and set it up as a subgoal.
        vscode.commands.registerTextEditorCommand('hol4-mode.sendSubgoal', (editor) => {
            holExtensionContext?.sendSubgoal(editor);
        }),

        // Send a tactic selection to the terminal.
        vscode.commands.registerTextEditorCommand('hol4-mode.sendTactic', (editor) => {
            holExtensionContext?.sendTactic(editor);
        }),

        // Send a tactic line to the terminal.
        vscode.commands.registerTextEditorCommand('hol4-mode.sendTacticLine', (editor) => {
            holExtensionContext?.sendTacticLine(editor);
        }),

        // Show goal.
        vscode.commands.registerCommand('hol4-mode.proofmanShow', () => {
            holExtensionContext?.showCurrentGoal();
        }),

        // Rotate goal.
        vscode.commands.registerCommand('hol4-mode.proofmanRotate', () => {
            holExtensionContext?.rotateGoal();
        }),

        // Step backwards goal.
        vscode.commands.registerCommand('hol4-mode.proofmanBack', () => {
            holExtensionContext?.stepbackGoal();
        }),

        // Restart goal.
        vscode.commands.registerCommand('hol4-mode.proofmanRestart', () => {
            holExtensionContext?.restartGoal();
        }),

        // Drop goal.
        vscode.commands.registerCommand('hol4-mode.proofmanDrop', () => {
            holExtensionContext?.dropGoal();
        }),

        // Toggle printing of terms with or without types
        vscode.commands.registerCommand('hol4-mode.toggleShowTypes', () => {
            holExtensionContext?.toggleShowTypes();
        }),

        // Toggle printing of theorem assumptions
        vscode.commands.registerCommand('hol4-mode.toggleShowAssums', () => {
            holExtensionContext?.toggleShowAssums();
        }),

        // Run Holmake in current directory
        vscode.commands.registerTextEditorCommand('hol4-mode.holmake', editor => {
            const docPath = path.dirname(editor.document.uri.fsPath);
            const terminal = vscode.window.createTerminal({
                cwd: docPath,
                name: 'Holmake',
                shellPath: 'Holmake',
                message: `Running Holmake in directory: ${docPath} ...`
            });
            terminal.show(true);
        }),

        vscode.commands.registerCommand('hol4-mode.clearAll', async () => {
            await holExtensionContext?.notebook?.clearAll();
        }),

        vscode.commands.registerCommand('hol4-mode.restart', () => {
            (async () => {
                await holExtensionContext?.notebook?.stop();
                await holExtensionContext?.notebook?.start();
            })();
        }),

        vscode.commands.registerCommand('hol4-mode.collapseAllCells', async () => {
            await holExtensionContext?.notebook?.collapseAll();
        }),

        vscode.commands.registerCommand('hol4-mode.expandAllCells', async () => {
            await holExtensionContext?.notebook?.expandAll();
        }),

        vscode.commands.registerCommand('hol4-mode.lsp.toggleGoalsPane', () => {
            goalsView?.toggle();
        }),

        vscode.commands.registerCommand('hol4-mode.lsp.restart', () => {
            lspClients?.restartActive();
        }),

        vscode.commands.registerCommand('hol4-mode.lsp.showOutput', () => {
            lspClients?.showOutput();
        }),

        vscode.commands.registerCommand('hol4-mode.lsp.retryCompile', () => {
            lspClients?.retryCompileActive();
        }),

        vscode.commands.registerCommand(
            'hol4-mode.lsp.gotoOutstandingProof', () => {
                lspClients?.gotoOutstandingProof();
            }),

        vscode.commands.registerCommand('hol4-mode.lsp.search', () => {
            lspClients?.searchTheorems();
        }),

        // No language providers are registered here.  Hover,
        // definition, documentSymbol, workspaceSymbol and completion
        // all come from the language server, which
        // vscode-languageclient wires up from the capabilities it
        // advertises.  Registering our own would be a second answer to
        // the same question.
        new AbbreviationFeature(),
    ];

    commands.forEach((cmd) => context.subscriptions.push(cmd));
}

// this method is called when your extension is deactivated
export function deactivate() {
    holExtensionContext?.stopSession()
}
