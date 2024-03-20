import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/** Theorem structure for go to definition and hover info */
interface HOLEntry {
  name: string;
  statement: string;
  file: string;
  line: number;
  type: 'Theorem' | 'Definition' | 'Inductive';
}

/** Used for the Document Symbol Provider for HOL */
export interface HOLSymbolInformation extends vscode.SymbolInformation {
  kind: vscode.SymbolKind;
}

export class HOLIDE {

    imports: string[] = [];
    cachedEntries: HOLEntry[] = [];
    dependencyEntries: HOLEntry[] = [];
    dependencyVariables: string[] = ['$HOLDIR','$CAKEMLDIR'];
    holIDEDir: string = '.holide';

    initIDE() {
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        this.cachedEntries = this.readEntriesOfDir(workspacePath!);
        const unindexedDeps: string[] = [];
        this.readDependenciesDirs().forEach((depPath) => {
            try {
                const entries = this.readEntriesOfDir(depPath);
                this.dependencyEntries = this.dependencyEntries.concat(entries);
            } catch (error) {
                unindexedDeps.push(depPath);
            }
        });
        vscode.window.showInformationMessage(`HOL: Read ${this.cachedEntries.length} entries from workspace cache and ${this.dependencyEntries.length} entries from HOLDIR cache!`);

        if (unindexedDeps.length > 0) {
            vscode.window.showInformationMessage(
                `HOL: Couldn't read ide information from some of the dependencies, namely: ${unindexedDeps}. Do you want to index them now?`,
                'Yes',
                'No'
            )
            .then((value) => {
                if (value === 'Yes') {
                    this.indexDependencies(unindexedDeps);
                }
            });
        }

        var editor = vscode.window.activeTextEditor;
        if (editor) {
            this.imports = this.getImports(editor.document);
        }
    }

