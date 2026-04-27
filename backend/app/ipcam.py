import logging
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import MEDIAMTX_API
from app.database import get_db
from app.models import IpCam

logger = logging.getLogger("deepeye.ipcam")

router = APIRouter(prefix="/api/ipcams", tags=["ipcam"])


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

    _remove_stream(cam.stream_key)

    db.delete(cam)
    db.commit()
    logger.info("IP CAM 삭제: id=%d stream_key=%s", cam_id, cam.stream_key)
