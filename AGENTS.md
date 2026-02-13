# AGENTS.md - AIClient-2-API

> 本文件为 AI 编码代理提供项目上下文和开发规范指南。

## 项目概述

AIClient-2-API 是一个统一的 AI API 代理服务器，支持多种 AI 提供商（OpenAI、Claude、Gemini、Kiro、Qwen 等）之间的协议转换。核心功能包括：
- 多协议兼容（OpenAI、Claude、Gemini 格式互转）
- 提供商池管理与健康检查
- OAuth 凭证自动刷新
- 插件系统支持

## 构建/测试命令

```bash
# 启动服务器（主进程模式）
npm start

# 启动服务器（独立模式）
npm run start:standalone

# 开发模式启动
npm run start:dev

# 运行所有测试
npm test

# 运行单个测试文件
npx jest ./tests/<filename>.test.js

# 运行特定测试用例
npx jest ./tests/api-integration.test.js -t "测试名称"

# 示例：运行 OpenAI 兼容端点测试
npx jest ./tests/api-integration.test.js -t "OpenAI Compatible Endpoints"

# 监视模式测试
npm run test:watch

# 测试覆盖率
npm run test:coverage

# 静默测试
npm run test:silent
```

## 代码风格指南

### 模块系统
- 使用 ES Modules（`import/export`），项目配置 `"type": "module"`
- 导入时必须包含 `.js` 扩展名：`import logger from './logger.js'`
- 第三方库导入在前，本地模块导入在后，按功能分组

```javascript
// 正确的导入顺序
import { v4 as uuidv4 } from 'uuid';
import deepmerge from 'deepmerge';

import logger from '../utils/logger.js';
import { handleError } from '../utils/common.js';
import { BaseConverter } from '../BaseConverter.js';
```

### 命名规范
- 文件名：kebab-case（如 `request-handler.js`、`api-server.js`）
- 类名：PascalCase（如 `BaseConverter`、`OpenAIConverter`）
- 函数/变量：camelCase（如 `handleStreamRequest`、`providerPoolManager`）
- 常量：UPPER_SNAKE_CASE（如 `MODEL_PROVIDER`、`API_ACTIONS`）
- 私有函数：下划线前缀（如 `_extractModelAndStreamInfo`）

### 类与继承
- 使用 ES6 class 语法
- 抽象基类在构造函数中检查 `new.target` 防止直接实例化
- 策略模式广泛使用（Converter、Provider Strategy）

```javascript
export class BaseConverter {
    constructor(protocolName) {
        if (new.target === BaseConverter) {
            throw new Error('BaseConverter是抽象类，不能直接实例化');
        }
        this.protocolName = protocolName;
    }
}
```

### 异步处理
- 优先使用 `async/await`
- Promise 用于事件驱动的异步操作（如 HTTP 请求体解析）
- 流式处理使用 `for await...of`

```javascript
// Promise 模式（事件驱动）
function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => resolve(body ? JSON.parse(body) : {}));
        req.on('error', reject);
    });
}

// async/await 模式
async function handleRequest(req, res) {
    const body = await parseRequestBody(req);
    // ...
}

// 流式处理
for await (const chunk of stream) {
    // 处理每个 chunk
}
```

### 错误处理
- 使用 try/catch 包裹异步操作
- 错误对象应包含 `statusCode`、`message` 属性
- 网络错误使用 `isRetryableNetworkError()` 判断是否可重试
- 不要使用空 catch 块，至少记录日志

```javascript
try {
    const result = await apiCall();
} catch (error) {
    logger.error(`[Server] Error: ${error.message}`);
    handleError(res, error, provider);
}
```

### 日志规范
- 使用项目统一的 `logger` 模块
- 日志标签格式：`[模块名]` 或 `[模块名] 操作描述`
- 支持请求上下文追踪（requestId）

```javascript
import logger from '../utils/logger.js';

logger.info(`[Server] Received request: ${req.method} ${req.url}`);
logger.error(`[Auth] Unauthorized request denied`);
logger.warn(`[Stream] Client disconnected`);
```

### 注释规范
- 使用 JSDoc 风格注释公共函数和类
- 中英双语注释（中文在前）
- 复杂逻辑添加行内注释

```javascript
/**
 * 转换请求
 * @param {Object} data - 请求数据
 * @param {string} targetProtocol - 目标协议
 * @returns {Object} 转换后的请求
 */
convertRequest(data, targetProtocol) {
    // ...
}
```

### 类型与常量
- 使用常量对象定义枚举值
- 导出常量供其他模块使用

```javascript
export const MODEL_PROVIDER = {
    GEMINI_CLI: 'gemini-cli-oauth',
    OPENAI_CUSTOM: 'openai-custom',
    CLAUDE_CUSTOM: 'claude-custom',
    // ...
};

export const MODEL_PROTOCOL_PREFIX = {
    GEMINI: 'gemini',
    OPENAI: 'openai',
    CLAUDE: 'claude',
    // ...
};
```

## 项目结构

```
src/
├── auth/           # OAuth 认证处理
├── converters/     # 协议转换器（策略模式）
│   ├── strategies/ # 具体转换器实现
│   ├── BaseConverter.js
│   └── ConverterFactory.js
├── handlers/       # 请求处理器
├── providers/      # AI 提供商适配器
│   ├── openai/
│   ├── claude/
│   └── provider-models.js
├── services/       # 核心服务
│   ├── api-server.js
│   ├── service-manager.js
│   └── provider-pool-manager.js
├── utils/          # 工具函数
│   ├── common.js
│   ├── logger.js
│   └── provider-strategies.js
└── ui-modules/     # UI 管理 API

tests/              # 测试文件
configs/            # 配置文件
static/             # 前端静态资源
```

## 测试规范

- 测试文件放在 `tests/` 目录，命名为 `*.test.js`
- 使用 Jest 框架，支持 ESM
- 集成测试需要运行中的服务器实例
- 测试超时设置为 30 秒

```javascript
describe('API Integration Tests', () => {
    beforeAll(async () => {
        // 检查服务器连接
    }, 30000);

    test('OpenAI /v1/chat/completions', async () => {
        const response = await makeRequest(url, 'POST', 'bearer', headers, body);
        expect(response.status).toBe(200);
    });
});
```

## 关键设计模式

1. **策略模式**：Converter 和 Provider Strategy 使用策略模式处理不同协议
2. **工厂模式**：`ConverterFactory` 和 `ProviderStrategyFactory` 创建实例
3. **单例模式**：`logger`、`PluginManager` 使用单例
4. **观察者模式**：插件系统的钩子机制

## 注意事项

- 修改转换器时确保双向转换一致性
- 流式响应需要正确处理客户端断开连接
- 提供商池健康检查逻辑在 `provider-pool-manager.js`
- 配置文件在 `configs/` 目录，支持热重载
