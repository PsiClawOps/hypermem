/**
 * wiki-page-emitter.ts
 *
 * Query-time API for the hypermem wiki layer.
 * Retrieves synthesized topic pages, resolves cross-links,
 * and triggers on-demand synthesis when pages are stale/missing.
 */
import type { DatabaseSync } from 'node:sqlite';
import { type SynthesisConfig } from './topic-synthesizer.js';
export interface WikiPage {
    topicName: string;
    content: string;
    version: number;
    updatedAt: string;
    crossLinks: WikiLink[];
}
export interface WikiLink {
    topicName: string;
    linkType: string;
    direction: 'from' | 'to';
}
export interface WikiPageSummary {
    topicName: string;
    updatedAt: string;
    messageCount: number;
    version: number;
}
export declare class WikiPageEmitter {
    private readonly libraryDb;
    private readonly getMessageDb;
    private readonly synthConfig?;
    private readonly knowledgeStore;
    private readonly synthesizer;
    private readonly regrowthThreshold;
    constructor(libraryDb: DatabaseSync, getMessageDb: (agentId: string) => DatabaseSync | null, synthConfig?: Partial<SynthesisConfig> | undefined);
    /**
     * Fetch the version number for an active knowledge entry.
     */
    private getVersion;
    /**
     * Get a wiki page for a topic.
     * If no page exists, or page is stale (topic has grown by >= regrowthThreshold
     * since last synthesis), trigger a synthesis pass first.
     * Returns null if topic has no messages or doesn't exist.
     */
    getPage(agentId: string, topicName: string): WikiPage | null;
    /**
     * List all synthesized pages for an agent — the table of contents.
     */
    listPages(agentId: string, opts?: {
        limit?: number;
        domain?: string;
    }): WikiPageSummary[];
    /**
     * Get a page's cross-links from knowledge_links table.
     * Resolves both directions (from and to).
     */
    private resolveLinks;
    /**
     * Force re-synthesis of a specific topic regardless of staleness.
     * Returns the new page or null if topic not found.
     */
    forceSynthesize(agentId: string, topicName: string): WikiPage | null;
}
//# sourceMappingURL=wiki-page-emitter.d.ts.map