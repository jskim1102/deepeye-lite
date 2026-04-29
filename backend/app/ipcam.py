import asyncio
import logging
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import CAPTURE_INTERVAL, MEDIAMTX_API
from app.database import get_db
from app.inference import models_dir
from app.models import IpCam
from app.streaming import manager as stream_manager
from app.streaming.manager import detections_to_json

logger = logging.getLogger("deepeye.ipcam")

router = APIRouter(prefix="/api/ipcams", tags=["ipcam"])


def _source_id(stream_key: str) -> str:
    """ipcam-<stream_key> 형식의 source_id."""
    return f"ipcam-{stream_key}"


# ─── MediaMTX 연동 ───


def _register_stream(stream_key: str, rtsp_url: str) -> bool:
    """MediaMTX에 RTSP 스트림 등록"""
    try:
        resp = httpx.post(
            f"{MEDIAMTX_API}/v3/config/paths/add/{stream_key}",
            json={"source": rtsp_url},
            timeout=5,
        )
        if resp.status_code in (200, 201):
            logger.info("MediaMTX 스트림 등록: %s → %s", stream_key, rtsp_url)
            return True
        logger.warning("MediaMTX 등록 실패: %d %s", resp.status_code, resp.text)
        return False
    except httpx.HTTPError:
        logger.exception("MediaMTX 연결 실패 (등록: %s)", stream_key)
        return False


def _remove_stream(stream_key: str) -> None:
    """MediaMTX에서 스트림 제거"""
    try:
        resp = httpx.delete(
            f"{MEDIAMTX_API}/v3/config/paths/delete/{stream_key}",
            timeout=5,
        )
        if resp.status_code in (200, 204):
            logger.info("MediaMTX 스트림 제거: %s", stream_key)
        else:
            logger.warning("MediaMTX 제거 실패: %d %s", resp.status_code, resp.text)
    except httpx.HTTPError:
        logger.exception("MediaMTX 연결 실패 (제거: %s)", stream_key)


def sync_streams_to_mediamtx(db: Session) -> None:
    """서버 시작 시 DB의 모든 IP CAM을 MediaMTX에 동기화"""
    cams = db.query(IpCam).all()
    for cam in cams:
        _register_stream(cam.stream_key, cam.rtsp_url)
    logger.info("MediaMTX 동기화 완료: %d개 스트림", len(cams))


# ─── 요청/응답 스키마 ───


class IpCamCreate(BaseModel):
    name: str
    rtsp_url: str


class IpCamUpdate(BaseModel):
    name: str
    rtsp_url: str


class IpCamResponse(BaseModel):
    id: int
    name: str
    rtsp_url: str
    stream_key: str
    created_at: datetime

    model_config = {"from_attributes": True}


# ─── 엔드포인트 ───


@router.get("", response_model=list[IpCamResponse])
def list_ipcams(db: Session = Depends(get_db)) -> list[IpCam]:
    """등록된 IP CAM 목록 조회"""
    return db.query(IpCam).order_by(IpCam.id).all()


@router.post("", response_model=IpCamResponse, status_code=201)
def create_ipcam(body: IpCamCreate, db: Session = Depends(get_db)) -> IpCam:
    """IP CAM 등록 + MediaMTX 스트림 등록"""
    cam = IpCam(name=body.name, rtsp_url=body.rtsp_url)
    db.add(cam)
    db.commit()
    db.refresh(cam)

    _register_stream(cam.stream_key, cam.rtsp_url)

    logger.info("IP CAM 등록: id=%d name=%s stream_key=%s", cam.id, cam.name, cam.stream_key)
    return cam


@router.put("/{cam_id}", response_model=IpCamResponse)
def update_ipcam(cam_id: int, body: IpCamUpdate, db: Session = Depends(get_db)) -> IpCam:
    """IP CAM 수정 + MediaMTX 스트림 재등록"""
    cam = db.query(IpCam).filter(IpCam.id == cam_id).first()
    if not cam:
        raise HTTPException(status_code=404, detail="IP CAM을 찾을 수 없습니다")

    old_url = cam.rtsp_url
    cam.name = body.name
    cam.rtsp_url = body.rtsp_url
    db.commit()
    db.refresh(cam)

    # RTSP 주소가 변경된 경우에만 MediaMTX 재등록
    if old_url != cam.rtsp_url:
        _remove_stream(cam.stream_key)
        _register_stream(cam.stream_key, cam.rtsp_url)

    logger.info("IP CAM 수정: id=%d name=%s", cam.id, cam.name)
    return cam


@router.delete("/{cam_id}", status_code=204)
def delete_ipcam(cam_id: int, db: Session = Depends(get_db)) -> None:
    """IP CAM 삭제 + MediaMTX 스트림 제거"""
    cam = db.query(IpCam).filter(IpCam.id == cam_id).first()
    if not cam:
        raise HTTPException(status_code=404, detail="IP CAM을 찾을 수 없습니다")

    # 진행 중 캡처 강제 종료
    sid = _source_id(cam.stream_key)
    stream_manager.stop_capture(sid)

    _remove_stream(cam.stream_key)

    db.delete(cam)
    db.commit()
    logger.info("IP CAM 삭제: id=%d stream_key=%s", cam_id, cam.stream_key)


