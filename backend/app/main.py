from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import CORS_ORIGINS, logger
from app.database import SessionLocal, init_db
from app.ipcam import router as ipcam_router, sync_streams_to_mediamtx
from app.webcam import manager, router as webcam_router


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """서버 시작/종료 시 리소스 관리"""
    init_db()
    # DB에 등록된 IP CAM을 MediaMTX에 동기화
    db = SessionLocal()
    try:
        sync_streams_to_mediamtx(db)
    finally:
        db.close()
    logger.info("DeepEye Lite API 서버 시작")
    yield
    logger.info("서버 종료 중 — 카메라 리소스 정리")
    manager.shutdown()
    logger.info("서버 종료 완료")


app = FastAPI(title="DeepEye Lite API", lifespan=lifespan)

# CORS 설정
cors_origins = ["*"] if CORS_ORIGINS == "*" else [o.strip() for o in CORS_ORIGINS.split(",")]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(webcam_router)
app.include_router(ipcam_router)


@app.get("/api/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}
