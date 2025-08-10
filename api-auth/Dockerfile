# --- ステージ1: ビルダー ---
# 安定したクロスコンパイル環境を使用
FROM messense/rust-musl-cross:x86_64-musl AS builder

WORKDIR /app

# --- 依存関係のキャッシュレイヤー ---
# 依存関係を定義するファイルだけをコピー
COPY ./Cargo.toml ./Cargo.lock ./
# 依存関係だけを先にビルドするためのダミーのプロジェクトを作成
RUN mkdir -p src && echo "fn main() {println!(\"Dummy main for dependency caching\")}" > src/main.rs
# 依存関係のみをビルド
RUN cargo build --release
# ダミーの成果物を削除
RUN rm -rf src target/x86_64-unknown-linux-musl/release/deps/api_auth*

# --- アプリケーションのビルドレイヤー ---
# 実際のソースコードとマイグレーションファイルをコピー
COPY ./src ./src
COPY ./.sqlx ./.sqlx
# ソースコードの変更部分だけを再コンパイル
RUN SQLX_OFFLINE=true cargo build --release

# --- ステージ2: 実行環境 ---
FROM alpine:latest

# 実行に必要な最低限のライブラリ
RUN apk --no-cache add ca-certificates

# ビルドステージからコンパイル済みのバイナリだけをコピー
COPY --from=builder /app/target/x86_64-unknown-linux-musl/release/api-auth /usr/local/bin/api-auth

# セキュリティのため、非rootユーザーで実行
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# コンテナ起動時に実行されるコマンド
CMD ["api-auth"]