from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import CORS_ORIGINS, logger
from app.database import SessionLocal, init_db
from app.inference import models_dir
from app.ipcam import inference_router, router as ipcam_router, sync_streams_to_mediamtx
from app.streaming import manager as stream_manager
from app.webcam import router as webcam_router


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """서버 시작/종료 시 리소스 관리."""
    init_db()
    models_dir.ensure_models_dir()

    # 추론 워커 + dispatch 스레드 기동 (v3.0)
    stream_manager.startup()

    # DB 의 IP CAM 을 MediaMTX 에 동기화 (v2.x 호환 — MediaMTX 미동작 시 warning 만)
    db = SessionLocal()
    try:
        sync_streams_to_mediamtx(db)
    finally:
        db.close()

    logger.info("DeepEye Lite API 서버 시작")
    yield
    logger.info("서버 종료 중 — 캡처/추론 리소스 정리")
    stream_manager.shutdown()
    logger.info("서버 종료 완료")


app = FastAPI(title="DeepEye Lite API", lifespan=lifespan)

# CORS
cors_origins = ["*"] if CORS_ORIGINS == "*" else [o.strip() for o in CORS_ORIGINS.split(",")]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(webcam_router)
app.include_router(ipcam_router)
app.include_router(inference_router)


@app.get("/api/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}
