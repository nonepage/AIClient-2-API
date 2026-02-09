import * as crypto from 'crypto';
import stringify from 'safe-stable-stringify';

/**
 * Recursively sorts all keys in a JSON object/array to ensure deterministic serialization
 * @param {any} value - The value to sort (object, array, or primitive)
 * @returns {any} - The value with all keys sorted recursively
 */
function sortJsonKeys(value) {
    if (value === null || value === undefined) {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map(sortJsonKeys);
    }

    if (typeof value === 'object') {
        const sorted = {};
        const keys = Object.keys(value).sort();
        for (const key of keys) {
            sorted[key] = sortJsonKeys(value[key]);
        }
        return sorted;
    }

    return value;
}

/**
 * Converts a value to a deterministic JSON string using safe-stable-stringify
 * @param {any} value - The value to stringify
 * @returns {string} - Deterministic JSON string
 */
function stableStringify(value) {
    return stringify(value);
}

/**
 * Hashes a string using SHA256
 * @param {string} str - The string to hash
 * @returns {string} - Hex-encoded SHA256 hash
 */
function hashString(str) {
    return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/**
 * Hashes an object by first sorting keys and then stringifying deterministically
 * @param {any} obj - The object to hash
 * @returns {string} - Hex-encoded SHA256 hash
 */
function hashObject(obj) {
    const sorted = sortJsonKeys(obj);
    const jsonStr = stableStringify(sorted);
    return hashString(jsonStr);
}

/**
 * Normalizes a tool object for hashing following the kiro-rs format
 * Format: "name:{name}|desc:{description}|schema:{sorted_json}"
 * @param {Object} tool - Tool object with name, description, and input_schema
 * @param {string} tool.name - Tool name
 * @param {string} [tool.description] - Tool description (optional)
 * @param {Object} [tool.input_schema] - Tool input schema (optional)
 * @returns {string} - Normalized tool string
 */
function normalizeToolForHash(tool) {
    const parts = [];
    
    // Add name (required)
    if (tool.name) {
        parts.push(`name:${tool.name}`);
    }
    
    // Add description if present and non-empty
    if (tool.description && tool.description.trim() !== '') {
        parts.push(`desc:${tool.description}`);
    }
    
    // Add schema if present and non-empty
    if (tool.input_schema && Object.keys(tool.input_schema).length > 0) {
        const sorted = sortJsonKeys(tool.input_schema);
        const schemaStr = stableStringify(sorted);
        parts.push(`schema:${schemaStr}`);
    }
    
    return parts.join('|');
}

/**
 * Cumulative hasher class for incremental hashing
 * Useful for cache breakpoints where you need intermediate hash values
 */
class CumulativeHasher {
    constructor() {
        this.buffer = '';
    }
    
    /**
     * Adds data to the cumulative buffer
     * @param {string} data - Data to add
     * @returns {CumulativeHasher} - Returns this for method chaining
     */
    update(data) {
        this.buffer += data;
        return this;
    }
    
    /**
     * Gets the current hash without finalizing
     * @returns {string} - Current SHA256 hash of accumulated data
     */
    getCurrentHash() {
        return crypto.createHash('sha256').update(this.buffer, 'utf8').digest('hex');
    }
    
    /**
     * Finalizes and returns the hash
     * @returns {string} - Final SHA256 hash
     */
    finalize() {
        return this.getCurrentHash();
    }
    
    /**
     * Resets the hasher buffer
     */
    reset() {
        this.buffer = '';
    }
}

// Export all functions and classes
export default {
    sortJsonKeys,
    stableStringify,
    hashString,
    hashObject,
    normalizeToolForHash,
    CumulativeHasher
};

export {
    sortJsonKeys,
    stableStringify,
    hashString,
    hashObject,
    normalizeToolForHash,
    CumulativeHasher
};
