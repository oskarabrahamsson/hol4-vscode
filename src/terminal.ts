import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';

/**
 * This class wraps the Pseudoterminal interface with some functionality to
 * toggle terminal echo. We need to toggle echoing of input as text is sent to
 * the HOL process via its `stdin`, and the plugin would become unbearable to
 * use otherwise.
 */
export class HolTerminal implements vscode.Pseudoterminal {

    private cwd: string;
    private holPath: string;
    private child: child_process.ChildProcess | undefined;
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<void>();

    private buffer: string[] = [];

    // Fixes linebreaks and backspaces when printing back to terminal stdout.
    private fixLineBreak(text: string) {
        return text
            .replace(/\r\n/gi,'\r')
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

    constructor(cwd: string, holPath: string) {
        this.cwd = cwd;
        this.holPath = holPath;
    }

    onDidWrite = this.writeEmitter.event;
    onDidClose = this.closeEmitter.event;

    open(_initialDimensions: vscode.TerminalDimensions | undefined) {
        this.child = child_process.spawn(path.join(this.holPath!, 'bin', 'hol'), {
            env: {...process.env, ...{'TERM': 'xterm'}},
            cwd: this.cwd,
            detached: true,
        });
        this.child.stdout?.on('data', (data: Buffer) => {
            this.writeEmitter.fire(this.fixLineBreak(data.toString()));
        });
        this.child.stderr?.on('data', (data: Buffer) => {
            console.log(data);
            this.writeEmitter.fire(this.fixLineBreak(data.toString()));
        });
    }

    close() {
        if (this.child?.pid) {
            process.kill(-this.child.pid, 'SIGTERM');
        }
    }

    interrupt() {
        if (this.child?.pid) {
            process.kill(-this.child.pid, 'SIGINT');
        }
    }

    setDimensions(_dimensions: vscode.TerminalDimensions) {}

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
            } else if (data[0].charCodeAt(0) === 3) {
                // Ctrl-C: send INT to process group.
                this.interrupt();
            } else {
                this.buffer.push(data[0]);
            }
            return;
        }

        this.child!.stdin?.write(data);
    };
}