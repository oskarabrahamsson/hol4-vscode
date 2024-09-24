export const EXTENSION_ID = 'oskarabrahamsson.hol4-mode';
export const KERNEL_ID = 'hol4';

/** Log a message with the 'hol-mode' prefix. */
export function log(message: string): void {
    console.log(`--- hol-mode: ${message}`);
}

/** Log an error with the 'hol-mode' prefix. */
export function error(message: string): void {
    console.error(`!!! hol-mode: Error: ${message}`);
}

/** Execute an async fn such that any concurrent calls block until the previous calls finish. */
export function disallowConcurrency<T>(fn: (arg: T) => Promise<void>): (arg: T) => Promise<void> {
    let inprogressPromise = Promise.resolve()
    return (arg) => {
        inprogressPromise = inprogressPromise.then(() => fn(arg))
        return inprogressPromise
    }
};
