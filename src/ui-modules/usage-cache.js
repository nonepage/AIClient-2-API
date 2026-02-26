import { existsSync } from 'fs';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

// 用量缓存文件路径
const USAGE_CACHE_FILE = path.join(process.cwd(), 'configs', 'usage-cache.json');

// 写入互斥锁：防止并发 read-modify-write 导致数据丢失
let _writeLock = Promise.resolve();

/**
 * 原子写入文件：先写临时文件再 rename，防止写入中途崩溃导致文件损坏
 * @param {string} filePath - 目标文件路径
 * @param {string} data - 要写入的数据
 */
async function atomicWriteFile(filePath, data) {
    const dir = path.dirname(filePath);
    const tmpFile = path.join(dir, `${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
        await fs.writeFile(tmpFile, data, 'utf8');
        await fs.rename(tmpFile, filePath);
    } catch (error) {
        // 清理临时文件
        try { await fs.unlink(tmpFile); } catch (_) { /* ignore */ }
        throw error;
    }
}

/**
 * 读取用量缓存文件
 * @returns {Promise<Object|null>} 缓存的用量数据，如果不存在或读取失败则返回 null
 */
export async function readUsageCache() {
    try {
        if (existsSync(USAGE_CACHE_FILE)) {
            const content = await fs.readFile(USAGE_CACHE_FILE, 'utf8');
            return JSON.parse(content);
        }
        return null;
    } catch (error) {
        logger.warn('[Usage Cache] Failed to read usage cache:', error.message);
        return null;
    }
}

/**
 * 写入用量缓存文件（原子写入）
 * @param {Object} usageData - 用量数据
 */
export async function writeUsageCache(usageData) {
    try {
        await atomicWriteFile(USAGE_CACHE_FILE, JSON.stringify(usageData, null, 2));
        logger.info('[Usage Cache] Usage data cached to', USAGE_CACHE_FILE);
    } catch (error) {
        logger.error('[Usage Cache] Failed to write usage cache:', error.message);
    }
}

/**
 * 读取特定提供商类型的用量缓存
 * @param {string} providerType - 提供商类型
 * @returns {Promise<Object|null>} 缓存的用量数据
 */
export async function readProviderUsageCache(providerType) {
    const cache = await readUsageCache();
    if (cache && cache.providers && cache.providers[providerType]) {
        return {
            ...cache.providers[providerType],
            cachedAt: cache.timestamp,
            fromCache: true
        };
    }
    return null;
}

/**
 * 更新特定提供商类型的用量缓存
 * 使用串行化锁防止并发 read-modify-write 竞态
 * @param {string} providerType - 提供商类型
 * @param {Object} usageData - 用量数据
 */
export async function updateProviderUsageCache(providerType, usageData) {
    // 串行化写入：等待前一个写入完成后再执行
    const prev = _writeLock;
    let resolve;
    _writeLock = new Promise(r => { resolve = r; });
    try {
        await prev;
        let cache = await readUsageCache();
        if (!cache) {
            cache = {
                timestamp: new Date().toISOString(),
                providers: {}
            };
        }
        cache.providers[providerType] = usageData;
        cache.timestamp = new Date().toISOString();
        await writeUsageCache(cache);
    } finally {
        resolve();
    }
}