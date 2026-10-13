FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# 依赖走腾讯云 npm 镜像（见 .npmrc）
COPY package.json .npmrc ./
RUN npm install --omit=dev

COPY src ./src
COPY scripts ./scripts
# 旧版页面导出的句子和练习记录：第一次启动、数据库里还没有句子时自动导入
COPY seed ./seed

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
