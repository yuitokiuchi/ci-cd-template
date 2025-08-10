# --- ステージ1: 依存関係 (Dependencies) ---
# このステージは、依存関係のインストールだけに責任を持つ
FROM node:20-alpine AS deps

WORKDIR /app
COPY package*.json ./
# 開発用も含め、すべての依存関係をインストール
RUN npm ci

# --- ステージ2: ビルダー (Builder) ---
# このステージは、コードのコンパイルだけに責任を持つ
FROM node:20-alpine AS builder

WORKDIR /app
# 依存関係ステージから、インストール済みのnode_modulesをコピー
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# TypeScriptをJavaScriptにコンパイル
RUN npx tsc

# --- ステージ3: 実行環境 (Runner) ---
# これが最終的な、本番用の軽量イメージ
FROM node:20-alpine

WORKDIR /app

# 実行に必要な本番用の依存関係だけを再インストール
COPY package*.json ./
RUN npm ci --only=production

# ビルダーステージから、コンパイル済みのJavaScriptだけをコピー
COPY --from=builder /app/dist ./dist

# セキュリティのため、非rootユーザーで実行
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# コンテナ起動時に実行されるコマンド
CMD [ "node", "dist/index.js" ]