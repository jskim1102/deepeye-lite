"""YOLO 추론 워커 패키지 (v3.0~).

CLAUDE.md §6 원칙: AI 추론은 메인 FastAPI 와 다른 프로세스에서 수행한다.
"""

from app.inference.worker import (
    Detection,
    FrameRequest,
    InferenceResult,
    InferenceWorker,
)
from app.inference import models_dir

__all__ = [
    "Detection",
    "FrameRequest",
    "InferenceResult",
    "InferenceWorker",
    "models_dir",
]
