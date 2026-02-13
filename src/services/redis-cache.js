/**
 * Redis Cache Service - Prompt caching using Redis with prefix hash matching
 * Based on kiro-rs cache.rs implementation
 * 
 * Features:
 * - Singleton pattern with module-level instance
 * - Fail-open strategy (graceful degradation if Redis unavailable)
 * - Cumulative hash breakpoints for cache lookup
 * - TTL support (5 minutes default, 1 hour extended)
 */

import Redis from 'ioredis';
import { countTokens } from '@anthropic-ai/tokenizer';
import { CumulativeHasher, normalizeToolForHash, stableStringify } from '../utils/crypto-utils.js';
import logger from '../utils/logger.js';

/** Default TTL: 5 minutes */
const DEFAULT_TTL_SECS = 5 * 60;
/** Extended TTL: 1 hour */
const EXTENDED_TTL_SECS = 60 * 60;

/**
 * Cache breakpoint information
 * @typedef {Object} CacheBreakpoint
 * @property {string} hash - Cumulative hash value
 * @property {number} tokens - Cumulative token count
 * @property {number} ttl - TTL in seconds
 */

/**
 * Cache query result
 * @typedef {Object} CacheResult
 * @property {number} cache_read_input_tokens - Tokens read from cache (on hit)
 * @property {number} cache_creation_input_tokens - Tokens written to cache (on miss)
 * @property {number} uncached_input_tokens - Tokens after last breakpoint
 */

/**
 * Redis Cache Service class
 * Implements prompt caching with cumulative hash breakpoints
 */
export class RedisCacheService {
    /**
     * Create a new RedisCacheService instance
     * @param {Object} config - Configuration object
     * @param {boolean} [config.REDIS_ENABLED=false] - Whether Redis caching is enabled
     * @param {string} [config.REDIS_HOST='localhost'] - Redis host
     * @param {number} [config.REDIS_PORT=6379] - Redis port
     * @param {string} [config.REDIS_PASSWORD] - Redis password (optional)
     * @param {number} [config.REDIS_DB=0] - Redis database number
     * @param {number} [config.REDIS_DEFAULT_TTL=300] - Default TTL in seconds
     * @param {number} [config.REDIS_EXTENDED_TTL=3600] - Extended TTL in seconds
     */
    constructor(config = {}) {
        this.config = config;
        this.client = null;
        this.isInitialized = false;
        
        // Environment variables take priority over config file
        this.isEnabled = this._getEnvBool('REDIS_ENABLED', config.REDIS_ENABLED ?? false);
        
        // Redis connection settings (env > config > default)
        this.host = process.env.REDIS_HOST || config.REDIS_HOST || 'localhost';
        this.port = this._getEnvInt('REDIS_PORT', config.REDIS_PORT || 6379);
        this.password = process.env.REDIS_PASSWORD || config.REDIS_PASSWORD || undefined;
        this.db = this._getEnvInt('REDIS_DB', config.REDIS_DB || 0);
        
        // TTL settings
        this.defaultTtl = this._getEnvInt('REDIS_DEFAULT_TTL', config.REDIS_DEFAULT_TTL || DEFAULT_TTL_SECS);
        this.extendedTtl = this._getEnvInt('REDIS_EXTENDED_TTL', config.REDIS_EXTENDED_TTL || EXTENDED_TTL_SECS);
    }

    /**
     * Get boolean value from environment variable
     * @private
     */
    _getEnvBool(key, defaultValue) {
        const val = process.env[key];
        if (val === undefined) return defaultValue;
        return val === 'true' || val === '1';
    }

    /**
     * Get integer value from environment variable
     * @private
     */
    _getEnvInt(key, defaultValue) {
        const val = process.env[key];
        if (val === undefined) return defaultValue;
        const parsed = parseInt(val, 10);
        return isNaN(parsed) ? defaultValue : parsed;
    }

