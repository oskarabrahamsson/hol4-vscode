import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    State,
} from 'vscode-languageclient/node';
import { error, hitLocation } from './common';

/** Position argument for the `$/hol/goalState` custom request. */
export interface GoalStatePosition {
    line: number;
    character: number;
}

export interface GoalStateParams {
    textDocument: { uri: string };
    position: GoalStatePosition;
    /** Column width to render the goal state at.  Omitted means the
     * server's own default (75). */
    width?: number;
}

export interface Goal {
    asms: string[];
    goal: string;
}

/** One piece of the pretty-printed goal state.  The pieces'
 * `text` concatenates to exactly what `pretty` shows once its colour
 * escapes are removed, so a renderer can walk them instead and keep
 * what the pretty-printer knew: `kind` says whether a symbol is a
 * constant, a free or a bound variable, or a type operator; `name`
 * gives a constant its theory-qualified identity ("listTheory$MAP");
 * `ty` its type.  Absent on the runs of ordinary text, which is most
 * of them. */
export interface GoalSegment {
    text: string;
    kind?: 'const' | 'fv' | 'bv' | 'tyvar' | 'tyop' | 'tysyn';
    name?: string;
    ty?: string;
}

export interface GoalStateResponse {
    theorem?: string;
    step?: number;
    goals?: Goal[];
    /** Server-side pretty-printed rendering with VT100 ANSI colour
     * escapes.  Present since the goalState LSP extension shipped;
     * preferred over `goals` when non-empty. */
    pretty?: string;
    /** `pretty` taken apart, so the pane can show what a symbol *is*.
     * The goals pane is the one place hover cannot help: the text is
     * in no file, so there is nothing to hover over. */
    segments?: GoalSegment[];
    status?: string;
    opaque?: boolean;
    error?: string;
}

/** Payload of `$/compileBlocked`: the server is not compiling this
 * file, because a theory or library its header declares could not be
 * loaded.  `modules` is the declared dependency list whose change
 * lifts the block; `message` says what failed. */
/** One entry of a `$/proofStates` batch: what the pool now thinks of
 * the proof whose declaration starts at `pos`.  `detail` is present
 * only for the three verdicts that need attention. */
export interface ProofState {
    pos: { line: number; character: number };
    name: string;
    status: 'checking' | 'proved' | 'failed' | 'suspended' | 'diverged'
          | 'cheated';
    detail?: string;
}

export interface ProofStatesParams {
    uri: string;
    states: ProofState[];
}

export interface CompileBlockedParams {
    uri: string;
    modules: string[];
    message: string;
}

function resolveHolExecutable(fallbackHoldir: string): string | undefined {
    const cfg = vscode.workspace.getConfiguration('hol4-mode');
    const override = cfg.get<string>('lsp.executable');
    if (override && override.trim() !== '') return override;
    if (fallbackHoldir) return path.join(fallbackHoldir, 'bin', 'hol');
    return undefined;
}

/**
 * Does this document get its own `bin/hol lsp` process?
 *
 * Only theory scripts do.  A `.sig` or a plain `.sml` declares no
 * theory of its own, has no goal states, and would cost a heap and a
 * compile for nothing; the server ignores them for binding purposes
 * too.  `untitled:` documents are excluded because they have no
 * directory, and the server picks its heap from the `Holmakefile` in
 * its working directory.
 */
export function isHolScript(doc: vscode.TextDocument): boolean {
    return doc.uri.scheme === 'file' && doc.uri.fsPath.endsWith('Script.sml');
}

/** `DocumentFilter.pattern` is matched as a glob, so a path holding
 * glob metacharacters could match a *different* file and let that
 * file be adopted into this file's server.  Wrap each metacharacter
 * in a one-element character class, which vscode's glob parser reads
 * as a literal.  `]` needs no escape: with every `[` escaped, no
 * character class is ever opened. */
