# node:24-bookworm-slim。digest 与 navi / atlas / raven 保持一致，避免基础镜像各自漂移。
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# tsc 只做类型检查，产物是空的 —— 运行时用 tsx 直接跑 .ts。
# 所以这里**不** tsc emit，只确认类型过得去。
RUN ./node_modules/.bin/tsc --noEmit --incremental false

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runner

WORKDIR /app

# infra 的 deploy 会传 AGENT_VERSION=<7 位 commit>，/healthz 靠它报版本。
# 与 ATLAS_VERSION / RAVEN_VERSION 是同一套机制。
ARG AGENT_VERSION=dev
ENV NODE_ENV=production
ENV AGENT_VERSION=$AGENT_VERSION
ENV AGENT_PORT=5900
ENV AGENT_DB_FILE=/data/agent.db

# Magpie 终端 CLI。启动时 little-one spawn `magpie serve`，配置落在 /data/magpie
# （和 agent.db 同一块盘，重建容器还在）。桌面构建要 GTK，容器里用不了。
# 换版本时同时改 URL 与 sha256（该 release 的 SHA256SUMS 里 magpie-cli-linux-amd64）。
ARG MAGPIE_VERSION=v0.1.1204
ARG MAGPIE_SHA256=de02d5a03166a0caef2b77b8246b83a0100bfd225af0e34087c55b3ff69adbe5
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL -o /usr/local/bin/magpie \
    "https://github.com/yetone/magpie-releases/releases/download/${MAGPIE_VERSION}/magpie-cli-linux-amd64" \
  && echo "${MAGPIE_SHA256}  /usr/local/bin/magpie" | sha256sum -c - \
  && chmod 755 /usr/local/bin/magpie \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
ENV MAGPIE_STATE_DIR=/data/magpie

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src

# ⚠️ **不要 `npm prune --omit=dev`**：`tsx` 在 devDependencies 里，而运行时
# 用 `node --import tsx src/main.ts` 直接跑 TypeScript。
#
# 代价是镜像里带着 tsc/eslint 的依赖（比raven 大不少）。换掉的做法是构建期
# 编译成 .js（要改 tsconfig 的 module 到 NodeNext 之外的处理），
# 那是另一次改动 —— 现在这份先跑起来，体积问题记在 docs/03-known-gaps.md 里。
USER node

EXPOSE 5900

# ⚠️ `--import tsx` 不是开发服务器的特权，运行时也需要它（理由见上）。
CMD ["node", "--import", "tsx", "src/main.ts"]