/** Log a message with the 'hol-mode' prefix. */
export function log(message: string): void {
    console.log(`--- hol-mode: ${message}`);
}

/** Log an error with the 'hol-mode' prefix. */
export function error(message: string): void {
    console.error(`!!! hol-mode: Error: ${message}`);
}