    readEntriesOfDir(dir: string): HOLEntry[] {
        const outputDir = path.join(dir, this.holIDEDir);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }
        const outputFile = path.join(outputDir, 'entries.json');
        try {
            return JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
        } catch (error) {
            return [];
        }
    }

    /** Reads the contents of the current .holide/dependencies.json */
    readDependenciesDirs(): string[] {
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspacePath) {
            vscode.window.showErrorMessage('No workspace open!');
            return [];
        }
        const outputDir = path.join(workspacePath, this.holIDEDir);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }
        const dependenciesFile = path.join(outputDir, 'dependencies.json');
        const contents = fs.readFileSync(dependenciesFile, 'utf-8');
        const depsJson = JSON.parse(contents);
        let paths: string[] = this.dependencyVariables;
        console.log(depsJson.paths);
        if (depsJson.paths) {
            paths = paths.concat(depsJson.paths);
        }
        return paths.map(p => {
            if (p.startsWith('$')) {
                const envVar = p.slice(1);
                return process.env[envVar]!;
            } else {
                return p;
            }
        });
    }

    /** Indexes the given smlFiles and returns the entries found */
    indexDir(smlFiles: string[]): HOLEntry[] {
        const entries: HOLEntry[] = [];
        smlFiles.forEach((filePath) => {
            const contents = fs.readFileSync(filePath, 'utf-8');
            const parsed = this.parseScriptSML(contents);
            parsed.forEach((entry) => {
                entries.push({
                    name: entry.name,
                    statement: entry.statement,
                    file: filePath,
                    line: entry.line,
                    type: entry.type
                });
            });
        });
        return entries;
    }

    /**
      * Indexes the current workspace and saves it under the .holide/entries.json file
      * If a document is given, only that document is indexed
      */
    indexWorkspace(document?: vscode.TextDocument) {
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspacePath) {
            vscode.window.showErrorMessage('No workspace open!');
            return;
        }
        let smlFiles: string[] = [];
        if (document) {
            const path = document.uri.fsPath;
            if (path.endsWith('Script.sml')) {
                smlFiles.push(path);
            }
        } else {
            smlFiles = this.findExtFiles(workspacePath, 'Script.sml');
        }
        const entries: HOLEntry[] = this.indexDir(smlFiles);
        const outputDir = path.join(workspacePath, this.holIDEDir);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }
        const outputFile = path.join(outputDir, 'entries.json');
        if (!document) {
            vscode.window.showInformationMessage(`HOL: Parsed ${entries.length} entries in current workspace!`);
        }
        this.cachedEntries = this.cachedEntries.filter((entry) => !smlFiles.includes(entry.file));
        this.cachedEntries = this.cachedEntries.concat(entries);
        fs.writeFileSync(outputFile, JSON.stringify(this.cachedEntries, null, 2));
    }

    /**
     * Indexes the directory under the given path and save it under its .holide/entries.json file
     */
    indexDep(workspacePath: string): HOLEntry[] {
        const smlFiles: string[] = this.findExtFiles(workspacePath, 'Script.sml');
        const entries: HOLEntry[] = this.indexDir(smlFiles);
        vscode.window.showInformationMessage(`HOL: Parsed ${entries.length} entries in ${workspacePath}!`);
        const outputDir = path.join(workspacePath, this.holIDEDir);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }
        const outputFile = path.join(outputDir, 'entries.json');
        fs.writeFileSync(outputFile, JSON.stringify(entries, null, 2));
        return entries;
    }

    /** Indexes directories given under the dependencies paths */
    indexDependencies(dependencies: string[]): HOLEntry[] {
        dependencies.forEach((depPath) => {
            try {
                this.dependencyEntries = this.dependencyEntries.concat(this.indexDep(depPath));
            } catch (error) {
                vscode.window.showErrorMessage(`HOL: Couldn't read ide information from dependency ${depPath}!`);
            }
        });
        return this.dependencyEntries;
    }

    /** Reindexes the current workspace and all dependencies */
    reindexAllDependencies() {
        this.indexWorkspace();
        this.indexDependencies(this.readDependenciesDirs());
    }

    updateImports(document: vscode.TextDocument) {
        this.imports = this.getImports(document);
    }


    allEntries(): HOLEntry[] {
        return this.cachedEntries.concat(this.dependencyEntries);
    }

    holEntryToSymbol(entry: HOLEntry) : HOLSymbolInformation {
        const symbol: HOLSymbolInformation = {
            name: entry.name,
            kind: vscode.SymbolKind.Function,
            location: new vscode.Location(vscode.Uri.file(entry.file), new vscode.Position(entry.line - 1, 0)),
            containerName: ''
        };
        return symbol;
    }

    /** Removes comments from the contents of a HOL4 file */
    removeComments(contents: string): string {
        const commentRegex = /\(\*[\s\S]*?\*\)/g;
        return contents.replace(commentRegex, (match: string) => {
            const numNewlines = match.split(/\r\n|\n|\r/).length - 1;
            const newlines = '\n'.repeat(numNewlines);
            return newlines;
        });
    }

    /** Parse Theorem entry */
    parseTheoremRegex(contents: string): HOLEntry[] {
        const theoremRegex = /Theorem\s+(\S+?)\s*:\s+([\s\S]*?)\sProof\s+([\s\S]*?)\sQED/mg;
        const afterIdentifierThingRegex = /\[\S*?\]/mg;
        const holentries: HOLEntry[] = [];
        let match: RegExpExecArray | null;
        while ((match = theoremRegex.exec(contents))) {
            const theorem: HOLEntry = {
                name: match[1].replace(afterIdentifierThingRegex, ''),
                statement: match[2],
                line: contents.slice(0, match.index).split('\n').length,
                file: '',
                type: 'Theorem'
            };
            holentries.push(theorem);
        }
        return holentries;
    }

    /** Parse Definition entry */
    parseDefinitionRegex(contents: string): HOLEntry[] {
        const definitionRegex = /Definition\s+(\S+?)\s*:\s+([\s\S]*?)\sEnd/mg;
        const definitionStatementTerminationRegex = /([\s\S]*?)Termination\s+([\s\S]*?)\s/;
        const afterIdentifierThingRegex = /\[\S*?\]/mg;
        const holentries: HOLEntry[] = [];
        let match: RegExpExecArray | null;
        while ((match = definitionRegex.exec(contents))) {
            let statement: RegExpExecArray | null;
            if(match[2].includes("Termination") && (statement = definitionStatementTerminationRegex.exec(match[2]))) {
                const definition: HOLEntry = {
                    name: match[1].replace(afterIdentifierThingRegex, ''),
                    statement: statement[1],
                    line: contents.slice(0, match.index).split('\n').length,
                    file: '',
                    type: 'Definition'
                };
                holentries.push(definition);
            } else {
                const definition: HOLEntry = {
                    name: match[1].replace(afterIdentifierThingRegex, ''),
                    statement: match[2],
                    line: contents.slice(0, match.index).split('\n').length,
                    file: '',
                    type: 'Definition'
                };
                holentries.push(definition);
            }
        }
        return holentries;
    }

    /** Parse store_thm syntax */
    parseStoreThmSMLSyntax(contents: string): HOLEntry[] {
        const storethmSMLSyntax = /val\s+(\S*)\s*=\s*(?:Q\.)?store_thm\s*\([^,]+,\s+\(?(?:“|`|``)([^”`]*)(?:”|`|``)\)?\s*,[^;]+?;/mg;
        const afterIdentifierThingRegex = /\[\S*?\]/mg;
        const holentries: HOLEntry[] = [];
        let match: RegExpExecArray | null;
        while ((match = storethmSMLSyntax.exec(contents))) {
            const theorem: HOLEntry = {
                name: match[1].replace(afterIdentifierThingRegex, ''),
                statement: match[2],
                line: contents.slice(0, match.index).split('\n').length,
                file: '',
                type: 'Theorem'
            };
            holentries.push(theorem);
        }
        return holentries;
    }

    /** Parse Inductive entry */
    parseInductiveRegex(contents: string): HOLEntry[] {
        const inductiveRegex = /Inductive\s+(\S+?)\s*:\s+([\s\S]*?)\sEnd/mg;
        const afterIdentifierThingRegex = /\[\S*?\]/mg;
        const holentries: HOLEntry[] = [];
        let match: RegExpExecArray | null;
        while ((match = inductiveRegex.exec(contents))) {
            const theorem: HOLEntry = {
                name: match[1].replace(afterIdentifierThingRegex, '') + '_def',
                statement: match[2],
                line: contents.slice(0, match.index).split('\n').length,
                file: '',
                type: 'Inductive'
            };
            holentries.push(theorem);
        }
        return holentries;
    }

    // TODO(kπ) check save_thm syntax, since it's a bit different from store_thm
    parseSaveThmSMLSyntax(contents: string): HOLEntry[] {
        const savethmSMLSyntax = /val\s+(\S*)\s*=\s*(?:Q\.)?save_thm\s*\([^,]+,\s+\(?(?:“|`|``)([^”`]*)(?:”|`|``)\)?\s*,[^;]+?;/mg;
        return [];
    }

    /** Poor man's parsing of HOL4 files */
    parseScriptSML(_contents: string): HOLEntry[] {
        const contents = this.removeComments(_contents);
        const holentries: HOLEntry[] = this.parseTheoremRegex(contents)
            .concat(this.parseDefinitionRegex(contents))
            .concat(this.parseStoreThmSMLSyntax(contents))
            .concat(this.parseInductiveRegex(contents));
        return holentries;
    }

    /**
     * Parse a .sig file (especially the comments that contain formatted theorem statements)
     */
    parseSig(_contents: string): HOLEntry[] {
        const holentries: HOLEntry[] = [];

        // TODO(kπ) implement this

        return holentries;
    }

    /** Returns all files ending in "Script.sml" from the current directory (or any nested directory) */
    findExtFiles(directory: string, ext: string): string[] {
        const smlFiles: string[] = [];
        fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
            const filePath = path.join(directory, entry.name);
            if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('examples')) {
                smlFiles.push(...this.findExtFiles(filePath, ext));
            } else if (entry.isFile() && entry.name.endsWith(ext)) {
                smlFiles.push(filePath);
            }
        });
        return smlFiles;
    }

    /** Creates a completion item from an entry */
    createCompletionItem(entry: HOLEntry, kind: vscode.CompletionItemKind): vscode.CompletionItem {
        const item = new vscode.CompletionItem(entry.name, kind);
        item.commitCharacters = [' '];
        item.documentation = `${entry.type}: ${entry.name}\n${entry.statement}`;
        return item;
    }

    /** Returns the imported theories in the given file */
    getImports(document: vscode.TextDocument): string[] {
        const imports: string[] = [];
        const importRegex = /^\s*open\s+([^;]+(\s+[^;]+)*?);/mg;
        const text = document.getText();
        const contents = this.removeComments(text);
        let match: RegExpExecArray | null;
        while ((match = importRegex.exec(contents))) {
            const names = match[1].split(/\s+/);
            names.forEach((name) => {
                const n = name.match(/(\S+)Theory/);
                if (n) {
                    imports.push(n[1] + 'Script.sml');
                } else {
                    imports.push(name);
                }
            });
        }
        return imports;
    }

    /** Check whether the entry should be accessible for the given parameters */
    isAccessibleEntry(entry: HOLEntry, imports: string[], document: vscode.TextDocument): boolean {
        return imports.some((imp) => entry.file.includes(imp)) || entry.file.includes(document.fileName);
    }

}
