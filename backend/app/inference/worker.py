"""YOLO 추론 워커 — backend 메인 프로세스와 분리된 별도 프로세스에서 동작.

CLAUDE.md §6: "AI 추론은 반드시 별도 프로세스" 원칙 구현.

흐름:
    main process                        worker process (별도)
    ─────────────                       ─────────────────────
    capture thread                       (이 모듈)
       │                                    │
       │  frame ──submit()───► in_q ──────►│  YOLO 추론
       │                                    │
       │  ◄───── out_q ◄──── result ◄──────│
       │
       └─ raw JPEG → WebSocket → 브라우저 (브라우저 canvas 가 bbox 오버레이, §4.19)
"""

from __future__ import annotations

import logging
import multiprocessing as mp
import os
import queue
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────
# 데이터 구조 (in/out queue 에 실리는 메시지)
# ─────────────────────────────────────────────────────────────────


@dataclass
class Detection:
    """단일 객체 탐지 결과."""

    class_id: int
    class_name: str
    confidence: float
    xyxy: tuple[int, int, int, int]  # (x1, y1, x2, y2) 픽셀 좌표
    # 어떤 모델이 이 detection 을 만들었는지. 다중 모델 추론 시 라벨 prefix 결정에 사용.
    model: str = ""


@dataclass
class FrameRequest:
    """워커에 보낼 프레임 요청. capture thread → worker."""

    source_id: str  # 카메라 식별자 ("webcam-0", "ipcam-<stream_key>")
    frame: np.ndarray  # OpenCV BGR 이미지
    timestamp: float  # time.time() 캡처 시각
    # per-source confidence threshold. None 이면 worker 의 global state 값 사용.
    conf_threshold: Optional[float] = None
    # per-source 모델 목록. None 이면 worker 의 global state model 1개 사용.
    # 리스트면 그 모델들을 모두 돌려 detection 결과 합침 (다중 모델 추론).
    model_names: Optional[list[str]] = None


@dataclass
class InferenceResult:
    """워커 결과. worker → capture thread."""

    source_id: str
    timestamp: float
    detections: list[Detection] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────
# 워커 클래스
# ─────────────────────────────────────────────────────────────────


