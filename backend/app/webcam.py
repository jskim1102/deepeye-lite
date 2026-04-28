"""웹캠(USB/V4L2) 라우팅 + 장치 스캔.

v3.0 부터 캡처/추론 로직은 `app.streaming.manager` 의 단일 매니저가 담당.
이 모듈은 V4L2 스캔(`_scan_webcams`) 과 라우팅만 책임진다.
"""

from __future__ import annotations

import asyncio
import glob as glob_module
import logging
import os
import subprocess

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.config import CAPTURE_INTERVAL, MAX_WEBCAMS
from app.streaming import manager

logger = logging.getLogger("deepeye.webcam")

router = APIRouter(prefix="/api/webcams", tags=["webcam"])


class WebcamInfo(BaseModel):
    index: int
    name: str
    available: bool


# ─── 웹캠 스캔 (Linux V4L2) ───


def _is_capture_device(index: int) -> bool:
    """/sys/class/video4linux/videoN/index 가 0 이면 캡처 장치."""
    try:
        with open(f"/sys/class/video4linux/video{index}/index") as f:
            return f.read().strip() == "0"
    except OSError:
        return False


def _get_usb_names() -> dict[str, str]:
    """lsusb 출력에서 vendor:product → 제품명 매핑."""
    usb_names: dict[str, str] = {}
    try:
        result = subprocess.run(["lsusb"], capture_output=True, text=True, timeout=5)
        for line in result.stdout.splitlines():
            parts = line.split("ID ")
            if len(parts) < 2:
                continue
            rest = parts[1]
            tokens = rest.split(" ", 1)
            usb_id = tokens[0]
            name = tokens[1].strip() if len(tokens) > 1 else usb_id
            usb_names[usb_id] = name
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return usb_names


def _get_device_usb_id(index: int) -> str:
    device_path = os.path.realpath(f"/sys/class/video4linux/video{index}/device")
    usb_device = os.path.dirname(device_path)
    vendor_path = os.path.join(usb_device, "idVendor")
    product_path = os.path.join(usb_device, "idProduct")
    try:
        with open(vendor_path) as f:
            vendor = f.read().strip()
        with open(product_path) as f:
            product = f.read().strip()
        return f"{vendor}:{product}"
    except OSError:
        return ""


def _scan_webcams() -> list[WebcamInfo]:
    usb_names = _get_usb_names()
    webcams: list[WebcamInfo] = []
    name_counts: dict[str, int] = {}
    devices = sorted(glob_module.glob("/dev/video*"))

    for device in devices:
        try:
            index = int(device.replace("/dev/video", ""))
        except ValueError:
            continue
        if not _is_capture_device(index):
            continue

        usb_id = _get_device_usb_id(index)
        usb_name = usb_names.get(usb_id, "")
        product_name = usb_name.split()[-1] if usb_name else "Unknown"

        name_counts[product_name] = name_counts.get(product_name, 0) + 1
        display_name = (
            product_name
            if name_counts[product_name] == 1
            else f"{product_name} ({name_counts[product_name]})"
        )
        webcams.append(WebcamInfo(index=index, name=display_name, available=True))

    return webcams


def _source_id(index: int) -> str:
    """webcam-N 형식의 source_id."""
    return f"webcam-{index}"


# ─── 라우팅 ───


@router.get("", response_model=list[WebcamInfo])
def list_webcams() -> list[WebcamInfo]:
    """서버에 연결된 웹캠 목록 (V4L2)."""
    try:
        webcams = _scan_webcams()
        logger.info("웹캠 스캔 완료: %d대 감지", len(webcams))
        return webcams
    except Exception:
        logger.exception("웹캠 스캔 중 예외 발생")
        raise HTTPException(status_code=500, detail="웹캠 스캔 실패")


@router.websocket("/{index}/ws")
async def webcam_ws(websocket: WebSocket, index: int) -> None:
    """JPEG 프레임을 WebSocket 으로 실시간 전송 (bbox 포함)."""
    if index < 0 or index >= MAX_WEBCAMS:
        await websocket.close(code=1008, reason="웹캠 인덱스 범위 초과")
        return

    await websocket.accept()
    sid = _source_id(index)
    logger.info("WebSocket 연결: %s", sid)

    if not manager.start_capture(sid, index):
        logger.warning("Capture %s 시작 실패 — WebSocket 종료", sid)
        await websocket.close(code=1011, reason=f"웹캠 {index}을 열 수 없습니다")
        return

    try:
        # 첫 프레임 대기 (최대 2초)
        for _ in range(20):
            if manager.get_frame(sid):
                break
            await asyncio.sleep(0.1)

        prev_frame: bytes = b""
        while True:
            frame = manager.get_frame(sid)
            if frame and frame is not prev_frame:
                await websocket.send_bytes(frame)
                prev_frame = frame
            await asyncio.sleep(CAPTURE_INTERVAL)
    except WebSocketDisconnect:
        logger.info("WebSocket 연결 해제: %s", sid)
    except Exception:
        logger.exception("WebSocket %s 전송 중 예외", sid)
    finally:
        manager.stop_capture(sid)