function globEscape(p: string): string {
    return p.replace(/[*?{[]/g, (c) => `[${c}]`);
}

interface ScriptClient {
    client: LanguageClient;
    output: vscode.OutputChannel;
    /** `onDidChangeState` subscription; lives and dies with the client. */
    state: vscode.Disposable;
    /** Why the server is not compiling this script, or undefined if it
     * is.  Set from `$/compileBlocked` and cleared by the compile that
     * gets through; see `blockedFor`. */
    blocked?: string;
    /** What the proof-checking pool is doing, by theorem name, with
     * the line its declaration starts on -- which is what makes the
     * count actionable: it is how `gotoOutstandingProof` reaches the
     * proof the tally is short of.
     * `$/proofStates` is a transition stream -- the server announces
     * each change and never sends a snapshot -- so this accumulates. */
    proofs?: Map<string, { status: string; line: number }>;
    /** `$/compileBlocked` / `$/compileCompleted` subscriptions. */
    notifications: vscode.Disposable[];
}

function disposeScriptClient(entry: ScriptClient): void {
    entry.state.dispose();
    for (const d of entry.notifications) d.dispose();
    // Each server holds a HOL heap, so a leaked process is hundreds
    // of megabytes, not a rounding error.
    entry.client.stop()
        .catch(() => { /* best-effort */ })
        .then(() => entry.output.dispose());
}

/**
 * One `bin/hol lsp` process per theory script, created lazily when a
 * script first becomes visible and disposed when it is closed.
 *
 * A server can serve exactly one script for its lifetime, and this is
 * not a limitation to be worked around later.  Putting a theory in
 * the graph means loading it, and loading it *seals* it
 * (`Theory.load_complete` calls `Thm.mark_sealed`, which writes to
 * the process-global `KernelSig.sealed_ref` deliberately kept outside
 * the snapshot/restore machinery, as a soundness gate against
 * cross-theory redefinition).  A second script's ancestors can
 * therefore be neither re-read nor withdrawn.  A shared server does
 * not fail loudly: it answers with wrong goal states and dead hovers.
 * See `tools-poly/lsp/README.md`, "One server per buffer", in the HOL
 * repo.
 */
/** One theorem `$/hol/search` found: what it is called, what it says,
 * and where it was proved.  `line` is 1-based, 0 when unrecorded, and
 * `uri` is absent for the same reason. */
interface SearchHit {
    name: string;
    theory: string;
    class: string;
    statement: string;
    uri?: string;
    line: number;
}

export class LspClients implements vscode.Disposable {
    private readonly clients = new Map<string, ScriptClient>();
    private readonly status: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly stateChanged = new vscode.EventEmitter<void>();
    private exe: string | undefined;

    /** Fires when any client starts, stops, or is disposed.  A server
     * takes seconds to load its heap, so consumers that asked too
     * early need a nudge rather than a poll. */
    readonly onDidChangeClientState = this.stateChanged.event;

    constructor(private readonly holdir: string) {
        this.status = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left, 100);
        this.status.command = 'hol4-mode.lsp.showOutput';
    }

    start(): void {
        const exe = resolveHolExecutable(this.holdir);
        if (!exe) {
            error('LSP: no `bin/hol` path resolved from ' +
                'hol4-mode.lsp.executable, hol4-mode.holdir, or $HOLDIR');
            this.showStatus('HOL LSP: no executable', true);
            return;
        }
        if (!fs.existsSync(exe)) {
            error(`LSP: ${exe} does not exist`);
            this.showStatus('HOL LSP: exe missing', true);
            return;
        }
        this.exe = exe;

        this.disposables.push(
            // Visible, not open: a window restoring twenty tabs would
            // otherwise start twenty heaps at once.  A script gets its
            // server the moment it is actually looked at.
            vscode.window.onDidChangeVisibleTextEditors(
                () => this.syncVisibleEditors()),
            vscode.window.onDidChangeActiveTextEditor(
                () => this.refreshStatus()),
            vscode.workspace.onDidCloseTextDocument(
                (doc) => this.closed(doc)),
            // Hover width is the one setting a running server needs to
            // hear about; it takes effect on the next hover, with no
            // restart.
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('hol4-mode.lsp.hoverWidth') ||
                    e.affectsConfiguration('hol4-mode.lsp.checkProofs')) {
                    this.sendConfigAll();
                }
            }));
        this.syncVisibleEditors();
    }

    /** Restart the server for the active editor's script. */
    async restartActive(): Promise<void> {
        const doc = vscode.window.activeTextEditor?.document;
        if (!doc || !isHolScript(doc)) {
            vscode.window.showInformationMessage(
                'HOL LSP: the active editor is not a HOL theory script.');
            return;
        }
        const entry = this.clients.get(doc.uri.toString());
        if (!entry) {
            this.ensure(doc);
            return;
        }
        try {
            await entry.client.stop();
            await entry.client.start();
        } catch (err) {
            error(`LSP failed to restart for ${doc.uri.fsPath}: ${err}`);
        }
        this.refreshStatus();
    }

    /** Show the output channel of the active editor's server, or the
     * only server there is if the active editor has none. */
    showOutput(): void {
        const doc = vscode.window.activeTextEditor?.document;
        const entry = doc ? this.clients.get(doc.uri.toString()) : undefined;
        if (entry) {
            entry.output.show(true);
            return;
        }
        if (this.clients.size === 1) {
            [...this.clients.values()][0].output.show(true);
            return;
        }
        vscode.window.showInformationMessage(this.clients.size === 0
            ? 'HOL LSP: no server is running.'
            : 'HOL LSP: open a theory script to see its server output.');
    }

    /** Why the server is not compiling `doc`, or undefined if it is.
     *
     * The server refuses to compile a script whose declared ancestors
     * or libraries could not be loaded: with one of them missing there
     * is nothing to elaborate the file against, so it reports the load
     * failure on the header entry that named it and waits for that
     * header to change.  Nothing else in the file is compiled, and no
     * goal state exists anywhere in it. */
    blockedFor(doc: vscode.TextDocument): string | undefined {
        return this.clients.get(doc.uri.toString())?.blocked;
    }

    /** Ask the active script's server to compile it again.
     *
     * The server lifts a block by itself when the `Ancestors` / `Libs`
     * header changes.  This is for the other case: the missing
     * ancestor has been built outside the editor and the header is
     * already what it should be. */
    retryCompileActive(): void {
        const doc = vscode.window.activeTextEditor?.document;
        if (!doc || !isHolScript(doc)) {
            vscode.window.showInformationMessage(
                'HOL LSP: the active editor is not a HOL theory script.');
            return;
        }
        const entry = this.clients.get(doc.uri.toString());
        if (!entry || entry.client.state !== State.Running) {
            vscode.window.showInformationMessage(
                'HOL LSP: no server is running for this script.');
            return;
        }
        this.setBlocked(doc.uri.toString(), undefined);
        entry.client.sendNotification('$/hol/retryCompile',
            { textDocument: { uri: doc.uri.toString() } })
            .catch((err) => error(`LSP retryCompile failed: ${err}`));
    }

    /** Send `method` to the server owning `doc`, if it is running. */
    async sendRequest<T>(
        doc: vscode.TextDocument,
        method: string,
        params: unknown
    ): Promise<T | undefined> {
        const entry = this.clients.get(doc.uri.toString());
        if (!entry || entry.client.state !== State.Running) return undefined;
        return entry.client.sendRequest<T>(method, params);
    }

    /** Ask the theorem database what matches, and offer the answers.
     *
     * The counterpart of emacs's `M-h M-m` and of `M-h M` before it: a
     * selector is a theory in single quotes, a fragment of a theorem's
     * name in double quotes, or a term pattern, and several of them
     * narrow rather than widen.  One box rather than a prompt per
     * selector, which the server splits -- a quoted run is one
     * selector and everything left over is one pattern -- so that the
     * same thing typed here and in emacs asks the same question.
     *
     * A quick pick rather than a panel: it filters as you type, which
     * is what you want having asked for fifty theorems, and picking
     * one goes to where it was proved.  A statement is shown as its
     * detail, newlines flattened, the widget being one line per item. */
    async searchTheorems(): Promise<void> {
        const doc = vscode.window.activeTextEditor?.document;
        if (!doc || !isHolScript(doc)) {
            vscode.window.showInformationMessage(
                'HOL: open a HOL script to search from.');
            return;
        }
        const query = await vscode.window.showInputBox({
            title: 'HOL: search for theorems',
            prompt: "'theory'   \"name fragment\"   term pattern " +
                    '\u2014 combine to narrow',
            placeHolder: '"ASSOC" \'arithmetic\'',
        });
        if (!query) return;
        let hits: SearchHit[] | undefined;
        try {
            hits = await this.sendRequest<SearchHit[]>(
                doc, '$/hol/search', { query, limit: 200 });
        } catch (err) {
            vscode.window.showErrorMessage(`HOL: search failed: ${err}`);
            return;
        }
        if (!hits || hits.length === 0) {
            vscode.window.showInformationMessage(
                `HOL: nothing matches ${query}`);
            return;
        }
        const items = hits.map((h) => {
            // The location is shown, not merely used on selection:
            // which script a theorem comes from is half of what the
            // reader is deciding between.
            const where = hitLocation(h.uri, h.line);
            return {
                label: `${h.theory}$${h.name}`,
                description: where ? `${h.class}  ${where}` : h.class,
                detail: (h.statement ?? '').replace(/\s+/g, ' ').trim(),
                hit: h,
            };
        });
        const chosen = await vscode.window.showQuickPick(items, {
            title: `${hits.length} theorem${hits.length === 1 ? '' : 's'}` +
                   ` for ${query}`,
            matchOnDetail: true,
        });
        if (!chosen) return;
        const { uri, line } = chosen.hit;
        if (!uri) {
            vscode.window.showInformationMessage(
                `HOL: no source location recorded for ${chosen.label}`);
            return;
        }
        const target = await vscode.workspace.openTextDocument(
            vscode.Uri.parse(uri));
        const editor = await vscode.window.showTextDocument(target);
        // `line` is 1-based, and 0 when the location was not recorded.
        const at = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
        editor.selection = new vscode.Selection(at, at);
        editor.revealRange(new vscode.Range(at, at),
                           vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.disposables.length = 0;
        for (const entry of this.clients.values()) disposeScriptClient(entry);
        this.clients.clear();
        this.stateChanged.dispose();
        this.status.dispose();
    }

    private syncVisibleEditors(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            this.ensure(editor.document);
        }
        this.refreshStatus();
    }

    /** Start a client for `doc` if this is its first sighting. */
    private ensure(doc: vscode.TextDocument): void {
        if (!this.exe || !isHolScript(doc)) return;
        const key = doc.uri.toString();
        if (this.clients.has(key)) return;
        const entry = this.create(this.exe, doc);
        // Registered before `start` is kicked off, so a burst of
        // visibility events cannot start two servers for one file.
        this.clients.set(key, entry);
        entry.client.start().then(() => this.sendConfig(entry)).catch((err) => {
            error(`LSP failed to start for ${doc.uri.fsPath}: ${err}`);
            this.refreshStatus();
        });
    }

    private create(exe: string, doc: vscode.TextDocument): ScriptClient {
        const fsPath = doc.uri.fsPath;
        const rel = vscode.workspace.asRelativePath(doc.uri);
        const output = vscode.window.createOutputChannel(`HOL4 LSP: ${rel}`);

        // No `transport:` field: the client defaults to stdio without
        // appending the `--stdio` flag that `bin/hol lsp` rejects.
        const serverOptions: ServerOptions = {
            command: exe,
            args: ['lsp'],
            // `get_heap_name` in tools-poly/hol.ML reads the
            // `Holmakefile` in the server's working directory, and
            // Holmakefiles do not govern subdirectories.  Inheriting
            // VS Code's cwd boots the wrong heap for any script in a
            // directory with its own HOLHEAP.
            options: { cwd: path.dirname(fsPath) },
        };

        const clientOptions: LanguageClientOptions = {
            // Pinned to this one path.  Selecting by language would
            // let the client's `register` sweep over
            // `workspace.textDocuments` adopt every other open SML
            // document into this process, which is exactly the
            // sharing that yields wrong goal states.
            documentSelector: [{ scheme: 'file', pattern: globEscape(fsPath) }],
            // Sharing the name keeps the Problems panel reading
            // "hol4-lsp" for every file; the collections themselves
            // stay one per client, each owning its own URI.
            diagnosticCollectionName: 'hol4-lsp',
            outputChannel: output,
            // No `synchronize.fileEvents`: the server has no
            // `workspace/didChangeWatchedFiles` handler and logs the
            // notification as unknown, and one workspace-wide watcher
            // per open script would be pure overhead.
        };

        const client = new LanguageClient(
            `hol4-lsp:${fsPath}`, `HOL4 LSP: ${rel}`,
            serverOptions, clientOptions);
        const state = client.onDidChangeState(() => {
            this.refreshStatus();
            this.stateChanged.fire();
        });
        // Registered before `start`, which the client allows: handlers
        // added early are held and attached to the connection when it
        // comes up.  A `$/compileBlocked` can arrive on the very first
        // didOpen, so a handler installed afterwards would miss it.
        const key = doc.uri.toString();
        const notifications = [
            client.onNotification('$/compileBlocked',
                (params: CompileBlockedParams) =>
                    this.setBlocked(key, params.message)),
            // The file compiled, so whatever it was blocked on is
            // resolved.
            client.onNotification('$/compileCompleted',
                () => { this.setBlocked(key, undefined);
                        this.pruneStaleProofs(key); }),
            client.onNotification('$/proofStates',
                (params: ProofStatesParams) =>
                    this.noteProofStates(key, params)),
        ];
        return { client, output, state, notifications };
    }

    /** Tell one server the settings it cannot work out for itself.
     *
     * The width has to come from us: a hover is markdown in a box, and
     * a theorem broken to some other width breaks in the wrong places.
     * VS Code does not expose the box's width, so this is the
     * `hoverWidth` setting rather than a measurement -- lower it if
     * statements come out wider than the box. */
    private sendConfig(entry: ScriptClient): void {
        if (entry.client.state !== State.Running) return;
        const cfg = vscode.workspace.getConfiguration('hol4-mode');
        entry.client.sendRequest('$/setConfig', {
            hoverWidth: cfg.get<number>('lsp.hoverWidth', 50),
            // The server leaves proof checking off unless told; sent on
            // every connection and again whenever the setting changes,
            // so turning it on or off needs no restart.
            checkProofs: cfg.get<boolean>('lsp.checkProofs', true),
        }).catch((err) => error(`LSP $/setConfig failed: ${err}`));
    }

    /** Re-send the configuration to every running server. */
    private sendConfigAll(): void {
        for (const entry of this.clients.values()) this.sendConfig(entry);
    }

    /** Fold one `$/proofStates` batch into `key`'s tally.
     *
     * Keyed by name alone.  The name is the only identity that
     * survives re-elaboration: an edit anywhere above a proof moves
     * it, so the same proof is announced at one position and then
     * another, and keying by position counted it twice -- adding a
     * line at the top of a 61-theorem file gave 122 entries, and the
     * tally climbed with every edit.  The exception is a rebound name,
     * two `Theorem foo`, which share one entry and so one slot in the
     * tally; nothing distinguishes them that an edit does not also
     * move.
     *
     * A proof with no name is not tracked at all.  Those are the
     * definition principle justifying itself -- pattern coverage,
     * automatic termination -- and appear nowhere in the script, so
     * counting them reported 65 proofs for a file with 61 theorems.
     *
     * `cheated` is kept, not dropped.  It means the pool has let go of
     * that entry -- an edit reached the proof -- and the compile that
     * follows re-enqueues it.  Dropping it made the tally *shrink*, so
     * "62 proofs checked" became "61 proofs checked", which reads as
     * finished rather than as one outstanding.  See
     * `pruneStaleProofs`.
     *
     * The line is data, not identity, and is refreshed by every
     * announcement -- the server re-announces a proof an edit moved
     * for that reason. */
    private noteProofStates(key: string, params: ProofStatesParams): void {
        const entry = this.clients.get(key);
        if (!entry || !params || !Array.isArray(params.states)) return;
        const tally = entry.proofs ??
            new Map<string, { status: string; line: number }>();
        for (const st of params.states) {
            if (!st || typeof st.name !== 'string' || st.name === '') continue;
            tally.set(st.name, { status: st.status, line: st.pos?.line ?? 0 });
        }
        entry.proofs = tally;
        this.refreshStatus();
    }

    /** Drop entries for proofs that are no longer in the document.
     *
     * A proof still `cheated` when a compile finishes was not
     * re-enqueued by that pass, which happens both when its theorem
     * has been deleted and when the server did not get round to it.
     * Those look identical from here, and dropping them silently is
     * the worse mistake: it counted an unchecked proof as if it had
     * been checked.  So only entries past the end of the file go. */
    private pruneStaleProofs(key: string): void {
        const entry = this.clients.get(key);
        if (!entry?.proofs) return;
        const doc = vscode.workspace.textDocuments.find(
            (d) => d.uri.toString() === key);
        if (!doc) return;
        let dropped = false;
        for (const [k, { line }] of [...entry.proofs]) {
            if (line >= doc.lineCount) {
                entry.proofs.delete(k);
                dropped = true;
            }
        }
        if (dropped) this.refreshStatus();
    }

    /** A tally of what the pool is doing, or '' when it has nothing to
     * say -- so a session with checking off shows no proof text.
     *
     * A count, not a progress bar: the states regress.  A proof that
     * suspends makes the server re-elaborate and drops the entries
     * below it, so a bar would run backwards, while a count falling
     * from 30 to 12 reads as what it is. */
    private proofSummary(entry: ScriptClient): string {
        if (!entry.proofs || entry.proofs.size === 0) return '';
        let checking = 0, unchecked = 0, proved = 0, bad = 0;
        for (const { status } of entry.proofs.values()) {
            if (status === 'checking') checking++;
            // `cheated` means the pool is not working on this one:
            // usually because an edit reached it and the next pass will
            // pick it up, but it stays that way if the pass never does.
            // Either way it has *not* been checked, and saying so is
            // the whole point of the count.
            else if (status === 'cheated') unchecked++;
            else if (status === 'proved') proved++;
            else bad++;
        }
        const total = checking + unchecked + proved + bad;
        const notes: string[] = [];
        if (bad > 0) notes.push(`${bad} to look at`);
        if (unchecked > 0) notes.push(`${unchecked} not checked`);
        const tail = notes.length > 0 ? ` (${notes.join(', ')})` : '';
        if (checking > 0 || unchecked > 0 || bad > 0) {
            return ` — proofs ${proved}/${total}${tail}`;
        }
        return ` — ${proved} proofs checked`;
    }

    /** The proofs the pool has not settled for the active editor, in
     * file order.  `proved` is left out: it needs nothing.  `checking`
     * and `cheated` are outstanding, and the three bad verdicts are
     * included because those are what a user most wants to reach. */
    outstandingProofs(): { name: string; status: string; line: number }[] {
        const doc = vscode.window.activeTextEditor?.document;
        const entry = doc && this.clients.get(doc.uri.toString());
        if (!entry?.proofs) return [];
        return [...entry.proofs]
            .filter(([, v]) => v.status !== 'proved')
            .map(([name, v]) => ({
                name,
                status: v.status === 'cheated' ? 'not checked' : v.status,
                line: v.line,
            }))
            .sort((a, b) => a.line - b.line);
    }

    /** Reveal the next unsettled proof after the cursor, cycling. */
    gotoOutstandingProof(): void {
        const editor = vscode.window.activeTextEditor;
        const out = this.outstandingProofs();
        if (!editor || out.length === 0) {
            vscode.window.showInformationMessage(
                'HOL: no outstanding proofs.');
            return;
        }
        const here = editor.selection.active.line;
        const next = out.find((p) => p.line > here) ?? out[0];
        const pos = new vscode.Position(next.line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos),
                           vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        vscode.window.setStatusBarMessage(
            `HOL: ${next.name} is ${next.status} (${out.length} outstanding)`,
            4000);
    }

    /** Record (or clear) why `key`'s script is not being compiled, and
     * nudge consumers -- the goals pane reads this to say what is
     * wrong instead of asking for a goal state that cannot exist. */
    private setBlocked(key: string, message: string | undefined): void {
        const entry = this.clients.get(key);
        if (!entry || entry.blocked === message) return;
        entry.blocked = message;
        this.refreshStatus();
        this.stateChanged.fire();
    }

    private closed(doc: vscode.TextDocument): void {
        const key = doc.uri.toString();
        const entry = this.clients.get(key);
        if (!entry) return;
        this.clients.delete(key);
        disposeScriptClient(entry);
        this.refreshStatus();
        this.stateChanged.fire();
    }

    /** The status bar reports the active editor's server: with N of
     * them, that is the only one the user is looking at. */
    private refreshStatus(): void {
        const doc = vscode.window.activeTextEditor?.document;
        if (!doc || !isHolScript(doc)) {
            this.status.hide();
            return;
        }
        if (!this.exe) {
            this.showStatus('HOL LSP: no executable', true);
            return;
        }
        const entry = this.clients.get(doc.uri.toString());
        if (!entry) {
            this.showStatus('HOL LSP: not started', true);
            return;
        }
        switch (entry.client.state) {
            case State.Running:
                // A running server that is not compiling this file is
                // the one state the user cannot infer from the editor:
                // there is one diagnostic and then nothing happens.
                if (entry.blocked) {
                    this.showStatus('HOL LSP: not compiling', true);
                    break;
                }
                // Proofs settle after the compile, so the tally keeps
                // moving while the editor is otherwise idle.
                this.showStatus('HOL LSP' + this.proofSummary(entry), false);
                break;
            case State.Starting:
                this.showStatus('HOL LSP: starting…', false);
                break;
            default:
                this.showStatus('HOL LSP: stopped', true);
                break;
        }
    }

    private showStatus(text: string, warn: boolean): void {
        this.status.text = warn ? `$(warning) ${text}` : `$(check) ${text}`;
        const out = this.outstandingProofs();
        if (out.length > 0) {
            // A count the user cannot act on is only half a message,
            // so name them and make the item jump to one.
            this.status.tooltip =
                'Outstanding proofs: ' +
                out.map((p) => `${p.name} (${p.status})`).join(', ') +
                '\nClick to go to the next one';
            this.status.command = 'hol4-mode.lsp.gotoOutstandingProof';
        } else {
            this.status.tooltip =
                'HOL4 LSP for the active script; click for its output channel';
            this.status.command = 'hol4-mode.lsp.showOutput';
        }
        this.status.show();
    }
}
