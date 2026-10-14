# 长难句拆解台 · 后端镜像
# 构建上下文是仓库根目录（npm workspaces 的锁文件在根目录）：docker compose 里已经这样配好了
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# 依赖默认走腾讯云 npm 镜像；GitHub Actions 里构建时传入官方源
ARG NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/
COPY package.json package-lock.json .npmrc ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY web/package.json web/
# 只装后端运行要用的依赖（pg）
RUN npm ci --omit=dev --workspace @sentence-site/api --registry="$NPM_REGISTRY" --ignore-scripts \
  && npm cache clean --force

COPY api/src api/src
# 出题规范：后端把里面的规则放进给 AI 的提示词
COPY api/skills api/skills
COPY api/scripts api/scripts
# 旧版页面导出的句子和练习记录：第一次启动、数据库里还没有句子时自动导入
COPY api/seed api/seed

WORKDIR /app/api
USER node
EXPOSE 3000
# 直接运行 TypeScript 源码（Node 22 自带的类型擦除）；显式打开开关，镜像里的 Node 是 22.6–22.17 也能跑
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/server.ts"]
