import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import { error, KERNEL_ID, log } from './common';

class Execution {
    private success: boolean = true;
    constructor(public exec?: vscode.NotebookCellExecution) { }
    markFail() {
        this.success = false;
    }
    end(date: number, success?: boolean) { this.exec?.end(success ?? this.success, date) }
}

export type OverflowEvent = { s: string, err: boolean, date: number }
export class HolKernel {
    /**
     * The connection to the HOL process itself. May be undefined if the process has not started yet
     * or if it was aborted etc., although the lifecycle of the {@link HolKernel} itself is intended
     * to track the child process. A {@link HolKernel} should not be used for two executions of HOL.
     */
    private child?: child_process.ChildProcess;

    /**
     * The underlying {@link vscode.NotebookController} for interfacing with vscode execution
     * requests.
     */
    public controller: vscode.NotebookController;

    /**
     * If a request has started, then this is not `undefined`. The {@link Execution.exec} is
     * undefined only for the "initial execution" representing the splash printing task before any
     * request is sent.
     */
    private currentExecution?: Execution;

    /** Fires when a queued cell is about to be executed. */
    private execListener = new vscode.EventEmitter<vscode.NotebookCell>();

    /** Fires when HOL says something outside the expected request/response flow. */
    private overflowListener = new vscode.EventEmitter<OverflowEvent>();

    /** True if we haven't seen any nontrivial prints, for removing a prefix of prompts. */
    private outputStart = false;

    /** The list of cells that are waiting for a previous execution to complete. */
    private executionQueue: vscode.NotebookCell[] = [];

    /**
     * After a cell outputs something that looks like a prompt, we wait a bit in case HOL has more
     * to say. This is defined when we have seen a prompt recently.
     */
    private looksLikeTheEnd?: NodeJS.Timer;

    /**
     * The execution order of the cells, used by vscode to show indicators on the cells (although
     * we don't currently support running cells out of order).
     */
    private executionOrder = 0;

    sendRaw(text: string) {
        if (this.child) {
            this.child?.stdin?.write(text);
        } else {
            error(`HOL session is not started`);
        }
    }

    constructor(
        private cwd: string, private holPath: string,
    ) {
        this.controller = vscode.notebooks.createNotebookController(
            KERNEL_ID, 'interactive', 'HOL4', cells => cells.forEach(this.runCell.bind(this)));
        this.controller.interruptHandler = this.interrupt.bind(this);
        this.controller.supportsExecutionOrder = true;
        this.controller.supportedLanguages = ['hol4'];
    }

    runCell(cell: vscode.NotebookCell) {
        if (this.currentExecution) {
            this.executionQueue.push(cell);
            return;
        }
        this.currentExecution = new Execution(this.controller.createNotebookCellExecution(cell));
        this.execListener.fire(cell);

        if (this.child) {
            this.currentExecution.exec!.token.onCancellationRequested(this.interrupt.bind(this));
            this.currentExecution.exec!.executionOrder = this.executionOrder++;
            this.currentExecution.exec!.start(Date.now());

            this.sendRaw((cell.metadata.fullContent ?? cell.document.getText()) + ';;\n');
            this.outputStart = true;
        } else {
            const now = Date.now();
            this.currentExecution.exec!.start(now);
            this.currentExecution.exec!.appendOutput(new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.stderr('HOL process is not started')
            ]));
            this.currentExecution.markFail();
            this.finish(now);
        }
    }

    finish(date: number) {
        if (this.currentExecution) {
            this.currentExecution?.end(date);
            this.currentExecution = undefined;
        } else {
            this.overflowListener.fire({ s: "", err: false, date });
        }
        const cell = this.executionQueue.shift();
        if (cell) this.runCell(cell);
    }

    private finishOutput(date: number) {
        // if (this.initializing) {
        //     this.initializing.dispose();
        //     this.initializing = undefined;
        // }
        this.finish(date);
    }

    onOverflow = this.overflowListener.event;
    onWillExec = this.execListener.event;

    open() {
        this.child = child_process.spawn(path.join(this.holPath!, 'bin', 'hol'), {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            env: { ...process.env, ...{ 'TERM': 'xterm' } },
            cwd: this.cwd,
            detached: true,
        });
        this.executionOrder = 0;
        this.currentExecution = new Execution;
        this.child.stdout?.on('data', (data: Buffer) => {
            let date = Date.now();
            if (this.looksLikeTheEnd) {
                clearTimeout(this.looksLikeTheEnd);
                this.looksLikeTheEnd = undefined;
            }
            let str = data.toString();
            const maybeDone = str.endsWith('> ');
            if (maybeDone) {
                str = str.substring(0, str.length - 2);
                this.looksLikeTheEnd = setTimeout(() => this.finishOutput(date), 100);
            }
            if (this.outputStart) {
                let i = 0;
                while (str.startsWith('> ', i) || str.startsWith('# ', i)) i += 2;
                str = str.substring(i);
                if (str) this.outputStart = false;
            }
            if (str) {
                if (this.currentExecution?.exec) {
                    if (str.includes('error:')) this.currentExecution.markFail();
                    this.currentExecution.exec.appendOutput(new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.stdout(str)
                    ]));
                } else {
                    this.overflowListener?.fire({ s: str, err: false, date });
                }
            }
        });
        this.child.stderr?.on('data', (data: Buffer) => {
            let date = Date.now();
            const str = data.toString();
            if (str) {
                if (this.currentExecution?.exec) {
                    this.currentExecution.exec.appendOutput(new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.stderr(str)
                    ]));
                    this.currentExecution.markFail()
                } else {
                    this.overflowListener?.fire({ s: str, err: true, date })
                }
            }
        });
        this.child.addListener('disconnect', this.cancelAll.bind(this));
        this.child.addListener('close', this.cancelAll.bind(this));
        this.child.addListener('exit', this.cancelAll.bind(this));
    }

    close() {
        if (this.child?.pid) {
            process.kill(-this.child.pid, 'SIGTERM');
        }
    }

    dispose() {
        this.close();
        this.controller.dispose();
    }

    cancelAll() {
        if (this.currentExecution) {
            this.currentExecution.markFail()
            this.currentExecution.end(Date.now());
            this.currentExecution = undefined;
        }
        this.executionQueue = [];
    }

    interrupt() {
        if (this.child?.pid) {
            process.kill(-this.child.pid, 'SIGINT');
        }
        this.cancelAll();
    }
}