@router.get("/{stream_key}/stats")
def get_ipcam_stats(stream_key: str) -> dict:
    """IP CAM 의 source/inference fps. 캡처 미동작 중이면 active=False."""
    sid = _source_id(stream_key)
    stats = stream_manager.get_capture_stats(sid)
    if stats is None:
        return {"active": False, "source_fps": 0.0, "inference_fps": 0.0}
    return {"active": True, **stats}


class PerSourceInferenceState(BaseModel):
    """단일 카메라의 추론 설정 — GET 응답 형식."""
    enabled: bool
    conf_threshold: float | None = None  # None = global 값 사용
    # 카메라별 사용 모델 목록.
    #   null: 미설정 (global 기본 1개 사용)
    #   [] : 명시적 추론 안 함 (bbox 없음)
    #   [m1, ...] : 해당 모델들 사용 (Phase 1 에선 첫 항목만 실제 추론, Phase 2 에 다중 추론 적용 예정)
    models: list[str] | None = None


class PerSourceInferenceUpdate(BaseModel):
    """카메라별 추론 설정 부분 업데이트 — PUT 요청 형식."""
    enabled: bool | None = None
    conf_threshold: float | None = None
    models: list[str] | None = None  # None = 변경 안 함, [] = 추론 안 함


def _build_inference_state(sid: str) -> dict:
    return {
        "enabled": stream_manager.is_source_inference_enabled(sid),
        "conf_threshold": stream_manager.get_source_conf_threshold(sid),
        "models": stream_manager.get_source_models(sid),
    }


@router.get("/{stream_key}/inference", response_model=PerSourceInferenceState)
def get_ipcam_inference(stream_key: str) -> dict:
    """이 IP CAM 의 추론 설정 (enabled + per-source conf + models)."""
    return _build_inference_state(_source_id(stream_key))


@router.put("/{stream_key}/inference", response_model=PerSourceInferenceState)
def set_ipcam_inference(stream_key: str, body: PerSourceInferenceUpdate) -> dict:
    """카메라별 추론 설정 부분 업데이트.

    - `enabled`: ON/OFF
    - `conf_threshold`: 0~1
    - `models`: 사용 모델 목록. `[]` 보내면 추론 안 함.
    """
    sid = _source_id(stream_key)
    if body.enabled is not None:
        stream_manager.set_source_inference_enabled(sid, body.enabled)
    if body.conf_threshold is not None:
        stream_manager.set_source_conf_threshold(sid, body.conf_threshold)
    if body.models is not None:
        stream_manager.set_source_models(sid, body.models)
    return _build_inference_state(sid)


@router.websocket("/{stream_key}/ws")
async def ipcam_ws(websocket: WebSocket, stream_key: str) -> None:
    """RTSP 직접 캡처 + 추론 → JPEG 프레임 WebSocket 송출 (v3.0, §2.7 옵션 A).

    DB 의 stream_key 로 IP CAM 조회 → rtsp_url 로 backend 가 직접 캡처.
    MediaMTX 경유 없이 backend 가 RTSP 클라이언트가 됨.
    """
    # DB 에서 stream_key 로 cam 조회 (Depends 사용 못 해서 manual)
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        cam = db.query(IpCam).filter(IpCam.stream_key == stream_key).first()
    finally:
        db.close()

    if not cam:
        await websocket.close(code=1008, reason="등록되지 않은 stream_key")
        return

    await websocket.accept()
    sid = _source_id(stream_key)
    logger.info("WebSocket 연결: %s (rtsp=%s)", sid, cam.rtsp_url)

    if not stream_manager.start_capture(sid, cam.rtsp_url):
        logger.warning("Capture %s 시작 실패 — RTSP 연결 안 됨", sid)
        await websocket.close(code=1011, reason=f"RTSP 연결 실패")
        return

    try:
        # 첫 프레임 대기 (RTSP 는 연결 latency 있을 수 있어 longer)
        for _ in range(50):  # 최대 5초
            if stream_manager.get_frame(sid):
                break
            await asyncio.sleep(0.1)

        prev_frame: bytes = b""
        prev_det_ts: float = 0.0
        while True:
            # 1) raw JPEG (binary frame)
            frame = stream_manager.get_frame(sid)
            if frame and frame is not prev_frame:
                await websocket.send_bytes(frame)
                prev_frame = frame

            # 2) 추론 결과 갱신 시만 detections JSON (text frame)
            det = stream_manager.get_source_latest_detections(sid)
            if det and det.timestamp != prev_det_ts:
                await websocket.send_text(detections_to_json(det))
                prev_det_ts = det.timestamp

            await asyncio.sleep(CAPTURE_INTERVAL)
    except WebSocketDisconnect:
        logger.info("WebSocket 연결 해제: %s", sid)
    except Exception:
        logger.exception("WebSocket %s 전송 중 예외", sid)
    finally:
        stream_manager.stop_capture(sid)


