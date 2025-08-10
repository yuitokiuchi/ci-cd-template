// auth_handler.rs
use axum::{
    extract::State,
    response::{IntoResponse}, // Response を追加
    http::{StatusCode, header, HeaderMap, HeaderValue},
    Json,
};
use axum_extra::extract::TypedHeader;
use headers::Cookie as HeaderCookie;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use jsonwebtoken::{encode, Header, EncodingKey, decode, DecodingKey, Validation};
use cookie::{Cookie, SameSite};
use crate::{AppState, AppConfigResponse, GitHubTokenRequest, GitHubAccessTokenResponse, GitHubUser, MeResponse};
use chrono::Utc;
use uuid::Uuid;

// --- Type Definitions for Tokens & GitHub Responses ---

#[derive(Debug, Serialize, Deserialize)]
struct AccessTokenClaims {
    sub: String, // User ID
    exp: usize,
}

#[derive(Debug, Serialize, Deserialize)]
struct RefreshTokenClaims {
    sub: String, // User ID
    jti: String, // JWT ID (Unique Identifier)
    exp: usize,
}

// --- 改善: GitHubの成功/エラー両方のレスポンスを扱えるenum ---
#[derive(Debug, Deserialize)]
#[serde(untagged)] // JSONの構造に応じて、どちらかのヴァリアントにデシリアライズする
enum GitHubTokenResponsePayload {
    Success(GitHubAccessTokenResponse),
    Error {
        error: String,
        error_description: String,
        error_uri: String,
    },
}

// --- Utility Functions ---
fn create_cookies(access_token: &str, refresh_token: &str, state: &Arc<AppState>) -> (HeaderValue, HeaderValue) {
    // __Host- プレフィックスはDomain属性と共存できないため、__Secure- に変更
    let mut access_cookie_builder = Cookie::build(("__Secure-access_token", access_token.to_string()))
        .path("/")
        .secure(true)
        .http_only(true)
        .same_site(SameSite::None);

    let mut refresh_cookie_builder = Cookie::build(("__Secure-refresh_token", refresh_token.to_string()))
        .path("/api/v1/auth/refresh")
        .secure(true)
        .http_only(true)
        .same_site(SameSite::None)
        .expires(cookie::time::OffsetDateTime::now_utc() + cookie::time::Duration::days(7));

    // .env に COOKIE_DOMAIN が設定されていれば、Domain属性を追加
    if let Some(domain) = &state.cookie_domain {
        access_cookie_builder = access_cookie_builder.domain(domain.clone());
        refresh_cookie_builder = refresh_cookie_builder.domain(domain.clone());
    }
    
    (
        access_cookie_builder.build().to_string().parse().unwrap(),
        refresh_cookie_builder.build().to_string().parse().unwrap(),
    )
}

