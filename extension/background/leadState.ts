/**
 * Per-tab lead ID state management.
 * Tracks which lead page (if any) is currently open in each browser tab.
 * Keyed by Chrome tab ID, value is the numeric lead ID string or null.
 */
const leadStateMap = new Map<number, string | null>();

/**
 * Updates the lead ID associated with a specific tab.
 *
 * @param tabId The Chrome tab ID
 * @param leadId The detected lead ID, or null if the tab is not on a lead page
 */
export function setLeadForTab(tabId: number, leadId: string | null): void {
    leadStateMap.set(tabId, leadId);
}

/**
 * Retrieves the current lead ID for a specific tab.
 *
 * @param tabId The Chrome tab ID
 * @returns The lead ID string if present, null if no lead detected, or undefined if tab not tracked
 */
export function getLeadForTab(tabId: number): string | null | undefined {
    return leadStateMap.get(tabId);
}

/**
 * Removes a tab's lead state entry.
 * Called when a tab is closed to prevent memory leaks.
 *
 * @param tabId The Chrome tab ID to remove
 */
export function removeTab(tabId: number): void {
    leadStateMap.delete(tabId);
}