    /**
     * Initialize Redis connection
     * Implements fail-open strategy - logs warning and continues if connection fails
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.isInitialized) {
            return;
        }

        if (!this.isEnabled) {
            logger.info('[Redis Cache] Redis caching is disabled');
            this.isInitialized = true;
            return;
        }

        try {
            const redisOptions = {
                host: this.host,
                port: this.port,
                db: this.db,
                retryStrategy: (times) => {
                    if (times > 3) {
                        logger.warn('[Redis Cache] Max retry attempts reached, giving up');
                        return null; // Stop retrying
                    }
                    const delay = Math.min(times * 200, 2000);
                    return delay;
                },
                maxRetriesPerRequest: 3,
                enableReadyCheck: true,
                lazyConnect: true,
            };

            if (this.password) {
                redisOptions.password = this.password;
            }

            this.client = new Redis(redisOptions);

            // Set up event handlers
            this.client.on('error', (err) => {
                logger.warn(`[Redis Cache] Connection error: ${err.message}`);
            });

            this.client.on('connect', () => {
                logger.info('[Redis Cache] Connected to Redis');
            });

            this.client.on('ready', () => {
                logger.info('[Redis Cache] Redis client ready');
            });

            this.client.on('close', () => {
                logger.debug('[Redis Cache] Connection closed');
            });

            // Attempt to connect
            await this.client.connect();
            
            // Test connection with PING
            await this.client.ping();
            logger.info(`[Redis Cache] Initialized successfully - ${this.host}:${this.port}/${this.db}`);
            
        } catch (error) {
            // Fail-open: log warning and continue without Redis
            logger.warn(`[Redis Cache] Failed to initialize: ${error.message}. Caching disabled.`);
            this.client = null;
        }

        this.isInitialized = true;
    }

    /**
     * Check if Redis is available and connected
     * @returns {boolean}
     */
    isAvailable() {
        return this.client !== null && this.client.status === 'ready';
    }

    /**
     * Parse TTL from cache_control object
     * @param {Object} cacheControl - Cache control object
     * @returns {number} TTL in seconds
     * @private
     */
    _parseTtl(cacheControl) {
        if (cacheControl && cacheControl.ttl === '1h') {
            return this.extendedTtl;
        }
        return this.defaultTtl;
    }

