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
    // Whether to create a backup before patching
    createBackup?: boolean;
    // Whether to validate the patch before applying
    validate?: boolean;
    // Whitespace handling options
    whitespaceConfig?: WhitespaceConfig;
}

/**
 * Line-based patch operation
 * Matches and replaces specific lines in a file
 */
export interface LinePatchOperation extends BasePatchOperation {
    type: 'line';
    // The line(s) to find in the file
    search: string | RegExp;
    // The line(s) to replace with (undefined for deletion)
    replace?: string;
    // Line numbers to target (alternative to search)
    lineNumbers?: number[];
    // Number of context lines to include
    context?: number;
}

/**
 * Block-based patch operation
 * Matches and replaces blocks of text between delimiters
 */
export interface BlockPatchOperation extends BasePatchOperation {
    type: 'block';
    // The block to find (including delimiters)
    search: string | RegExp;
    // The block to replace with (undefined for deletion)
    replace?: string;
    // Start/end delimiters for blocks
    startDelimiter?: string;
    endDelimiter?: string;
    // Whether to include delimiters in replacement
    includeDelimiters?: boolean;
}

/**
 * Complete file update operation
 * Replaces entire file content with proper whitespace handling
 */
export interface CompleteUpdateOperation extends BasePatchOperation {
    type: 'complete';
    // New content for the file
    content: string;
    // Whether to preserve original formatting
    preserveFormatting?: boolean;
}

/**
 * Diff-based patch operation
 * Applies unified diff format patches
 */
export interface DiffPatchOperation extends BasePatchOperation {
    type: 'diff';
    // Unified diff format patch
    diff: string;
    // Number of context lines
    context?: number;
    // Whether to ignore whitespace
    ignoreWhitespace?: boolean;
}

/**
 * Batch processing configuration
 */
export interface BatchConfig {
    // Maximum size of each chunk in bytes
    maxChunkSize?: number;
    // Maximum number of lines per chunk
    maxLinesPerChunk?: number;
    // Whether to process chunks in parallel
    parallel?: boolean;
    // Maximum number of parallel operations
    maxParallelOps?: number;
    // Delay between chunks in ms
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
    // Number of changes made
    changesApplied: number;
    // Backup file path if created
    backupPath?: string;
    // Any errors encountered
    error?: string;
    // Line numbers affected
    modifiedLines?: number[];
    // Original content of modified sections
    originalContent?: string[];
    // New content of modified sections
    newContent?: string[];
    // Whitespace changes made
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
    // Whether to check file exists
    checkFileExists?: boolean;
    // Whether to verify search matches
    verifyMatches?: boolean;
    // Whether to check file permissions
    checkPermissions?: boolean;
    // Whether to validate patch syntax
    validateSyntax?: boolean;
    // Whether to validate whitespace
    validateWhitespace?: boolean;
}

/**
 * Configuration for whitespace handling
 */
export interface WhitespaceConfig {
    // Whether to preserve original indentation
    preserveIndentation: boolean;
    // Whether to preserve original line endings
    preserveLineEndings: boolean;
    // Whether to normalize other whitespace
    normalizeWhitespace: boolean;
    // Whether to trim trailing whitespace
    trimTrailingWhitespace: boolean;
    // Default indentation to use if not preserving
    defaultIndentation?: string;
    // Default line ending to use if not preserving
    defaultLineEnding?: string;
}

/**
 * Normalized content with whitespace information
 */
export interface NormalizedContent {
    // Content with normalized whitespace
    normalized: string;
    // Original line ending format
    lineEndings: string;
    // Original indentation style
    indentation: string;
    // Original content hash
    hash: string;
    // Whitespace statistics
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
    // Number of matches found for search patterns
    matchCount?: number;
    // Line numbers of matches
    matchLines?: number[];
    // Whitespace validation results
    whitespaceIssues?: {
        inconsistentIndentation: boolean;
        mixedLineEndings: boolean;
        trailingWhitespace: boolean;
    };
}
