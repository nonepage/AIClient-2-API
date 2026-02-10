# Multi-stage build optimized for ARM64 architecture
# Stage 1: Builder - Install dependencies
FROM node:20-alpine AS builder

# 设置标签
LABEL maintainer="AIClient2API Team"
LABEL description="Docker image for AIClient2API server - ARM64 optimized"

# 安装必要的系统工具（tar 用于更新功能，git 用于版本检查）
RUN apk add --no-cache tar git

# 设置工作目录
WORKDIR /app

# 复制package.json和package-lock.json（如果存在）
COPY package*.json ./

# 安装依赖（包括生产和开发依赖用于构建）
RUN npm install

# Stage 2: Runtime - Create minimal production image
FROM node:20-alpine AS runtime

# 安装运行时必需的系统工具
RUN apk add --no-cache tar git

# 设置工作目录
WORKDIR /app

# 从builder阶段复制node_modules
COPY --from=builder /app/node_modules ./node_modules

# 复制package.json
COPY package*.json ./

# 复制源代码（.dockerignore会自动排除configs/等敏感目录）
COPY . .

USER root

# 创建目录用于存储日志和系统提示文件
RUN mkdir -p /app/logs

# 暴露端口
# 3000: Web UI
# 8085-8087: OAuth callbacks (Gemini, Antigravity, iFlow)
# 1455: Codex OAuth callback
# 19876-19880: Kiro OAuth callbacks
EXPOSE 3000 8085 8086 8087 1455 19876-19880

# 添加健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js || exit 1

# 设置启动命令
# 使用默认配置启动服务器，支持通过环境变量配置
# 通过环境变量传递参数，例如：docker run -e ARGS="--api-key mykey --port 8080" ...
CMD ["sh", "-c", "node src/core/master.js $ARGS"]