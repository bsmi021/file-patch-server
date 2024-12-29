#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError
} from '@modelcontextprotocol/sdk/types.js';
import { promises as fs, createReadStream, createWriteStream } from 'fs';
import { Transform, pipeline } from 'stream';
import { promisify } from 'util';
import * as diff from 'diff';
import { EventEmitter } from 'events';
import {
    PatchOperation,
    PatchResult,
    LinePatchOperation,
    BlockPatchOperation,
    DiffPatchOperation,
    CompleteUpdateOperation,
    PatchValidationResult,
    NormalizedContent,
    ContentScope,
    ScopeType,
    WhitespaceConfig,
    BatchConfig,
    ChunkResult,
    ProgressInfo
} from './types.js';

const pipelineAsync = promisify(pipeline);

// Default configurations
const DEFAULT_BATCH_CONFIG: BatchConfig = {
    maxChunkSize: 1024 * 1024, // 1MB
    maxLinesPerChunk: 1000,
    parallel: false,
    maxParallelOps: 4,
    chunkDelay: 100
};

const DEFAULT_WHITESPACE_CONFIG: WhitespaceConfig = {
    preserveIndentation: true,
    preserveLineEndings: true,
    normalizeWhitespace: true,
    trimTrailingWhitespace: true,
    defaultIndentation: '    ',
    defaultLineEnding: '\n'
};

interface MethodInfo {
    name: string;
    params: string;
    returnType?: string;
    modifiers?: string[];
    constraints?: string[];
}

/**
 * Handles processing of file chunks for large files
 */
class ChunkProcessor extends Transform {
    private config: BatchConfig;
    private buffer: string = '';
    private chunkIndex: number = 0;
    private bytesProcessed: number = 0;
    private linesProcessed: number = 0;
    private startTime: number = Date.now();
    private progressEmitter: EventEmitter;

    constructor(config: BatchConfig = DEFAULT_BATCH_CONFIG) {
        super({ objectMode: true });
        this.config = config;
        this.progressEmitter = new EventEmitter();
    }

    onProgress(listener: (progress: ProgressInfo) => void): void {
        this.progressEmitter.on('progress', listener);
    }

    private shouldProcessChunk(): boolean {
        const currentSize = this.buffer.length;
        const lineCount = this.buffer.split('\n').length - 1;
        const maxChunkSize = this.config?.maxChunkSize ?? DEFAULT_BATCH_CONFIG.maxChunkSize ?? 1024 * 1024;
        const maxLines = this.config?.maxLinesPerChunk ?? DEFAULT_BATCH_CONFIG.maxLinesPerChunk ?? 1000;
        return currentSize >= maxChunkSize || lineCount >= maxLines;
    }

    private extractChunk(): { content: string; lineCount: number } {
        const lines = this.buffer.split('\n');
        const maxLines = this.config.maxLinesPerChunk || DEFAULT_BATCH_CONFIG.maxLinesPerChunk;
        const chunkLines = lines.slice(0, maxLines);
        const chunk = chunkLines.join('\n');
        this.buffer = lines.slice(maxLines).join('\n');
        return { content: chunk, lineCount: chunkLines.length };
    }

    private calculateETA(totalBytes: number): number {
        const elapsedMs = Date.now() - this.startTime;
        const bytesPerMs = this.bytesProcessed / elapsedMs;
        const remainingBytes = totalBytes - this.bytesProcessed;
        return remainingBytes / bytesPerMs;
    }

    private emitProgress(progress: ProgressInfo): void {
        this.progressEmitter.emit('progress', progress);
    }