    /**
     * Compute cache breakpoints from request components
     * 
     * IMPORTANT: Anthropic prompt caching is PREFIX-based. The cache key (hash) should only
     * include content UP TO AND INCLUDING the cache_control marker. Content AFTER the last
     * cache_control marker should NOT affect the hash of previous breakpoints.
     * 
     * This means:
     * - We process tools → system → messages in order
     * - We accumulate hash as we go
     * - We ONLY create a breakpoint when we encounter cache_control
     * - The hash at each breakpoint represents ALL content up to that point
     * - Content after the last cache_control does NOT invalidate previous cache entries
     * 
     * @param {Array<Object>|null} tools - Array of tool definitions
     * @param {Array<Object>|string|null} system - System prompt(s)
     * @param {Array<Object>} messages - Message array
     * @returns {Array<CacheBreakpoint>} Array of cache breakpoints
     */
    computeBreakpoints(tools, system, messages) {
        const breakpoints = [];
        const hasher = new CumulativeHasher();
        let cumulativeTokens = 0;

        // Log cache_control statistics
        const toolsWithCacheControl = tools 
            ? tools.filter(t => t.cache_control).length 
            : 0;
        const systemWithCacheControl = this._countSystemCacheControl(system);
        const messagesWithCacheControl = this._countMessagesCacheControl(messages);

        logger.debug(
            `[Redis Cache] Cache control in request: tools=${toolsWithCacheControl}/${tools?.length || 0}, ` +
            `system=${systemWithCacheControl}, messages=${messagesWithCacheControl}/${messages?.length || 0}`
        );

        // 1. Process tools (sorted by name for determinism)
        if (tools && Array.isArray(tools) && tools.length > 0) {
            const sortedTools = [...tools].sort((a, b) => 
                (a.name || '').localeCompare(b.name || '')
            );

            for (const tool of sortedTools) {
                // Normalize tool for hashing
                const normalized = normalizeToolForHash(tool);
                hasher.update(normalized);
                
                // Count tokens
                try {
                    cumulativeTokens += countTokens(normalized);
                } catch (e) {
                    // Fallback: estimate based on string length
                    cumulativeTokens += Math.ceil(normalized.length / 4);
                }

                // Check for cache_control
                if (tool.cache_control) {
                    const ttl = this._parseTtl(tool.cache_control);
                    breakpoints.push({
                        hash: hasher.getCurrentHash(),
                        tokens: cumulativeTokens,
                        ttl,
                    });
                }
            }
        }

        // 2. Process system prompt(s)
        if (system) {
            const systemArray = Array.isArray(system) ? system : [{ type: 'text', text: system }];
            
            for (const msg of systemArray) {
                const text = typeof msg === 'string' ? msg : (msg.text || '');
                
                // Skip system entries containing x-anthropic-billing-header to prevent cache busting
                if (text && text.includes('x-anthropic-billing-header')) {
                    continue;
                }
                
                if (text) {
                    hasher.update(text);
                    try {
                        cumulativeTokens += countTokens(text);
                    } catch (e) {
                        cumulativeTokens += Math.ceil(text.length / 4);
                    }
                }

                // Check for cache_control
                const cacheControl = msg?.cache_control;
                if (cacheControl) {
                    const ttl = this._parseTtl(cacheControl);
                    breakpoints.push({
                        hash: hasher.getCurrentHash(),
                        tokens: cumulativeTokens,
                        ttl,
                    });
                }
            }
        }

        // 3. Process messages - ONLY up to and including blocks with cache_control
        // Content after the last cache_control should not affect the hash
        if (messages && Array.isArray(messages)) {
            // First pass: find the last message index and block index with cache_control
            let lastCacheControlMsgIdx = -1;
            let lastCacheControlBlockIdx = -1;
            
            for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
                const msg = messages[msgIdx];
                const content = msg.content;
                
                if (Array.isArray(content)) {
                    for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
                        if (content[blockIdx].cache_control) {
                            lastCacheControlMsgIdx = msgIdx;
                            lastCacheControlBlockIdx = blockIdx;
                        }
                    }
                }
            }
            
            // Second pass: process messages only up to the last cache_control
            // This ensures that new messages after the cached prefix don't invalidate the cache
            for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
                const msg = messages[msgIdx];
                const content = msg.content;
                
                // If we're past the last message with cache_control, stop processing for hash
                if (msgIdx > lastCacheControlMsgIdx) {
                    break;
                }
                
