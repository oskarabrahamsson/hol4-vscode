import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { log, error } from './common';

/**
 * Path to where symbol databases are stored in each directory.
 */
const databaseDir = ".hol-vscode";

/**
 * Default locations to search for workspace-external dependencies in. Lines
 * that start with a dollar sign ($) are treated as environment variables.
 */
const externalDirs = [
    '$HOLDIR',
];

/**
 * The kind of entry indexed by the entry database:
 * - Theorem: Regular theorems
 * - Definition: Recursive function definitions
 * - Inductive: Inductive relation definitions
 */

/**
 * Theorem structure for go-to-definition and hover info.
 */
interface HOLEntry {
    name: string;
    statement: string;
    file: string;
    line: number;
    type: "Theorem" | "Definition" | "Inductive";
};

/**
 * Convert a {@link HOLEntry} into a {@link vscode.SymbolInformation}.
 *
 * @returns A {@link vscode.SymbolInformation}.
 */
export function entryToSymbol(entry: HOLEntry): vscode.SymbolInformation {
    return {
        name: entry.name,
        kind: vscode.SymbolKind.Function,
        location: new vscode.Location(
            vscode.Uri.file(entry.file),
            new vscode.Position(entry.line - 1, 0)),
        containerName: "",
    };
};

/**
 * Convert a {@link HOLEntry} into a {@link vscode.CompletionItem}.
 *
 * @returns A {@link vscode.CompletionItemKind}.
 */
export function entryToCompletionItem(entry: HOLEntry): vscode.CompletionItem {
    const item = new vscode.CompletionItem(
        entry.name,
        vscode.CompletionItemKind.Function,
    );
    item.commitCharacters = [" "];
    item.documentation = `${entry.type}: ${entry.name}\n${entry.statement}`;
    return item;
}

/**
 * This class is responsible for maintaining an index of all HOL symbols
 * (theorems, function definitions, rule definitions) in the current workspace,
 * and optionally, for all its dependencies.
 *
 * On construction, it first tries to consult an existing database in the
 * directory {@link databaseDir} in the workspace root. If it does not find this
 * database, it attempts to create it.
 *
 * By default, the database consults the list {@link externalDirs}
 * when indexing dependencies outside of the current workspace. Optionally,
 * the user may create a file called `dependencies.json` in the
 * {@link databaseDir} directory, which lists all dependency directories:
 * ```json
 * [
 *     "foo/bar/baz",
 *     "bar/baz/quux"
 * ]
 * ```
 * When possible, the database will attempt to index these locations as well
 * (as if they were part of the workspace).
 *
 */
export class HOLIDE {

    /**
     * This variable holds the list of imports in the currently active document.
     */
    public imports: string[] = [];

    /**
     * Database of workspace-local {@link HOLEntry} entries.
     */
    private workspaceIndex: HOLEntry[];

    /**
     * Database of workspace-external {@link HOLEntry} entries.
     */
    private externalIndex: HOLEntry[] = [];