    async processFile(
        filePath: string,
        processor: (chunk: string, chunkInfo: { start: number; end: number }) => Promise<string>
    ): Promise<ChunkResult[]> {
        const results: ChunkResult[] = [];
        const stats = await fs.stat(filePath);
        const maxChunkSize = this.config?.maxChunkSize ?? DEFAULT_BATCH_CONFIG.maxChunkSize ?? 1024 * 1024;
        const totalChunks = Math.ceil(stats.size / maxChunkSize);

        return new Promise((resolve, reject) => {
            const readStream = createReadStream(filePath, { encoding: 'utf8' });
            const tempPath = `${filePath}.tmp`;
            const writeStream = createWriteStream(tempPath, { encoding: 'utf8' });

            const processChunk = async (chunk: string): Promise<string> => {
                this.buffer += chunk;
                let output = '';

                while (this.shouldProcessChunk()) {
                    const { content, lineCount } = this.extractChunk();
                    const startLine = this.linesProcessed;
                    const endLine = startLine + lineCount;

                    const processed = await processor(content, { start: startLine, end: endLine });

                    this.bytesProcessed += content.length;
                    this.linesProcessed += lineCount;

                    const result: ChunkResult = {
                        success: true,
                        chunkIndex: this.chunkIndex++,
                        startLine,
                        endLine,
                        bytesProcessed: content.length
                    };
                    results.push(result);

                    this.emitProgress({
                        currentChunk: this.chunkIndex,
                        totalChunks,
                        bytesProcessed: this.bytesProcessed,
                        totalBytes: stats.size,
                        linesProcessed: this.linesProcessed,
                        totalLines: -1,
                        startTime: this.startTime,
                        estimatedTimeRemaining: this.calculateETA(stats.size)
                    });

                    if (this.config.chunkDelay) {
                        await new Promise(resolve => setTimeout(resolve, this.config.chunkDelay));
                    }

                    output += processed;
                }

                return output;
            };

            const transform = new Transform({
                transform: (chunk, encoding, callback) => {
                    processChunk(chunk.toString())
                        .then(processed => {
                            callback(null, processed);
                        })
                        .catch(error => {
                            callback(error instanceof Error ? error : new Error(String(error)));
                        });
                },
                flush: (callback) => {
                    if (this.buffer.length > 0) {
                        processChunk(this.buffer)
                            .then(processed => {
                                callback(null, processed);
                            })
                            .catch(error => {
                                callback(error instanceof Error ? error : new Error(String(error)));
                            });
                    } else {
                        callback();
                    }
                }
            });

            pipelineAsync(readStream, transform, writeStream)
                .then(() => {
                    fs.rename(tempPath, filePath)
                        .then(() => resolve(results))
                        .catch(err => reject(err));
                })
                .catch(err => {
                    fs.unlink(tempPath)
                        .catch(() => { })
                        .finally(() => reject(err));
                });
        });
    }
}

class FilePatchServer {
    private server: Server;
    private chunkProcessor: ChunkProcessor;

