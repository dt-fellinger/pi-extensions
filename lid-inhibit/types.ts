/**
 * Common interface for platform-specific lid-close inhibitors.
 *
 * Each platform acquires an exclusive hold that prevents the OS from
 * sleeping when the lid is closed. Crash-safety guarantees vary by
 * platform - see individual implementations for details.
 */
export interface Inhibitor {
  acquire(): Promise<void>;
  release(): Promise<void>;
}
