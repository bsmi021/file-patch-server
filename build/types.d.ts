/**
 * Types for file patching operations
 */
/**
 * Supported patch operation types
 */
export type PatchType = 'line' | 'block' | 'diff' | 'complete';
/**
 * Base interface for all patch operations
 */
export interface BasePatchOperation {
    type: PatchType;
    filePath: string;
    createBackup?: boolean;
    validate?: boolean;
    whitespaceConfig?: WhitespaceConfig;
}
/**
 * Line-based patch operation
 * Matches and replaces specific lines in a file
 */
export interface LinePatchOperation extends BasePatchOperation {
    type: 'line';
    search: string | RegExp;
    replace?: string;
    lineNumbers?: number[];
    context?: number;
}
/**
 * Block-based patch operation
 * Matches and replaces blocks of text between delimiters
 */
export interface BlockPatchOperation extends BasePatchOperation {
    type: 'block';
    search: string | RegExp;
    replace?: string;
    startDelimiter?: string;
    endDelimiter?: string;
    includeDelimiters?: boolean;
}
/**
 * Complete file update operation
 * Replaces entire file content with proper whitespace handling
 */
export interface CompleteUpdateOperation extends BasePatchOperation {
    type: 'complete';
    content: string;
    preserveFormatting?: boolean;
}
/**
 * Diff-based patch operation
 * Applies unified diff format patches
 */
export interface DiffPatchOperation extends BasePatchOperation {
    type: 'diff';
    diff: string;
    context?: number;
    ignoreWhitespace?: boolean;
}
/**
 * Batch processing configuration
 */
export interface BatchConfig {
    maxChunkSize?: number;
    maxLinesPerChunk?: number;
    parallel?: boolean;
    maxParallelOps?: number;
    chunkDelay?: number;
}
/**
 * Progress information for batch operations
 */
export interface ProgressInfo {
    currentChunk: number;
    totalChunks: number;
    bytesProcessed: number;
    totalBytes: number;
    linesProcessed: number;
    totalLines: number;
    startTime: number;
    estimatedTimeRemaining?: number;
}
/**
 * Union type of all patch operations
 */
export type PatchOperation = LinePatchOperation | BlockPatchOperation | DiffPatchOperation | CompleteUpdateOperation;
/**
 * Result of a patch operation
 */
export interface PatchResult {
    success: boolean;
    filePath: string;
    type: PatchType;
    changesApplied: number;
    backupPath?: string;
    error?: string;
    modifiedLines?: number[];
    originalContent?: string[];
    newContent?: string[];
    whitespaceChanges?: {
        indentationFixed: boolean;
        lineEndingsNormalized: boolean;
        trailingWhitespaceRemoved: boolean;
    };
}
/**
 * Options for patch validation
 */
export interface PatchValidationOptions {
    checkFileExists?: boolean;
    verifyMatches?: boolean;
    checkPermissions?: boolean;
    validateSyntax?: boolean;
    validateWhitespace?: boolean;
}
/**
 * Configuration for whitespace handling
 */
export interface WhitespaceConfig {
    preserveIndentation: boolean;
    preserveLineEndings: boolean;
    normalizeWhitespace: boolean;
    trimTrailingWhitespace: boolean;
    defaultIndentation?: string;
    defaultLineEnding?: string;
}
/**
 * Normalized content with whitespace information
 */
export interface NormalizedContent {
    normalized: string;
    lineEndings: string;
    indentation: string;
    hash: string;
    stats: {
        indentationSpaces: number;
        indentationTabs: number;
        trailingWhitespace: number;
        emptyLines: number;
        maxLineLength: number;
    };
}
/**
 * Scope type for code blocks
 */
export type ScopeType = 'class' | 'method' | 'property' | 'unknown';
/**
 * Content scope information
 */
export interface ContentScope {
    type: ScopeType;
    start: number;
    end: number;
    context: string[];
    indentationLevel: number;
}
/**
 * Chunk processing result
 */
export interface ChunkResult {
    success: boolean;
    chunkIndex: number;
    startLine: number;
    endLine: number;
    bytesProcessed: number;
    error?: string;
}
/**
 * Result of patch validation
 */
export interface PatchValidationResult {
    valid: boolean;
    errors: string[];
    matchCount?: number;
    matchLines?: number[];
    whitespaceIssues?: {
        inconsistentIndentation: boolean;
        mixedLineEndings: boolean;
        trailingWhitespace: boolean;
    };
}
