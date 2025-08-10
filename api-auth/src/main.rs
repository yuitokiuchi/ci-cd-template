// main.rs
mod auth_handler;

use axum::{
    routing::{get, post},
    http::{HeaderValue, Method},
    Router,
};
use dotenvy::dotenv;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sqlx::{mysql::MySqlPoolOptions, MySqlPool};
use std::{env, sync::Arc, net::SocketAddr};
use tower_http::{
    cors::CorsLayer,
    trace::TraceLayer,
};

// --- アプリケーション全体で使う構造体をここに定義 ---
// pub をつけて、auth_handler.rs からもアクセスできるようにする
#[derive(Deserialize)]
pub struct GitHubTokenRequest {
    pub code: String,
    pub redirect_to: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GitHubAccessTokenResponse {
    pub access_token: String,
}

#[derive(Debug, Deserialize)]
pub struct GitHubUser {
    pub id: u64,
    pub login: String,
    pub avatar_url: Option<String>,
}

#[derive(Serialize)]
pub struct MeResponse {
    pub user_id: String,
    pub access_token: String, // <-- この行を追加
}

#[derive(Serialize)]
pub struct AppConfigResponse {
    pub allowed_redirect_origins: Vec<String>,
}

#[derive(Clone)]
pub struct AppState {
    pub db: MySqlPool,
    pub http: Client,
    pub jwt_secret: String,
    pub allowed_redirects: Vec<String>,
    pub github_client_id: String,
    pub github_client_secret: String,
    pub cookie_domain: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // .envファイルから環境変数を読み込む
    dotenv().ok();

    // RUST_LOG環境変数を読み込んでロギングを初期化
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "info".into());

    // ロガーを初期化し、先ほど作成したフィルターを適用
    tracing_subscriber::fmt()
        .with_env_filter(filter) // <-- 正しいメソッドはこれです
        .with_target(false)
        .compact()
        .init();

    // 環境変数から設定を読み込む
    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let jwt_secret = env::var("JWT_SECRET").expect("JWT_SECRET must be set");
    let github_client_id = env::var("GITHUB_CLIENT_ID").expect("GITHUB_CLIENT_ID must be set");
    let github_client_secret = env::var("GITHUB_CLIENT_SECRET").expect("GITHUB_CLIENT_SECRET must be set");
    let allowed_redirects_str = env::var("ALLOWED_REDIRECTS").unwrap_or_default();
    let cookie_domain = env::var("COOKIE_DOMAIN").ok(); 

    // --- ここからが重要なデバッグログ ---
    tracing::debug!("=================================================");
    tracing::debug!("  Auth API Service - Starting with Configuration");
    tracing::debug!("=================================================");
    tracing::debug!("- DATABASE_URL: {}", database_url);
    tracing::debug!("- JWT_SECRET: [REDACTED]");
    tracing::debug!("- GITHUB_CLIENT_ID: {}", github_client_id);
    tracing::debug!("- GITHUB_CLIENT_SECRET: [REDACTED]");
    tracing::debug!("- ALLOWED_REDIRECTS: {}", allowed_redirects_str);
    tracing::debug!("=================================================");

    // DB接続プールを作成
    let db_pool = MySqlPoolOptions::new()
        .connect(&database_url)
        .await?;

    let http_client = Client::new();

    // 文字列をVec<String>にパース
    let allowed_redirects: Vec<String> = allowed_redirects_str
        .split(',')
        .filter(|s| !s.trim().is_empty()) // 空の文字列を除外
        .map(|s| s.trim().to_string())
        .collect();

    // CORSで許可するオリジンをパース
    let cors_allowed_origins: Vec<HeaderValue> = allowed_redirects
        .iter()
        .filter_map(|origin| origin.parse().ok())
        .collect();

    // AppStateにはパース後のVecを渡す
    let app_state = Arc::new(AppState {
        db: db_pool,
        http: http_client,
        jwt_secret,
        allowed_redirects,
        github_client_id,
        github_client_secret,
        cookie_domain,
    });

    let cors_layer = CorsLayer::new()
        .allow_origin(cors_allowed_origins)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([
            axum::http::header::ACCEPT,
            axum::http::header::CONTENT_TYPE,
        ])
        .allow_credentials(true)
        .max_age(std::time::Duration::from_secs(86400));

    // アプリケーションのルーティングを定義
    let app = Router::new()
        .route("/api/v1/auth/github/token", post(auth_handler::github_token_handler))
        .route("/api/v1/auth/refresh", post(auth_handler::refresh_token_handler))
        .route("/api/v1/me", get(auth_handler::me_handler))
        .route("/api/v1/auth/logout", post(auth_handler::logout_handler))
        .route("/api/v1/config", get(auth_handler::get_config_handler))
        .with_state(app_state)
        .layer(TraceLayer::new_for_http())
        .layer(cors_layer);

    // --- より洗練されたサーバー起動 ---
    let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
    tracing::info!("Auth API listening on {}", addr);

    // `axum_server::bind` が自動でGraceful Shutdownを処理してくれる
    axum_server::bind(addr)
        .serve(app.into_make_service())
        .await?;

    Ok(())
}

// この関数は他モジュールから参照されるため `pub` にする
pub fn is_allowed_redirect(url: &str, allowed: &[String]) -> bool {
    if let Ok(parsed_url) = url.parse::<url::Url>() {
        if let Some(host) = parsed_url.host_str() {
            let target_origin = format!("{}://{}", parsed_url.scheme(), host);
            return allowed.iter().any(|allowed_origin| *allowed_origin == target_origin);
        }
    }
    false
}