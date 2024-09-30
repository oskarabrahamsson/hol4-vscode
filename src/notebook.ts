import * as vscode from 'vscode';
import { HolKernel, OverflowEvent } from './kernel';
import { error } from './common';

function getRanges<T>(arr: T[], f: (t: T) => boolean): { start: number, end: number }[] {
    let ranges: { start: number, end: number }[] = [];
    let range = { start: 0, end: 0 };
    arr.forEach((t, index) => {
        if (f(t)) {
            if (range.end == index) {
                range.end++;
            } else {
                if (range.start < range.end) ranges.push(range);
                range = { start: index, end: index + 1 };
            }
        }
    });
    if (range.start < range.end) ranges.push(range);
    return ranges;
}

export class HolNotebook {
    /**
     * If true, we will show the actual text we are sending to HOL instead of the cleaned up
     * version.
     */
    private readonly rawMessages: boolean =
        vscode.workspace.getConfiguration('hol4-mode').get<boolean>('rawMessages', false);

    /** The insertion point for overflow events, generally just after the last executing cell. */
    public outputCell: number = 0;

    /** The kernel connection. */
    public kernel: HolKernel;

    private overflowPromise: Promise<void>;

    constructor(
        private readonly cwd: string,
        private readonly holPath: string,
        private readonly editor: vscode.NotebookEditor,
    ) {
        this.kernel = new HolKernel(this.cwd, this.holPath);
        this.kernel.controller.updateNotebookAffinity(
            this.editor.notebook, vscode.NotebookControllerAffinity.Preferred);
        this.kernel.onWillExec(cell => this.outputCell = cell.index + 1);
        this.overflowPromise = Promise.resolve();
        this.kernel.onOverflow((e) => {
            this.overflowPromise = this.overflowPromise.then(() => this.handleOverflow(e));
            return this.overflowPromise
        });
    }

    private async handleOverflow({ s, err }: OverflowEvent) {
        if (!s) return;
        const edit = new vscode.WorkspaceEdit();
        // Creating a new cell is so ugly, but the below code does not really work :(
        //-----------
        // let hasCode: vscode.NotebookCell | undefined;
        // let hasMarkupCode: vscode.TextDocument | undefined;
        // if (this.outputCell !== undefined) {
        //     const cell = this.editor.notebook.cellAt(this.outputCell);
        //     if (cell.kind == vscode.NotebookCellKind.Code) {
        //         hasCode = cell;
        //     } else if (cell.kind == vscode.NotebookCellKind.Markup && cell.metadata.code) {
        //         hasMarkupCode = cell.document;
        //     }
        // }
        // if (hasMarkupCode) {
        //     edit.set(hasMarkupCode.uri, [
        //         vscode.TextEdit.insert(new vscode.Position(hasMarkupCode.lineCount, 0), s)
        //     ]);
        //     await vscode.workspace.applyEdit(edit);
        // } else if (hasCode) {
        //     const index = this.outputCell;
        //     const item: vscode.NotebookCellOutputItem = err ?
        //         vscode.NotebookCellOutputItem.stderr(s) :
        //         vscode.NotebookCellOutputItem.stdout(s);
        //     let executionSummary: vscode.NotebookCellExecutionSummary | undefined;
        //     if (hasCode.executionSummary) {
        //         const timing = hasCode.executionSummary.timing
        //             ? { startTime: hasCode.executionSummary.timing.startTime, endTime: date }
        //             : undefined;
        //         executionSummary = {
        //             executionOrder: hasCode.executionSummary.executionOrder,
        //             success: hasCode.executionSummary.success,
        //             timing
        //         }
        //     }
        //     const outputs = [...hasCode.outputs, new vscode.NotebookCellOutput([item])];
        //     const data: vscode.NotebookCellData = {
        //         kind: vscode.NotebookCellKind.Code,
        //         value: hasCode.document.getText(),
        //         languageId: hasCode.document.languageId,
        //         outputs,
        //         metadata: hasCode.metadata,
        //         executionSummary,
        //     };
        //     edit.set(this.editor.notebook.uri, [
        //         vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(index, index + 1), [data])
        //     ]);
        //     this.outputCell = index;
        // } else {
        const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, s, 'hol4');
        data.metadata = { code: true };
        edit.set(this.editor.notebook.uri, [
            vscode.NotebookEdit.insertCells(this.outputCell, [data])
        ]);
        this.outputCell++;
        await vscode.workspace.applyEdit(edit);
    }

    async start() {
        await this.kernel.start();
        await this.overflowPromise;
    }

    async stop() {
        this.kernel.stop();
    }

    async send(s: string, collapsed?: boolean, fullContent?: string) {
        if (!this.kernel.running) {
            error('no active session');
            return;
        }
        if (this.rawMessages && fullContent !== undefined) s = fullContent;
        const edit = new vscode.WorkspaceEdit();
        const index = this.editor.notebook.cellCount;
        const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, s, 'hol4');
        if (fullContent !== undefined) data.metadata = { fullContent }
        edit.set(this.editor.notebook.uri, [vscode.NotebookEdit.insertCells(index, [data])]);
        await vscode.workspace.applyEdit(edit);
        if (collapsed) {
            await vscode.commands.executeCommand('notebook.cell.collapseCellInput', {
                ranges: [{ start: index, end: index + 1 }],
                document: this.editor.notebook.uri
            });
        }
        vscode.commands.executeCommand('notebook.cell.execute', {
            ranges: [{ start: index, end: index + 1 }],
            document: this.editor.notebook.uri
        });
    }

    dispose() {
        this.kernel.dispose();
    }

    close() {
        this.kernel.stop();
        // FIXME: close the tab
    }

    show() {
        // FIXME: focus the tab
    }

    sync(): boolean {
        this.kernel.sync();
        if (this.editor.notebook.isClosed) {
            this.dispose();
            return false;
        }
        return true;
    }

    async clearAll() {
        const workspaceEdit = new vscode.WorkspaceEdit();
        const length = this.editor.notebook.cellCount;
        const edit = vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(0, length));
        workspaceEdit.set(this.editor.notebook.uri, [edit]);
        await vscode.workspace.applyEdit(workspaceEdit);
    }

    async collapseAll() {
        const ranges = getRanges(this.editor.notebook.getCells(), cell => cell.kind === vscode.NotebookCellKind.Code);
        if (ranges) {
            await vscode.commands.executeCommand('notebook.cell.collapseCellInput', {
                ranges, document: this.editor.notebook.uri
            });
        }
    }

    async expandAll() {
        const ranges = getRanges(this.editor.notebook.getCells(), cell => cell.kind === vscode.NotebookCellKind.Code);
        if (ranges) {
            await vscode.commands.executeCommand('notebook.cell.expandCellInput', {
                ranges, document: this.editor.notebook.uri
            });
        }
    }
}