class InferenceWorker:
    """별도 프로세스로 YOLO 추론을 수행한다.

    사용 예:
        worker = InferenceWorker()                    # YOLO_DEFAULT_MODEL · YOLO_DEVICE 환경변수 자동 사용
        worker.start()
        worker.submit(FrameRequest("webcam-0", frame, time.time()))
        result = worker.get_result()                  # non-blocking
        worker.set_model("yolo26s.pt")                # 런타임 모델 전환
        worker.set_enabled(False)                      # 추론 OFF (raw 스트리밍 회귀)
        worker.stop()
    """

    # 큐 크기 — 최신 프레임만 처리하기 위해 in_q=1, 결과 약간 버퍼링 out_q=8
    _IN_QUEUE_SIZE = 1
    _OUT_QUEUE_SIZE = 8

    def __init__(
        self,
        model_name: Optional[str] = None,
        conf_threshold: Optional[float] = None,
        device: Optional[str] = None,
    ) -> None:
        self.model_name: str = model_name or os.getenv("YOLO_DEFAULT_MODEL", "yolo26n.pt")
        self.conf_threshold: float = float(
            conf_threshold
            if conf_threshold is not None
            else os.getenv("YOLO_CONF_THRESHOLD", "0.5")
        )
        # device=None 이면 워커가 torch.cuda.is_available() 로 자동 감지
        self.device: Optional[str] = device or os.getenv("YOLO_DEVICE") or None

        ctx = mp.get_context("spawn")  # CUDA 호환을 위해 spawn 강제 (fork 시 CUDA 초기화 충돌)
        self.in_q: mp.Queue = ctx.Queue(maxsize=self._IN_QUEUE_SIZE)
        self.out_q: mp.Queue = ctx.Queue(maxsize=self._OUT_QUEUE_SIZE)

        # 런타임 제어용 shared state (Manager dict)
        self._manager = ctx.Manager()
        self._state = self._manager.dict()
        self._state["model_name"] = self.model_name
        self._state["conf_threshold"] = self.conf_threshold
        self._state["enabled"] = True
        self._state["stop"] = False

        self._proc: Optional[mp.Process] = None
        self._ctx = ctx

    # ── lifecycle ────────────────────────────────────────────────

    def start(self) -> None:
        """워커 프로세스 spawn. 모델 로딩은 워커 안에서 (메인 프로세스 메모리 절약)."""
        if self._proc is not None and self._proc.is_alive():
            return
        self._proc = self._ctx.Process(
            target=_worker_main,
            args=(self.in_q, self.out_q, self._state, self.device),
            daemon=True,
            name="yolo-inference-worker",
        )
        self._proc.start()
        logger.info(
            "Inference worker started: pid=%s, model=%s, device=%s",
            self._proc.pid,
            self.model_name,
            self.device or "auto",
        )

    def stop(self) -> None:
        """워커 종료 및 정리."""
        self._state["stop"] = True
        if self._proc is not None:
            self._proc.join(timeout=5)
            if self._proc.is_alive():
                logger.warning("Worker did not exit gracefully, terminating")
                self._proc.terminate()
            self._proc = None
        logger.info("Inference worker stopped")

    # ── 메인 → 워커 (제출) ────────────────────────────────────────

    def submit(self, req: FrameRequest) -> None:
        """프레임 제출. 큐 가득차있으면 가장 오래된 것 drop 후 새 것 삽입."""
        try:
            self.in_q.put_nowait(req)
        except queue.Full:
            try:
                self.in_q.get_nowait()  # 오래된 것 drop
            except queue.Empty:
                pass
            try:
                self.in_q.put_nowait(req)
            except queue.Full:
                pass  # 그 사이에 다른 producer 가 채웠을 수 있음. 다음 기회에.

    # ── 워커 → 메인 (결과 수신) ──────────────────────────────────

    def get_result(self, timeout: float = 0.0) -> Optional[InferenceResult]:
        """결과 1건 가져오기. 기본 non-blocking (timeout=0)."""
        try:
            if timeout > 0:
                return self.out_q.get(timeout=timeout)
            return self.out_q.get_nowait()
        except queue.Empty:
            return None

    def drain_results(self) -> list[InferenceResult]:
        """현재 큐의 모든 결과를 비워서 반환 (capture thread 가 한 tick 에 처리)."""
        results: list[InferenceResult] = []
        while True:
            try:
                results.append(self.out_q.get_nowait())
            except queue.Empty:
                break
        return results

    # ── 런타임 제어 (API 에서 호출) ───────────────────────────────

    def set_model(self, model_name: str) -> None:
        """런타임 모델 전환. 워커가 다음 iteration 에서 reload."""
        self._state["model_name"] = model_name
        logger.info("Model switch requested: %s", model_name)

    def set_enabled(self, enabled: bool) -> None:
        """추론 ON/OFF 토글. OFF 면 워커는 in_q 만 비우고 결과 송출 안 함."""
        self._state["enabled"] = bool(enabled)
        logger.info("Inference enabled=%s", enabled)

    def set_conf_threshold(self, threshold: float) -> None:
        """confidence 임계값 변경."""
        self._state["conf_threshold"] = float(threshold)

    def get_status(self) -> dict:
        """현재 상태 (FastAPI `/api/inference/config` GET 용)."""
        return {
            "enabled": bool(self._state.get("enabled", True)),
            "model": str(self._state.get("model_name", self.model_name)),
            "conf_threshold": float(self._state.get("conf_threshold", self.conf_threshold)),
            "device": self.device or "auto",
        }


# ─────────────────────────────────────────────────────────────────
# 워커 프로세스 메인 — module-level 함수 (spawn 으로 picklable)
# ─────────────────────────────────────────────────────────────────