    constructor() {
        // Get the path to the current workspace root. This class is constructed
        // by the extension, which is activated by opening a HOL4 document. By
        // this time there should be a workspace.
        const workspacePath = vscode.workspace.workspaceFolders![0].uri.fsPath;

        // Read the entry-index in the workspace database.
        //
        // The first time a user opens a new workspace there generally won't be
        // an existing database. If this is the case, query the user about
        // refreshing the database, and then resume as if the index was empty.
        let index = readDatabase(workspacePath);
        this.workspaceIndex = index ? index : [];

        if (!index) {
            vscode.window.showInformationMessage(
                'HOL: Unable to find workspace index. Refreshing it now.',
            );
            this.refreshIndex();
        }

        // Attempt to read the entry-indices for each listed dependency, and
        // add those entries to `this.externalIndex`. Those paths for which
        // we can't find any entries are added to `unindexed`.
        const unindexed: string[] = [];
        readDependencies(workspacePath).forEach((depPath) => {
            const entries = readDatabase(depPath);
            if (entries) {
                entries.forEach((entry) => {
                    this.externalIndex.push(entry);
                });
            } else {
                log(`Unable to index ${depPath}`);
                unindexed.push(depPath);
            }
        });

        // Create indexes for workspace dependencies.
        if (unindexed.length > 0) {
            vscode.window.showInformationMessage(
                `HOL: Indexing ${unindexed.length} external directories`
            );
            this.updateDependencyIndex(unindexed);
        }

        vscode.window.showInformationMessage(
            `HOL: Indexed ${this.workspaceIndex.length} workspace entries`
        );
        vscode.window.showInformationMessage(
            `HOL: Indexed ${this.externalIndex.length} dependencies entries`
        );

        // Collect all `open` declarations in the current document.
        let editor;
        if ((editor = vscode.window.activeTextEditor)) {
            this.imports = getImports(editor.document);
        }
    }

    /**
     * Refresh the index entries for the provided document.
     *
     * @param document The document to index.
     */
    indexDocument(document: vscode.TextDocument) {
        this.updateWorkspaceIndex([document.uri.fsPath]);
    }

    /**
     * Refresh the index entries for all files in the workspace.
     */
    indexWorkspace() {
        const workspacePath = vscode.workspace.workspaceFolders![0].uri.fsPath;
        let scripts: string[] = findExtFiles(workspacePath, "Script.sml");
        this.updateWorkspaceIndex(scripts);
    }

    /**
     * Refresh the workspace index entries for each file in the list, and
     * synchronize the entries with the on-disk workspace index in
     * {@link databaseDir}/entries.json. If this file does not exist, then it
     * (and its directory) is created.
     *
     * TODO(oskar.abrahamsson) Lots of duplication in this and {@link indexDep}
     *   and {@link updateDependencyIndex}.
     *
     * @param files Paths to files to refresh the index for.
     */
    private updateWorkspaceIndex(files: string[]) {
        const workspacePath = vscode.workspace.workspaceFolders![0].uri.fsPath;
        // If the database directory doesn't exist, then create it:
        const outputDir = path.join(workspacePath, databaseDir);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }
        const entries = parseFiles(files);

        // Refresh the entries in `workspaceIndex` that referred to any of the
        // files in `files`:
        this.workspaceIndex = this.workspaceIndex.filter((entry) =>
            !files.includes(entry.file)
        );
        entries.forEach((entry) => {
            this.workspaceIndex.push(entry);
        });

        // Write to disk:
        const outputFile = path.join(outputDir, 'entries.json');
        fs.writeFileSync(outputFile, JSON.stringify(this.workspaceIndex, null, 2));
    }

    /**
     * Indexes the files in the list and returns a list of entries.
     * {@link databaseDir}/entries.json file. Returns a list of updated entries.
     *
     * @param files The files
     * @param workspacePath The directory where the database should be stored.
     * @returns
     */
    private indexDep(files: string[], workspacePath: string): HOLEntry[] {
        // If the database directory does not exist, then create it:
        const outputDir = path.join(workspacePath, databaseDir);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }
        const entries = parseFiles(files);

        // Write to disk:
        const outputFile = path.join(outputDir, 'entries.json');
        fs.writeFileSync(outputFile, JSON.stringify(entries, null, 2));

        return entries;
    }

    /**
     * Indexes directories given under the dependencies paths using
     * {@link indexDep}.
     *
     * @param paths Paths to search for HOL scripts to index.
     */
    private updateDependencyIndex(paths: string[]) {
        paths.forEach((depPath) => {
            try {
                const files = findExtFiles(depPath, "Script.sml");
                this.indexDep(files, depPath).forEach((entry) => {
                    this.externalIndex.push(entry);
                });
            } catch (err: unknown) {
                if (err instanceof Error) {
                    error(
                        `Unable to index files in ${depPath}: ${err.message}`
                    );
                }
            }
        });
    }

    /**
     * Refresh the index of the current workspace and all its dependencies.
     */
    refreshIndex() {
        this.indexWorkspace();

        const workspaceDir = vscode.workspace.workspaceFolders![0].uri.fsPath;
        this.updateDependencyIndex(readDependencies(workspaceDir));
    }

    updateImports(document: vscode.TextDocument) {
        this.imports = getImports(document);
    }

    /**
     * Returns all entries in the database: both those local to the current
     * workspace, and external entries.
     *
     * @returns All entries in the database.
     */
    allEntries(): HOLEntry[] {
        return this.workspaceIndex.concat(this.externalIndex);
    }

    /**
     * Returns the list of all {@link HOLEntry} entries that belong to the
     * document.
     *
     * @param document The document for which to return entries.
     * @returns All entries belonging to the current document.
     */
    documentEntries(document: vscode.TextDocument): HOLEntry[] {
        return this.workspaceIndex
            .filter((entry) => entry.file === document.uri.path);
    }
}