// --- Handlers ---
pub async fn github_token_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<GitHubTokenRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    tracing::info!("Processing POST /api/v1/auth/github/token");
    let client_id = &state.github_client_id;
    let client_secret = &state.github_client_secret;

    let redirect_to = payload.redirect_to.unwrap_or_else(|| "https://auth-debug.pages.dev".to_string());
    if !crate::is_allowed_redirect(&redirect_to, &state.allowed_redirects) {
        return Err((StatusCode::BAD_REQUEST, "リダイレクト先が許可されていません".to_string()));
    }

    let params = [("client_id", client_id), ("client_secret", client_secret), ("code", &payload.code)];
    let token_res = state.http.post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json").form(&params).send().await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    
    // --- ここからが最終修正 ---
    let token_response: GitHubTokenResponsePayload = token_res.json().await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("GitHub token response deserialization error: {}", e)))?;

    let access_token_str = match token_response {
        GitHubTokenResponsePayload::Success(s) => s.access_token,
        // --- ここを修正 ---
        GitHubTokenResponsePayload::Error { error, error_description, error_uri } => {
            // error_uriもログに出力する
            tracing::warn!(
                "GitHub OAuth error: {} - {}. URI: {}",
                error,
                error_description,
                error_uri
            );
            return Err((StatusCode::BAD_REQUEST, format!("GitHub returned an error: {}", error_description)));
        }
    };
    // --- 修正完了 ---
    
    let user_res = state.http.get("https://api.github.com/user")
        .bearer_auth(&access_token_str).header("User-Agent", "auth-api")
        .send().await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    
    let user: GitHubUser = user_res.json().await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("GitHub user response error: {}", e)))?;
    
    tracing::info!("Successfully fetched user info from GitHub for user_id: {}", user.id);

    sqlx::query!(
        r#"
        INSERT INTO users (id, username, display_name, avatar_url)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            username = VALUES(username)
        "#,
        user.id as i64,      // -> id
        user.login.clone(),  // -> username
        user.login.clone(),  // -> display_name (初回作成時のみ使われる)
        user.avatar_url      // -> avatar_url
    )
    .execute(&state.db)
    .await
    .map_err(|e| {
        tracing::error!("Failed to upsert user on login: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    })?;

    let user_id_str = user.id.to_string();
    let encoding_key = EncodingKey::from_secret(state.jwt_secret.as_bytes());

    let access_claims = AccessTokenClaims {
        sub: user_id_str.clone(),
        exp: (Utc::now() + chrono::Duration::minutes(15)).timestamp() as usize,
    };
    let access_token = encode(&Header::default(), &access_claims, &encoding_key)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let jti = Uuid::new_v4().to_string();
    let refresh_claims = RefreshTokenClaims {
        sub: user_id_str.clone(),
        jti,
        exp: (Utc::now() + chrono::Duration::days(7)).timestamp() as usize,
    };
    let refresh_token = encode(&Header::default(), &refresh_claims, &encoding_key)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let expires_at = Utc::now() + chrono::Duration::days(7);

    sqlx::query!(
        r#"
        INSERT INTO refresh_tokens (jti, user_id, expires_at) 
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE 
            jti = VALUES(jti),
            expires_at = VALUES(expires_at)
        "#,
        refresh_claims.jti,
        user.id as i64,
        expires_at
    )
    .execute(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let (access_cookie_val, refresh_cookie_val) = create_cookies(&access_token, &refresh_token, &state);

    let mut headers = HeaderMap::new();
    headers.append(header::SET_COOKIE, access_cookie_val);
    headers.append(header::SET_COOKIE, refresh_cookie_val);

    Ok((headers, StatusCode::OK))
}

pub async fn refresh_token_handler(
    State(state): State<Arc<AppState>>,
    TypedHeader(cookie): TypedHeader<HeaderCookie>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    tracing::info!("Processing POST /api/v1/auth/refresh");

    // 1. Cookieからリフレッシュトークンを取得
    let refresh_token_str = cookie.get("__Secure-refresh_token") // <-- Cookieプレフィックスを適用
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Missing refresh token".to_string()))?;

    // 2. JWTとしての署名と有効期限を検証
    let decoding_key = DecodingKey::from_secret(state.jwt_secret.as_bytes());
    let token_data = decode::<RefreshTokenClaims>(refresh_token_str, &decoding_key, &Validation::default())
        .map_err(|e| {
            tracing::warn!("Invalid refresh token received: {}", e);
            (StatusCode::UNAUTHORIZED, "Invalid refresh token".to_string())
        })?;
    
    // 3. DBに保存されたJTIと照合し、古いトークンを削除 (トークンローテーション)
    let deleted = sqlx::query!("DELETE FROM refresh_tokens WHERE jti = ?", token_data.claims.jti)
        .execute(&state.db).await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    
    // もしDBから削除した行がなければ、そのトークンは既に使われたか、無効なもの。
    // これは、リプレイ攻撃（盗まれたトークンの再利用）の可能性があるため、セキュリティ上重要なチェック。
    if deleted.rows_affected() == 0 {
        tracing::warn!("Refresh token JTI not found in DB or already used. Potentially stolen/reused token for user_id: {}", token_data.claims.sub);
        // ここで、このユーザーIDに紐づくすべてのリフレッシュトークンを無効化する処理を追加すると、さらにセキュアになる
        return Err((StatusCode::UNAUTHORIZED, "Invalid refresh token".to_string()));
    }
    
    // --- 4. 新しいアクセストークンとリフレッシュトークンを発行 ---
    let user_id_str = token_data.claims.sub;
    let encoding_key = EncodingKey::from_secret(state.jwt_secret.as_bytes());

    // 新しいアクセストークン (15分)
    let access_claims = AccessTokenClaims {
        sub: user_id_str.clone(),
        exp: (Utc::now() + chrono::Duration::minutes(15)).timestamp() as usize,
    };
    let new_access_token = encode(&Header::default(), &access_claims, &encoding_key)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // 新しいリフレッシュトークン (7日間)
    let new_jti = Uuid::new_v4().to_string();
    let refresh_claims = RefreshTokenClaims {
        sub: user_id_str.clone(),
        jti: new_jti,
        exp: (Utc::now() + chrono::Duration::days(7)).timestamp() as usize,
    };
    let new_refresh_token = encode(&Header::default(), &refresh_claims, &encoding_key)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // --- 5. 新しいリフレッシュトークンのJTIをDBに保存 ---
    let expires_at = Utc::now() + chrono::Duration::days(7);
    let user_id = user_id_str.parse::<i64>()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Invalid user ID format in token".to_string()))?;
    sqlx::query!(
        r#"
        INSERT INTO refresh_tokens (jti, user_id, expires_at) 
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE 
            jti = VALUES(jti),
            expires_at = VALUES(expires_at)
        "#,
        refresh_claims.jti,
        user_id,
        expires_at
    )
    .execute(&state.db)
    .await
    .map_err(|e| {
        tracing::error!("Failed to upsert refresh token: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    })?;

    // --- 6. 新しいCookieを生成してクライアントに返す ---
    let (access_cookie_val, refresh_cookie_val) = create_cookies(&new_access_token, &new_refresh_token, &state);

    let mut headers = HeaderMap::new();
    headers.append(header::SET_COOKIE, access_cookie_val);
    headers.append(header::SET_COOKIE, refresh_cookie_val);

    tracing::info!("Successfully refreshed tokens for user_id: {}", user_id_str);
    Ok((headers, StatusCode::OK))
}

pub async fn me_handler(
    State(state): State<Arc<AppState>>,
    TypedHeader(cookie): TypedHeader<HeaderCookie>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    tracing::info!("Processing GET /api/v1/me");

    let access_token_str = cookie.get("__Secure-access_token")
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Missing access token".to_string()))?;

    let decoding_key = DecodingKey::from_secret(state.jwt_secret.as_bytes());
    let token_data = decode::<AccessTokenClaims>(access_token_str, &decoding_key, &Validation::default())
        .map_err(|_| (StatusCode::UNAUTHORIZED, "Invalid access token".to_string()))?;

    // --- ここを修正 ---
    Ok(Json(MeResponse {
        user_id: token_data.claims.sub,
        // 受け取ったトークンの文字列を、そのままレスポンスに含める
        access_token: access_token_str.to_string(),
    }))
}

pub async fn logout_handler(
    State(state): State<Arc<AppState>>,
    TypedHeader(cookie): TypedHeader<HeaderCookie>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    tracing::info!("--- LOGOUT HANDLER V-FINAL: Applying all cookie attributes ---");
    
    if let Some(refresh_token_str) = cookie.get("__Secure-refresh_token") {
        let decoding_key = DecodingKey::from_secret(state.jwt_secret.as_bytes());
        if let Ok(token_data) = decode::<RefreshTokenClaims>(refresh_token_str, &decoding_key, &Validation::default()) {
            let _ = sqlx::query!("DELETE FROM refresh_tokens WHERE jti = ?", token_data.claims.jti)
                .execute(&state.db).await;
        }
    }

    // --- ここからが最終的な修正 ---
    // 削除用Cookieにも、作成時と "全く同じ" 属性を設定する
    let mut access_cookie_builder = Cookie::build(("__Secure-access_token", ""))
        .path("/").secure(true).http_only(true).same_site(SameSite::None)
        .expires(cookie::time::OffsetDateTime::UNIX_EPOCH);

    let mut refresh_cookie_builder = Cookie::build(("__Secure-refresh_token", ""))
        .path("/api/v1/auth/refresh").secure(true).http_only(true).same_site(SameSite::None)
        .expires(cookie::time::OffsetDateTime::UNIX_EPOCH);

    // .env に COOKIE_DOMAIN が設定されていれば、削除用CookieにもDomain属性を追加
    if let Some(domain) = &state.cookie_domain {
        access_cookie_builder = access_cookie_builder.domain(domain.clone());
        refresh_cookie_builder = refresh_cookie_builder.domain(domain.clone());
    }
    
    let mut headers = HeaderMap::new();
    headers.append(header::SET_COOKIE, access_cookie_builder.build().to_string().parse().unwrap());
    headers.append(header::SET_COOKIE, refresh_cookie_builder.build().to_string().parse().unwrap());
    
    Ok((headers, StatusCode::OK))
}

pub async fn get_config_handler(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // ... (変更なし) ...
    tracing::info!("Serving app configuration");
    Json(AppConfigResponse {
        allowed_redirect_origins: state.allowed_redirects.clone(),
    })
}