def _worker_main(in_q: mp.Queue, out_q: mp.Queue, state, device_override: Optional[str]) -> None:
    """워커 프로세스 entry point. import 도 여기서 — 메인 프로세스 메모리 절약."""
    # 워커 프로세스 안에서만 import (torch/ultralytics 무거움)
    import torch
    from ultralytics import YOLO

    from app.inference.models_dir import resolve_model_path

    # 로깅 (워커는 별도 프로세스라 핸들러 별도 설정 필요할 수 있음)
    worker_logger = logging.getLogger("inference.worker")

    # device 결정
    if device_override:
        device = device_override
    elif torch.cuda.is_available():
        device = "cuda:0"
    else:
        device = "cpu"
    worker_logger.info("Worker device: %s", device)

    # 모델 cache — 여러 모델을 동시에 GPU 메모리에 보유하여 per-source 모델을 즉시 사용
    # key: 모델 이름 (예: "yolo26n.pt"), value: 로드된 YOLO 객체
    models_cache: dict[str, "YOLO"] = {}

    def get_or_load_model(name: str):
        """name 의 YOLO 모델을 cache 에서 가져오거나 새로 로드. 로드 실패 시 None 반환."""
        if name in models_cache:
            return models_cache[name]
        try:
            path = resolve_model_path(name)
            worker_logger.info("Loading YOLO model into cache: %s (path: %s)", name, path)
            m = YOLO(path)
            try:
                m.to(device)
            except Exception as e:
                worker_logger.warning("model.to(%s) failed for %s: %s — keeping CPU", device, name, e)
            models_cache[name] = m
            return m
        except Exception as e:
            worker_logger.error("Model load failed: %s — %s", name, e)
            return None

    # 시작 시 global 기본 모델 미리 로드
    global_model_name = state["model_name"]
    get_or_load_model(global_model_name)

    # 메인 루프
    while not state.get("stop", False):
        # 1) global 기본 모델 전환 요청 — per-source 가 없을 때 fallback
        requested_global = state.get("model_name", global_model_name)
        if requested_global != global_model_name:
            worker_logger.info("Global model switch: %s → %s", global_model_name, requested_global)
            if get_or_load_model(requested_global) is not None:
                global_model_name = requested_global
            else:
                state["model_name"] = global_model_name  # rollback

        # 2) OFF 모드 — 큐만 비우고 휴식
        if not state.get("enabled", True):
            try:
                in_q.get(timeout=0.1)
            except queue.Empty:
                pass
            continue

        # 3) 프레임 가져오기
        try:
            req: FrameRequest = in_q.get(timeout=0.1)
        except queue.Empty:
            continue

        # 4) 이 frame 에 적용할 모델 list 결정 — per-source > global (단일 모델로 폴백)
        target_names = req.model_names if req.model_names else [global_model_name]

        # 5) 각 모델로 추론 → detections 합침 (Phase 2)
        conf = (
            req.conf_threshold
            if req.conf_threshold is not None
            else float(state.get("conf_threshold", 0.5))
        )
        detections: list[Detection] = []
        for target_name in target_names:
            model = get_or_load_model(target_name)
            if model is None:
                # 로드 실패한 모델은 skip — 다른 모델은 계속 처리
                worker_logger.warning("Skipping unavailable model: %s", target_name)
                continue
            try:
                results = model(req.frame, conf=conf, verbose=False)
                detections.extend(_parse_results(results[0], model.names, target_name))
            except Exception as e:
                worker_logger.error("Inference error (%s): %s", target_name, e)
                continue

        # 6) 결과 송출 (detections 가 비어있어도 send — 클라이언트가 raw 표시)
        result = InferenceResult(
            source_id=req.source_id,
            timestamp=req.timestamp,
            detections=detections,
        )
        try:
            out_q.put_nowait(result)
        except queue.Full:
            # 결과 큐 가득 차면 오래된 거 drop
            try:
                out_q.get_nowait()
                out_q.put_nowait(result)
            except (queue.Empty, queue.Full):
                pass

    worker_logger.info("Worker exiting")


def _parse_results(result, names: dict, model_name: str = "") -> list[Detection]:
    """ultralytics Results 객체 → Detection 리스트.

    `model_name` 은 다중 모델 추론에서 어떤 모델이 만든 detection 인지 표시하기 위해 사용.
    """
    detections: list[Detection] = []
    if result.boxes is None or len(result.boxes) == 0:
        return detections
    boxes = result.boxes
    xyxy_arr = boxes.xyxy.cpu().numpy().astype(int)
    conf_arr = boxes.conf.cpu().numpy()
    cls_arr = boxes.cls.cpu().numpy().astype(int)
    for i in range(len(boxes)):
        x1, y1, x2, y2 = xyxy_arr[i].tolist()
        cls_id = int(cls_arr[i])
        detections.append(
            Detection(
                class_id=cls_id,
                class_name=str(names.get(cls_id, str(cls_id))),
                confidence=float(conf_arr[i]),
                xyxy=(x1, y1, x2, y2),
                model=model_name,
            )
        )
    return detections
