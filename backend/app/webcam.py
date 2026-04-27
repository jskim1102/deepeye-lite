import asyncio
import glob as glob_module
import logging
import os
import subprocess
import threading
import time

import cv2
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.config import CAPTURE_INTERVAL, JPEG_QUALITY, MAX_WEBCAMS

logger = logging.getLogger("deepeye.webcam")

router = APIRouter(prefix="/api/webcams", tags=["webcam"])


class WebcamInfo(BaseModel):
    index: int
    name: str
    available: bool


class CameraCapture:
    """백그라운드 스레드에서 프레임을 캡처하고 버퍼에 저장"""

    def __init__(self, index: int) -> None:
        self.index = index
        self._cap: cv2.VideoCapture | None = None
        self._frame: bytes = b""
        self._lock = threading.Lock()
        self._running = False
        self._thread: threading.Thread | None = None
        self._ref_count = 0

    def start(self) -> bool:
        """캡처 시작. 이미 실행 중이면 ref_count만 증가."""
        with self._lock:
            self._ref_count += 1
            if self._running:
                return True

        self._running = True
        self._open_event = threading.Event()
        self._thread = threading.Thread(target=self._capture_loop, daemon=True)
        self._thread.start()

        self._open_event.wait(timeout=5)

        if not self._cap or not self._cap.isOpened():
            self._running = False
            with self._lock:
                self._ref_count -= 1
            return False
        return True

    def stop(self) -> None:
        """ref_count 감소. 0이 되면 캡처 종료."""
        with self._lock:
            self._ref_count = max(0, self._ref_count - 1)
            if self._ref_count > 0:
                return
        self._running = False
        if self._thread:
            self._thread.join(timeout=3)

    def _capture_loop(self) -> None:
        """카메라 열기 + 캡처를 같은 스레드에서 수행"""
        cap = cv2.VideoCapture(self.index, cv2.CAP_V4L2)
        self._cap = cap
        self._open_event.set()

        if not cap.isOpened():
            logger.error("카메라 %d 열기 실패", self.index)
            self._running = False
            return

        logger.info("카메라 %d 캡처 시작", self.index)
        try:
            while self._running and cap.isOpened():
                ret, frame = cap.read()
                if not ret:
                    time.sleep(0.01)
                    continue
                _, buffer = cv2.imencode(
                    ".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY]
                )
                with self._lock:
                    self._frame = buffer.tobytes()
        except Exception:
            logger.exception("카메라 %d 캡처 중 예외 발생", self.index)
        finally:
            cap.release()
            self._cap = None
            self._running = False
            logger.info("카메라 %d 캡처 종료", self.index)

    def get_frame(self) -> bytes:
        """최신 프레임 반환"""
        with self._lock:
            return self._frame

    @property
    def is_running(self) -> bool:
        return self._running


class CameraManager:
    """모든 카메라 캡처를 관리"""

    def __init__(self) -> None:
        self._cameras: dict[int, CameraCapture] = {}
        self._lock = threading.Lock()

    def start_camera(self, index: int) -> bool:
        with self._lock:
            if index not in self._cameras:
                self._cameras[index] = CameraCapture(index)
        return self._cameras[index].start()

    def stop_camera(self, index: int) -> None:
        with self._lock:
            cam = self._cameras.get(index)
        if cam:
            cam.stop()

    def get_frame(self, index: int) -> bytes:
        with self._lock:
            cam = self._cameras.get(index)
        if cam:
            return cam.get_frame()
        return b""

    def shutdown(self) -> None:
        """모든 카메라 캡처를 강제 종료 (서버 셧다운 시 호출)"""
        with self._lock:
            indices = list(self._cameras.keys())
        for idx in indices:
            cam = self._cameras.get(idx)
            if cam and cam.is_running:
                cam._running = False
                if cam._thread:
                    cam._thread.join(timeout=3)
                logger.info("카메라 %d 셧다운 완료", idx)
        with self._lock:
            self._cameras.clear()


manager = CameraManager()


# ─── 웹캠 스캔 (Linux V4L2) ───


def _is_capture_device(index: int) -> bool:
    """/sys/class/video4linux/videoN/index가 0이면 캡처 장치 (메타데이터 장치 제외)"""
    try:
        with open(f"/sys/class/video4linux/video{index}/index") as f:
            return f.read().strip() == "0"
    except OSError:
        return False


def _get_usb_names() -> dict[str, str]:
    """lsusb에서 vendor_id:model_id → 제품명 매핑"""
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
    """장치의 vendor_id:model_id를 /sys에서 직접 읽기"""
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
    """/sys/class/video4linux + lsusb로 웹캠 스캔"""
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

        if usb_name:
            product_name = usb_name.split()[-1]
        else:
            product_name = "Unknown"

        name_counts[product_name] = name_counts.get(product_name, 0) + 1
        if name_counts[product_name] == 1:
            display_name = product_name
        else:
            display_name = f"{product_name} ({name_counts[product_name]})"

        webcams.append(WebcamInfo(index=index, name=display_name, available=True))

    return webcams


@router.get("", response_model=list[WebcamInfo])
def list_webcams() -> list[WebcamInfo]:
    """서버에 연결된 웹캠 목록 조회"""
    try:
        webcams = _scan_webcams()
        logger.info("웹캠 스캔 완료: %d대 감지", len(webcams))
        return webcams
    except Exception:
        logger.exception("웹캠 스캔 중 예외 발생")
        raise HTTPException(status_code=500, detail="웹캠 스캔 실패")


@router.websocket("/{index}/ws")
async def webcam_ws(websocket: WebSocket, index: int) -> None:
    """WebSocket으로 JPEG 프레임을 실시간 전송"""
    if index < 0 or index >= MAX_WEBCAMS:
        await websocket.close(code=1008, reason="웹캠 인덱스 범위 초과")
        return

    await websocket.accept()
    logger.info("WebSocket 연결: 카메라 %d", index)

    if not manager.start_camera(index):
        logger.warning("카메라 %d 시작 실패 — WebSocket 종료", index)
        await websocket.close(code=1011, reason=f"웹캠 {index}을 열 수 없습니다")
        return

    try:
        # 첫 프레임 대기 (최대 2초)
        for _ in range(20):
            if manager.get_frame(index):
                break
            await asyncio.sleep(0.1)

        prev_frame: bytes = b""
        while True:
            frame = manager.get_frame(index)
            if frame and frame is not prev_frame:
                await websocket.send_bytes(frame)
                prev_frame = frame
            await asyncio.sleep(CAPTURE_INTERVAL)
    except WebSocketDisconnect:
        logger.info("WebSocket 연결 해제: 카메라 %d", index)
    except Exception:
        logger.exception("WebSocket 카메라 %d 전송 중 예외", index)
    finally:
        manager.stop_camera(index)