/**
 * Read the contents of the on-disk {@link HOLEntry} database in
 * {@link databaseDir}. Returns `undefined` if the database does not exist,
 * or if {@link databaseDir} does not exist.
 *
 * @param dir The directory to look for the entry database in.
 * @returns A list of {@link HOLEntry} entries, if the database exists.
 */
function readDatabase(dir: string): HOLEntry[] | undefined {

    const outputDir = path.join(dir, databaseDir);
    if (!fs.existsSync(outputDir)) {
        log(`${outputDir} does not exist`);
        return;
    }

    const outputFile = path.join(outputDir, "entries.json");
    if (!fs.existsSync(outputFile)) {
        log(`${outputFile} does not exist`);
        return;
    }

    try {
        return JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    } catch (err) {
        if (err instanceof Error) {
            log(`Unable read ${outputFile}: ${err.message}`);
        }
        return;
    }
}

/**
 * Reads the contents of the dependency index from disk, if it exists. The
 * dependency index always contains at least the contents of
 * {@link externalDirs}.
 *
 * @param dir The directory to search in.
 * @returns A list of directories to search for dependencies in.
 */
function readDependencies(dir: string): string[] {
    let paths: string[] = externalDirs;

    const outputFile = path.join(dir, databaseDir, 'dependencies.json');
    try {
        const contents = fs.readFileSync(outputFile, 'utf-8');
        paths.concat(JSON.parse(contents));
    } catch (err) {
        if (err instanceof Error) {
            log(`Unable to parse ${outputFile}: ${err.message}`);
            log(`Proceeding with default external dependencies`);
        }
    } finally {
        return paths.map(p => {
            if (p.startsWith('$')) {
                const envVar = p.slice(1);
                return process.env[envVar]!;
            } else {
                return p;
            }
        });
    }
}

/**
 * Returns all files ending in "Script.sml" from the current directory (or any
 * nested directory).
 *
 * @param directory
 * @param ext
 * @returns
 */
function findExtFiles(directory: string, ext: string): string[] {
    const smlFiles: string[] = [];
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
            smlFiles.push(...findExtFiles(filePath, ext));
        } else if (entry.isFile() && entry.name.endsWith(ext)) {
            smlFiles.push(filePath);
        }
    });
    return smlFiles;
}

