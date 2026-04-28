"""사용자 업로드 custom YOLO 가중치(.pt) 관리.

저장 위치: 컨테이너 내부 `/app/models` (호스트의 `backend/models/` 에 bind mount).
preset 모델(yolo26n/s/m/l/x.pt) 은 ultralytics 가 자동 다운로드 — 여기서 관리하지 않음.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

# 컨테이너 내부 경로 — 호스트의 ./backend/models/ 가 마운트됨
MODELS_DIR = Path(os.getenv("CUSTOM_MODELS_DIR", "/app/models"))

# Preset 모델 — UI 토글 + worker 자동 다운로드 기본값
PRESET_MODELS: tuple[str, ...] = (
    "yolo26n.pt",
    "yolo26s.pt",
    "yolo26m.pt",
    "yolo26l.pt",
    "yolo26x.pt",
)


def ensure_models_dir() -> None:
    """디렉토리가 없으면 생성. 서버 startup 시 호출."""
    MODELS_DIR.mkdir(parents=True, exist_ok=True)


def is_safe_filename(name: str) -> bool:
    """업로드된 파일명 안전성 검사.

    경로 traversal(..,/), 절대경로 차단. `.pt` 확장자 강제.
    """
    if not name:
        return False
    if "/" in name or "\\" in name:
        return False
    if name.startswith(".") or ".." in name:
        return False
    if not name.endswith(".pt"):
        return False
    return True


def list_custom_models() -> list[dict]:
    """`/app/models` 안의 `.pt` 파일 목록."""
    if not MODELS_DIR.exists():
        return []
    out: list[dict] = []
    for p in sorted(MODELS_DIR.glob("*.pt")):
        try:
            size_mb = round(p.stat().st_size / (1024 * 1024), 2)
        except OSError:
            size_mb = 0.0
        out.append({"name": p.name, "type": "custom", "size_mb": size_mb})
    return out


def list_all_models() -> list[dict]:
    """preset + custom 통합 목록 (UI 드롭다운용)."""
    presets = [{"name": n, "type": "preset", "size_mb": None} for n in PRESET_MODELS]
    return presets + list_custom_models()


def save_custom_model(name: str, src_fileobj) -> dict:
    """업로드 파일을 `/app/models/<name>` 으로 저장. 기존 파일 덮어씀."""
    if not is_safe_filename(name):
        raise ValueError(f"올바르지 않은 파일명: {name}")
    ensure_models_dir()
    dest = MODELS_DIR / name
    with dest.open("wb") as f:
        shutil.copyfileobj(src_fileobj, f)
    size_mb = round(dest.stat().st_size / (1024 * 1024), 2)
    return {"name": name, "type": "custom", "size_mb": size_mb}


def delete_custom_model(name: str) -> bool:
    """`/app/models/<name>` 삭제. 없으면 False."""
    if not is_safe_filename(name):
        raise ValueError(f"올바르지 않은 파일명: {name}")
    target = MODELS_DIR / name
    if not target.exists():
        return False
    target.unlink()
    return True


def resolve_model_path(name: str) -> str:
    """모델 이름 → 실제 경로 또는 이름.

    custom 디렉토리에 파일이 있으면 그 경로(워커가 그대로 로드),
    없으면 이름 그대로 (ultralytics 가 자동 다운로드).
    """
    if is_safe_filename(name):
        candidate = MODELS_DIR / name
        if candidate.is_file():
            return str(candidate)
    return name
