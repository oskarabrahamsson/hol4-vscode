import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';

/**
 * Fixes linebreaks and backspaces when printing back to terminal stdout.
 */
function fixLineBreak(text: string) {
    return text
        .replace(/\r\n/gi, '\r')
        .replace(/\r/gi, '\n')
        .replace(/\n/gi, '\r\n')
        .replace(/\x7f/gi, '\b \b');
}

/**
 * This class wraps the Pseudoterminal interface with some functionality to
 * toggle terminal echo. We need to toggle echoing of input as text is sent to
 * the HOL process via its `stdin`, and the plugin would become unbearable to
 * use otherwise.
 */
export class HolTerminal implements vscode.Pseudoterminal {

    private cwd: string;
    private holPath: string;
    private child?: child_process.ChildProcess;
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<void>();

    private buffer: string[] = [];

    closing: boolean = false;
    sendRaw(text: string) {
        this.child!.stdin?.write(text);
    }

    constructor(cwd: string, holPath: string) {
        this.cwd = cwd;
        this.holPath = holPath;
    }

    onDidWrite = this.writeEmitter.event;
    onDidClose = this.closeEmitter.event;

    write(s: string) { this.writeEmitter.fire(s) };

    deleteChar() { this.write("\x1b[P") }
    cursorBack() { this.write("\x1b[D") }
    clear() { this.write("\x1b[2J\x1b[3J\x1b[;H") }

    open(_initialDimensions: vscode.TerminalDimensions | undefined) {
        this.child = child_process.spawn(path.join(this.holPath!, 'bin', 'hol'), {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            env: { ...process.env, ...{ 'TERM': 'xterm' } },
            cwd: this.cwd,
            detached: true,
        });
        this.child.stdout?.on('data', (data: Buffer) => {
            this.write(fixLineBreak(data.toString()));
        });
        this.child.stderr?.on('data', (data: Buffer) => {
            this.write(fixLineBreak(data.toString()));
        });
    }

    close() {
        if (this.child?.pid) {
            this.child.kill('SIGTERM');
        }
        this.closeEmitter.fire();
    }

    interrupt() {
        if (this.child?.pid) {
            this.child.kill('SIGINT');
        }
    }

    setDimensions(_dimensions: vscode.TerminalDimensions) { }

    handleInput(data: string) {
        if (this.closing) {
            this.close();
            return;
        }
        console.log(`got ${JSON.stringify(data)} (${data[0].charCodeAt(0)})`)
        switch (data) {
            case '\b': case '\x7f':
                if (this.buffer.pop() !== undefined) {
                    this.deleteChar();
                }
                return;
            case '\r':
                this.child?.stdin?.write(this.buffer.join(''));
                this.child?.stdin?.write('\n');
                this.write('\r\n');
                this.buffer = [];
                break;
            case '\x03':
                // Ctrl-C: send INT to process group.
                this.write('^C');
                this.interrupt();
                break;
            case '\x04':
                // Ctrl-D: end of input
                this.child!.stdin?.destroy();
                this.write('\r\nEnd of input. Press any key to close this window\r\n')
                this.closing = true;
                break;
            case '\u001b[A': case '\u001b[B': case '\u001b[C': case '\u001b[D':
                // arrow keys not supported for now
                break;
            default:
                this.write(fixLineBreak(data));
                this.buffer.push(data[0]);
        }
    };
}