const importRegex = /^\s*open\b/mg;
const identRegex = /\s+([a-zA-Z][a-zA-Z0-9_']*)\b/mg;
const keywords = new Set([
    'datatype', 'local', 'nonfix', 'prim_val', 'type', 'val', 'end', 'exception',
    'functor', 'signature', 'structure', 'end', 'exception', 'open',
]);

/**
 * Returns the imported theories in the document.
 *
 * @param document Document to scan for imported theories.
 * @returns A list of imports.
 */
function getImports(document: vscode.TextDocument): string[] {
    const imports: string[] = [];
    const text = document.getText();
    const contents = removeComments(text);
    let match: RegExpExecArray | null;
    while (importRegex.exec(contents)) {
        let lastIndex = identRegex.lastIndex = importRegex.lastIndex;
        while ((match = identRegex.exec(contents))) {
            if (match.index != lastIndex) break;
            lastIndex = identRegex.lastIndex;
            const name = match[1];
            if (keywords.has(name)) {
                if (name == 'open') identRegex.lastIndex = match.index;
                break;
            }
            const n = name.match(/(\S+)Theory/);
            if (n) {
                imports.push(n[1] + 'Script.sml');
            } else {
                imports.push(name);
            }
        }
        importRegex.lastIndex = identRegex.lastIndex;
    }
    return imports;
}

/**
 * Removes comments from the contents of a HOL4 file.
 *
 * TODO(oskar.abrahamsson) There's a similar function in hol_extension_context.
 *
 * @param contents
 * @returns
 */
function removeComments(contents: string): string {
    const commentRegex = /\(\*[\s\S]*?\*\)/g;
    return contents.replace(commentRegex, (match: string) => {
        const numNewlines = match.split(/\r\n|\n|\r/).length - 1;
        const newlines = '\n'.repeat(numNewlines);
        return newlines;
    });
}

/**
 * Check whether the entry should be accessible for the given parameters.
 */
export function isAccessibleEntry(
    entry: HOLEntry,
    imports: string[],
    document: vscode.TextDocument,
): boolean {
    return imports.some((imp) => entry.file.includes(imp)) ||
        entry.file.includes(document.fileName);
}

/**
 * Try to parse all HOL `Theorem` declarations in a string:
 * ```
 *   Theorem <name><attribute-list>?:
 *   <term>
 *   End
 * ```
 * where `<attribute-list>` is a comma-separated list of identifiers.
 */
function parseTheoremRegex(filename: string, contents: string): HOLEntry[] {
    const theoremRegex = /Theorem\s+(\S+?)\s*:\s+([\s\S]*?)\sProof\s+([\s\S]*?)\sQED/mg;
    const afterIdentifierThingRegex = /\[\S*?\]/mg;
    const entries: HOLEntry[] = [];
    let match: RegExpExecArray | null;
    while ((match = theoremRegex.exec(contents))) {
        entries.push({
            name: match[1].replace(afterIdentifierThingRegex, ""),
            statement: match[2],
            file: filename,
            line: contents.slice(0, match.index).split("\n").length,
            type: "Theorem",
        });
    }
    return entries;
}

/**
 * Try to parse all HOL `Definition` declarations in a string:
 * ```
 *   Definition <name>:
 *   <term>
 *   Termination?
 *   <tactics>?
 *   End
 * ```
 */
function parseDefinitions(filename: string, contents: string): HOLEntry[] {
    const definition = /Definition\s+(\S+?)\s*:\s+([\s\S]*?)\sEnd/mg;
    const termination = /([\s\S]*?)Termination\s+([\s\S]*?)\s/;
    const attributes = /\[\S*?\]/mg;
    const entries: HOLEntry[] = [];
    let match: RegExpExecArray | null;
    while ((match = definition.exec(contents))) {
        let statement: RegExpExecArray | null;
        if (match[2].includes("Termination") && (statement = termination.exec(match[2]))) {
            entries.push({
                name: match[1].replace(attributes, ""),
                statement: statement[1],
                file: filename,
                line: contents.slice(0, match.index).split("\n").length,
                type: "Definition",
            });
        } else {
            entries.push({
                name: match[1].replace(attributes, ""),
                statement: match[2],
                file: filename,
                line: contents.slice(0, match.index).split("\n").length,
                type: "Definition",
            });
        }
    }
    return entries;
}

/**
 * Try to parse all HOL `Define` declarations in a string:
 * ```
 *   val <name> = Define <term>
 * ```
 */
function parseDefines(filename: string, contents: string): HOLEntry[] {
    // TODO(oskar.abrahamsson) Write a function that picks up all Define-style
    //   (old-style definitions).
    return [];
}

/**
 * Try to parse all `store_thm` applications in a string:
 * ```
 *   val ... = store_thm(..., <name>, <term>);
 * ```
 */
function parseStoreThms(filename: string, contents: string): HOLEntry[] {
    const storethmSMLSyntax = /val\s+(\S*)\s*=\s*(?:Q\.)?store_thm\s*\([^,]+,\s+\(?(?:“|`|``)([^”`]*)(?:”|`|``)\)?\s*,[^;]+?;/mg;
    const attributes = /\[\S*?\]/mg;
    const entries: HOLEntry[] = [];
    let match: RegExpExecArray | null;
    while ((match = storethmSMLSyntax.exec(contents))) {
        entries.push({
            name: match[1].replace(attributes, ""),
            statement: match[2],
            file: filename,
            line: contents.slice(0, match.index).split("\n").length,
            type: "Theorem",
        });
    }
    return entries;
}

/**
 * Try to parse all HOL `Inductive` declarations in a string:
 * ```
 *   Inductive <name>:
 *   <sort-of-term>
 *   End
 * ```
 */
function parseInductives(filename: string, contents: string): HOLEntry[] {
    const inductive = /Inductive\s+(\S+?)\s*:\s+([\s\S]*?)\sEnd/mg;
    const attributes = /\[\S*?\]/mg;
    const entries: HOLEntry[] = [];
    let match: RegExpExecArray | null;
    while ((match = inductive.exec(contents))) {
        entries.push({
            name: match[1].replace(attributes, "") + "_def",
            statement: match[2],
            file: filename,
            line: contents.slice(0, match.index).split("\n").length,
            type: "Inductive",
        });
    }
    return entries;
}

/**
 * Try to parse all `save_thm` applications in a string:
 * ```
 *   val ... = ...
 * ```
 */
function parseSaveThms(filename: string, contents: string): HOLEntry[] {
    // TODO(kπ) check save_thm syntax, since it's a bit different from store_thm
    const savethmSMLSyntax = /val\s+(\S*)\s*=\s*(?:Q\.)?save_thm\s*\([^,]+,\s+\(?(?:“|`|``)([^”`]*)(?:”|`|``)\)?\s*,[^;]+?;/mg;
    return [];
}

/**
 * Attempt to extract all HOL definitions, rule definitions, and theorems from
 * a file.
 *
 * @param filename Name of the file that's being parsed.
 * @param data Contents of the file that's being parsed.
 * @returns A list of parsed {@link HOLEntry} entries.
 */
function parseScriptSML(filename: string, data: string): HOLEntry[] {
    const contents = removeComments(data);
    return parseTheoremRegex(filename, contents)
        .concat(parseDefinitions(filename, contents))
        .concat(parseDefines(filename, contents))
        .concat(parseSaveThms(filename, contents))
        .concat(parseStoreThms(filename, contents))
        .concat(parseInductives(filename, contents));
}

/**
 * Reads the files in the list and parses their contents for
 * {@link HOLEntry} entries.
 *
 * TODO(oskar.abrahamsson) This will throw if some file does not exist, or
 *   if we can't read it for whatever reason.
 *
 * TODO(oskar.abrahamsson) Theory names will confuse the plugin.
 *
 * @param files List of files to parse.
 * @returns A list of {@link HOLEntry} entries.
 */
function parseFiles(files: string[]): HOLEntry[] {
    let entries: HOLEntry[] = [];
    files.forEach((filename) => {
        const contents = fs.readFileSync(filename, 'utf-8');
        const parsed = parseScriptSML(filename, contents);
        parsed.forEach((entry) => {
            entry.file = filename;
            entries.push(entry);
        });
    });
    return entries;
}