# ─── 추론 제어 (모델 토글, ON/OFF, conf threshold) ───


class InferenceConfig(BaseModel):
    enabled: bool
    model: str
    conf_threshold: float
    device: str


class InferenceConfigUpdate(BaseModel):
    enabled: bool | None = None
    model: str | None = None
    conf_threshold: float | None = None


inference_router = APIRouter(prefix="/api/inference", tags=["inference"])


@inference_router.get("/config", response_model=InferenceConfig)
def get_inference_config() -> dict:
    """현재 추론 워커 상태."""
    return stream_manager.get_inference_config()


@inference_router.put("/config", response_model=InferenceConfig)
def update_inference_config(body: InferenceConfigUpdate) -> dict:
    """추론 ON/OFF · 모델 · conf threshold 변경. 부분 업데이트 지원."""
    if body.enabled is not None:
        stream_manager.set_inference_enabled(body.enabled)
    if body.model is not None:
        stream_manager.set_inference_model(body.model)
    if body.conf_threshold is not None:
        stream_manager.set_inference_conf_threshold(body.conf_threshold)
    return stream_manager.get_inference_config()


# ─── 모델 CRUD (Custom .pt 업로드/삭제) ───


class ModelInfo(BaseModel):
    name: str
    type: str  # "preset" 또는 "custom"
    size_mb: float | None = None


# 업로드 한도 — RTX 3090 으로 학습한 큰 모델도 보통 500MB 이내
_MAX_UPLOAD_MB = 500


@inference_router.get("/models", response_model=list[ModelInfo])
def list_models() -> list[dict]:
    """preset(YOLO26 5종) + custom 업로드 모델 통합 목록."""
    return models_dir.list_all_models()


@inference_router.post("/models", response_model=ModelInfo, status_code=201)
async def upload_model(file: UploadFile = File(...)) -> dict:
    """Custom `.pt` 파일 업로드. 파일명 그대로 저장 (덮어쓰기 허용)."""
    name = file.filename or ""
    if not models_dir.is_safe_filename(name):
        raise HTTPException(
            status_code=400,
            detail="파일명은 `.pt` 로 끝나야 하며 경로 구분자(/, \\) 나 .. 를 포함할 수 없습니다.",
        )

    # 크기 검사 (스트리밍 — UploadFile.spool 안에서 size 확인)
    content = await file.read()
    size_mb = len(content) / (1024 * 1024)
    if size_mb > _MAX_UPLOAD_MB:
        raise HTTPException(
            status_code=413,
            detail=f"파일이 너무 큽니다 ({size_mb:.1f} MB > {_MAX_UPLOAD_MB} MB)",
        )

    # 저장
    import io
    info = models_dir.save_custom_model(name, io.BytesIO(content))
    logger.info("Custom 모델 업로드: %s (%s MB)", info["name"], info["size_mb"])
    return info


_classes_cache: dict[str, dict[int, str]] = {}


@inference_router.get("/models/{name}/classes")
def get_model_classes(name: str) -> list[dict]:
    """주어진 모델의 클래스 ID→이름 목록.

    최초 호출 시 lazy load → `model.names` → 캐시.
    카메라/모델별 클래스 필터·색상 UI 메타데이터 소스 (§4.20).
    """
    if not models_dir.is_safe_filename(name):
        raise HTTPException(status_code=400, detail="올바르지 않은 파일명")

    if name not in _classes_cache:
        try:
            from ultralytics import YOLO
            path = models_dir.resolve_model_path(name)
            m = YOLO(path)
            names = dict(m.names) if getattr(m, "names", None) else {}
            _classes_cache[name] = {int(k): str(v) for k, v in names.items()}
        except Exception as e:
            logger.exception("모델 클래스 조회 실패: %s", name)
            raise HTTPException(status_code=500, detail=f"모델 로드 실패: {e}")

    names = _classes_cache[name]
    return [{"id": k, "name": v} for k, v in sorted(names.items())]


@inference_router.delete("/models/{name}", status_code=204)
def delete_model(name: str) -> None:
    """Custom 모델 삭제. preset 은 삭제 불가."""
    if name in models_dir.PRESET_MODELS:
        raise HTTPException(status_code=400, detail="preset 모델은 삭제할 수 없습니다")
    if not models_dir.is_safe_filename(name):
        raise HTTPException(status_code=400, detail="올바르지 않은 파일명")
    if not models_dir.delete_custom_model(name):
        raise HTTPException(status_code=404, detail="해당 모델이 없습니다")

    # 현재 사용 중이던 모델이면 yolo26n 으로 폴백
    cfg = stream_manager.get_inference_config()
    if cfg.get("model") == name:
        stream_manager.set_inference_model("yolo26n.pt")
        logger.info("삭제된 모델이 사용 중이라 yolo26n.pt 로 폴백")

    logger.info("Custom 모델 삭제: %s", name)
