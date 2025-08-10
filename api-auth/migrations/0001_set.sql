-- Up Migration
CREATE TABLE IF NOT EXISTS public.users (
    id BIGINT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- ★★★ ここを修正！ 'public.' を明記する ★★★
CREATE TABLE IF NOT EXISTS public.refresh_tokens (
    jti TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE (user_id)
);
-- ★★★ インデックスにも 'public.' を明記するとさらに良い ★★★
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON public.refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON public.refresh_tokens(expires_at);
-- Down Migration
DROP TABLE IF EXISTS public.refresh_tokens;
DROP TABLE IF EXISTS public.users;