    // Helper functions for C# code analysis
    private removeComments(line: string): string {
        return line.replace(/\/\/.*$/, '').replace(/\/\*.*\*\//, '').trim();
    }

    private normalizeType(type: string): string {
        return type.replace(/\s+/g, ' ')
            .replace(/\b(int|Int32)\b/g, 'int')
            .replace(/\b(string|String)\b/g, 'string')
            .replace(/\b(bool|Boolean)\b/g, 'bool')
            .replace(/\b(float|Single)\b/g, 'float')
            .replace(/\b(double|Double)\b/g, 'double')
            .replace(/\b(void|Void)\b/g, 'void')
            .trim();
    }

    private extractMethodInfo(signature: string): MethodInfo | null {
        const cleanSignature = this.removeComments(signature);
        if (!cleanSignature) return null;

        // Extract modifiers
        const modifiers: string[] = [];
        const modifierPattern = /\b(public|private|protected|internal|static|virtual|override|abstract|async|sealed|partial)\b/g;
        let match;
        while ((match = modifierPattern.exec(cleanSignature)) !== null) {
            modifiers.push(match[1]);
        }

        // Extract return type and method name
        const methodPattern = /(?:[\w\[\]<>,\s.]+)\s+(\w+)\s*\((.*?)\)/;
        const methodMatch = cleanSignature.match(methodPattern);
        if (!methodMatch) return null;

        // Extract generic constraints
        const constraints: string[] = [];
        const constraintPattern = /where\s+[\w<>]+\s*:\s*(?:class|struct|new\(\)|[\w<>,\s]+)/g;
        while ((match = constraintPattern.exec(cleanSignature)) !== null) {
            constraints.push(match[0]);
        }

        return {
            name: methodMatch[1],
            params: methodMatch[2].split(',').map(p => this.normalizeType(p)).join(','),
            modifiers,
            constraints
        };
    }

    private isMethodMatch(search: MethodInfo, current: MethodInfo): boolean {
        // Name must match exactly
        if (search.name !== current.name) return false;

        // Parameters must be compatible
        const searchParams = search.params.replace(/\s+/g, '');
        const currentParams = current.params.replace(/\s+/g, '');

        if (searchParams !== currentParams) {
            // Check if parameter types are compatible
            const searchParamList = searchParams.split(',').filter(p => p);
            const currentParamList = currentParams.split(',').filter(p => p);

            if (searchParamList.length !== currentParamList.length) return false;

            for (let i = 0; i < searchParamList.length; i++) {
                const searchType = this.normalizeType(searchParamList[i]);
                const currentType = this.normalizeType(currentParamList[i]);
                if (searchType !== currentType) return false;
            }
        }

        // If search specifies modifiers, they must all be present
        if (search.modifiers && search.modifiers.length > 0) {
            if (!current.modifiers) return false;
            for (const modifier of search.modifiers) {
                if (!current.modifiers.includes(modifier)) return false;
            }
        }

        // If search specifies constraints, they must all be present
        if (search.constraints && search.constraints.length > 0) {
            if (!current.constraints) return false;
            for (const constraint of search.constraints) {
                if (!current.constraints.includes(constraint)) return false;
            }
        }

        return true;
    }

    constructor() {
        this.server = new Server(
            {
                name: 'file-patch-server',
                version: '1.0.0',
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );

        this.chunkProcessor = new ChunkProcessor();
        this.setupToolHandlers();
        this.setupProgressHandling();

        // Error handling
        this.server.onerror = (error: Error) => console.error('[MCP Error]', error);
        process.on('SIGINT', async () => {
            await this.server.close();
            process.exit(0);
        });
    }

    private setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'apply_patch',
                    description: 'Apply a patch to a file',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            operation: {
                                type: 'object',
                                properties: {
                                    type: {
                                        type: 'string',
                                        enum: ['line', 'block', 'diff', 'complete'],
                                        description: 'Type of patch operation'
                                    },
                                    filePath: {
                                        type: 'string',
                                        description: 'Path to the file to patch'
                                    },
                                    search: {
                                        type: 'string',
                                        description: 'Text/pattern to search for'
                                    },
                                    replace: {
                                        type: 'string',
                                        description: 'Text to replace with'
                                    },
                                    createBackup: {
                                        type: 'boolean',
                                        description: 'Whether to create a backup'
                                    },
                                    whitespaceConfig: {
                                        type: 'object',
                                        description: 'Whitespace handling configuration'
                                    }
                                },
                                required: ['type', 'filePath'],
                                additionalProperties: true
                            }
                        },
                        required: ['operation']
                    }
                }
            ]
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
            if (request.params.name !== 'apply_patch') {
                throw new McpError(
                    ErrorCode.MethodNotFound,
                    `Unknown tool: ${request.params.name}`
                );
            }

            if (!request.params.arguments) {
                throw new McpError(ErrorCode.InvalidParams, 'Missing arguments');
            }

            const args = request.params.arguments;
            if (!args?.operation) {
                throw new McpError(ErrorCode.InvalidParams, 'Missing operation parameter');
            }

            const operation = args.operation as PatchOperation;
            const result = await this.applyPatch(operation);

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(result, null, 2)
                    }
                ]
            };
        });
    }

    private async createBackup(filePath: string): Promise<string> {
        const backupPath = `${filePath}.bak`;
        await fs.copyFile(filePath, backupPath);
        return backupPath;
    }

    private async validatePatch(operation: PatchOperation): Promise<PatchValidationResult> {
        const errors: string[] = [];
        const whitespaceIssues = {
            inconsistentIndentation: false,
            mixedLineEndings: false,
            trailingWhitespace: false
        };

        try {
            await fs.access(operation.filePath);
        } catch {
            errors.push(`File not found: ${operation.filePath}`);
            return { valid: false, errors };
        }

        const fileContent = await fs.readFile(operation.filePath, 'utf8');
        const whitespaceConfig = operation.whitespaceConfig || DEFAULT_WHITESPACE_CONFIG;
        const { normalized: content, stats } = this.normalizeContent(fileContent, whitespaceConfig);

        // Check for whitespace issues
        whitespaceIssues.inconsistentIndentation = stats.indentationSpaces > 0 && stats.indentationTabs > 0;
        whitespaceIssues.trailingWhitespace = stats.trailingWhitespace > 0;
        whitespaceIssues.mixedLineEndings = fileContent.includes('\r\n') && (fileContent.includes('\n') && !fileContent.includes('\r\n'));

        switch (operation.type) {
            case 'complete': {
                const op = operation as CompleteUpdateOperation;
                const normalized = this.normalizeContent(op.content, whitespaceConfig);
                if (!normalized.normalized.trim()) {
                    errors.push('Empty content provided');
                }
                break;
            }
            case 'line': {
                const op = operation as LinePatchOperation;
                if (!op.lineNumbers && !op.search) {
                    errors.push('Either lineNumbers or search pattern must be provided');
                    break;
                }
                if (op.lineNumbers) {
                    const lines = content.split('\n');
                    const invalidLines = op.lineNumbers.filter(n => n < 1 || n > lines.length);
                    if (invalidLines.length > 0) {
                        errors.push(`Invalid line numbers: ${invalidLines.join(', ')}`);
                    }
                } else {
                    const pattern = op.search instanceof RegExp ? op.search : new RegExp(op.search, 'g');
                    const matches = content.match(pattern);
                    if (!matches) {
                        errors.push('Search pattern not found');
                    }
                }
                break;
            }
            case 'block': {
                const op = operation as BlockPatchOperation;
                const scope = this.detectScope(op.search.toString());
                if (scope.type === 'unknown') {
                    errors.push('Could not detect valid code block in search pattern');
                }
                const matches = content.match(op.search instanceof RegExp ? op.search : new RegExp(op.search, 'g'));
                if (!matches) {
                    errors.push('Block pattern not found');
                }
                break;
            }
            case 'diff': {
                const op = operation as DiffPatchOperation;
                try {
                    const patches = diff.parsePatch(op.diff);
                    if (patches.length === 0) {
                        errors.push('Invalid diff format');
                    }
                } catch (e) {
                    errors.push(`Invalid diff: ${e instanceof Error ? e.message : String(e)}`);
                }
                break;
            }
            default:
                errors.push(`Unknown patch type: ${(operation as PatchOperation).type}`);
        }

        return {
            valid: errors.length === 0,
            errors,
            whitespaceIssues
        };
    }

    private normalizeContent(content: string, config: WhitespaceConfig = DEFAULT_WHITESPACE_CONFIG): NormalizedContent {
        const lines = content.split(/\r\n|\r|\n/);
        const lineEndings = content.includes('\r\n') ? '\r\n' :
            content.includes('\r') ? '\r' : '\n';

        // Detect indentation
        const indentationMatch = content.match(/^[ \t]+/m);
        const indentation = indentationMatch ? indentationMatch[0] : config.defaultIndentation || '    ';

        // Process lines
        let maxLineLength = 0;
        let indentationSpaces = 0;
        let indentationTabs = 0;
        let trailingWhitespace = 0;
        let emptyLines = 0;

        const processedLines = lines.map(line => {
            // Track statistics
            maxLineLength = Math.max(maxLineLength, line.length);
            if (line.trim().length === 0) emptyLines++;
            if (line.match(/[ \t]+$/)) trailingWhitespace++;

            const indent = line.match(/^[ \t]+/);
            if (indent) {
                indentationSpaces += (indent[0].match(/ /g) || []).length;
                indentationTabs += (indent[0].match(/\t/g) || []).length;
            }

            // Apply whitespace configuration
            let processedLine = line;
            if (config.trimTrailingWhitespace) {
                processedLine = processedLine.replace(/[ \t]+$/, '');
            }
            if (!config.preserveIndentation) {
                processedLine = processedLine.replace(/^[ \t]+/, config.defaultIndentation || '    ');
            }
            return processedLine;
        });

        const normalized = processedLines.join(config.preserveLineEndings ? lineEndings : (config.defaultLineEnding || '\n'));

        // Generate content hash
        const hash = Buffer.from(normalized).toString('base64');

        return {
            normalized,
            lineEndings,
            indentation,
            hash,
            stats: {
                indentationSpaces,
                indentationTabs,
                trailingWhitespace,
                emptyLines,
                maxLineLength
            }
        };
    }

    private detectScope(content: string): ContentScope {
        const lines = content.split(/\r\n|\r|\n/);
        let scope: ContentScope = {
            type: 'unknown',
            start: 0,
            end: lines.length - 1,
            context: [],
            indentationLevel: 0
        };

        // Look for class/method/property signatures
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const indentMatch = line.match(/^[ \t]*/);
            const indentLevel = indentMatch ? indentMatch[0].length : 0;
            const trimmedLine = line.trim();

            // Skip comments and empty lines
            if (trimmedLine.startsWith('//') || trimmedLine.startsWith('/*') || !trimmedLine) {
                continue;
            }

            // Class detection
            if (trimmedLine.match(/^(?:export\s+)?(?:abstract\s+)?(?:public|private|protected)?\s*class\s+/)) {
                scope.type = 'class';
                scope.start = i;
                scope.indentationLevel = indentLevel;

                // Find matching closing brace
                let braceCount = 0;
                for (let j = i; j < lines.length; j++) {
                    const currentLine = lines[j];
                    braceCount += (currentLine.match(/{/g) || []).length;
                    braceCount -= (currentLine.match(/}/g) || []).length;
                    if (braceCount === 0) {
                        scope.end = j;
                        break;
                    }
                }
                break;
            }

            // Method detection
            if (trimmedLine.match(/^(?:public|private|protected)?\s*(?:static|virtual|override|abstract)?\s*\w+\s+\w+\s*\(/)) {
                scope.type = 'method';
                scope.start = i;
                scope.indentationLevel = indentLevel;

                // Find method end
                let braceCount = 0;
                for (let j = i; j < lines.length; j++) {
                    const currentLine = lines[j];
                    braceCount += (currentLine.match(/{/g) || []).length;
                    braceCount -= (currentLine.match(/}/g) || []).length;
                    if (braceCount === 0) {
                        scope.end = j;
                        break;
                    }
                }
                break;
            }

            // Property detection
            if (trimmedLine.match(/^(?:public|private|protected)?\s*(?:readonly|static|const)?\s*\w+\s+\w+\s*(?:=|;|{)/)) {
                scope.type = 'property';
                scope.start = i;
                scope.indentationLevel = indentLevel;

                // Find property end
                for (let j = i; j < lines.length; j++) {
                    const currentLine = lines[j].trim();
                    if (currentLine.endsWith(';') || currentLine === '}') {
                        scope.end = j;
                        break;
                    }
                }
                break;
            }
        }

        // Collect context (surrounding lines)
        const contextRange = 3;
        const contextStart = Math.max(0, scope.start - contextRange);
        const contextEnd = Math.min(lines.length - 1, scope.end + contextRange);
        scope.context = lines.slice(contextStart, contextEnd + 1);

        return scope;
    }

    private trackChanges(original: string, modified: string): {
        isDuplicate: boolean;
        isValid: boolean;
        hash: string;
    } {
        const normalizedOriginal = this.normalizeContent(original, {
            ...DEFAULT_WHITESPACE_CONFIG,
            preserveIndentation: false,
            preserveLineEndings: false
        });

        const normalizedModified = this.normalizeContent(modified, {
            ...DEFAULT_WHITESPACE_CONFIG,
            preserveIndentation: false,
            preserveLineEndings: false
        });

        return {
            isDuplicate: normalizedOriginal.hash === normalizedModified.hash,
            isValid: modified.length > 0 && modified.trim().length > 0,
            hash: normalizedModified.hash
        };
    }

    private setupProgressHandling() {
        this.chunkProcessor.on('progress', (progress: ProgressInfo) => {
            console.error(JSON.stringify({
                type: 'progress',
                data: progress
            }));
        });
    }

    private async applyPatch(operation: PatchOperation): Promise<PatchResult> {
        try {
            // Validate first if requested
            if (operation.validate) {
                const validation = await this.validatePatch(operation);
                if (!validation.valid) {
                    return {
                        success: false,
                        filePath: operation.filePath,
                        type: operation.type,
                        changesApplied: 0,
                        error: validation.errors.join(', ')
                    };
                }
            }

            // Create backup if requested
            let backupPath: string | undefined;
            if (operation.createBackup) {
                backupPath = await this.createBackup(operation.filePath);
            }

            const stats = await fs.stat(operation.filePath);
            const effectiveConfig = operation.whitespaceConfig || DEFAULT_WHITESPACE_CONFIG;

            // For large files, use chunk processing
            if (stats.size >= (DEFAULT_BATCH_CONFIG.maxChunkSize || 1024 * 1024)) {
                // TODO: Implement chunk processing for large files
                // For now, fall back to normal processing with a warning
                console.warn(`Warning: Large file detected (${stats.size} bytes). Chunk processing not yet implemented.`);
            }

            // Process file normally
            const fileContent = await fs.readFile(operation.filePath, 'utf8');
            const { normalized: content, lineEndings, indentation } = this.normalizeContent(fileContent, effectiveConfig);

            let newContent: string;
            let changesApplied = 0;
            const appliedChanges = new Set<string>();
            const whitespaceChanges = {
                indentationFixed: false,
                lineEndingsNormalized: false,
                trailingWhitespaceRemoved: false
            };

            switch (operation.type) {
                case 'complete': {
                    const op = operation as CompleteUpdateOperation;
                    const normalized = this.normalizeContent(op.content, effectiveConfig);

                    // Track whitespace changes
                    whitespaceChanges.indentationFixed = normalized.indentation !== indentation;
                    whitespaceChanges.lineEndingsNormalized = normalized.lineEndings !== lineEndings;
                    whitespaceChanges.trailingWhitespaceRemoved = normalized.stats.trailingWhitespace > 0;

                    const changeTracking = this.trackChanges(content, normalized.normalized);
                    if (!changeTracking.isDuplicate && changeTracking.isValid) {
                        newContent = normalized.normalized;
                        changesApplied = 1;
                        appliedChanges.add(changeTracking.hash);
                    } else {
                        newContent = content;
                    }
                    break;
                }

                case 'line': {
                    const op = operation as LinePatchOperation;
                    const lines = content.split('\n');
                    const modifiedLines: number[] = [];

                    if (op.lineNumbers) {
                        // Replace specific line numbers
                        op.lineNumbers.forEach(lineNum => {
                            if (lineNum > 0 && lineNum <= lines.length) {
                                if (op.replace !== undefined) {
                                    const normalized = this.normalizeContent(op.replace, effectiveConfig);
                                    const changeTracking = this.trackChanges(lines[lineNum - 1], normalized.normalized);
                                    if (!changeTracking.isDuplicate && changeTracking.isValid) {
                                        lines[lineNum - 1] = normalized.normalized;
                                        modifiedLines.push(lineNum);
                                        changesApplied++;
                                        appliedChanges.add(changeTracking.hash);
                                    }
                                } else {
                                    lines.splice(lineNum - 1, 1);
                                    modifiedLines.push(lineNum);
                                    changesApplied++;
                                }
                            }
                        });
                    } else {
                        // Replace by search pattern
                        const pattern = op.search instanceof RegExp ? op.search : new RegExp(op.search, 'g');
                        lines.forEach((line: string, index: number) => {
                            if (pattern.test(line)) {
                                if (op.replace !== undefined) {
                                    const normalized = this.normalizeContent(op.replace, effectiveConfig);
                                    const changeTracking = this.trackChanges(line, normalized.normalized);
                                    if (!changeTracking.isDuplicate && changeTracking.isValid) {
                                        lines[index] = normalized.normalized;
                                        modifiedLines.push(index + 1);
                                        changesApplied++;
                                        appliedChanges.add(changeTracking.hash);
                                    }
                                } else {
                                    lines.splice(index, 1);
                                    modifiedLines.push(index + 1);
                                    changesApplied++;
                                }
                            }
                        });
                    }
                    newContent = lines.join('\n');
                    break;
                }

                case 'block': {
                    const op = operation as BlockPatchOperation;
                    const searchContent = this.normalizeContent(op.search.toString(), effectiveConfig);

                    // Find the first non-empty line in search pattern and clean it
                    const searchLines = searchContent.normalized.split('\n');
                    let searchMethodInfo: MethodInfo | null = null;
                    for (const line of searchLines) {
                        const cleanedLine = this.removeComments(line);
                        if (cleanedLine.trim()) {
                            searchMethodInfo = this.extractMethodInfo(cleanedLine);
                            if (searchMethodInfo) {
                                console.error(`[Debug] Found search method info: ${JSON.stringify(searchMethodInfo)}`);
                                break;
                            }
                        }
                    }

                    if (!searchMethodInfo) {
                        throw new Error('Could not extract method info from search pattern');
                    }

                    // Process file content
                    const lines = content.split('\n');
                    const processedLines: string[] = [];
                    let i = 0;
                    let foundMatch = false;

                    // TODO: Implement block matching logic
                    newContent = content;
                    break;
                }

                default:
                    newContent = content;
            }

            // Write changes to file
            await fs.writeFile(operation.filePath, newContent, 'utf8');

            return {
                success: true,
                filePath: operation.filePath,
                type: operation.type,
                changesApplied,
                backupPath,

                originalContent: content.split('\n'),
                newContent: newContent.split('\n'),
                whitespaceChanges
            };
        } catch (error) {
            return {
                success: false,
                filePath: operation.filePath,
                type: operation.type,
                changesApplied: 0,
                error: error instanceof Error ? error.message : String(error)
            };
        }

    }

    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('File patch server started');
    }

}

const server = new FilePatchServer();
server.run().catch(console.error);
