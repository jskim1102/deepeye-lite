import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

# backend/.env 를 로드
_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_env_path)

CORS_ORIGINS: str = os.getenv("CORS_ORIGINS", "*")

# 환경변수 검증 후 상수 등록
_raw_jpeg = int(os.getenv("JPEG_QUALITY", "70"))
JPEG_QUALITY: int = max(1, min(100, _raw_jpeg))

_raw_max_webcams = int(os.getenv("MAX_WEBCAMS", "16"))
MAX_WEBCAMS: int = max(1, min(64, _raw_max_webcams))

_raw_interval = float(os.getenv("CAPTURE_INTERVAL", "0.03"))
CAPTURE_INTERVAL: float = max(0.01, min(1.0, _raw_interval))

LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO").upper()

# MEDIAMTX_API 는 하드코딩 fallback 을 두지 않는다 (CLAUDE.md §12).
# Docker compose 가 `environment:` 블록으로 `http://mediamtx:${MEDIAMTX_API_PORT}` 를 주입.
# 로컬 실행(Docker 없이 poetry run) 시에는 `backend/.env` 에 MEDIAMTX_API 를 반드시 설정해야 한다.
try:
    MEDIAMTX_API: str = os.environ["MEDIAMTX_API"]
except KeyError as e:
    raise RuntimeError(
        "환경변수 MEDIAMTX_API 가 설정되지 않았습니다. "
        "Docker 에서는 docker-compose.yml 의 environment 블록, "
        "로컬 실행 시에는 backend/.env 의 MEDIAMTX_API 를 확인하세요."
    ) from e


def setup_logging() -> logging.Logger:
    """애플리케이션 로거 설정"""
    logger = logging.getLogger("deepeye")
    logger.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))

    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(
            logging.Formatter("[%(asctime)s] %(levelname)s  %(name)s — %(message)s",
                              datefmt="%Y-%m-%d %H:%M:%S")
        )
        logger.addHandler(handler)

    return logger


logger = setup_logging()

# 검증 결과가 원래 값과 다르면 경고
if _raw_jpeg != JPEG_QUALITY:
    logger.warning("JPEG_QUALITY=%d → %d 로 보정됨 (허용 범위: 1~100)", _raw_jpeg, JPEG_QUALITY)
if _raw_max_webcams != MAX_WEBCAMS:
    logger.warning("MAX_WEBCAMS=%d → %d 로 보정됨 (허용 범위: 1~64)", _raw_max_webcams, MAX_WEBCAMS)
if _raw_interval != CAPTURE_INTERVAL:
    logger.warning("CAPTURE_INTERVAL=%.3f → %.3f 로 보정됨 (허용 범위: 0.01~1.0)", _raw_interval, CAPTURE_INTERVAL)
