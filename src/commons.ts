import * as vscode from 'vscode';
import { HOLIDE } from "./ide";
import { HolTerminal } from "./terminal";

export type HOLExtensionContext = {
  /** Path to the HOL installation to use. */
  holPath: string | undefined;
  /** Currently active pseudoterminal (if any). */
  holTerminal: HolTerminal | undefined;
  /** Current IDE class instance */
  holIDE: HOLIDE | undefined;
  /** Currently active terminal (if any). */
  terminal: vscode.Terminal | undefined;
  /** Whether the HOL session is active. */
  active: boolean;
  /** Configuration settings. */
  config: vscode.WorkspaceConfiguration | undefined;
};

/** Log a message with the 'hol-mode' prefix. */
export function log(message: string): void {
  console.log(`--- hol-mode: ${message}`);
}

/** Log an error with the 'hol-mode' prefix. */
export function error(message: string): void {
  console.error(`!!! hol-mode: Error: ${message}`);
}

/** Returns whether the current session is inactive. If it is inactive, then an
 * error message is printed.
 */
export function isInactive(holExtensionContext: HOLExtensionContext): boolean {
  if (!holExtensionContext.active) {
      vscode.window.showErrorMessage('No active HOL session; doing nothing.');
      error('No active session; doing nothing');
  }

  return !holExtensionContext.active;
}