                if (Array.isArray(content)) {
                    // Content is array of blocks
                    for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
                        const block = content[blockIdx];
                        
                        // If we're in the last cache_control message but past the cache_control block, stop
                        if (msgIdx === lastCacheControlMsgIdx && blockIdx > lastCacheControlBlockIdx) {
                            break;
                        }
                        
                        // Create a normalized block for hashing (exclude cache_control field itself)
                        const blockForHash = { ...block };
                        delete blockForHash.cache_control;
                        const blockJson = stableStringify(blockForHash);
                        hasher.update(blockJson);

                        // Estimate tokens from text content
                        if (block.text) {
                            try {
                                cumulativeTokens += countTokens(block.text);
                            } catch (e) {
                                cumulativeTokens += Math.ceil(block.text.length / 4);
                            }
                        }
                        
                        // Also count tokens for thinking blocks
                        if (block.thinking) {
                            try {
                                cumulativeTokens += countTokens(block.thinking);
                            } catch (e) {
                                cumulativeTokens += Math.ceil(block.thinking.length / 4);
                            }
                        }

                        // Check for cache_control
                        if (block.cache_control) {
                            const ttl = this._parseTtl(block.cache_control);
                            breakpoints.push({
                                hash: hasher.getCurrentHash(),
                                tokens: cumulativeTokens,
                                ttl,
                            });
                        }
                    }
                } else if (typeof content === 'string') {
                    // Content is plain string - only process if this message has cache_control potential
                    // (string content can't have cache_control, so we only include it if it's before a cache_control)
                    if (msgIdx < lastCacheControlMsgIdx || (msgIdx === lastCacheControlMsgIdx && lastCacheControlBlockIdx === -1)) {
                        hasher.update(content);
                        try {
                            cumulativeTokens += countTokens(content);
                        } catch (e) {
                            cumulativeTokens += Math.ceil(content.length / 4);
                        }
                    }
                }
            }
        }

        logger.debug(
            `[Redis Cache] Breakpoints computed: count=${breakpoints.length}, ` +
            `tokens_at_last_breakpoint=${cumulativeTokens}, ` +
            `tools=${tools?.length || 0}, system=${Array.isArray(system) ? system.length : (system ? 1 : 0)}, ` +
            `messages=${messages?.length || 0}`
        );

        return breakpoints;
    }

    /**
     * Count system messages with cache_control
     * @private
     */
    _countSystemCacheControl(system) {
        if (!system) return 0;
        if (typeof system === 'string') return 0;
        if (Array.isArray(system)) {
            return system.filter(s => s?.cache_control).length;
        }
        return system.cache_control ? 1 : 0;
    }

    /**
     * Count messages with cache_control in content blocks
     * @private
     */
    _countMessagesCacheControl(messages) {
        if (!messages || !Array.isArray(messages)) return 0;
        return messages.filter(msg => {
            if (!Array.isArray(msg.content)) return false;
            return msg.content.some(block => block?.cache_control);
        }).length;
    }

    /**
     * Lookup cache or create new entries
     * Searches from last breakpoint backwards for cache hit
     * On hit: refreshes TTL and creates subsequent breakpoints
     * On miss: creates all breakpoints
     * 
     * @param {string} sessionId - Session identifier for cache key prefix
     * @param {Array<CacheBreakpoint>} breakpoints - Array of cache breakpoints
     * @param {number} totalTokens - Total input tokens in request
     * @returns {Promise<CacheResult>} Cache result with token counts
     */
    async lookupOrCreate(sessionId, breakpoints, totalTokens) {
        // Default result for when caching is unavailable
        const defaultResult = {
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            uncached_input_tokens: totalTokens,
        };

        // Check if Redis is available
        if (!this.isAvailable()) {
            logger.debug('[Redis Cache] Lookup skipped: Redis not available');
            return defaultResult;
        }

        // Check if there are breakpoints
        if (!breakpoints || breakpoints.length === 0) {
            logger.debug('[Redis Cache] Lookup skipped: no breakpoints');
            return defaultResult;
        }

        const result = {
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            uncached_input_tokens: 0,
        };

        try {
            // Search from last breakpoint backwards for cache hit
            for (let i = breakpoints.length - 1; i >= 0; i--) {
                const bp = breakpoints[i];
                const key = `cache:${sessionId}:${bp.hash}`;

                try {
                    const cachedTokens = await this.client.get(key);

                    if (cachedTokens !== null) {
                        // Cache hit
                        const cachedValue = parseInt(cachedTokens, 10);
                        logger.debug(`[Redis Cache] Hit: key=${key}, cached_tokens=${cachedValue}`);
                        result.cache_read_input_tokens = cachedValue;

                        // Refresh TTL
                        try {
                            await this.client.expire(key, bp.ttl);
                        } catch (e) {
                            logger.warn(`[Redis Cache] Failed to refresh TTL for ${key}: ${e.message}`);
                        }

                        // Create subsequent breakpoints
                        let prevTokens = cachedValue;
                        for (let j = i + 1; j < breakpoints.length; j++) {
                            const laterBp = breakpoints[j];
                            const laterKey = `cache:${sessionId}:${laterBp.hash}`;
                            const additionalTokens = laterBp.tokens - prevTokens;

                            try {
                                await this.client.setex(laterKey, laterBp.ttl, laterBp.tokens);
                            } catch (e) {
                                logger.warn(`[Redis Cache] Failed to create cache for ${laterKey}: ${e.message}`);
                            }

                            result.cache_creation_input_tokens += additionalTokens;
                            prevTokens = laterBp.tokens;
                        }

                        break; // Exit loop on cache hit
                    } else {
                        logger.debug(`[Redis Cache] Miss: key=${key}`);
                    }
                } catch (e) {
                    logger.warn(`[Redis Cache] Error checking key ${key}: ${e.message}`);
                }
            }

            // If no cache hit, create all breakpoints
            if (result.cache_read_input_tokens === 0 && breakpoints.length > 0) {
                logger.info(`[Redis Cache] Creating ${breakpoints.length} new cache entries`);
                let prevTokens = 0;
                for (const bp of breakpoints) {
                    const key = `cache:${sessionId}:${bp.hash}`;
                    
                    logger.debug(`[Redis Cache] Creating breakpoint: hash=${bp.hash.substring(0, 8)}..., tokens=${bp.tokens}, ttl=${bp.ttl}`);
                    
                    try {
                        await this.client.setex(key, bp.ttl, bp.tokens);
                        logger.debug(`[Redis Cache] Successfully created cache entry: ${key}`);
                    } catch (e) {
                        logger.warn(`[Redis Cache] Failed to create cache for ${key}: ${e.message}`);
                    }

                    const additionalTokens = bp.tokens - prevTokens;
                    result.cache_creation_input_tokens += additionalTokens;
                    logger.debug(`[Redis Cache] Added ${additionalTokens} tokens to creation count (total: ${result.cache_creation_input_tokens})`);
                    prevTokens = bp.tokens;
                }
                logger.info(`[Redis Cache] Finished creating cache entries, total creation tokens: ${result.cache_creation_input_tokens}`);
            } else {
                logger.debug(`[Redis Cache] Skipping cache creation: cache_read=${result.cache_read_input_tokens}, breakpoints=${breakpoints.length}`);
            }

            // Calculate uncached tokens
            const cachedTokens = result.cache_read_input_tokens + result.cache_creation_input_tokens;
            result.uncached_input_tokens = Math.max(0, totalTokens - cachedTokens);

            logger.debug(
                `[Redis Cache] Result: read=${result.cache_read_input_tokens}, ` +
                `creation=${result.cache_creation_input_tokens}, uncached=${result.uncached_input_tokens}`
            );

        } catch (error) {
            // Fail-open: return default result on any error
            logger.warn(`[Redis Cache] lookupOrCreate error: ${error.message}`);
            return defaultResult;
        }

        return result;
    }

    /**
     * Disconnect from Redis
     * @returns {Promise<void>}
     */
    async disconnect() {
        if (this.client) {
            try {
                await this.client.quit();
                logger.info('[Redis Cache] Disconnected from Redis');
            } catch (error) {
                logger.warn(`[Redis Cache] Error during disconnect: ${error.message}`);
            }
            this.client = null;
        }
        this.isInitialized = false;
    }
}

// Module-level singleton instance
let redisServiceInstance = null;

/**
 * Get the Redis cache service singleton instance
 * Creates a new instance if one doesn't exist
 * 
 * @param {Object} [config] - Configuration object (only used on first call)
 * @returns {RedisCacheService} The Redis cache service instance
 */
export function getRedisService(config) {
    if (!redisServiceInstance) {
        redisServiceInstance = new RedisCacheService(config);
    }
    return redisServiceInstance;
}

export default {
    RedisCacheService,
    getRedisService,
};
