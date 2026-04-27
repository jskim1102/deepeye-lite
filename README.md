# DeepEye Lite

경량 단독 설치형 CCTV AI 분석 플랫폼. **웹캠** 또는 **IP CAM (RTSP)** 을 입력으로 받아 웹 브라우저에서 실시간으로 모니터링한다.

> **v2.0** — Docker 단일 배포 (스트리밍 전용)
> v3.0 (예정) — YOLO 객체탐지 통합

## 아키텍처

```
[브라우저] ──http──► [frontend (Nginx)]    : 5173
[브라우저] ──ws/http──► [backend (FastAPI)] : 8000  ──► /dev/video* (웹캠)
[브라우저] ──hls──► [mediamtx]              : 8888  ◄── RTSP IP CAM
                       ▲
                       └─ [backend] ──API──► [mediamtx :9997]
```

| 레이어 | 스택 |
|--------|------|
| Frontend | React 19 + Vite + TypeScript → Nginx |
| Backend | FastAPI + OpenCV + SQLAlchemy 2.0 (SQLite) |
| 미디어 서버 | MediaMTX (RTSP → HLS 변환) |
| 배포 | Docker Compose (단일 명령 기동) |

## 시스템 요구사항

- Docker Engine + Docker Compose v2 (Linux · macOS · Windows 모두 가능)
- **USB 웹캠 기능을 쓰려면 Linux 호스트** + `/dev/video*` 디바이스 접근 권한 (Mac/Windows 는 IP CAM 만 가능)
- (v3.0 부터) NVIDIA GPU + `nvidia-container-toolkit` (Linux)

## 빠른 시작

### 1. 프로젝트 클론

```bash
git clone git@github.com:jskim1102/deepeye-lite.git
cd deepeye-lite
```

### 2. 환경변수 파일 생성

```bash
# 루트 (compose 가 사용 — 호스트 노출 포트)
cp .env.example .env

# Backend (런타임 설정)
cp backend/.env.example backend/.env

# Frontend (로컬 dev 시에만 사용. Docker 배포는 루트 .env 사용)
cp frontend/.env.example frontend/.env
```

각 `.env` 파일 편집하여 `{...}` 플레이스홀더를 실제 값으로 채운다.

### 3. 빈 SQLite DB 파일 생성

> Docker 가 bind mount 할 파일이 미리 존재해야 한다. 없으면 디렉토리로 자동 생성됨.

```bash
touch backend/deepeye.db
```

### 4. (Linux + USB 웹캠 사용 시에만) 웹캠 override 활성화

`/dev/video*` 를 backend 컨테이너에 마운트해야 웹캠 기능이 동작한다. 두 가지 방법:

**방법 A — `.env` 에 한 줄 추가 (권장)**

```bash
echo "COMPOSE_FILE=docker-compose.yml:docker-compose.webcam.yml" >> .env
```

이후 `docker compose ...` 명령 평소대로 사용 — 두 파일이 자동 머지된다.

**방법 B — 매 명령마다 `-f` 명시**

```bash
docker compose -f docker-compose.yml -f docker-compose.webcam.yml up -d
```

> Mac/Windows 또는 웹캠 미사용 시 이 단계는 **건너뛰고** 다음으로 진행. 기본 `docker-compose.yml` 만으로 IP CAM 은 정상 동작한다.

> 호스트의 비디오 디바이스 수에 맞게 `docker-compose.webcam.yml` 의 `/dev/videoN` 줄을 추가/제거해야 한다 (디바이스 없는 줄이 있으면 backend 가 시작 거부).

### 5. 기동

```bash
docker compose up -d --build
```

최초 실행은 2~3분 소요 (이미지 빌드 + MediaMTX 다운로드).

### 6. 접속

브라우저에서:

```
http://<서버IP>:5173
```

- **Webcam**: USB 웹캠을 자동 감지하여 그리드 스트리밍
- **IP CAM**: RTSP 주소 등록 → MediaMTX 가 HLS 로 변환 → 브라우저 재생

### 7. 종료

```bash
docker compose down
```

## 환경변수

### 루트 `.env` (compose 치환용 — 호스트 외부 노출 포트)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `BACKEND_PORT` | 8000 | Backend API 호스트 노출 포트 |
| `FRONTEND_PORT` | 5173 | Frontend (Nginx) 호스트 노출 포트 |
| `MEDIAMTX_API_PORT` | 9997 | MediaMTX REST API 포트 |
| `MEDIAMTX_HLS_PORT` | 8888 | MediaMTX HLS 재생 포트 |
| `MEDIAMTX_RTSP_PORT` | 8554 | MediaMTX RTSP 포트 (디버깅용) |

