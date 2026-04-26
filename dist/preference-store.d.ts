/**
 * hypermem Preference Store
 *
 * Behavioral patterns observed about people, systems, and workflows.
 * Lives in the central library DB.
 * "operator prefers architectural stability" is a preference, not a fact.
 */
import type { DatabaseSync } from 'node:sqlite';
export interface Preference {
    id: number;
    subject: string;
    domain: string;
    key: string;
    value: string;
    agentId: string;
    confidence: number;
    visibility: string;
    sourceType: string;
    sourceRef: string | null;
    createdAt: string;
    updatedAt: string;
}
export declare class PreferenceStore {
    private readonly db;
    constructor(db: DatabaseSync);
    /**
     * Set or update a preference. Upserts on (subject, domain, key).
     */
    set(subject: string, key: string, value: string, opts?: {
        domain?: string;
        agentId?: string;
        confidence?: number;
        visibility?: string;
        sourceType?: string;
        sourceRef?: string;
    }): Preference;
    /**
     * Get a specific preference.
     */
    get(subject: string, key: string, domain?: string): Preference | null;
    /**
     * Get all preferences for a subject.
     */
    getForSubject(subject: string, domain?: string): Preference[];
    /**
     * Search preferences by value content.
     */
    search(query: string, subject?: string): Preference[];
    /**
     * Delete a preference.
     */
    delete(subject: string, key: string, domain?: string): boolean;
}
//# sourceMappingURL=preference-store.d.ts.map