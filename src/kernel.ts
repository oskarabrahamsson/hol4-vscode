import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import { error, KERNEL_ID } from './common';

class Execution {
    private buffer: string = '';
    private success: boolean = true;
    private writeAnyway: NodeJS.Timeout | undefined;
    constructor(public exec: vscode.NotebookCellExecution) { }
    appendOutput(str: string, err?: boolean) {
        const pos = str.lastIndexOf('\n');
        if (pos >= 0) {
            this.buffer += str.substring(0, pos);
            this.output(err);
            this.buffer = str.substring(pos + 1);
            if (this.buffer) {
                // Avoid sitting on buffered output for too long
                if (this.writeAnyway) {
                    this.writeAnyway.refresh();
                } else {
                    this.writeAnyway = setTimeout(() => {
                        this.output(err);
                        this.buffer = '';
                    }, 300);
                }
            }
        } else {
            if (err) this.markFail();
            this.buffer += str;
        }
    }
    private output(err?: boolean) {
        if (err || this.buffer.includes('error:')) {
            this.markFail();
            this.exec.appendOutput(new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.stderr(this.buffer)
            ]));
        } else {
            this.exec.appendOutput(new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.stdout(this.buffer)
            ]));
        }
    }

    markFail() {
        this.success = false;
    }
    end(success?: boolean) {
        if (this.buffer) this.output();
        clearTimeout(this.writeAnyway);
        this.exec.end(success ?? this.success, Date.now())
    }
}

export type OverflowEvent = { s: string, err: boolean }
export class HolKernel {
    /**
     * The connection to the HOL process itself. May be undefined if the process has not started yet
     * or if it was aborted etc.
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

    /** The list of cells that are waiting for a previous execution to complete. */
    private executionQueue: vscode.NotebookCell[] = [];

    /**
     * The execution order of the cells, used by vscode to show indicators on the cells (although
     * we don't currently support running cells out of order).
     */
    private executionOrder = 0;

    get running(): boolean { return !!this.child; }

    sendRaw(text: string) {
        if (this.child) {
            // console.log(`send ${JSON.stringify(text)}\n${text}`);
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

        this.sync();
        this.currentExecution = new Execution(this.controller.createNotebookCellExecution(cell));
        this.execListener.fire(cell);

        if (this.child) {
            this.currentExecution.exec.token.onCancellationRequested(this.interrupt.bind(this));
            this.currentExecution.exec.executionOrder = this.executionOrder++;
            this.currentExecution.exec.start(Date.now());

            this.sendRaw((cell.metadata.fullContent ?? cell.document.getText()) + '\0');
        } else {
            this.currentExecution.exec.start(Date.now());
            this.currentExecution.exec.appendOutput(new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.stderr('HOL process is not started')
            ]));
            this.currentExecution.markFail();
            this.finish();
        }
    }

    finish() {
        if (this.currentExecution) {
            this.currentExecution.end();
            this.currentExecution = undefined;
            const cell = this.executionQueue.shift();
            if (cell) this.runCell(cell);
        }
    }

    onOverflow = this.overflowListener.event;
    onWillExec = this.execListener.event;

    start(): Promise<void> {
        this.child = child_process.spawn(path.join(this.holPath!, 'bin', 'hol'), ['--zero'], {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            env: { ...process.env, ...{ 'TERM': 'xterm' } },
            cwd: this.cwd,
            detached: true,
        });
        this.executionOrder = 0;
        this.child.addListener('disconnect', this.onKilled.bind(this));
        this.child.addListener('close', this.onKilled.bind(this));
        this.child.addListener('exit', this.onKilled.bind(this));
        return new Promise((resolve, reject) => {
            const buffer: string[] = [];
            const listenerStderr = (data: Buffer) => {
                if (!data.length) return;
                buffer.push(data.toString());
                const s = buffer.join('');
                this.overflowListener.fire({ s, err: true });
                buffer.length = 0;
                reject(s)
            };
            const listenerStdout = (data: Buffer) => {
                if (!data.length) return;
                if (data.readUint8(data.length - 1) === 0) {
                    buffer.push(data.toString(undefined, undefined, data.length - 1));
                    this.child?.stdout?.off('data', listenerStdout);
                    this.child?.stderr?.off('data', listenerStderr);
                    this.finishOpen(buffer.join(''));
                    resolve()
                } else {
                    buffer.push(data.toString());
                }
            }
            this.child?.stdout?.on('data', listenerStdout);
            this.child?.stderr?.on('data', listenerStderr);
        })
    }

    private appendOutput(str: string, err?: boolean) {
        if (this.currentExecution) {
            this.currentExecution.appendOutput(str);
        } else {
            this.overflowListener.fire({ s: str, err: err ?? false });
        }
    }

    private finishOpen(result: string) {
        if (result) this.overflowListener.fire({ s: result, err: result.includes('error:') });
        this.child?.stdout?.on('data', (data: Buffer) => {
            if (!data.length) return;
            if (data.readUint8(data.length - 1) === 0) {
                this.appendOutput(data.toString(undefined, undefined, data.length - 1));
                this.finish();
            } else {
                this.appendOutput(data.toString());
            }
        });
        this.child?.stderr?.on('data', (data: Buffer) => {
            if (!data.length) return;
            this.appendOutput(data.toString(), true);
        });
    }

    stop() {
        if (this.child?.pid) {
            process.kill(-this.child.pid, 'SIGTERM');
        }
        this.onKilled();
    }

    dispose() {
        this.stop();
        this.controller.dispose();
    }

    cancelAll() {
        if (this.currentExecution) {
            this.currentExecution.markFail();
            this.currentExecution.end();
            this.currentExecution = undefined;
        }
        this.executionQueue = [];
    }

    private onKilled() {
        this.cancelAll();
        this.child = undefined;
    }

    interrupt() {
        if (this.child?.pid) {
            process.kill(-this.child.pid, 'SIGINT');
        }
        this.cancelAll();
    }

    sync() {
        if (this.child && (this.child.killed || !this.child.pid || this.child?.exitCode != null)) {
            this.onKilled();
        }
    }
}