### `backend/.env` (Backend 런타임)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `INTERNAL_IP` | (설치 환경) | 서버 내부 IP |
| `EXTERNAL_IP` | (설치 환경) | 서버 외부 IP |
| `CORS_ORIGINS` | `*` | CORS 허용 origin. 쉼표 구분. `*` 는 모두 허용. |
| `JPEG_QUALITY` | 70 | JPEG 인코딩 품질 (1~100) |
| `MAX_WEBCAMS` | 16 | 최대 웹캠 수 |
| `CAPTURE_INTERVAL` | 0.03 | 캡처 스레드 sleep (초) |
| `LOG_LEVEL` | INFO | 로그 레벨 (DEBUG/INFO/WARNING/ERROR) |
| `MEDIAMTX_API` | `http://localhost:9997` | (로컬 실행용 기본값. Docker 기동시 compose 가 `http://mediamtx:${MEDIAMTX_API_PORT}` 로 override) |

### `frontend/.env` (로컬 dev 시에만 — Vite dev server)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `VITE_API_PORT` | 8000 | Backend 호스트 노출 포트 |
| `VITE_HLS_PORT` | 8888 | MediaMTX HLS 호스트 노출 포트 |
| `VITE_DEV_PORT` | 5173 | Vite dev server 포트 |

> Docker 빌드 시엔 루트 `.env` 의 `BACKEND_PORT`, `MEDIAMTX_HLS_PORT` 가 build args 로 자동 주입된다 (compose).

## API 엔드포인트

### Backend (`http://<host>:<BACKEND_PORT>`)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/health` | 서버 상태 |
| GET | `/api/webcams` | 연결된 웹캠 목록 |
| WS | `/api/webcams/{index}/ws` | 웹캠 WebSocket 스트림 |
| GET | `/api/ipcams` | 등록된 IP CAM 목록 |
| POST | `/api/ipcams` | IP CAM 등록 (RTSP URL) |
| DELETE | `/api/ipcams/{id}` | IP CAM 삭제 |

### MediaMTX (`http://<host>:<MEDIAMTX_HLS_PORT>`)

| 경로 | 설명 |
|---|---|
| `/{stream_key}/index.m3u8` | HLS 매니페스트 (브라우저 재생) |

## 디렉토리 구조

```
deepeye-lite/
├── docker-compose.yml      ← 3-서비스 오케스트레이터
├── .env / .env.example     ← 호스트 노출 포트
├── mediamtx.yml            ← MediaMTX 설정
│
├── backend/
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── pyproject.toml      ← 개발자용 Poetry
│   ├── poetry.lock
│   ├── requirements.txt    ← Docker 용 (poetry export 산물)
│   ├── .env / .env.example
│   └── app/
│       ├── main.py         ← FastAPI 앱
│       ├── config.py       ← 설정 로드
│       ├── database.py     ← SQLAlchemy
│       ├── models.py       ← ORM 모델
│       ├── webcam.py       ← 웹캠 캡처/스트리밍
│       └── ipcam.py        ← IP CAM CRUD + MediaMTX 연동
│
└── frontend/
    ├── Dockerfile          ← multi-stage (node → nginx)
    ├── .dockerignore
    ├── nginx.conf          ← SPA fallback + 캐시 정책
    ├── package.json
    ├── package-lock.json
    ├── .env / .env.example ← 로컬 dev 시에만 사용
    └── src/
        ├── App.tsx
        ├── main.tsx
        ├── pages/
        │   ├── HomePage.tsx
        │   ├── WebcamPage.tsx
        │   └── IpcamPage.tsx
        └── components/
            └── HlsPlayer.tsx
```

## 개발 노트

### 의존성 추가 (Backend)

```bash
cd backend
poetry add <패키지명>                                                     # pyproject.toml + poetry.lock 갱신
poetry export -f requirements.txt -o requirements.txt --without-hashes    # Docker 용 재생성
git add pyproject.toml poetry.lock requirements.txt
```

> Poetry 2.x 는 export 가 별도 플러그인 — 최초 1회: `poetry self add poetry-plugin-export`

### 의존성 추가 (Frontend)

```bash
cd frontend
npm install <패키지명>
git add package.json package-lock.json
```

### 이미지 재빌드만

```bash
docker compose build              # 둘 다
docker compose build backend      # 하나만
```

### 로그 확인

```bash
docker compose logs -f backend    # 실시간 follow
docker compose logs --tail 30     # 마지막 30줄
```

## 라이선스

(작성 예정)
