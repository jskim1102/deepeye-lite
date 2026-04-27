# syntax=docker/dockerfile:1.7
# DeepEye Lite Frontend — React + Vite → Nginx 정적 서빙
# 멀티스테이지 빌드: node(빌드) → nginx(런타임).
# 런타임 이미지에는 Node/npm 이 포함되지 않아 용량과 공격 표면이 최소화된다.

# ─────────────────────── Stage 1: Builder ───────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# -----------------------------------------------------------------------------
# Vite 빌드 타임 환경변수
#   Vite 는 `import.meta.env.VITE_*` 값을 **빌드 시점에 정적으로 인라인** 하므로
#   런타임 ENV 로는 바꿀 수 없다. docker-compose 의 build.args 로 반드시 전달해야 한다.
#   기본값(fallback) 을 두지 않음 — CLAUDE.md §12 (포트 하드코딩 금지) 준수.
#   값 누락 시 아래 RUN 체크에서 빌드가 실패하여 조용한 오작동을 방지.
# -----------------------------------------------------------------------------
ARG VITE_API_PORT
ARG VITE_HLS_PORT
ENV VITE_API_PORT=${VITE_API_PORT} \
    VITE_HLS_PORT=${VITE_HLS_PORT}

RUN test -n "${VITE_API_PORT}" || (echo "ERROR: VITE_API_PORT build-arg 필수 (compose 의 build.args 확인)" >&2; exit 1) \
 && test -n "${VITE_HLS_PORT}" || (echo "ERROR: VITE_HLS_PORT build-arg 필수" >&2; exit 1)

# 의존성 설치 (레이어 캐시 극대화 — 소스 변경 시 재설치 회피)
#   npm ci 는 package-lock.json 을 엄격 반영하여 재현성 보장 (npm install 보다 안전).
COPY package.json package-lock.json ./
RUN npm ci

# 소스 복사 + 프로덕션 빌드
COPY . .
RUN npm run build
# → 산출물: /app/dist

# ─────────────────────── Stage 2: Runtime (Nginx) ───────────────────────
FROM nginx:alpine

# 빌드 산출물을 Nginx 기본 document root 로 복사
COPY --from=builder /app/dist /usr/share/nginx/html

# SPA 라우팅 대응 설정 (react-router 용 HTML5 History fallback)
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# nginx:alpine 의 기본 CMD (`nginx -g "daemon off;"`) 를 그대로 사용
