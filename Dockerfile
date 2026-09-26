# syntax=docker/dockerfile:1

# ---- 依赖与构建 ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---- 静态页面服务 ----
FROM nginx:1.27-alpine AS web
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80

# ---- 一次性验收：Vitest + Playwright ----
# 镜像标签须与 package.json 中 @playwright/test 版本保持一致。
FROM mcr.microsoft.com/playwright:v1.48.2-noble AS verify
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# E2E_BASE_URL 由 compose 注入（指向 web 服务）；本地则自起 preview。
CMD ["npm", "run", "verify"]
