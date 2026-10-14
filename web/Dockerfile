# 长难句拆解台 · 前端镜像：先用 Node 构建出静态页面，再放进 Nginx
# 构建上下文是仓库根目录（npm workspaces 的锁文件在根目录）：docker compose 里已经这样配好了
FROM node:22-alpine AS build
WORKDIR /app

# 依赖默认走腾讯云 npm 镜像；GitHub Actions 里构建时传入官方源
ARG NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --workspace @sentence-site/web --registry="$NPM_REGISTRY"

COPY shared shared
COPY web web
RUN npm run build -w @sentence-site/web

FROM nginx:1.27-alpine
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
